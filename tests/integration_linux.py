"""Run ONLY in a disposable privileged Linux container/VM, never on a workstation.
Creates three isolated network namespaces and real WireGuard interfaces.
"""
import base64
import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from temperance.control import ControlStore
from temperance.gateway import firewall,apply_firewall,wg_config,sync_peers
from temperance.dns import Resolver,UDPHandler,UDPServer
from temperance.gateway_store import GatewayStore

assert os.environ.get('TEMPERANCE_DISPOSABLE_TEST')=='1', 'Use a disposable test container'
def run(*args,body=None):
    result=subprocess.run(args,input=body,text=True,capture_output=True)
    if result.returncode:raise RuntimeError(f'{args}: {result.stderr}')
    return result.stdout.strip()
def ns(name,*args,body=None):return run('ip','netns','exec',name,*args,body=body)
def probe():
    return subprocess.run(['ip','netns','exec','t-client','curl','--silent','--fail','--max-time','2','http://203.0.113.2:8080'],capture_output=True).returncode==0
server_private=run('wg','genkey');server_public=run('wg','pubkey',body=server_private)
client_private=run('wg','genkey');client_public=run('wg','pubkey',body=client_private)
store=ControlStore(':memory:','UTC','192.0.2.1:51820',server_public)
pid=store.save_profile({'name':'Test','deny':['blocked.test']})
code=store.issue_code(pid)['code'];device=store.enroll({'name':'Test device','code':code,'public_key':client_public})
state=store.gateway_state()
http=None;dns=None
try:
    for name in ('t-client','t-internet'):run('ip','netns','add',name);ns(name,'ip','link','set','lo','up')
    for host,peer,namespace,hostip,peerip in [('transport','transport-c','t-client','192.0.2.1/24','192.0.2.2/24'),('wan-test','wan-peer','t-internet','203.0.113.1/24','203.0.113.2/24')]:
        run('ip','link','add',host,'type','veth','peer','name',peer)
        run('ip','link','set',peer,'netns',namespace)
        run('ip','addr','add',hostip,'dev',host);run('ip','link','set',host,'up')
        ns(namespace,'ip','addr','add',peerip,'dev',peer);ns(namespace,'ip','link','set',peer,'up')
    run('sysctl','-w','net.ipv4.ip_forward=1')
    run('ip','link','add','temperance','type','wireguard')
    run('wg','set','temperance','private-key','/dev/stdin','listen-port','51820',body=server_private)
    run('ip','addr','add','10.77.0.1/24','dev','temperance');run('ip','link','set','temperance','up')
    sync_peers('temperance',state)
    assert run('wg','show','temperance','public-key')==server_public,'syncconf cleared server identity'
    ns('t-client','ip','link','add','wg-client','type','wireguard')
    ns('t-client','wg','set','wg-client','private-key','/dev/stdin','peer',server_public,'allowed-ips','0.0.0.0/0','endpoint','192.0.2.1:51820','persistent-keepalive','25',body=client_private)
    ns('t-client','ip','addr','add','10.77.0.2/32','dev','wg-client');ns('t-client','ip','link','set','wg-client','up')
    ns('t-client','ip','route','add','203.0.113.0/24','dev','wg-client')
    ns('t-client','ip','route','add','10.77.0.0/24','dev','wg-client')
    http=subprocess.Popen(['ip','netns','exec','t-internet','python3','-m','http.server','8080','--bind','203.0.113.2'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    dns=UDPServer(('10.77.0.1',53),UDPHandler);dns.resolver=Resolver(store,networks=['10.77.0.0/24'])
    threading.Thread(target=dns.serve_forever,daemon=True).start()
    script=firewall(state,'temperance','wan-test')
    run('nft','--check','-f','-',body=script);apply_firewall(script)
    time.sleep(.5)
    assert probe(),'allowed encrypted traffic failed'
    print('PASS: real WireGuard tunnel forwards allowed traffic',flush=True)
    # Send a DNS query to an alternate resolver; the gateway must redirect it.
    code="import socket,struct;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(2);s.sendto(struct.pack('!6H',1,256,1,0,0,0)+b'\\x07blocked\\x04test\\0\\0\\1\\0\\1',('203.0.113.2',53));assert s.recv(4096)[3]&15==3"
    ns('t-client','python3','-c',code)
    print('PASS: alternate DNS is redirected and domain rules enforced',flush=True)
    store.save_profile({'id':pid,'name':'Test','paused':True});state=store.gateway_state();apply_firewall(firewall(state,'temperance','wan-test'))
    assert not probe(),'pause leaked forwarded traffic'
    store.save_profile({'id':pid,'name':'Test'});state=store.gateway_state();apply_firewall(firewall(state,'temperance','wan-test'))
    assert probe(),'resume did not restore traffic'
    print('PASS: pause and resume enforce both traffic directions',flush=True)
    # Upgrade the same encrypted peer to the richer policy protocol and exercise real packet rules.
    p=dict(state['profiles'][0],filter_level='adult',managed=True,paused=True,unmanaged=['school.test'],allow=[],deny=[],categories=[],schedules=[],category_limits={},site_limits={},rewards=[])
    enhanced={**state,'policy_schema':2,'profiles':[p],'paused':False}
    destinations=[{'ip':'10.77.0.2','address':'203.0.113.2','host':'school.test','expires':time.time()+120}]
    apply_firewall(firewall(enhanced,'temperance','wan-test',destinations=destinations))
    assert probe(),'unmanaged exception did not bypass pause'
    print('PASS: unmanaged site exception bypasses profile pause',flush=True)
    p['paused']=False;p['unmanaged']=[];p['allow_only']=True;p['allow']=['school.test']
    apply_firewall(firewall(enhanced,'temperance','wan-test',destinations=destinations))
    assert probe(),'strict allow-list blocked its known allowed destination'
    apply_firewall(firewall(enhanced,'temperance','wan-test'))
    assert not probe(),'strict allow-list leaked unknown destinations'
    print('PASS: strict allow-list denies unknown IP destinations',flush=True)
    p['allow_only']=False;p['category_limits']={'video':1};p['bucket_usage']={'category:video':1}
    destinations[0]['host']='youtube.com'
    apply_firewall(firewall(enhanced,'temperance','wan-test',destinations=destinations))
    assert not probe(),'category quota leaked an existing destination'
    p['bucket_usage']={'category:video':0}
    apply_firewall(firewall(enhanced,'temperance','wan-test',destinations=destinations))
    assert probe(),'category budget restore did not allow traffic'
    print('PASS: category budget enforcement and attributed counters',flush=True)
    apply_firewall(firewall(state,'temperance','wan-test'))
    time.sleep(16)
    assert not probe(),'expired access lease leaked traffic'
    print('PASS: expired enforcement lease fails closed',flush=True)
    apply_firewall(firewall(state,'temperance','wan-test'))
    store.delete_device('10.77.0.2');state=store.gateway_state()
    sync_peers('temperance',state)
    assert not probe(),'revoked peer could still pass traffic'
    print('PASS: revocation removes tunnel peer',flush=True)
    # A home device that cannot run the VPN app, routed by this gateway on the LAN.
    run('ip','netns','add','t-home');ns('t-home','ip','link','set','lo','up')
    run('ip','link','add','lan-test','type','veth','peer','name','lan-peer');run('ip','link','set','lan-peer','netns','t-home')
    run('ip','addr','add','192.168.50.1/24','dev','lan-test');run('ip','link','set','lan-test','up')
    ns('t-home','ip','addr','add','192.168.50.2/24','dev','lan-peer');ns('t-home','ip','addr','add','192.168.50.3/24','dev','lan-peer')
    ns('t-home','ip','link','set','lan-peer','up');ns('t-home','ip','route','add','default','via','192.168.50.1')
    # Unregistered devices are not masqueraded by Temperance; stand in for the router's own NAT.
    ns('t-internet','ip','route','add','192.168.50.0/24','via','203.0.113.1')
    def home_probe(source='192.168.50.2'):
        return subprocess.run(['ip','netns','exec','t-home','curl','--silent','--fail','--max-time','2','--interface',source,'http://203.0.113.2:8080'],capture_output=True).returncode==0
    tv={'id':'tv','ip':'192.168.50.2','profile_id':p['id'],'managed':True,'paused':False}
    p.update(category_limits={},bucket_usage={},deny=['blocked.test'])
    home_state={**enhanced,'peers':[],'lan_devices':[tv]}
    lan=('lan-test','192.168.50.1')
    home_store=GatewayStore(lan_networks=['192.168.50.0/24']);home_store.state=home_state
    lan_dns=UDPServer(('192.168.50.1',53),UDPHandler);lan_dns.resolver=Resolver(home_store,networks=['192.168.50.0/24'])
    threading.Thread(target=lan_dns.serve_forever,daemon=True).start()
    script=firewall(home_state,'temperance','wan-test',lan=lan)
    run('nft','--check','-f','-',body=script);apply_firewall(script)
    assert home_probe(),'allowed home device was not routed'
    code="import socket,struct;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind(('192.168.50.2',0));s.settimeout(2);s.sendto(struct.pack('!6H',1,256,1,0,0,0)+b'\\x07blocked\\x04test\\0\\0\\1\\0\\1',('203.0.113.2',53));assert s.recv(4096)[3]&15==3"
    ns('t-home','python3','-c',code)
    print('PASS: home device is routed, its DNS redirected and filtered',flush=True)
    tv['paused']=True;apply_firewall(firewall(home_state,'temperance','wan-test',lan=lan))
    assert not home_probe(),'paused home device leaked traffic'
    assert home_probe('192.168.50.3'),'unregistered LAN device was blocked'
    print('PASS: pausing a home device stops it; other LAN devices are untouched',flush=True)
    tv['paused']=False;apply_firewall(firewall(home_state,'temperance','wan-test',lan=lan))
    assert home_probe(),'home device resume failed'
    lan_dns.shutdown();lan_dns.server_close()
finally:
    if http:http.terminate();http.wait()
    if dns:dns.shutdown();dns.server_close()
    for name in ('t-client','t-internet','t-home'):subprocess.run(['ip','netns','delete',name],capture_output=True)
    for name in ('transport','wan-test','temperance','lan-test'):subprocess.run(['ip','link','delete',name],capture_output=True)
