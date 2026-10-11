"""Authenticated enrollment and authoritative policy distribution."""
import argparse
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import time
import uuid
from http.cookies import SimpleCookie
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse

from .server import Handler, STATIC
from .store import Store


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def key(value):
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, TypeError):
        raise ValueError("Invalid WireGuard public key") from None
    if len(raw) != 32 or raw == bytes(32):
        raise ValueError("Invalid WireGuard public key")
    return value


class ControlStore(Store):
    def __init__(self, path, timezone="UTC", endpoint="127.0.0.1:51820", public_key=None):
        super().__init__(path, timezone)
        host, port = endpoint.rsplit(":", 1)
        ipaddress.IPv4Address(host)
        if not 1 <= int(port) <= 65535:
            raise ValueError("Invalid endpoint")
        self.endpoint, self.public_key = endpoint, key(public_key)
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS revisions(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER);
            INSERT OR IGNORE INTO revisions VALUES(1,1);
            CREATE TABLE IF NOT EXISTS codes(hash TEXT PRIMARY KEY, profile_id INTEGER NOT NULL
                REFERENCES profiles(id), expires REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY, public_key TEXT UNIQUE NOT NULL,
                token_hash TEXT UNIQUE NOT NULL, ip TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
                profile_id INTEGER NOT NULL REFERENCES profiles(id), revoked INTEGER DEFAULT 0);
        """)

    def bump(self):
        self.db.execute("UPDATE revisions SET version=version+1 WHERE id=1")

    def snapshot(self, now=None):
        result=super().snapshot(now)
        result['vpn']=True
        result['total']=sum(p['used'] for p in result['profiles'])
        result['blocked']=sum(p['paused'] for p in result['profiles'])
        return result

    def save_profile(self, data):
        with self.lock, self.db:
            result = super().save_profile(data)
            self.bump()
            return result

    def save_device(self, data):
        with self.lock, self.db:
            enrolled = self.db.execute("SELECT * FROM clients WHERE ip=?", (data.get("ip"),)).fetchone()
            if enrolled and data.get("profile_id") is None:
                raise ValueError("Enrolled VPN devices must have a profile; revoke instead")
            super().save_device(data)
            if enrolled:
                self.db.execute("UPDATE clients SET profile_id=?,name=? WHERE ip=?", (data["profile_id"], data["name"], data["ip"]))
            self.bump()

    def delete_device(self, ip):
        with self.lock, self.db:
            self.db.execute("UPDATE clients SET revoked=1 WHERE ip=?", (ip,))
            super().delete_device(ip)
            self.bump()

    def issue_code(self, pid):
        with self.lock, self.db:
            if type(pid) is not int or not self.profile(pid):
                raise ValueError("Choose an existing profile")
            code = secrets.token_urlsafe(24)
            self.db.execute("INSERT INTO codes VALUES(?,?,?)", (digest(code), pid, time.time()+600))
            self.db.execute("DELETE FROM codes WHERE expires<?", (time.time(),))
            return dict(code=code, expires_in=600)

    def enroll(self, data):
        public_key = key(data.get("public_key"))
        name = str(data.get("name", "")).strip()
        if not name or len(name) > 80:
            raise ValueError("Device name must contain 1–80 characters")
        with self.lock, self.db:
            code = self.db.execute("SELECT * FROM codes WHERE hash=? AND expires>?", (digest(str(data.get("code", ""))), time.time())).fetchone()
            if not code:
                raise ValueError("Enrollment code expired or already used")
            if self.db.execute("SELECT 1 FROM clients WHERE public_key=?", (public_key,)).fetchone():
                raise ValueError("This public key is already enrolled")
            used = {r[0] for r in self.db.execute("SELECT ip FROM clients UNION SELECT ip FROM devices")}
            ip = next((f"10.77.0.{n}" for n in range(2,255) if f"10.77.0.{n}" not in used), None)
            if not ip:
                raise ValueError("Gateway address pool exhausted")
            token, cid = secrets.token_urlsafe(32), str(uuid.uuid4())
            self.db.execute("INSERT INTO clients(id,public_key,token_hash,ip,name,profile_id) VALUES(?,?,?,?,?,?)", (cid,public_key,digest(token),ip,name,code["profile_id"]))
            self.db.execute("INSERT INTO devices VALUES(?,?,?)", (ip,name,code["profile_id"]))
            self.db.execute("DELETE FROM codes WHERE hash=?", (code["hash"],))
            self.bump()
            return dict(token=token, **self.client_state(cid))

    def client_id(self, token):
        with self.lock:
            row = self.db.execute("SELECT id FROM clients WHERE token_hash=? AND revoked=0", (digest(token),)).fetchone()
            return row[0] if row else None

    def client_state(self, cid):
        with self.lock:
            client = self.db.execute("SELECT * FROM clients WHERE id=? AND revoked=0", (cid,)).fetchone()
            if not client:
                raise ValueError("Device revoked")
            octet = int(client["ip"].split(".")[-1])
            config = self.profile(client["profile_id"])
            return dict(device_id=cid, version=self.db.execute("SELECT version FROM revisions").fetchone()[0],
                        policy=dict(**config, used=self.used(client["profile_id"], self.day(time.time())), timezone=str(self.zone)),
                        tunnel=dict(address=client["ip"]+"/32", address_v6=f"fd77::{octet:x}/128", dns="10.77.0.1",
                                    endpoint=self.endpoint, public_key=self.public_key, allowed_ips="0.0.0.0/0, ::/0", keepalive=25))

    def gateway_state(self):
        with self.lock:
            snapshot = self.snapshot()
            snapshot["version"] = self.db.execute("SELECT version FROM revisions").fetchone()[0]
            snapshot["peers"] = [dict(r) for r in self.db.execute("SELECT id,public_key,ip,profile_id FROM clients WHERE revoked=0")]
            return snapshot

    def account(self, ids):
        if not isinstance(ids,list) or len(ids)>253 or any(not isinstance(i,str) for i in ids):
            raise ValueError("Invalid activity report")
        now=time.time()
        self.prune(now)
        with self.lock,self.db:
            for cid in set(ids):
                row=self.db.execute("SELECT profile_id FROM clients WHERE id=? AND revoked=0",(cid,)).fetchone()
                if row:
                    self.db.execute("INSERT OR IGNORE INTO activity VALUES(?,?,?)",(row[0],self.day(now),int(now//60)))
        return dict(ok=True)


class ControlHandler(Handler):
    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def bearer(self):
        auth=self.headers.get("Authorization","")
        return auth[7:] if auth.startswith("Bearer ") else ""

    def admin(self):
        if hmac.compare_digest(self.bearer(),self.server.admin_token):
            return True
        cookie=SimpleCookie()
        try: cookie.load(self.headers.get("Cookie",""))
        except Exception:return False
        value=cookie.get("temperance_session")
        if not value:return False
        try:
            expiry,signature=value.value.split(".",1)
            expected=hmac.new(self.server.admin_token.encode(),expiry.encode(),hashlib.sha256).hexdigest()
            return int(expiry)>time.time() and hmac.compare_digest(signature,expected)
        except ValueError:return False

    def trusted(self,write=False):
        # Called by the original dashboard handler: auth is mandatory, including GETs.
        if not self.admin():
            self.send(401,{"error":"Administrator sign-in required"});return False
        if write and not self.bearer() and self.headers.get("Origin")!=self.server.public_url:
            self.send(403,{"error":"Same-origin requests required"});return False
        return True

    def do_GET(self):
        if self.path=="/healthz":self.send(200,{"ok":True});return
        if self.path=="/v1/device/state":
            cid=self.server.store.client_id(self.bearer())
            if not cid:self.send(401,{"error":"Invalid or revoked device"});return
            self.send(200,self.server.store.client_state(cid));return
        if self.path=="/v1/gateway/state":
            if not hmac.compare_digest(self.bearer(),self.server.gateway_token):self.send(401,{"error":"Unauthorized"});return
            self.send(200,self.server.store.gateway_state());return
        if self.path in ("/","/login.js") and not self.admin():
            name="login.html" if self.path=="/" else "login.js"
            self.send(200,(STATIC/name).read_bytes(),"text/html; charset=utf-8" if name.endswith("html") else "text/javascript; charset=utf-8");return
        if self.path=="/style.css":
            self.send(200,(STATIC/"style.css").read_bytes(),"text/css; charset=utf-8");return
        super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/") and self.path!="/api/enrollment":
            super().do_POST();return
        try:
            size=int(self.headers.get("Content-Length","0"))
            if not 0<size<=65536:raise ValueError("Invalid request size")
            data=json.loads(self.rfile.read(size))
            if not isinstance(data,dict):raise ValueError("Expected an object")
            if self.path=="/v1/login":
                if self.headers.get("Origin")!=self.server.public_url or not hmac.compare_digest(str(data.get("token","")),self.server.admin_token):
                    self.send(401,{"error":"Invalid sign-in"});return
                expiry=str(int(time.time()+3600))
                signature=hmac.new(self.server.admin_token.encode(),expiry.encode(),hashlib.sha256).hexdigest()
                self.send_response(200)
                self.send_header("Set-Cookie",f"temperance_session={expiry}.{signature}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600"+("; Secure" if self.server.public_url.startswith("https:") else ""))
                self.send_header("Content-Length","2");self.end_headers();self.wfile.write(b"{}");return
            if self.path=="/v1/enroll":self.send(200,self.server.store.enroll(data));return
            if self.path=="/api/enrollment":
                if self.trusted(write=True):self.send(200,self.server.store.issue_code(data.get("profile_id")))
                return
            if self.path=="/v1/gateway/activity":
                if not hmac.compare_digest(self.bearer(),self.server.gateway_token):self.send(401,{"error":"Unauthorized"});return
                self.send(200,self.server.store.account(data.get("active_devices")));return
            self.send(404,{"error":"Not found"})
        except (ValueError,TypeError) as exc:self.send(400,{"error":str(exc)})


def main():
    parser=argparse.ArgumentParser(description="Temperance policy and enrollment service")
    parser.add_argument("--host",default="127.0.0.1")
    parser.add_argument("--port",type=int,default=8788)
    parser.add_argument("--data",default="data/control.sqlite3")
    parser.add_argument("--timezone",default="UTC")
    parser.add_argument("--public-url",default="http://127.0.0.1:8788")
    parser.add_argument("--vpn-endpoint",required=True,help="Public IPv4:UDP port")
    parser.add_argument("--vpn-public-key",required=True)
    args=parser.parse_args()
    for name in ("TEMPERANCE_ADMIN_TOKEN","TEMPERANCE_GATEWAY_TOKEN"):
        if len(os.environ.get(name,""))<32:parser.error(f"{name} must contain at least 32 characters")
    url=urlparse(args.public_url)
    if url.scheme!="https" and url.hostname not in ("localhost","127.0.0.1"):
        parser.error("Remote public URL must use HTTPS")
    if os.environ["TEMPERANCE_ADMIN_TOKEN"]==os.environ["TEMPERANCE_GATEWAY_TOKEN"]:
        parser.error("Admin and gateway tokens must be different")
    from pathlib import Path
    os.umask(0o077)
    Path(args.data).parent.mkdir(parents=True,exist_ok=True)
    server=ThreadingHTTPServer((args.host,args.port),ControlHandler)
    server.store=ControlStore(args.data,args.timezone,args.vpn_endpoint,args.vpn_public_key)
    server.admin_token=os.environ["TEMPERANCE_ADMIN_TOKEN"]
    server.gateway_token=os.environ["TEMPERANCE_GATEWAY_TOKEN"]
    server.public_url=args.public_url.rstrip("/")
    print(f"Policy service: {server.public_url}",flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close();server.store.db.close()


if __name__=="__main__":main()
