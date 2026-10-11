"""Private, portable cached policy and idempotent outage accounting journal."""
import json
import os
import time
import uuid
from pathlib import Path
from .policy import local

class PolicyCache:
    def __init__(self,path,service):
        self.path=Path(path);self.service=service.rstrip('/');self.saved_at=0;self.state=None;self.pending=[];self.history=[]
        if self.path.exists():
            value=json.loads(self.path.read_text())
            if value.get('service')!=self.service:raise ValueError('Cached policy belongs to a different service origin')
            self.saved_at=value['saved_at'];self.state=value['state'];self.pending=value.get('pending',[]);self.history=value.get('history',[])
    def save(self):
        self.path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        temporary=self.path.with_name(self.path.name+'.'+uuid.uuid4().hex+'.tmp')
        fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        try:
            with os.fdopen(fd,'w') as output:
                json.dump(dict(service=self.service,saved_at=self.saved_at,state=self.state,pending=self.pending,history=self.history),output);output.flush();os.fsync(output.fileno())
            os.replace(temporary,self.path)
        finally:
            if temporary.exists():temporary.unlink()
    def update(self,state,now=None):
        now=time.time() if now is None else now
        if self.state and state['version']<self.state['version']:raise ValueError('Refusing policy version rollback')
        self.state=state;self.saved_at=now;self.save()
    def usable(self,now=None):
        now=time.time() if now is None else now
        return bool(self.state and -30<=now-self.saved_at<=self.state.get('offline_grace_seconds',0))
    def record(self,activity,history=()):
        known={(x['device_id'],x['minute'],tuple(x['buckets'])) for x in self.pending}
        for entry in activity:
            identity=(entry['device_id'],entry['minute'],tuple(entry['buckets']))
            if identity not in known:self.pending.append(entry);known.add(identity)
        known_history={h['id'] for h in self.history}
        self.history.extend(h for h in history if h['id'] not in known_history)
        self.history=self.history[-2000:]
        cutoff=int(time.time()//60)-7*1440
        self.pending=[x for x in self.pending if x['minute']>=cutoff]
        self.save()
    def batch(self):return {'active_devices':[],'activity':self.pending[:1000],'history':self.history[:500]}
    def acknowledge(self,batch):
        # Keep acknowledged accounting in the local snapshot until the next successful state refresh.
        self.state=self.effective()
        count=len(batch['activity']);self.pending=self.pending[count:]
        reported={h['id'] for h in batch['history']};self.history=[h for h in self.history if h['id'] not in reported];self.save()
    def effective(self,now=None):
        import copy
        now=time.time() if now is None else now
        state=copy.deepcopy(self.state)
        current_day=local(now,state['timezone'])[0]
        snapshot_day=state.get('day',local(self.saved_at,state['timezone'])[0])
        peer_profiles={p['id']:p['profile_id'] for p in state['peers']}
        extra={}
        for entry in self.pending:
            pid=peer_profiles.get(entry['device_id'])
            if pid is None or local(entry['minute']*60,state['timezone'])[0]!=current_day:continue
            for bucket in entry['buckets']:extra.setdefault((pid,bucket),set()).add(entry['minute'])
        for p in state['profiles']:
            if current_day!=snapshot_day:p['used']=0;p['bucket_usage']={};p['usage_minutes']={}
            for (pid,bucket),minutes in extra.items():
                if pid!=p['id']:continue
                existing=set(p.get('usage_minutes',{}).get(bucket,[]))
                fresh=minutes-existing
                if bucket=='total':p['used']+=len(fresh)
                else:p.setdefault('bucket_usage',{})[bucket]=p.get('bucket_usage',{}).get(bucket,0)+len(fresh)
                p.setdefault('usage_minutes',{})[bucket]=sorted(existing|minutes)
        state['day']=current_day
        return state
