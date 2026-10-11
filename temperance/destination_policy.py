"""Turn DNS-observed destinations into per-device packet rules and counters."""
import hashlib
import ipaddress
import time
from .policy import classify, domain_reason, group_scopes, matches

TUNNEL=ipaddress.ip_network('10.77.0.0/24')


def counter_name(ip):
    """nftables counter for a client's total traffic; tunnel and home-network names never collide."""
    address=ipaddress.IPv4Address(ip)
    return f'peer_{int(address)&255}' if address in TUNNEL else f'home_{int(address)}'


def destination_rules(state,destinations,expired=False):
    if expired:return {'objects':[],'outbound':[],'inbound':[],'buckets':{}}
    peers={p['ip']:p for p in state['peers']}
    profiles={p['id']:p for p in state['profiles']}
    groups={}
    for entry in destinations:
        if entry['expires']<=time.time() or entry['ip'] not in peers:continue
        address=str(ipaddress.IPv4Address(entry['address']))
        groups.setdefault((entry['ip'],address),[]).append(entry['host'])
    objects,outbound,inbound,buckets=[],[],[],{}
    for (ip,address),hosts in sorted(groups.items()):
        peer=peers[ip];p=profiles[peer['profile_id']]
        if not peer.get('managed',True) or not p.get('managed',True):continue
        reasons=[domain_reason(p,host,state['timezone'],household_paused=state.get('paused',False),extra=state.get('extra_domains')) for host in hosts]
        if 'unmanaged' in reasons:
            outbound.append(f'  ip saddr {ip} ip daddr {address} accept')
            inbound.append(f'  ip daddr {ip} ip saddr {address} ct state established,related accept')
            continue
        blocked=peer.get('paused',False) or any(r!='allowed' for r in reasons)
        if blocked:
            outbound.append(f'  ip saddr {ip} ip daddr {address} drop')
            inbound.append(f'  ip daddr {ip} ip saddr {address} drop')
            continue
        if p.get('filter_level')=='none':
            outbound.append(f'  ip saddr {ip} ip daddr {address} accept')
            inbound.append(f'  ip daddr {ip} ip saddr {address} ct state established,related accept')
            continue
        scopes={'category:'+classify(host,state.get('extra_domains')) for host in hosts}
        for host in hosts:
            # Include individual tracked host and any configured site/app budget parent.
            scopes.add('site:'+host)
            scopes.update('site:'+site for site in p.get('site_limits',{}) if matches(host,site))
            scopes.update(group_scopes(p,host))
        total=counter_name(ip)
        counters=[]
        for scope in sorted(scopes):
            name='bucket_'+total.split('_',1)[1]+'_'+hashlib.sha256(scope.encode()).hexdigest()[:12]
            if name not in buckets:
                objects.append(f' counter {name} {{ }}')
                buckets[name]={'device_id':peer['id'],'bucket':scope}
            counters.append(f'counter name "{name}"')
        action=f'counter name "{total}" '+' '.join(counters)+' accept'
        outbound.append(f'  ip saddr {ip} ip daddr {address} {action}')
        inbound.append(f'  ip daddr {ip} ip saddr {address} ct state established,related {action}')
    return dict(objects=objects,outbound=outbound,inbound=inbound,buckets=buckets)
