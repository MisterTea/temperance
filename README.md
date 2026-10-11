# Temperance

Open source family VPN and DNS controls inspired by [Circle](https://meetcircle.com/pages/features-usage). Manage family profiles, assign devices, filter domains, pause DNS access, and set bedtime schedules and daily DNS activity budgets. Configuration is stored in a local SQLite database; VPN clients share observed activity minutes with your self-hosted policy service. Standalone DNS mode has no account, telemetry, cloud service, or runtime dependencies. VPN mode adds an authenticated self-hosted policy service and WireGuard dependencies.

**Status: working MVP with VPN client source for all five platforms; not a complete Circle replacement.** Temperance is an independent project and has no affiliation with Circle. It uses original code and a distinct interface.

## VPN apps and policy service

Temperance now includes a central authenticated Next.js policy service, a Linux WireGuard enforcement gateway, and device applications for **macOS, Linux, Windows, Android, and iOS**. Parents update profiles in the HTTPS dashboard and issue short-lived enrollment codes. Devices generate VPN keys locally and install a full tunnel. The gateway applies DNS filters plus packet-level pauses, bedtime, and observed-network-minute budgets, refreshing policy every five seconds. Expiring firewall leases close forwarding if enforcement stops.

- [Build/install the five device apps](clients/README.md)
- [Deploy the Next.js service to Vercel, Cloudflare Workers, or Docker](web/README.md)
- [Configure the Linux VPN gateway](docs/deployment.md)
- [Circle research and feature-parity audit](docs/research/circle-feature-audit.md)
- [Architecture, API, and enforcement limits](docs/architecture.md)

All five clients share one Rust business-logic layer, [`core/temperance-core`](core): the enrollment/refresh protocol, key generation, tunnel validation, the policy engine, the child status view, child alerts, time requests and location answers. It is linked natively into the Rust desktop app (Linux, Windows, macOS) and compiled through UniFFI into an XCFramework with Swift bindings (iOS, macOS) and Android `.so` libraries with Kotlin bindings. Platform code only provides HTTPS, secure storage, VPN APIs and UI. The mobile apps embed WireGuard; the Apple apps use native SwiftUI/Network Extension. Linux and Windows use the Rust app with a localhost browser UI and official OS WireGuard tooling.

Parents sign in with a username and password (salted PBKDF2 hashes; co-parents get their own accounts), and native or scripted clients can use the OAuth 2.0 password and refresh-token grants. The policy service stores data in SQLite, PostgreSQL, or libSQL/Turso, selected by `TEMPERANCE_DATABASE_URL`. Apple VPN builds require your signing team and entitlements for installation. Android debug APKs are test artifacts. Unmanaged-device VPN removal and comprehensive encrypted-DNS/content filtering remain limitations. The repository includes CI build artifacts and an isolated Linux integration test with real encrypted traffic; it does not provision a public server or publish app-store releases automatically.

## Standalone DNS mode

The original dependency-free DNS dashboard can still run without a VPN or policy service.

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

DNS filtering cannot terminate existing connections or stop access through cached answers, IP literals, VPNs, mobile data, encrypted DNS, or alternate resolvers. Dependable whole-network enforcement requires router firewall/routing controls and usually device agents. Standalone DNS mode does not implement router controls, discovery, location tracking, rewards, or exact app usage reporting. For mobile/off-network traffic and packet-level controls, use the VPN apps and gateway described above. The standalone DNS service is designed for a small trusted home network, not an internet-facing resolver.

## Development

```sh
coverage run -m unittest discover -s tests && coverage report   # Python gateway (80% gate)
(cd web && npm run test:coverage)                                # policy service + dashboard (80% gate)
(cd web && npm run build && npx playwright test)                 # feature/UX + layout audits
(cd core && cargo llvm-cov --workspace --fail-under-lines 80)    # Rust core + desktop
```

GitHub Actions run all of these, Playwright on both SQLite and PostgreSQL, Rust desktop builds for Linux/Windows/macOS (x64 and arm64), the Android APK and the unsigned macOS/iOS apps.

Python tests use temporary SQLite databases and a deterministic local DNS upstream, covering policy precedence, timezones, minute budgets, persistence, retention, malformed packets, UDP/TCP forwarding, and the administration API. No router configuration or live external DNS is required for tests.

Architecture: `store.py` owns SQLite and policy decisions; `dns.py` implements wire forwarding; `server.py` hosts the API and static dashboard. The frontend is plain HTML/CSS/JavaScript, served from the package. All runtime code uses Python's standard library.

## Next milestones

1. Home routing for TVs/consoles that cannot run the VPN app.
2. Captive-portal and VPN-permission diagnostics in the clients.
3. Push/e-mail delivery of parent notifications.
4. IPv6 internet forwarding and operational metrics.
5. Physical-device acceptance testing and signed store releases.

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [MIT](LICENSE).
