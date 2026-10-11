import json
import socket
import struct
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path

from temperance.dns import Resolver, TCPHandler, TCPServer, UDPHandler, UDPServer, question, read_exact
from temperance.server import Handler
from temperance.store import Store, domain, matches


def query(host):
    return struct.pack('!6H', 42, 0x100, 1, 0, 0, 0) + b''.join(bytes([len(p)]) + p.encode() for p in host.split('.')) + b'\0\0\1\0\1'


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'test.sqlite3'
        self.store = Store(self.path, 'America/Chicago')
        self.pid = self.store.save_profile(dict(name='Alex', categories=['social'], deny=['example.com'], allow=['safe.example.com'], limit=2, bedtime={'start':'21:00','end':'07:00'}))
        self.store.save_device(dict(ip='192.168.1.42', name='Tablet', profile_id=self.pid))
        self.now = datetime(2026, 10, 11, 18, tzinfo=timezone.utc).timestamp()

    def tearDown(self):
        self.store.db.close()
        self.tmp.cleanup()

    def decision(self, host, seconds=0, ip='192.168.1.42'):
        return self.store.evaluate(ip, host, self.now+seconds)

    def test_domain_boundary_and_allow_precedence(self):
        self.assertEqual(self.decision('a.example.com'), (True, 'custom rule'))
        self.assertEqual(self.decision('safe.example.com'), (False, 'allowed'))
        self.assertEqual(self.decision('notexample.com'), (False, 'allowed'))
        self.assertEqual(self.decision('www.instagram.com'), (True, 'social'))
        self.assertEqual(self.decision('instagram.com.evil.test'), (False, 'allowed'))

    def test_budget_counts_profile_minutes_and_allows_current_minute(self):
        self.decision('allowed.test')
        self.store.save_device(dict(ip='192.168.1.43',name='Phone',profile_id=self.pid))
        self.decision('allowed.test', 10, '192.168.1.43')
        self.assertEqual(self.store.used(self.pid,self.store.day(self.now)),1)
        self.assertEqual(self.decision('allowed.test',60),(False,'allowed'))
        self.assertEqual(self.decision('allowed.test',70),(False,'allowed'))
        self.assertEqual(self.decision('safe.example.com',120),(True,'daily limit'))
        self.assertEqual(self.decision('allowed.test',86400),(False,'allowed'))

    def test_pause_overrides_allow_and_other_devices_are_unmanaged(self):
        self.store.save_profile(dict(id=self.pid,name='Alex',paused=True,allow=['example.com']))
        self.assertEqual(self.decision('example.com'),(True,'paused'))
        self.assertEqual(self.decision('example.com',ip='192.168.1.99'),(False,'allowed'))

    def test_overnight_bedtime_local_timezone(self):
        for utc_hour, blocked in [(1,False),(2,True),(11,True),(12,False)]:
            now=datetime(2026,10,12,utc_hour,tzinfo=timezone.utc).timestamp()
            self.assertEqual(self.store.evaluate('192.168.1.42','safe.example.com',now)[0],blocked)

    def test_validation_and_persistence(self):
        for bad in [dict(name=''),dict(name='A',limit=-1),dict(name='A',deny=['https://example.com']),dict(name='A',bedtime={'start':'21:00'})]:
            with self.assertRaises(ValueError):self.store.save_profile(bad)
        self.assertEqual(domain('CAFÉ.example.'),'xn--caf-dma.example')
        self.assertFalse(matches('evilfacebook.com','facebook.com'))
        reopened=Store(self.path,'America/Chicago')
        self.assertEqual(reopened.snapshot(self.now)['profiles'][0]['name'],'Alex')
        reopened.db.close()

    def test_retention(self):
        self.decision('allowed.test')
        self.store.prune(self.now+32*86400)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM queries').fetchone()[0],0)


class WireTests(unittest.TestCase):
    def setUp(self):
        self.store=Store(':memory:')
        self.pid=self.store.save_profile(dict(name='Test',deny=['blocked.test']))
        self.store.save_device(dict(ip='127.0.0.1',name='Loopback',profile_id=self.pid))
        # Deterministic upstream handles both transports on one ephemeral port.
        class EchoUDP(UDPHandler):
            def handle(self):
                packet,sock=self.request
                reply=packet[:2]+b'\x81\x80'+packet[4:]
                sock.sendto(reply,self.client_address)
        class EchoTCP(TCPHandler):
            def handle(self):
                packet=read_exact(self.request,struct.unpack('!H',read_exact(self.request,2))[0])
                reply=packet[:2]+b'\x81\x80'+packet[4:]
                self.request.sendall(struct.pack('!H',len(reply))+reply)
        udp=UDPServer(('127.0.0.1',0),EchoUDP)
        tcp=TCPServer(udp.server_address,EchoTCP)
        self.servers=[udp,tcp]
        self.resolver=Resolver(self.store,udp.server_address)
        gateway_udp=UDPServer(('127.0.0.1',0),UDPHandler)
        gateway_tcp=TCPServer(gateway_udp.server_address,TCPHandler)
        for server in (gateway_udp,gateway_tcp):server.resolver=self.resolver
        self.servers += [gateway_udp,gateway_tcp]
        self.address=gateway_udp.server_address
        for server in self.servers:threading.Thread(target=server.serve_forever,daemon=True).start()

    def tearDown(self):
        for server in self.servers:server.shutdown();server.server_close()
        self.store.db.close()

    def test_udp_and_tcp_forwarding_and_blocking(self):
        for transport in (socket.SOCK_DGRAM,socket.SOCK_STREAM):
            for host,code in [('allowed.test',0),('sub.blocked.test',3)]:
                with socket.socket(socket.AF_INET,transport) as sock:
                    sock.settimeout(2);sock.connect(self.address);packet=query(host)
                    if transport==socket.SOCK_STREAM:
                        sock.sendall(struct.pack('!H',len(packet))+packet)
                        reply=read_exact(sock,struct.unpack('!H',read_exact(sock,2))[0])
                    else:sock.send(packet);reply=sock.recv(4096)
                    self.assertEqual(reply[:2],packet[:2]);self.assertEqual(reply[3]&15,code)
        snapshot=self.store.snapshot()
        self.assertEqual(snapshot['total'],4);self.assertEqual(snapshot['blocked'],2)

    def test_management_hostname_resolves_while_paused(self):
        self.store.save_profile({'id':self.pid,'name':'Test','paused':True})
        self.resolver.management_domains=frozenset(['policy.test'])
        self.assertEqual(self.resolver.resolve(query('policy.test'),'127.0.0.1')[3]&15,0)
        self.assertEqual(self.resolver.resolve(query('other.test'),'127.0.0.1')[3]&15,3)

    def test_malformed_and_untrusted_clients(self):
        self.assertEqual(self.resolver.resolve(query('allowed.test'),'10.1.1.1')[3]&15,5)
        for packet in [b'x',query('test')[:13],query('test')[:12]+b'\xc0\x0c\0\1\0\1']:
            with self.assertRaises(ValueError):question(packet)
            reply=self.resolver.resolve(packet,'127.0.0.1')
            if reply:self.assertEqual(reply[3]&15,1)


class APITests(unittest.TestCase):
    def setUp(self):
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.server.store=Store(':memory:')
        threading.Thread(target=self.server.serve_forever,daemon=True).start()
        self.port=self.server.server_port

    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.server.store.db.close()

    def request(self,path,body=None,headers=None):
        conn=HTTPConnection('127.0.0.1',self.port,timeout=2)
        conn.request('POST' if body is not None else 'GET',path,json.dumps(body) if body is not None else None,headers or {})
        response=conn.getresponse();result=response.read();conn.close()
        return response.status,result

    def test_profile_device_and_static_flow(self):
        headers={'Origin':f'http://127.0.0.1:{self.port}','Content-Type':'application/json'}
        status,body=self.request('/api/profiles',{'name':'Alex'},headers)
        self.assertEqual(status,200);pid=json.loads(body)['profiles'][0]['id']
        self.assertEqual(self.request('/api/devices',{'name':'Tablet','ip':'192.168.1.42','profile_id':pid},headers)[0],200)
        self.assertEqual(len(json.loads(self.request('/api/state')[1])['devices']),1)
        for path in ('/','/app.js','/style.css'):self.assertEqual(self.request(path)[0],200)
        self.assertEqual(self.request('/api/profiles',{'name':'A','limit':-5},headers)[0],400)

    def test_cross_origin_and_rebinding_are_rejected(self):
        self.assertEqual(self.request('/api/profiles',{'name':'A'})[0],403)
        self.assertEqual(self.request('/api/profiles',{'name':'A'},{'Origin':'http://evil.test'})[0],403)
        self.assertEqual(self.request('/api/state',headers={'Host':'evil.test'})[0],403)


if __name__=='__main__':unittest.main()
