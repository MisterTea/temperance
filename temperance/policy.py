"""Version-two policy semantics shared with the Next.js service via golden tests."""
from datetime import datetime
from zoneinfo import ZoneInfo
import time

CATALOG = {
 'social':['facebook.com','instagram.com','tiktok.com','reddit.com','x.com','snapchat.com'],
 'video':['youtube.com','youtu.be','netflix.com','twitch.tv','disneyplus.com','hulu.com'],
 'gaming':['roblox.com','epicgames.com','steampowered.com','minecraft.net'],
 'adult':['pornhub.com','xvideos.com','xhamster.com'],
 'gambling':['bet365.com','draftkings.com','fanduel.com'],
 'education':['khanacademy.org','wikipedia.org','duolingo.com','classroom.google.com','scratch.mit.edu'],
 'shopping':['amazon.com','ebay.com','temu.com'],
 'news':['bbc.com','cnn.com','nytimes.com'],
 'ads':['doubleclick.net','googlesyndication.com','googleadservices.com'],
 'proxy':['protonvpn.com','nordvpn.com','expressvpn.com','hide.me'],
 'malware':[],
}
PRESETS={'kid':['adult','gambling','proxy','malware'],'teen':['adult','gambling','malware'],'adult':['malware'],'none':[]}

def matches(host,rule):
    return host==rule or host.endswith('.'+rule)

def local(at,zone):
    value=datetime.fromtimestamp(at,ZoneInfo(zone))
    return value.strftime('%Y-%m-%d'),value.strftime('%H:%M'),(value.weekday()+1)%7

def in_window(window,at,zone):
    start,end=window.get('start',''),window.get('end','')
    if not start or not end:return False
    _,clock,weekday=local(at,zone)
    days=window.get('days',list(range(7)))
    if start<end:return weekday in days and start<=clock<end
    return (weekday in days and clock>=start) or ((weekday+6)%7 in days and clock<end)

def classify(host,extra=None):
    longest,category=0,'other'
    for name,domains in {**CATALOG,**(extra or {})}.items():
        for d in domains:
            if len(d)>longest and matches(host,d):longest,category=len(d),name
    return category

def rewards(profile,at,zone):
    day=local(at,zone)[0]
    return [r for r in profile.get('rewards',[]) if r['day']==day]

def daily_limit(profile,at,zone,scope='total'):
    _,_,weekday=local(at,zone)
    if scope=='total':base=profile.get('weekday_limits',{}).get(str(weekday),profile.get('limit',0))
    elif scope.startswith('category:'):base=profile.get('category_limits',{}).get(scope[9:],0)
    else:base=profile.get('site_limits',{}).get(scope[5:],0)
    if not base:return 0
    return min(1440,base+sum(r.get('minutes',0) for r in rewards(profile,at,zone) if r['kind']=='extra_time' and r.get('scope','total')==scope))

def active_windows(profile,at,zone):
    skip={r.get('window_id') for r in rewards(profile,at,zone) if r['kind']=='skip_window'}
    return [w for w in profile.get('schedules',[]) if w['id'] not in skip and in_window(w,at,zone)]

def access_reason(profile,zone,at=None,household_paused=False):
    at=time.time() if at is None else at
    if not profile.get('managed',True):return 'allowed'
    if household_paused:return 'household pause'
    if profile.get('paused'):return 'paused'
    bedtime=dict(profile.get('bedtime',{}))
    late=[r for r in rewards(profile,at,zone) if r['kind']=='late_bedtime']
    if late:bedtime['start']=late[-1]['bedtime']
    if in_window(bedtime,at,zone):return 'bedtime'
    if any(w['mode']=='off' for w in active_windows(profile,at,zone)):return 'off time'
    limit=daily_limit(profile,at,zone)
    if profile.get('filter_level','adult')!='none' and limit>0 and profile.get('used',0)>=limit:return 'daily limit'
    return 'allowed'

def domain_reason(profile,host,zone,at=None,household_paused=False,extra=None):
    at=time.time() if at is None else at
    if not profile.get('managed',True) or any(matches(host,d) for d in profile.get('unmanaged',[])):return 'unmanaged'
    reason=access_reason(profile,zone,at,household_paused)
    if reason!='allowed':return reason
    category=classify(host,extra)
    focuses=[w for w in active_windows(profile,at,zone) if w['mode']=='focus']
    if any(not any(matches(host,d) for d in w['allow']) and category not in w['allowed_categories'] for w in focuses):return 'focus time'
    if profile.get('filter_level','adult')=='none':return 'allowed'
    scopes=['category:'+category]+['site:'+d for d in profile.get('site_limits',{}) if matches(host,d)]
    for scope in scopes:
        limit=daily_limit(profile,at,zone,scope)
        if limit and profile.get('bucket_usage',{}).get(scope,0)>=limit:return 'limit '+scope
    if any(matches(host,d) for d in profile.get('allow',[])):return 'allowed'
    if any(matches(host,d) for d in profile.get('deny',[])):return 'custom rule'
    if profile.get('allow_only'):return 'allow-list only'
    if category in PRESETS[profile.get('filter_level','adult')]+profile.get('categories',[]):return category
    return 'allowed'
