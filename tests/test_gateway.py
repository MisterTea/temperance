import socket
import struct
import threading
import unittest

from temperance.dns import Resolver, TCPHandler, TCPServer, UDPHandler, UDPServer, question, read_exact
from temperance.gateway_store import GatewayStore
from temperance.policy import matches


def query(host):
    return struct.pack('!6H', 42, 0x100, 1, 0, 0, 0) + b''.join(bytes([len(p)]) + p.encode() for p in host.split('.')) + b'\0\0\1\0\1'


def policy_state(**profile):
    return {'policy_schema': 2, 'version': 1, 'timezone': 'UTC', 'paused': False,
            'profiles': [{'id': 1, 'name': 'Test', 'managed': True, 'paused': False, 'filter_level': 'adult', 'limit': 0, 'used': 0,
                          'allow': [], 'deny': ['blocked.test'], 'unmanaged': [], 'categories': [], 'schedules': [],
                          'bedtime': {'start': '', 'end': '', 'days': list(range(7))}, **profile}],
            'peers': [{'id': 'loopback', 'ip': '127.0.0.1', 'profile_id': 1, 'managed': True, 'paused': False}]}


class WireTests(unittest.TestCase):
    def setUp(self):
        self.store = GatewayStore()
        self.store.state = policy_state()
        # Deterministic upstream handles both transports on one ephemeral port.
        class EchoUDP(UDPHandler):
            def handle(self):
                packet, sock = self.request
                reply = packet[:2] + b'\x81\x80' + packet[4:]
                sock.sendto(reply, self.client_address)
        class EchoTCP(TCPHandler):
            def handle(self):
                packet = read_exact(self.request, struct.unpack('!H', read_exact(self.request, 2))[0])
                reply = packet[:2] + b'\x81\x80' + packet[4:]
                self.request.sendall(struct.pack('!H', len(reply)) + reply)
        udp = UDPServer(('127.0.0.1', 0), EchoUDP)
        tcp = TCPServer(udp.server_address, EchoTCP)
        self.servers = [udp, tcp]
        self.resolver = Resolver(self.store, udp.server_address, networks=['127.0.0.0/8'])
        gateway_udp = UDPServer(('127.0.0.1', 0), UDPHandler)
        gateway_tcp = TCPServer(gateway_udp.server_address, TCPHandler)
        for server in (gateway_udp, gateway_tcp):
            server.resolver = self.resolver
        self.servers += [gateway_udp, gateway_tcp]
        self.address = gateway_udp.server_address
        for server in self.servers:
            threading.Thread(target=server.serve_forever, daemon=True).start()

    def tearDown(self):
        for server in self.servers:
            server.shutdown()
            server.server_close()

    def test_udp_and_tcp_forwarding_and_blocking(self):
        for transport in (socket.SOCK_DGRAM, socket.SOCK_STREAM):
            for host, code in [('allowed.test', 0), ('sub.blocked.test', 3)]:
                with socket.socket(socket.AF_INET, transport) as sock:
                    sock.settimeout(2)
                    sock.connect(self.address)
                    packet = query(host)
                    if transport == socket.SOCK_STREAM:
                        sock.sendall(struct.pack('!H', len(packet)) + packet)
                        reply = read_exact(sock, struct.unpack('!H', read_exact(sock, 2))[0])
                    else:
                        sock.send(packet)
                        reply = sock.recv(4096)
                    self.assertEqual(reply[:2], packet[:2])
                    self.assertEqual(reply[3] & 15, code)
        self.assertEqual([(h['domain'], h['blocked']) for h in self.store.history],
                         [('allowed.test', False), ('sub.blocked.test', True)] * 2)

    def test_management_hostname_resolves_while_paused(self):
        self.store.state = policy_state(paused=True)
        self.resolver.management_domains = frozenset(['policy.test'])
        self.assertEqual(self.resolver.resolve(query('policy.test'), '127.0.0.1')[3] & 15, 0)
        self.assertEqual(self.resolver.resolve(query('other.test'), '127.0.0.1')[3] & 15, 3)

    def test_no_policy_fails_closed(self):
        self.store.state = None
        self.assertEqual(self.resolver.resolve(query('allowed.test'), '127.0.0.1')[3] & 15, 3)

    def test_malformed_and_untrusted_clients(self):
        self.assertEqual(self.resolver.resolve(query('allowed.test'), '10.1.1.1')[3] & 15, 5)
        for packet in [b'x', query('test')[:13], query('test')[:12] + b'\xc0\x0c\0\1\0\1']:
            with self.assertRaises(ValueError):
                question(packet)
            reply = self.resolver.resolve(packet, '127.0.0.1')
            if reply:
                self.assertEqual(reply[3] & 15, 1)

    def test_upstream_failure_is_servfail(self):
        self.resolver.upstream = ('127.0.0.1', 9)
        self.servers[0].shutdown()
        self.servers[0].server_close()
        self.servers.pop(0)
        self.assertEqual(self.resolver.resolve(query('allowed.test'), '127.0.0.1')[3] & 15, 2)

    def test_domain_matching_respects_label_boundaries(self):
        self.assertTrue(matches('www.facebook.com', 'facebook.com'))
        self.assertFalse(matches('evilfacebook.com', 'facebook.com'))


if __name__ == '__main__':
    unittest.main()
