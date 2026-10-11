import json
import tempfile
import time
import unittest
from pathlib import Path
from temperance.policy import access_reason,domain_reason
from temperance.policy_cache import PolicyCache
from temperance.gateway import firewall
from temperance.gateway_store import GatewayStore
class PolicyV2Tests(unittest.TestCase):
    def profile(self,**values):return {'id':1,'name':'Test','managed':True,'paused':False,'filter_level':'kid','limit':0,'used':0,'allow':[],'deny':[],'unmanaged':[],'categories':[],'schedules':[],'bedtime':{'start':'','end':'','days':list(range(7))},**values}
    def state(self,p):return {'policy_schema':2,'version':1,'day':'2026-10-11','timezone':'America/Chicago','paused':False,'profiles':[p],'peers':[{'id':'device','ip':'10.77.0.2','profile_id':1,'public_key':'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=','managed':True,'paused':False}],'offline_grace_seconds':86400}
    def test_unmanaged_bypasses_household_pause_without_recording(self):
        p=self.profile(paused=True,unmanaged=['school.test']);store=GatewayStore();store.state=self.state(p);store.state['paused']=True
        self.assertEqual(store.evaluate('10.77.0.2','school.test'),(False,'unmanaged'));self.assertEqual(store.history,[])
        self.assertEqual(store.evaluate('10.77.0.2','other.test')[0],True)
    def test_packet_exceptions_and_strict_focus(self):
        p=self.profile(paused=True,unmanaged=['school.test']);state=self.state(p)
        destination={'ip':'10.77.0.2','address':'203.0.113.2','host':'school.test','expires':time.time()+60}
        script=firewall(state,'temperance','wan-test',destinations=[destination])
        self.assertIn('ip saddr 10.77.0.2 ip daddr 203.0.113.2 accept',script)
        self.assertNotIn('ip saddr 10.77.0.2 oifname',script)
        self.assertNotIn('ip saddr 10.77.0.2 ip daddr 203.0.113.2 accept',firewall(state,'temperance','wan-test',expired=True,destinations=[destination]))
        p['paused']=False;p['allow_only']=True;p['allow']=['school.test'];p['unmanaged']=[]
        script=firewall(state,'temperance','wan-test',destinations=[destination])
        self.assertIn('ip saddr 10.77.0.2 ip daddr 203.0.113.2 counter',script)
        self.assertNotIn('ip saddr 10.77.0.2 oifname',script)
    def test_category_budget_closes_known_existing_destination(self):
        p=self.profile(category_limits={'video':1},bucket_usage={'category:video':1})
        destination={'ip':'10.77.0.2','address':'203.0.113.2','host':'youtube.com','expires':time.time()+60}
        script=firewall(self.state(p),'temperance','wan-test',destinations=[destination]);self.assertIn('ip saddr 10.77.0.2 ip daddr 203.0.113.2 drop',script)
    def test_private_cache_survives_restart_and_fails_after_grace(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'policy.json';cache=PolicyCache(path,'https://policy.test');state=self.state(self.profile(limit=2));cache.update(state,now=1000)
            self.assertEqual(path.stat().st_mode&0o777,0o600)
            restored=PolicyCache(path,'https://policy.test');self.assertTrue(restored.usable(2000));self.assertFalse(restored.usable(1000+86401))
            with self.assertRaises(ValueError):PolicyCache(path,'https://different.test')
            with self.assertRaises(ValueError):restored.update({**state,'version':0})
    def test_offline_accounting_is_deduplicated_and_midnight_resets(self):
        with tempfile.TemporaryDirectory() as directory:
            cache=PolicyCache(Path(directory)/'policy.json','https://policy.test');p=self.profile(limit=2,used=1)
            state=self.state(p);cache.update(state)
            now=time.time();state['day']=__import__('temperance.policy',fromlist=['local']).local(now,state['timezone'])[0]
            entry={'device_id':'device','minute':int(now//60),'buckets':['total','category:video']}
            cache.record([entry,entry]);self.assertEqual(len(cache.pending),1);self.assertEqual(cache.effective(now)['profiles'][0]['used'],2)
            self.assertEqual(cache.effective(now+86400)['profiles'][0]['used'],0)
            batch=cache.batch();cache.acknowledge(batch);self.assertEqual(cache.pending,[])

class SharedPolicyContractTests(unittest.TestCase):
    def test_shared_cases(self):
        from datetime import datetime
        cases=json.loads((Path(__file__).parents[1]/'specs/policy-cases.json').read_text())
        for case in cases:
            with self.subTest(case['name']):
                p={'id':1,'name':'A','filter_level':'adult',**case['profile']}
                at=datetime.fromisoformat(case['at'].replace('Z','+00:00')).timestamp()
                if case['kind']=='domain':result=domain_reason(p,case['host'],case['zone'],at,case.get('household_paused',False))
                else:result=access_reason(p,case['zone'],at,case.get('household_paused',False))
                self.assertEqual(result,case['expected'])

class DNSRestrictionTests(unittest.TestCase):
    def test_safe_search_and_video_restricted_aliases(self):
        from temperance.dns import Resolver
        from test_gateway import query
        p=PolicyV2Tests().profile(safe_search=True,youtube_restricted=True)
        store=GatewayStore();store.state=PolicyV2Tests().state(p)
        resolver=Resolver(store,networks=['10.77.0.0/24'])
        reply=resolver.resolve(query('www.google.com'),'10.77.0.2')
        self.assertIn(b'forcesafesearch',reply)
        self.assertEqual(reply[3]&15,0)
        self.assertEqual(store.dns_override('10.77.0.2','www.google.com',1),'forcesafesearch.google.com')
        self.assertEqual(store.dns_override('10.77.0.2','www.bing.com',1),'strict.bing.com')
        self.assertEqual(store.dns_override('10.77.0.2','www.youtube.com',1),'restrict.youtube.com')
        p['filter_level']='none';self.assertIsNone(store.dns_override('10.77.0.2','www.youtube.com',1))
