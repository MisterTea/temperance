# Temperance

Open source, local-first family DNS controls inspired by [Circle](https://meetcircle.com/pages/features-usage). Manage family profiles, assign devices, filter domains, pause DNS access, and set bedtime schedules and daily DNS activity budgets. All configuration and browsing metadata stay in a local SQLite database. No account, telemetry, cloud service, or runtime dependencies.

**Status: working MVP, not a complete Circle replacement.** Temperance is an independent project and has no affiliation with Circle. It uses original code and a distinct interface.

## Run locally

Requires Python 3.11 or newer. From this directory:

```sh
python3 -m temperance.server --timezone America/Chicago
```

Open **http://127.0.0.1:8787**. The dashboard starts empty. Add a profile and a device with IP `127.0.0.1` to try rules locally. DNS listens on UDP and TCP port 5533; your system DNS configuration is not changed.

```sh
dig @127.0.0.1 -p 5533 example.com
dig +tcp @127.0.0.1 -p 5533 example.com
```

Add `example.com` to the profile's blocked domains and repeat: the gateway returns NXDOMAIN. Resume/pause and other rules apply to subsequent requests.

Optional installation:

```sh
python3 -m venv .venv
.venv/bin/pip install -e .
.venv/bin/temperance --timezone America/Chicago
```

## Put it on a home network

Use an always-on Linux host or Raspberry Pi with a reserved LAN address. Reserve client addresses in your router, then assign those addresses to profiles. Production DNS must listen on port 53 for both UDP and TCP. For example, on a host at `192.168.1.10`, with permission to bind port 53:

```sh
python3 -m temperance.server \
  --dns-host 192.168.1.10 --dns-port 53 \
  --allow-network 192.168.1.0/24 \
  --timezone America/Chicago \
  --data /path/to/private-data/temperance.sqlite3
```

Grant a dedicated service only the privilege needed to bind port 53 (for example, `CAP_NET_BIND_SERVICE` in a Linux service manager). Configure DHCP to advertise this host as the DNS resolver, or set DNS on one test device first. Allow port 53 only from your home subnet in the host firewall. Avoid advertising an alternative resolver that bypasses these rules. The allow-network option is mandatory when binding beyond loopback.

Clients must query Temperance directly. If the router proxies all DNS under its own address, Temperance cannot distinguish devices. Unknown/unassigned addresses are allowed and appear in recent activity. IPv4 only in this MVP; IPv6 DNS paths need separate network controls.

The administration UI binds exclusively to `127.0.0.1`, with Host/Origin checks to prevent browser cross-origin writes and DNS rebinding. It has no user authentication: any user/process on that host can administer it. Keep the host trusted. For remote administration use an SSH tunnel, e.g. `ssh -L 8787:127.0.0.1:8787 user@gateway`, then open the local dashboard. Do not expose the dashboard through an unauthenticated reverse proxy.

## What the controls mean

- **Usage:** the number of distinct minutes with at least one allowed DNS request across a profile's devices. Simultaneous devices count once per minute. Background requests may count, and cached DNS or existing connections may not. It is not exact screen time or time spent in a specific app. Requests are counted before forwarding, even if the upstream later fails.
- **Daily budgets:** block new DNS requests in new minutes after the budget is reached. The current counted minute remains allowed. Budgets reset at midnight in the configured IANA timezone, default UTC.
- **Bedtime:** a daily interval, including intervals spanning midnight. Start is inclusive; end is exclusive.
- **Pause:** immediately refuses new DNS requests for that profile.
- **Filtering:** exact domains plus all their subdomains, including IDNA normalization. Allow rules override category/domain filters. Pause, bedtime, and budget rules take precedence over allow rules.
- **Categories:** small, transparent starter lists in `temperance/store.py` for social, video, and gaming services. These are examples, not comprehensive content classifications.
- **Privacy:** raw domain names, client IPs, decisions, and timestamps are retained for 30 days and pruned at startup/hourly. Protect the data directory and backups. Domain logs can reveal sensitive browsing habits. Data is not sent to a Temperance service; allowed DNS questions are forwarded to the configured upstream (default `1.1.1.1`).

DNS filtering cannot terminate existing connections or stop access through cached answers, IP literals, VPNs, mobile data, encrypted DNS, or alternate resolvers. Dependable whole-network enforcement requires router firewall/routing controls and usually device agents. This MVP does not implement those controls, device discovery, mobile apps, location tracking, rewards, or exact app usage reporting. It is designed for a small trusted home network, not an internet-facing resolver.

## Development

```sh
python3 -m unittest discover -s tests -v
node --check temperance/static/app.js
```

Tests use temporary SQLite databases and a deterministic local DNS upstream, covering policy precedence, timezones, minute budgets, persistence, retention, malformed packets, UDP/TCP forwarding, and the administration API. No router configuration or live external DNS is required for tests.

Architecture: `store.py` owns SQLite and policy decisions; `dns.py` implements wire forwarding; `server.py` hosts the API and static dashboard. The frontend is plain HTML/CSS/JavaScript, served from the package. All runtime code uses Python's standard library.

## Next milestones

1. Authenticated remote administration and profile/history management.
2. Curated, updateable category lists and per-category budgets.
3. Router integrations for discovery and enforceable network pauses.
4. Optional device agents for accurate foreground usage and off-network controls.
5. IPv6 support, bounded concurrency, and operational metrics.

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [MIT](LICENSE).
