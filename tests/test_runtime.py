"""Entry points and host-integration code exercised with mocked OS boundaries."""
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

from temperance import control, gateway, server
from temperance.gateway_store import GatewayStore, addresses
from temperance.store import Store

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

    def test_activity_reads_counters(self):
        st = state(peers=state()['peers'] + [{'id': 'idle', 'ip': '10.77.0.3', 'profile_id': 1, 'public_key': KEY}])
        counters = {'nftables': [
            {'counter': {'name': 'peer_2', 'bytes': 10}},
            {'counter': {'name': 'peer_3', 'bytes': 0}},
            {'table': {'name': 'temperance'}},
        ]}
        with mock.patch('subprocess.run', return_value=Completed(json.dumps(counters))):
            self.assertEqual(gateway.activity('temperance', st), ['dev'])

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

    def test_import_state_for_legacy_and_v2_stores(self):
        legacy = {'timezone': 'UTC', 'profiles': [{'id': 1, 'name': 'Old', 'limit': 5}],
                  'peers': [{'ip': '10.77.0.2', 'id': 'dev', 'profile_id': 1}]}
        store = Store(':memory:')
        gateway.import_state(store, legacy)
        self.assertEqual(store.db.execute('SELECT COUNT(*) FROM devices').fetchone()[0], 1)
        v2 = GatewayStore()
        gateway.import_state(v2, state())
        self.assertEqual(v2.state['policy_schema'], 2)

    def test_legacy_network_blocking(self):
        p = {'paused': False, 'limit': 0, 'used': 0, 'bedtime': {'start': '21:00', 'end': '07:00'}}
        night = 1760241600  # 2025-10-12 04:00 UTC
        self.assertTrue(gateway.network_blocked(p, 'UTC', night))
        self.assertFalse(gateway.network_blocked({**p, 'bedtime': {'start': '', 'end': ''}}, 'UTC', night))
        self.assertTrue(gateway.network_blocked({**p, 'limit': 1, 'used': 1, 'bedtime': {'start': '', 'end': ''}}, 'UTC'))
        legacy = {'timezone': 'UTC', 'profiles': [{'id': 1, **p, 'bedtime': {'start': '', 'end': ''}}], 'peers': []}
        self.assertTrue(gateway.peer_allowed(legacy, {'profile_id': 1}))
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
        with mock.patch.object(sys, 'argv', self.argv()), mock.patch.dict('os.environ', {'TEMPERANCE_GATEWAY_TOKEN': TOKEN}), \
                mock.patch('temperance.gateway.call', fake_call), mock.patch('os.name', 'posix'), \
                mock.patch('os.uname', return_value=uname), mock.patch('os.geteuid', return_value=0), \
                mock.patch('temperance.gateway.apply_firewall', applied.append), \
                mock.patch('temperance.gateway.sync_peers'), mock.patch('temperance.gateway.UDPServer', FakeServer), \
                mock.patch('temperance.gateway.TCPServer', FakeServer), \
                mock.patch('temperance.gateway.detailed_activity', return_value=[]), \
                mock.patch('temperance.gateway.activity', return_value=['dev']), \
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


def free_port():
    import socket
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class ServerMainTests(unittest.TestCase):
    def run_main(self, *args):
        with mock.patch.object(sys, 'argv', ['temperance', *args]), redirect_stdout(io.StringIO()) as out, \
                mock.patch('sys.stderr', io.StringIO()) as err:
            try:
                server.main()
            except SystemExit as exc:
                return exc.code, out.getvalue() + err.getvalue()
        return 0, out.getvalue()

    def test_dns_server_starts_and_shuts_down(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp) / 'nested' / 'db.sqlite3'
            import threading
            ticks = iter([False, True])

            class HourlyEvent(threading.Event):
                def wait(self, timeout=None):
                    return next(ticks) if timeout == 3600 else super().wait(timeout)
            with mock.patch('threading.Event', HourlyEvent), mock.patch('signal.signal'):
                code, out = self.run_main('--data', str(data), '--http-port', str(free_port()), '--dns-port', str(free_port()))
            self.assertEqual(code, 0)
            self.assertIn('Temperance dashboard', out)
            self.assertEqual(data.stat().st_mode & 0o777, 0o600)

    def test_argument_validation(self):
        for args in (['--upstream', 'not-an-ip'], ['--dns-host', '0.0.0.0'], ['--allow-network', '::/0'],
                     ['--http-port', '70000'], ['--upstream', '127.0.0.1', '--dns-port', '53', '--upstream-port', '53']):
            with self.subTest(args):
                self.assertEqual(self.run_main(*args)[0], 2)

    def test_port_conflict_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch('temperance.server.UDPServer', side_effect=OSError('in use')):
            code, out = self.run_main('--data', str(Path(tmp) / 'db.sqlite3'), '--http-port', str(free_port()))
        self.assertEqual(code, 1)
        self.assertIn('Could not start Temperance', out)


class ControlMainTests(unittest.TestCase):
    def test_policy_service_main(self):
        env = {'TEMPERANCE_ADMIN_TOKEN': 'a' * 40, 'TEMPERANCE_GATEWAY_TOKEN': 'g' * 40}
        with tempfile.TemporaryDirectory() as tmp:
            argv = ['c', '--port', '0', '--data', str(Path(tmp) / 'c.sqlite3'), '--vpn-endpoint', '192.0.2.1:51820', '--vpn-public-key', KEY]
            with mock.patch.object(sys, 'argv', argv), mock.patch.dict('os.environ', env), \
                    mock.patch('temperance.control.ThreadingHTTPServer.serve_forever', side_effect=KeyboardInterrupt), \
                    redirect_stdout(io.StringIO()) as out:
                control.main()
            self.assertIn('Policy service', out.getvalue())
            for bad_env, bad_args in (({**env, 'TEMPERANCE_ADMIN_TOKEN': 'short'}, []),
                                      ({**env, 'TEMPERANCE_GATEWAY_TOKEN': 'a' * 40}, []),
                                      (env, ['--public-url', 'http://example.com'])):
                with mock.patch.object(sys, 'argv', argv + bad_args), mock.patch.dict('os.environ', bad_env), \
                        mock.patch('sys.stderr', io.StringIO()), self.assertRaises(SystemExit):
                    control.main()


if __name__ == '__main__':
    unittest.main()
