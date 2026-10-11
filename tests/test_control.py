import base64
import json
import threading
import time
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from temperance.control import ControlStore, ControlHandler, digest
from temperance.gateway import firewall, wg_config, network_blocked

PUBLIC=base64.b64encode(bytes(range(32))).decode()
DEVICE=base64.b64encode(bytes(range(1,33))).decode()

class ControlTests(unittest.TestCase):
    def setUp(self):
        self.store=ControlStore(':memory:','UTC','192.0.2.1:51820',PUBLIC)
        self.pid=self.store.save_profile({'name':'Test'})
    def tearDown(self):self.store.db.close()
    def enroll(self):
        code=self.store.issue_code(self.pid)['code']
        return code,self.store.enroll({'code':code,'name':'Phone','public_key':DEVICE})
    def test_enrollment_is_single_use_and_private_keys_never_collected(self):
        code,result=self.enroll()
        self.assertEqual(result['tunnel']['address'],'10.77.0.2/32')
        self.assertNotIn('private_key',result)
        self.assertEqual(self.store.client_id(result['token']),result['device_id'])
        self.assertNotIn(result['token'],str(self.store.gateway_state()))
        self.assertEqual(self.store.db.execute('SELECT token_hash FROM clients').fetchone()[0],digest(result['token']))
        with self.assertRaises(ValueError):self.store.enroll({'code':code,'name':'Other','public_key':PUBLIC})
    def test_expiry_and_invalid_key_do_not_consume_code(self):
        code=self.store.issue_code(self.pid)['code']
        with self.assertRaises(ValueError):self.store.enroll({'code':code,'name':'Phone','public_key':'garbage'})
        self.store.db.execute('UPDATE codes SET expires=?',(time.time()-1,));self.store.db.commit()
        with self.assertRaises(ValueError):self.store.enroll({'code':code,'name':'Phone','public_key':DEVICE})
    def test_policy_dissemination_and_revocation(self):
        _,device=self.enroll();version=device['version']
        self.store.save_profile({'id':self.pid,'name':'Test','paused':True})
        latest=self.store.client_state(device['device_id'])
        self.assertTrue(latest['policy']['paused']);self.assertGreater(latest['version'],version)
        with self.assertRaises(ValueError):self.store.save_device({'ip':'10.77.0.2','name':'Phone','profile_id':None})
        self.store.delete_device('10.77.0.2')
        self.assertIsNone(self.store.client_id(device['token']));self.assertEqual(self.store.gateway_state()['peers'],[])
    def test_usage_counts_once_and_updates_budget(self):
        _,device=self.enroll();self.store.account([device['device_id']]*2)
        self.store.account([device['device_id']])
        self.assertEqual(self.store.client_state(device['device_id'])['policy']['used'],1)
    def test_network_budget_and_overnight_schedule(self):
        from datetime import datetime, timezone
        profile={'paused':False,'limit':2,'used':2,'bedtime':{'start':'','end':''}}
        self.assertTrue(network_blocked(profile,'UTC'))
        profile['used']=0;profile['bedtime']={'start':'21:00','end':'07:00'}
        now=datetime(2026,10,12,2,tzinfo=timezone.utc).timestamp()
        self.assertTrue(network_blocked(profile,'America/Chicago',now))
        now=datetime(2026,10,12,12,tzinfo=timezone.utc).timestamp()
        self.assertFalse(network_blocked(profile,'America/Chicago',now))
    def test_firewall_has_lease_and_checks_both_directions_before_conntrack(self):
        self.enroll();state=self.store.gateway_state()
        script=firewall(state,'temperance','eth0')
        self.assertIn('timeout 15s',script);self.assertIn('ip saddr != @lease drop',script)
        self.assertIn('ip daddr != @lease drop',script)
        self.assertIn('dnat to 10.77.0.1:53',script)
        self.assertIn('meta nfproto ipv6 drop',script)
        self.assertIn('10.77.0.2 oifname',script)
        self.assertNotIn('10.77.0.2 oifname',firewall(state,'temperance','eth0',expired=True))
        self.assertNotIn('PrivateKey',wg_config(state))
        with self.assertRaises(ValueError):firewall(state,'bad;command','eth0')
        state['profiles'][0]['paused']=True
        self.assertNotIn('10.77.0.2 oifname',firewall(state,'temperance','eth0'))

class ControlAPITests(unittest.TestCase):
    def setUp(self):
        self.server=ThreadingHTTPServer(('127.0.0.1',0),ControlHandler)
        self.server.store=ControlStore(':memory:','UTC','192.0.2.1:51820',PUBLIC)
        self.server.admin_token='a'*32;self.server.gateway_token='g'*32
        self.server.public_url=f'http://127.0.0.1:{self.server.server_port}'
        threading.Thread(target=self.server.serve_forever,daemon=True).start()
    def tearDown(self):self.server.shutdown();self.server.server_close();self.server.store.db.close()
    def req(self,path,body=None,token=None,origin=None,cookie=None):
        conn=HTTPConnection('127.0.0.1',self.server.server_port,timeout=2)
        headers={'Content-Type':'application/json'}
        if token:headers['Authorization']='Bearer '+token
        if origin:headers['Origin']=origin
        if cookie:headers['Cookie']=cookie
        conn.request('GET' if body is None else 'POST',path,json.dumps(body) if body is not None else None,headers)
        res=conn.getresponse();data=res.read();result=(res.status,data,res.getheader('Set-Cookie'));conn.close();return result
    def test_roles_and_cookie_csrf(self):
        self.assertEqual(self.req('/api/state')[0],401)
        self.assertEqual(self.req('/v1/gateway/state',token='a'*32)[0],401)
        self.assertEqual(self.req('/v1/gateway/state',token='g'*32)[0],200)
        self.assertEqual(self.req('/v1/device/state',token='g'*32)[0],401)
        status,_,cookie=self.req('/v1/login',{'token':'a'*32},origin=self.server.public_url)
        self.assertEqual(status,200);self.assertIn('HttpOnly',cookie)
        self.assertEqual(self.req('/api/profiles',{'name':'A'},cookie=cookie)[0],403)
        self.assertEqual(self.req('/api/profiles',{'name':'A'},cookie=cookie,origin=self.server.public_url)[0],200)
        self.assertEqual(self.req('/api/profiles',{'name':'A'},token='g'*32)[0],401)
    def test_enrollment_http_flow(self):
        pid=json.loads(self.req('/api/profiles',{'name':'A'},token='a'*32)[1])['profiles'][0]['id']
        code=json.loads(self.req('/api/enrollment',{'profile_id':pid},token='a'*32)[1])['code']
        result=json.loads(self.req('/v1/enroll',{'code':code,'public_key':DEVICE,'name':'Phone'})[1])
        self.assertEqual(self.req('/v1/device/state',token=result['token'])[0],200)
        self.assertEqual(self.req('/api/state',token=result['token'])[0],401)
