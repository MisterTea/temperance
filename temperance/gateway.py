"""Linux WireGuard reconciler. Only dedicated nftables tables are modified."""
import argparse
import ipaddress
import json
import os
import re
import subprocess
import threading
import time
from urllib.request import Request, urlopen
from urllib.parse import urlparse

from .dns import Resolver, UDPServer, UDPHandler, TCPServer, TCPHandler
from .store import Store
from .control import key


def network_blocked(profile, zone, now=None):
    from datetime import datetime
    from zoneinfo import ZoneInfo
    clock=datetime.fromtimestamp(time.time() if now is None else now,ZoneInfo(zone)).strftime('%H:%M')
    start,end=profile['bedtime']['start'],profile['bedtime']['end']
    return profile['paused'] or (profile['limit']>0 and profile['used']>=profile['limit']) or bool(start and (start<=clock<end if start<end else clock>=start or clock<end))


def firewall(state, interface, uplink, expired=False):
    for name in (interface,uplink):
        if not re.fullmatch(r'[a-zA-Z0-9_.-]{1,15}',name):raise ValueError('Invalid interface name')
    profiles={p['id']:p for p in state['profiles']}
    peers=state['peers']
    live=[str(ipaddress.IPv4Address(p['ip'])) for p in peers if not expired and not network_blocked(profiles[p['profile_id']],state['timezone'])]
    lines=['table inet temperance {',
        ' set lease { type ipv4_addr; flags timeout; timeout 15s;'+(' elements = { '+', '.join(live)+' };' if live else '')+' }']
    for peer in peers:
        lines.append(f' counter peer_{int(ipaddress.IPv4Address(peer["ip"])) & 255} {{ }}')
    lines += [
        ' chain input { type filter hook input priority -10; policy accept;',
        f'  iifname "{interface}" ip daddr 10.77.0.1 udp dport 53 accept',
        f'  iifname "{interface}" ip daddr 10.77.0.1 tcp dport {{ 53, 443 }} accept',
        f'  iifname "{interface}" drop',
        ' }',
        ' chain forward { type filter hook forward priority -10; policy accept;',
        f'  iifname "{interface}" jump outbound',
        f'  oifname "{interface}" jump inbound',
        ' }',
        ' chain outbound {',
        '  meta nfproto ipv6 drop',
        '  ip saddr != @lease drop',
        '  ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4 } drop',
        '  udp dport { 53, 853 } drop',
        '  tcp dport { 53, 853 } drop',
    ]
    for peer in peers:
        ip=str(ipaddress.IPv4Address(peer['ip']))
        if ipaddress.ip_address(ip) not in ipaddress.ip_network('10.77.0.0/24'):raise ValueError('Peer outside tunnel network')
        if not expired and not network_blocked(profiles[peer['profile_id']],state['timezone']):
            lines.append(f'  ip saddr {ip} oifname "{uplink}" counter name "peer_{ip.split(".")[-1]}" accept')
    lines += ['  drop',' }',' chain inbound {','  meta nfproto ipv6 drop','  ip daddr != @lease drop']
    for peer in peers:
        if not expired and not network_blocked(profiles[peer['profile_id']],state['timezone']):
            lines.append(f'  ip daddr {peer["ip"]} iifname "{uplink}" ct state established,related counter name "peer_{peer["ip"].split(".")[-1]}" accept')
    lines+=['  drop',' }']
    lines += ['}', 'table ip temperance_nat {',
              ' chain postrouting { type nat hook postrouting priority srcnat; policy accept;',
              f'  ip saddr 10.77.0.0/24 oifname "{uplink}" masquerade',' }',
              ' chain prerouting { type nat hook prerouting priority dstnat; policy accept;',
              f'  iifname "{interface}" udp dport 53 dnat to 10.77.0.1:53',
              f'  iifname "{interface}" tcp dport 53 dnat to 10.77.0.1:53',' }','}']
    return '\n'.join(lines)+'\n'


def wg_config(state):
    # wg syncconf accepts public peers only; preserve the server's private key/listen port.
    return ''.join(f'[Peer]\nPublicKey = {key(p["public_key"])}\nAllowedIPs = {ipaddress.IPv4Address(p["ip"])}/32\n\n' for p in state['peers'])


def import_state(store,state):
    from zoneinfo import ZoneInfo
    with store.lock,store.db:
        store.zone=ZoneInfo(state['timezone'])
        store.db.execute('DELETE FROM devices')
        store.db.execute('DELETE FROM profiles')
        for p in state['profiles']:
            from .store import validate_profile
            store.db.execute('INSERT INTO profiles VALUES(?,?)',(p['id'],json.dumps(validate_profile(p))))
        for p in state['peers']:
            store.db.execute('INSERT INTO devices VALUES(?,?,?)',(p['ip'],p['id'],p['profile_id']))


def call(url,token,data=None):
    req=Request(url,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},data=json.dumps(data).encode() if data is not None else None)
    with urlopen(req,timeout=10) as response:return json.load(response)


def run(cmd,body=None):
    return subprocess.run(cmd,input=body,text=True,check=True,capture_output=True).stdout


def sync_peers(interface,state):
    # syncconf treats missing Interface keys as cleared. Preserve server key,
    # ListenPort and FwMark from the live interface, without printing them.
    interface_config=run(['wg','showconf',interface]).split('[Peer]',1)[0].strip()
    run(['wg','syncconf',interface,'/dev/stdin'],interface_config+'\n\n'+wg_config(state))


def apply_firewall(script):
    # Delete/recreate in a single nft transaction; never flush other applications' rules.
    prefix=''
    for family,table in [('inet','temperance'),('ip','temperance_nat')]:
        if subprocess.run(['nft','list','table',family,table],capture_output=True).returncode==0:
            prefix+=f'delete table {family} {table}\n'
    run(['nft','-f','-'],prefix+script)


def activity(interface,state):
    counters=json.loads(run(['nft','-j','list','table','inet','temperance']))['nftables']
    active_octets={item['counter']['name'][5:] for item in counters if 'counter' in item and item['counter'].get('name','').startswith('peer_') and item['counter'].get('bytes',0)>0}
    return [p['id'] for p in state['peers'] if p['ip'].split('.')[-1] in active_octets]


def main():
    parser=argparse.ArgumentParser(description='Temperance Linux VPN enforcement agent')
    parser.add_argument('--service',required=True)
    parser.add_argument('--interface',default='temperance')
    parser.add_argument('--uplink',required=True)
    parser.add_argument('--dry-run',action='store_true',help='Print rules without changing host networking')
    args=parser.parse_args()
    token=os.environ.get('TEMPERANCE_GATEWAY_TOKEN','')
    if len(token)<32:parser.error('Set TEMPERANCE_GATEWAY_TOKEN')
    url=urlparse(args.service)
    if url.scheme!='https' and url.hostname not in ('localhost','127.0.0.1'):parser.error('Remote policy service must use HTTPS')
    state=call(args.service.rstrip('/')+'/v1/gateway/state',token)
    script=firewall(state,args.interface,args.uplink)
    if args.dry_run:print(script);print(wg_config(state));return
    if os.name!='posix' or os.uname().sysname!='Linux' or os.geteuid()!=0:parser.error('Gateway enforcement requires root on Linux')
    store=Store(':memory:',state['timezone'])
    import_state(store,state)
    apply_firewall(firewall(state,args.interface,args.uplink,expired=True))
    resolver=Resolver(store,networks=['10.77.0.0/24'])
    servers=[]
    for cls,handler in [(UDPServer,UDPHandler),(TCPServer,TCPHandler)]:
        server=cls(('10.77.0.1',53),handler);server.resolver=resolver;servers.append(server)
        threading.Thread(target=server.serve_forever,daemon=True).start()
    sync_peers(args.interface,state)
    apply_firewall(script)
    subprocess.run(['nft','delete','table','inet','temperance_boot'],capture_output=True)
    last_good=time.monotonic()
    try:
        while True:
            try:
                ids=activity(args.interface,state)
                call(args.service.rstrip('/')+'/v1/gateway/activity',token,{'active_devices':ids})
                latest=call(args.service.rstrip('/')+'/v1/gateway/state',token)
                script=firewall(latest,args.interface,args.uplink)
                import_state(store,latest)
                apply_firewall(script)
                sync_peers(args.interface,latest)
                state=latest;last_good=time.monotonic()
            except Exception as exc:
                print(f'Gateway sync failed ({type(exc).__name__}); retrying',flush=True)
                # Reset counters after reporting to avoid accounting the same traffic twice.
                apply_firewall(firewall(state,args.interface,args.uplink,expired=time.monotonic()-last_good>30))
            time.sleep(5)
    except KeyboardInterrupt:pass
    finally:
        apply_firewall(firewall(state,args.interface,args.uplink,expired=True))
        for server in servers:server.shutdown();server.server_close()


if __name__=='__main__':main()
