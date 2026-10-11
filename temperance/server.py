"""Local administration server and gateway entry point."""
import argparse
import ipaddress
import json
import os
import signal
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .dns import Resolver, TCPHandler, TCPServer, UDPHandler, UDPServer
from .store import Store

STATIC = Path(__file__).parent / "static"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Do not duplicate browsing history in console logs.

    def send(self, status, body, kind="application/json"):
        payload = json.dumps(body).encode() if kind == "application/json" else body
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(payload)

    def trusted(self, write=False):
        host = self.headers.get("Host", "")
        port = self.server.server_port
        if host not in (f"127.0.0.1:{port}", f"localhost:{port}"):
            self.send(403, {"error": "Use localhost to access administration"})
            return False
        origin = self.headers.get("Origin")
        if (origin and origin != "http://" + host) or (write and origin != "http://" + host):
            self.send(403, {"error": "Same-origin requests required"})
            return False
        return True

    def do_GET(self):
        if not self.trusted():
            return
        if self.path == "/api/state":
            self.send(200, self.server.store.snapshot())
        elif self.path in ("/", "/app.js", "/style.css"):
            name = {"/": "index.html", "/app.js": "app.js", "/style.css": "style.css"}[self.path]
            kind = {"index.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8", "style.css": "text/css; charset=utf-8"}[name]
            self.send(200, (STATIC / name).read_bytes(), kind)
        else:
            self.send(404, {"error": "Not found"})

    def do_POST(self):
        if not self.trusted(write=True):
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 65536:
                raise ValueError("Invalid request size")
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict):
                raise ValueError("Expected an object")
            if self.path == "/api/profiles":
                self.server.store.save_profile(data)
            elif self.path == "/api/devices":
                self.server.store.save_device(data)
            elif self.path == "/api/devices/delete":
                self.server.store.delete_device(str(data.get("ip", "")))
            else:
                self.send(404, {"error": "Not found"})
                return
            self.send(200, self.server.store.snapshot())
        except (ValueError, TypeError) as exc:
            self.send(400, {"error": str(exc)})


def main():
    parser = argparse.ArgumentParser(description="Temperance family DNS gateway")
    parser.add_argument("--data", type=Path, default=Path("data/temperance.sqlite3"))
    parser.add_argument("--http-port", type=int, default=8787)
    parser.add_argument("--dns-host", default="127.0.0.1")
    parser.add_argument("--dns-port", type=int, default=5533)
    parser.add_argument("--upstream", default="1.1.1.1")
    parser.add_argument("--upstream-port", type=int, default=53)
    parser.add_argument("--allow-network", action="append", help="Permitted client IPv4 CIDR; repeat for multiple networks")
    parser.add_argument("--timezone", default="UTC", help="IANA timezone used for bedtime and day boundaries")
    args = parser.parse_args()
    try:
        ipaddress.IPv4Address(args.upstream)
        ipaddress.IPv4Address(args.dns_host)
        networks = args.allow_network or ["127.0.0.0/8"]
        for network in networks:
            if ipaddress.ip_network(network).version != 4:
                raise ValueError("Only IPv4 networks supported")
        if args.dns_host != "127.0.0.1" and not args.allow_network:
            parser.error("LAN binding requires explicit --allow-network")
        if args.upstream == args.dns_host and args.upstream_port == args.dns_port:
            parser.error("Upstream cannot be the gateway itself")
        for port in (args.http_port, args.dns_port, args.upstream_port):
            if not 1 <= port <= 65535:
                raise ValueError("Ports must be between 1 and 65535")
    except ValueError as exc:
        parser.error(str(exc))
    # SQLite WAL/SHM sidecars also contain private browsing metadata.
    os.umask(0o077)
    args.data.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    new_database = not args.data.exists()
    store = Store(args.data, args.timezone)
    if new_database:
        args.data.chmod(0o600)
    store.prune()
    resolver = Resolver(store, (args.upstream, args.upstream_port), networks)
    servers = []
    try:
        for server_type, address, handler in (
            (ThreadingHTTPServer, ("127.0.0.1", args.http_port), Handler),
            (UDPServer, (args.dns_host, args.dns_port), UDPHandler),
            (TCPServer, (args.dns_host, args.dns_port), TCPHandler),
        ):
            server = server_type(address, handler)
            server.store, server.resolver = store, resolver
            servers.append(server)
    except OSError as exc:
        for server in servers:
            server.server_close()
        store.db.close()
        parser.exit(1, f"Could not start Temperance: {exc}. Try different --http-port / --dns-port values.\n")
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"Temperance dashboard: http://127.0.0.1:{args.http_port}", flush=True)
    print(f"DNS: {args.dns_host}:{args.dns_port} (UDP/TCP); timezone: {args.timezone}", flush=True)
    try:
        while not stop.wait(3600):
            store.prune()
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
        store.db.close()


if __name__ == "__main__":
    main()
