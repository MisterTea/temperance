"""Entry points and host-integration code exercised with mocked OS boundaries."""
import base64
import io
import json
import struct
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from temperance import gateway
from temperance.gateway_store import GatewayStore, addresses

KEY = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='
TOKEN = 't' * 40


def profile(**values):
    return {'id': 1, 'name': 'Kid', 'managed': True, 'paused': False, 'filter_level': 'kid', 'limit': 0, 'used': 0,
            'allow': [], 'deny': [], 'unmanaged': [], 'categories': [], 'schedules': [],
            'bedtime': {'start': '', 'end': '', 'days': list(range(7))}, **values}


def state(**values):
    return {'policy_schema': 2, 'version': 1, 'day': '2026-10-11', 'timezone': 'America/Chicago', 'paused': False,
            'profiles': [profile()], 'offline_grace_seconds': 86400,
            'peers': [{'id': 'dev', 'ip': '10.77.0.2', 'profile_id': 1, 'public_key': KEY, 'managed': True, 'paused': False}],
            **values}


def dns_reply(host, address, ttl=120):
    name = b''.join(bytes([len(p)]) + p.encode() for p in host.split('.')) + b'\0'
    header = struct.pack('!6H', 1, 0x8180, 1, 1, 0, 0)
    answer = b'\xc0\x0c' + struct.pack('!HHIH', 1, 1, ttl, 4) + bytes(int(n) for n in address.split('.'))
    return header + name + b'\0\x01\0\x01' + answer


class Completed:
    def __init__(self, stdout='', returncode=0):
        self.stdout, self.returncode = stdout, returncode


class HostCommandTests(unittest.TestCase):
    def test_run_and_peer_sync_preserve_interface_keys(self):
        calls = []

        def fake(cmd, **kwargs):
            calls.append((cmd, kwargs.get('input')))
            return Completed('[Interface]\nPrivateKey = secret\nListenPort = 51820\n\n[Peer]\nPublicKey = old\n')
        with mock.patch('subprocess.run', fake):
            gateway.sync_peers('temperance', state())
        self.assertEqual(calls[0][0], ['wg', 'showconf', 'temperance'])
        self.assertEqual(calls[1][0], ['wg', 'syncconf', 'temperance', '/dev/stdin'])
        self.assertIn('ListenPort = 51820', calls[1][1])
        self.assertIn(f'PublicKey = {KEY}', calls[1][1])
        self.assertNotIn('PublicKey = old', calls[1][1])

    def test_apply_firewall_replaces_only_existing_temperance_tables(self):
        scripts = []

        def fake(cmd, **kwargs):
            if cmd[:2] == ['nft', 'list']:
                return Completed(returncode=0 if cmd[4] == 'temperance' else 1)
            scripts.append(kwargs.get('input'))
            return Completed()
        with mock.patch('subprocess.run', fake):
            gateway.apply_firewall('table inet temperance {}\n')
        self.assertTrue(scripts[0].startswith('delete table inet temperance\n'))
        self.assertNotIn('temperance_nat', scripts[0].split('\n')[0])

    def test_detailed_activity_attributes_destination_buckets(self):
        p = profile(category_limits={'video': 30})
        st = state(profiles=[p])
        destination = {'ip': '10.77.0.2', 'address': '203.0.113.9', 'host': 'youtube.com', 'expires': time.time() + 60}
        from temperance.destination_policy import destination_rules
        bucket_counter = next(iter(destination_rules(st, [destination])['buckets']))
        counters = {'nftables': [
            {'counter': {'name': 'peer_2', 'bytes': 5}},
            {'counter': {'name': bucket_counter, 'bytes': 5}},
            {'counter': {'name': 'peer_9', 'bytes': 5}},
            {'counter': {'name': 'other', 'bytes': 0}},
        ]}
        with mock.patch('subprocess.run', return_value=Completed(json.dumps(counters))):
            result = gateway.detailed_activity(st, [destination])
        self.assertEqual(result[0]['device_id'], 'dev')
        self.assertIn('total', result[0]['buckets'])
        self.assertIn('category:video', result[0]['buckets'])

    def test_call_sends_bearer_json(self):
        seen = {}

        class Response(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *a): return False

        def fake(req, timeout):
            seen['auth'] = req.headers['Authorization']
            seen['body'] = req.data
            return Response(b'{"ok": true}')
        with mock.patch('temperance.gateway.urlopen', fake):
            self.assertEqual(gateway.call('https://svc/v1/x', TOKEN, {'a': 1}), {'ok': True})
        self.assertEqual(seen['auth'], 'Bearer ' + TOKEN)
        self.assertEqual(json.loads(seen['body']), {'a': 1})

    def test_import_state_and_policy_format(self):
        store = GatewayStore()
        gateway.import_state(store, state())
        self.assertEqual(store.state['policy_schema'], 2)
        with mock.patch('temperance.gateway.call', return_value=state()):
            self.assertEqual(gateway.fetch_state('https://svc/', TOKEN)['version'], 1)
        with mock.patch('temperance.gateway.call', return_value={'timezone': 'UTC', 'profiles': [], 'peers': []}), \
                self.assertRaisesRegex(ValueError, 'Unsupported policy format'):
            gateway.fetch_state('https://svc', TOKEN)

    def test_keys_and_interface_names_are_validated(self):
        self.assertEqual(gateway.key(KEY), KEY)
        for bad in ('not base64!', base64.b64encode(bytes(32)).decode(), base64.b64encode(b'short').decode(), None):
            with self.subTest(bad), self.assertRaises(ValueError):
                gateway.key(bad)
        with self.assertRaises(ValueError):
            gateway.firewall(state(), 'bad name!', 'wan')
        with self.assertRaises(ValueError):
            gateway.firewall(state(peers=[{**state()['peers'][0], 'ip': '10.78.0.2'}]), 'tun', 'wan')


class GatewayMainTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = str(Path(self.tmp.name) / 'policy.json')

    def tearDown(self):
        self.tmp.cleanup()

    def argv(self, *extra):
        return ['temperance-gateway', '--service', 'https://policy.test', '--uplink', 'eth0', '--cache', self.cache, *extra]

    def test_dry_run_prints_rules_and_peers(self):
        out = io.StringIO()
        with mock.patch.object(sys, 'argv', self.argv('--dry-run')), mock.patch.dict('os.environ', {'TEMPERANCE_GATEWAY_TOKEN': TOKEN}), \
                mock.patch('temperance.gateway.call', return_value=state()), redirect_stdout(out):
            gateway.main()
        self.assertIn('table inet temperance', out.getvalue())
        self.assertIn('[Peer]', out.getvalue())

    def test_rejects_missing_token_plain_http_and_non_root(self):
        with mock.patch.object(sys, 'argv', self.argv()), mock.patch.dict('os.environ', {'TEMPERANCE_GATEWAY_TOKEN': ''}), \
                redirect_stdout(io.StringIO()), mock.patch('sys.stderr', io.StringIO()), self.assertRaises(SystemExit):
            gateway.main()
        argv = ['g', '--service', 'http://policy.test', '--uplink', 'eth0', '--cache', self.cache]
        with mock.patch.object(sys, 'argv', argv), mock.patch.dict('os.environ', {'TEMPERANCE_GATEWAY_TOKEN': TOKEN}), \
                mock.patch('sys.stderr', io.StringIO()), self.assertRaises(SystemExit):
            gateway.main()
        with mock.patch.object(sys, 'argv', self.argv()), mock.patch.dict('os.environ', {'TEMPERANCE_GATEWAY_TOKEN': TOKEN}), \
                mock.patch('temperance.gateway.call', return_value=state()), mock.patch('os.geteuid', return_value=1000), \
                mock.patch('sys.stderr', io.StringIO()), self.assertRaises(SystemExit):
            gateway.main()

    def test_outage_without_cache_fails_but_cached_policy_is_used(self):
        env = {'TEMPERANCE_GATEWAY_TOKEN': TOKEN}
        with mock.patch.object(sys, 'argv', self.argv('--dry-run')), mock.patch.dict('os.environ', env), \
                mock.patch('temperance.gateway.call', side_effect=OSError('down')), self.assertRaises(OSError):
            gateway.main()
        from temperance.policy_cache import PolicyCache
        PolicyCache(self.cache, 'https://policy.test').update(state())
        out = io.StringIO()
        with mock.patch.object(sys, 'argv', self.argv('--dry-run')), mock.patch.dict('os.environ', env), \
                mock.patch('temperance.gateway.call', side_effect=OSError('down')), redirect_stdout(out):
            gateway.main()
        self.assertIn('10.77.0.2', out.getvalue())

    def test_enforcement_loop_syncs_reports_and_falls_back(self):
        responses = [state(), {'ok': True}, state(version=2), OSError('outage')]
        calls = []

        def fake_call(url, token, data=None):
            calls.append((url, data))
            value = responses.pop(0) if responses else state(version=3)
            if isinstance(value, Exception):
                raise value
            return value
        applied = []
        sleeps = iter([None, KeyboardInterrupt()])

        def fake_sleep(_):
            value = next(sleeps)
            if isinstance(value, BaseException):
                raise value

        class FakeServer:
            def __init__(self, *a): self.resolver = None
            def serve_forever(self): pass
            def shutdown(self): pass
            def server_close(self): pass
        uname = mock.Mock(sysname='Linux')
        lan = ('--lan-interface', 'eth1', '--lan-address', '192.168.1.1', '--lan-network', '192.168.1.0/24')
        with mock.patch.object(sys, 'argv', self.argv(*lan)), mock.patch.dict('os.environ', {'TEMPERANCE_GATEWAY_TOKEN': TOKEN}), \
                mock.patch('temperance.gateway.call', fake_call), mock.patch('os.name', 'posix'), \
                mock.patch('os.uname', return_value=uname), mock.patch('os.geteuid', return_value=0), \
                mock.patch('temperance.gateway.apply_firewall', applied.append), \
                mock.patch('temperance.gateway.sync_peers'), mock.patch('temperance.gateway.UDPServer', FakeServer), \
                mock.patch('temperance.gateway.TCPServer', FakeServer), \
                mock.patch('temperance.gateway.detailed_activity', return_value=[]), \
                mock.patch('subprocess.run', return_value=Completed()), mock.patch('time.sleep', fake_sleep), \
                redirect_stdout(io.StringIO()):
            gateway.main()
        self.assertTrue(any(url.endswith('/v1/gateway/activity') for url, _ in calls))
        self.assertGreaterEqual(len(applied), 4)
        self.assertIn('elements = { 10.77.0.2 }', applied[2])


class GatewayStoreTests(unittest.TestCase):
    def test_dns_answers_are_parsed_and_tracked(self):
        packet = dns_reply('youtube.com', '203.0.113.7', ttl=5)
        self.assertEqual(addresses(packet), [('203.0.113.7', 30)])
        self.assertEqual(addresses(b'short'), [])
        self.assertEqual(addresses(packet[:20]), [])
        store = GatewayStore()
        store.observe_dns_reply('10.77.0.2', 'youtube.com', packet)
        self.assertEqual(store.destinations, {})
        store.state = state()
        store.observe_dns_reply('10.77.0.2', 'youtube.com', packet)
        self.assertEqual(list(store.destinations.values())[0]['address'], '203.0.113.7')

    def test_safe_search_and_youtube_overrides(self):
        store = GatewayStore()
        self.assertIsNone(store.dns_override('10.77.0.2', 'google.com', 1))
        store.state = state(profiles=[profile(safe_search=True, youtube_restricted=True)])
        self.assertEqual(store.dns_override('10.77.0.2', 'www.google.com', 1), 'forcesafesearch.google.com')
        self.assertEqual(store.dns_override('10.77.0.2', 'www.bing.com', 1), 'strict.bing.com')
        self.assertEqual(store.dns_override('10.77.0.2', 'duckduckgo.com', 1), 'safe.duckduckgo.com')
        self.assertEqual(store.dns_override('10.77.0.2', 'm.youtube.com', 1), 'restrict.youtube.com')
        self.assertIsNone(store.dns_override('10.77.0.2', 'example.com', 1))
        self.assertIsNone(store.dns_override('10.77.0.9', 'google.com', 1))

    def test_device_pause_and_unassigned_peers(self):
        store = GatewayStore()
        store.state = state(peers=[{**state()['peers'][0], 'paused': True}])
        self.assertEqual(store.evaluate('10.77.0.2', 'example.com'), (True, 'device pause'))
        self.assertEqual(store.evaluate('10.77.0.9', 'example.com'), (True, 'unassigned VPN device'))
        store.state['peers'][0]['managed'] = False
        self.assertEqual(store.evaluate('10.77.0.2', 'example.com'), (False, 'unmanaged'))


HOME_TV = {'id': 'tv', 'ip': '192.168.1.50', 'profile_id': 1, 'managed': True, 'paused': False}
LAN = ('eth1', '192.168.1.1')


class HomeDeviceTests(unittest.TestCase):
    def test_firewall_routes_dns_and_leases_home_devices(self):
        script = gateway.firewall(state(lan_devices=[HOME_TV]), 'temperance', 'eth0', lan=LAN)
        self.assertIn('set home { type ipv4_addr; elements = { 192.168.1.50 }; }', script)
        self.assertIn('set home_lease { type ipv4_addr; flags timeout; timeout 15s; elements = { 192.168.1.50 }; }', script)
        self.assertIn('iifname "eth1" ip saddr @home jump home_outbound', script)
        self.assertIn('ip saddr 192.168.1.50 counter name "home_3232235826" accept', script)
        self.assertIn('iifname "eth1" ip saddr { 192.168.1.50 } udp dport 53 dnat to 192.168.1.1:53', script)
        self.assertIn('ip saddr { 192.168.1.50 } oifname "eth0" masquerade', script)
        self.assertIn('counter peer_2 { }', script)

    def test_paused_expired_and_strict_home_devices_are_not_forwarded(self):
        paused = gateway.firewall(state(lan_devices=[{**HOME_TV, 'paused': True}]), 'temperance', 'eth0', lan=LAN)
        self.assertIn('set home_lease { type ipv4_addr; flags timeout; timeout 15s; }', paused)
        self.assertNotIn('ip saddr 192.168.1.50 counter', paused)
        expired = gateway.firewall(state(lan_devices=[HOME_TV]), 'temperance', 'eth0', lan=LAN, expired=True)
        self.assertNotIn('ip saddr 192.168.1.50 counter', expired)
        strict = state(profiles=[profile(allow_only=True, allow=['school.test'])], lan_devices=[HOME_TV])
        destination = {'ip': '192.168.1.50', 'address': '203.0.113.5', 'host': 'school.test', 'expires': time.time() + 60}
        script = gateway.firewall(strict, 'temperance', 'eth0', lan=LAN, destinations=[destination])
        self.assertIn('ip saddr 192.168.1.50 ip daddr 203.0.113.5 counter name "home_3232235826"', script)
        self.assertNotIn('ip saddr 192.168.1.50 counter name', script)
        unmanaged = gateway.firewall(state(lan_devices=[{**HOME_TV, 'managed': False}]), 'temperance', 'eth0', lan=LAN)
        self.assertIn('ip saddr 192.168.1.50 accept', unmanaged)

    def test_home_rules_validate_addresses_and_are_optional(self):
        self.assertNotIn('home', gateway.firewall(state(lan_devices=[HOME_TV]), 'temperance', 'eth0'))
        self.assertNotIn('@home', gateway.firewall(state(), 'temperance', 'eth0', lan=LAN))
        for bad in ({**HOME_TV, 'ip': '10.77.0.9'}, {**HOME_TV, 'ip': '8.8.8.8'}):
            with self.subTest(bad), self.assertRaises(ValueError):
                gateway.firewall(state(lan_devices=[bad]), 'temperance', 'eth0', lan=LAN)
        with self.assertRaises(ValueError):
            gateway.firewall(state(lan_devices=[HOME_TV]), 'temperance', 'eth0', lan=('bad name!', '192.168.1.1'))

    def test_dns_policy_for_registered_and_unregistered_lan_addresses(self):
        store = GatewayStore(lan_networks=['192.168.1.0/24'])
        store.state = state(profiles=[profile(deny=['blocked.test'], safe_search=True)], lan_devices=[dict(HOME_TV)])
        self.assertEqual(store.evaluate('192.168.1.50', 'blocked.test')[0], True)
        self.assertEqual(store.history[-1]['device_id'], 'tv')
        self.assertEqual(store.dns_override('192.168.1.50', 'google.com', 1), 'forcesafesearch.google.com')
        self.assertEqual(store.evaluate('192.168.1.77', 'blocked.test'), (False, 'unmanaged'))
        self.assertIsNone(store.dns_override('192.168.1.77', 'google.com', 1))
        self.assertEqual(store.evaluate('10.77.0.9', 'example.com'), (True, 'unassigned VPN device'))
        store.state['home_profile_id'] = 1
        history = len(store.history)
        self.assertEqual(store.evaluate('192.168.1.77', 'blocked.test')[0], True)
        self.assertEqual(len(store.history), history, 'unregistered devices have no history owner')
        store.state['lan_devices'][0]['managed'] = False
        self.assertEqual(store.evaluate('192.168.1.50', 'blocked.test'), (False, 'unmanaged'))
        self.assertIsNone(store.dns_override('192.168.1.50', 'google.com', 1))

    def test_activity_attributes_home_counters(self):
        st = state(lan_devices=[HOME_TV])
        counters = {'nftables': [{'counter': {'name': 'home_3232235826', 'bytes': 9}}, {'counter': {'name': 'peer_2', 'bytes': 0}}]}
        with mock.patch('subprocess.run', return_value=Completed(json.dumps(counters))):
            self.assertEqual(gateway.detailed_activity(st, []), [{'device_id': 'tv', 'minute': int(time.time() // 60), 'buckets': ['total']}])

    def test_lan_arguments_are_validated_and_printed(self):
        base = ['temperance-gateway', '--service', 'https://policy.test', '--uplink', 'eth0', '--dry-run']
        env = {'TEMPERANCE_GATEWAY_TOKEN': TOKEN}
        for extra in (['--lan-interface', 'eth1'], ['--lan-interface', 'eth1', '--lan-address', '10.0.0.1', '--lan-network', '192.168.1.0/24'],
                      ['--lan-interface', 'eth1', '--lan-address', 'nope', '--lan-network', '192.168.1.0/24']):
            with self.subTest(extra), mock.patch.object(sys, 'argv', base + extra), mock.patch.dict('os.environ', env), \
                    mock.patch('sys.stderr', io.StringIO()), self.assertRaises(SystemExit):
                gateway.main()
        out = io.StringIO()
        argv = base + ['--lan-interface', 'eth1', '--lan-address', '192.168.1.1', '--lan-network', '192.168.1.0/24']
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(sys, 'argv', argv + ['--cache', tmp + '/p.json']), \
                mock.patch.dict('os.environ', env), mock.patch('temperance.gateway.call', return_value=state(lan_devices=[HOME_TV])), redirect_stdout(out):
            gateway.main()
        self.assertIn('dnat to 192.168.1.1:53', out.getvalue())


if __name__ == '__main__':
    unittest.main()
