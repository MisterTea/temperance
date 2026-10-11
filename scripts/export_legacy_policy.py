"""Export the old SQLite control plane as a private Next.js import file.
Reads the source database in read-only mode; never changes or deletes it.
"""
import argparse
import json
import os
import sqlite3
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo


def export(path,timezone='UTC'):
    db=sqlite3.connect(Path(path).resolve().as_uri()+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
    db.execute('BEGIN')
    state=dict(schema=2,version=1,nextProfileId=1,profiles=[],devices=[],codes=[],rewards=[],usage={},history=[],requests=[],events=[],paused=False,extra_domains={},retention_days=30,offline_grace_seconds=86400)
    tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for row in db.execute('SELECT * FROM profiles'):
        p=json.loads(row['config'])
        p.update(id=row['id'],avatar='◒',filter_level='adult',managed=True,weekday_limits={},unmanaged=[],allow_only=False,safe_search=False,youtube_restricted=False,schedules=[],category_limits={},site_limits={})
        p['bedtime']['days']=list(range(7));state['profiles'].append(p)
    state['nextProfileId']=max([p['id'] for p in state['profiles']],default=0)+1
    if 'clients' in tables:
        for row in db.execute('SELECT * FROM clients'):
            state['devices'].append(dict(id=row['id'],ip=row['ip'],name=row['name'],profile_id=row['profile_id'],public_key=row['public_key'],token_hash=row['token_hash'],revoked=bool(row['revoked']),paused=False,managed=True))
    for row in db.execute('SELECT * FROM activity'):
        day=datetime.fromtimestamp(row['minute']*60,ZoneInfo(timezone)).strftime('%Y-%m-%d')
        state['usage'].setdefault(day,{}).setdefault(str(row['profile_id']),{}).setdefault('total',[]).append(row['minute'])
    if 'revisions' in tables:state['version']=db.execute('SELECT version FROM revisions WHERE id=1').fetchone()[0]
    db.close()
    # Old DNS-only LAN assignments are not VPN peers; do not pretend an enrollment was migrated.
    return dict(format='temperance',schema=2,exported_at=int(__import__('time').time()),state=state)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database',type=Path);parser.add_argument('--output',required=True,type=Path);parser.add_argument('--timezone',default='UTC');args=parser.parse_args()
    result=export(args.database,args.timezone)
    fd=os.open(args.output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as out:json.dump(result,out,indent=2)
    print('Created private migration backup; the original database is unchanged. Import through Next.js Settings.')

if __name__=='__main__':main()
