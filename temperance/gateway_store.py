"""DNS policy/history and destination attribution for the gateway."""
import ipaddress
import struct
import threading
import time
import uuid
from .policy import domain_reason, classify


def addresses(packet):
    if len(packet)<12:return []
    _,_,questions,answers,_,_=struct.unpack('!6H',packet[:12])
    pos=12
    def skip_name(pos):
        for _ in range(128):
            if pos>=len(packet):raise ValueError('Truncated name')
            length=packet[pos];pos+=1
            if length&0xc0==0xc0:
                if pos>=len(packet):raise ValueError('Truncated pointer')
                return pos+1
            if length==0:return pos
            if length>63 or pos+length>len(packet):raise ValueError('Invalid label')
            pos+=length
        raise ValueError('Invalid name')
    result=[]
    try:
        for _ in range(questions):pos=skip_name(pos)+4
        for _ in range(answers):
            pos=skip_name(pos)
            kind,cls,ttl,length=struct.unpack('!HHIH',packet[pos:pos+10]);pos+=10
            data=packet[pos:pos+length];pos+=length
            if kind==1 and cls==1 and len(data)==4:result.append((str(ipaddress.IPv4Address(data)),min(max(ttl,30),3600)))
    except (ValueError,struct.error):return []
    return result


def clients(state):
    """VPN peers plus home-network devices that are enforced by LAN address."""
    return list(state.get('peers',[]))+list(state.get('lan_devices',[]))


class GatewayStore:
    def __init__(self,lan_networks=()):
        self.lock=threading.RLock()
        self.state=None
        self.destinations={}
        self.history=[]
        self.lan_networks=[ipaddress.ip_network(n) for n in lan_networks]

    def subject(self,ip):
        """Return (client, profile). Unregistered home-network addresses follow the Home profile, if any."""
        client=next((c for c in clients(self.state) if c['ip']==ip),None)
        profiles={p['id']:p for p in self.state['profiles']}
        if client:return client,profiles.get(client['profile_id'])
        if any(ipaddress.ip_address(ip) in n for n in self.lan_networks):
            return None,profiles.get(self.state.get('home_profile_id'))
        return None,None

    def evaluate(self,ip,host,now=None):
        if not self.state:return True,'no policy'
        now=time.time() if now is None else now
        with self.lock:
            client,p=self.subject(ip)
            if not p:
                if not client and self.lan_networks and any(ipaddress.ip_address(ip) in n for n in self.lan_networks):return False,'unmanaged'
                return True,'unassigned VPN device'
            if (client and not client.get('managed',True)) or not p.get('managed',True):reason='unmanaged'
            else:
                reason=domain_reason(p,host,self.state['timezone'],now,self.state.get('paused',False),self.state.get('extra_domains'))
                if client and client.get('paused') and reason!='unmanaged':reason='device pause'
            blocked=reason not in ('allowed','unmanaged')
            if client and reason!='unmanaged' and p.get('filter_level')!='none':
                self.history.append(dict(id=str(uuid.uuid4()),device_id=client['id'],at=now,domain=host,blocked=blocked,reason=reason,category=classify(host,self.state.get('extra_domains'))))
                self.history=self.history[-500:]
            return blocked,reason

    def observe_dns_reply(self,ip,host,packet):
        if not self.state:return
        with self.lock:
            now=time.time()
            self.destinations={k:v for k,v in self.destinations.items() if v['expires']>now}
            for address,ttl in addresses(packet):
                self.destinations[(ip,address,host)]={'ip':ip,'address':address,'host':host,'expires':now+ttl}
            if len(self.destinations)>10000:
                self.destinations=dict(sorted(self.destinations.items(),key=lambda item:item[1]['expires'],reverse=True)[:10000])

    def dns_override(self,ip,host,kind):
        if not self.state:return None
        client,p=self.subject(ip)
        if not p or not p.get('managed',True) or p.get('filter_level')=='none':return None
        if client and not client.get('managed',True):return None
        if p.get('safe_search') and (host=='google.com' or host.startswith('www.google.') or host=='www.bing.com' or host=='duckduckgo.com'):
            return {'www.bing.com':'strict.bing.com','duckduckgo.com':'safe.duckduckgo.com'}.get(host,'forcesafesearch.google.com')
        if p.get('youtube_restricted') and host in ('youtube.com','www.youtube.com','m.youtube.com','youtubei.googleapis.com','youtube.googleapis.com','www.youtube-nocookie.com'):
            return 'restrict.youtube.com'
        return None
