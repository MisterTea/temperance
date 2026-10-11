# Temperance

Open source family VPN and DNS controls inspired by [Circle](https://meetcircle.com/pages/features-usage). Manage family profiles, devices, filters, pauses, bedtime and schedules, and daily time budgets from a self-hosted Next.js web service. Phones and computers are enforced through a WireGuard VPN; TVs and consoles on the home network are enforced by the same Linux gateway. There is no Temperance cloud service or telemetry.

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

## Run locally

The web service is the Next.js app in [`web/`](web) and needs Node.js 24 or newer:

```sh
cd web && npm ci
cp .env.example .env.local   # set the two tokens; SQLite is the default database
npm run dev
```

Open **http://127.0.0.1:3000**, enter `TEMPERANCE_ADMIN_TOKEN` once to create the owner account, then add profiles and devices. The Python package in [`temperance/`](temperance) is only the Linux gateway that enforces the policy on VPN peers and home-network devices; it has no web interface. See [docs/deployment.md](docs/deployment.md) to run it, including DNS-only and router modes for devices on a home network.

DNS and packet filtering cannot stop access through mobile data, other VPNs or DNS-over-HTTPS on devices that are not routed through the gateway. [docs/architecture.md](docs/architecture.md) describes what each control measures and its enforcement limits.

## Development

```sh
coverage run -m unittest discover -s tests && coverage report   # Linux gateway (80% gate)
(cd web && npm run test:coverage)                                # policy service + dashboard (80% gate)
(cd web && npm run build && npx playwright test)                 # feature/UX + layout audits
(cd core && cargo llvm-cov --workspace --fail-under-lines 80)    # Rust core + desktop
```

GitHub Actions run all of these, Playwright on both SQLite and PostgreSQL, Rust desktop builds for Linux/Windows/macOS (x64 and arm64), the Android APK and the unsigned macOS/iOS apps.

Gateway tests use a deterministic local DNS upstream and mocked host commands, covering the shared policy cases, UDP/TCP forwarding, malformed packets, nftables rule generation, the offline policy cache and the enforcement loop. No router configuration or live external DNS is required.

Gateway layout: `gateway.py` polls the web service and writes WireGuard peers and nftables rules; `gateway_store.py` and `policy.py` make DNS decisions from the service's policy document; `dns.py` implements wire forwarding. It uses only Python's standard library.

## Next milestones

1. Push/e-mail delivery of parent notifications.
2. IPv6 internet forwarding and operational metrics.
3. Physical-device acceptance testing and signed store releases.

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [MIT](LICENSE).
