# Temperance

Open source family VPN and DNS controls inspired by [Circle](https://meetcircle.com/pages/features-usage). Manage family profiles, devices, filters, pauses, bedtime and schedules, and daily time budgets from one program you run at home. Phones and computers are enforced through its built-in WireGuard VPN wherever they are; TVs and consoles on the home network are enforced through its DNS or (on Linux) router mode. There is no Temperance cloud service or telemetry.

**Status: working MVP with VPN client source for macOS, Windows, Android, and iOS; not a complete Circle replacement.** Temperance is an independent project and has no affiliation with Circle. It uses original code and a distinct interface.

## VPN apps and policy service

Temperance is one home program: the authenticated Next.js dashboard and policy service with a WireGuard gateway written in Rust embedded as a native add-on, plus device applications for **macOS, Windows, Android, and iOS**. It runs on Linux, macOS or Windows with a single forwarded UDP port. Parents update profiles and create client users in the admin-password-protected dashboard. Devices generate VPN keys locally and install a full tunnel. The gateway applies DNS filters plus per-connection pauses, bedtime, and observed-network-minute budgets, re-checking policy every few seconds. A 15-second policy lease stops forwarding if enforcement stops.

- [Run Temperance at home](docs/deployment.md) (Linux `.deb`/`.rpm`/tarball releases; installers for Linux, macOS and Windows; port forwarding; HTTPS), or [with Docker](#run-with-docker)
- [Router guide](docs/routers.md): automatic UPnP port forwarding, Dynu dynamic DNS, and manual steps for TP-Link, eero and Netgear routers
- [Build/install the device apps](clients/README.md)
- [Develop the web service, or host the dashboard on Vercel/Cloudflare with a separate gateway](web/README.md)
- [Circle research and feature-parity audit](docs/research/circle-feature-audit.md)
- [Architecture, API, and enforcement limits](docs/architecture.md)

All four clients and the gateway share one Rust business-logic layer, [`core/temperance-core`](core): the enrollment/refresh protocol, key generation, tunnel validation, the policy engine, the child status view, child alerts, time requests and location answers. It is linked natively into the Rust desktop app for Windows and compiled through UniFFI into an XCFramework with Swift bindings (iOS, macOS) and Android `.so` libraries with Kotlin bindings. Platform code only provides HTTPS, secure storage, VPN APIs and UI. The mobile apps embed WireGuard; the Apple apps use native SwiftUI/Network Extension. Windows uses the Rust app with a localhost browser UI and the official WireGuard tunnel service. There is no Linux device app; Linux computers can be protected as home-network devices behind the gateway.

The website uses a single admin password to manage policy and create client users. Client apps sign in with a username/password and receive the family profile assigned to that user, without OAuth or a profile picker. Stored user passwords are salted hashes, and apps persist only scoped device credentials. Data lives in SQLite in the data directory by default, or in PostgreSQL when `TEMPERANCE_DATABASE_URL` points to one. Apple VPN builds require your signing team and entitlements for installation. Android debug APKs are test artifacts. Unmanaged-device VPN removal and comprehensive encrypted-DNS/content filtering remain limitations. The repository includes CI build artifacts and end-to-end tests with real encrypted traffic. Version tags publish Linux packages and a container image; it does not provision a server or publish app-store releases automatically.

## Run locally

The web service is the Next.js app in [`web/`](web) and needs Node.js 24 or newer:

```sh
cd web && npm ci
cp .env.example .env.local   # set the two tokens; SQLite is the default database
npm run dev
```

Open **http://127.0.0.1:3000**, sign in with `TEMPERANCE_ADMIN_PASSWORD`, then add profiles and devices. To run the VPN gateway too, build the add-on once (`npm run build:gateway`, needs Rust) and set `TEMPERANCE_GATEWAY_LISTEN=0.0.0.0:51820`. See [docs/deployment.md](docs/deployment.md) to install it as a service, including DNS and router modes for devices on a home network.

## Run with Docker

If the home machine already runs Docker (a Linux box, a NAS such as Synology, Unraid or TrueNAS, or Docker Desktop), install the published image (amd64 and arm64) with Docker Compose:

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/MisterTea/temperance/main/deploy/docker/install.sh)"
```

The installer asks for your public hostname, timezone and HTTPS method. It writes `~/temperance/compose.yml` and a `.env` with a generated admin password, then starts the containers and waits for them to report healthy. Rerun it to upgrade. To set it up by hand, copy [`deploy/docker/compose.yml`](deploy/docker/compose.yml) and [`deploy/docker/.env.example`](deploy/docker/.env.example) (as `.env`) into one directory and run `docker compose up -d`.

The device apps only accept an HTTPS address, so `.env` picks a front end with `COMPOSE_PROFILES`:

- `caddy`: Caddy gets a Let's Encrypt certificate for `TEMPERANCE_PUBLIC_URL`.
- `cloudflared`: a Cloudflare Tunnel; route its public hostname to `http://temperance:3000`.
- Empty: point your own reverse proxy at the dashboard port.

The dashboard stays on `127.0.0.1:8788`.

### Port forwarding with Docker

Phones and laptops reach the gateway from outside your home, so their packets go from your router to the Docker host and then to the container:

```
internet ──UDP 51820──▶ router ──UDP 51820──▶ Docker host (192.168.1.20) ──▶ container :51820
```

1. **Give the Docker host a fixed LAN address.** Reserve one in your router's DHCP settings. With Docker Desktop on macOS or Windows, this is the Mac's or PC's own address, not the address of Docker's internal VM.
2. **Forward UDP 51820 on the router** to that address. The protocol must be UDP; TCP forwarding does nothing for WireGuard. With `COMPOSE_PROFILES=caddy`, also forward TCP 80 and 443 for the certificate and HTTPS. A Cloudflare Tunnel needs no inbound TCP ports. The gateway's automatic UPnP forwarding cannot reach the router from Docker's default bridge network or from Docker Desktop; it works only with `network_mode: host` on a Linux host. Otherwise forward the port by hand: the [router guide](docs/routers.md) covers TP-Link, eero and Netgear.
3. **Publish the same UDP port from the container.** `compose.yml` maps `${TEMPERANCE_WIREGUARD_PORT}:51820/udp`. With plain `docker run`, write `-p 51820:51820/udp`; without `/udp`, Docker publishes TCP only.
4. **Advertise the outside port.** `TEMPERANCE_VPN_ENDPOINT` must be your public hostname (or IPv4 address) with the port the *router* exposes. If 51820 is taken, set `TEMPERANCE_WIREGUARD_PORT=51821`, forward UDP 51821 on the router, and use `home.example.net:51821`. The container always listens on 51820 inside.
5. **Allow it through the host firewall.** Docker adds its own iptables rules for published ports, and those bypass `ufw` and `firewalld` zones. That is why the dashboard is published on `127.0.0.1` only. On Windows, allow Docker Desktop through Windows Firewall when it asks.
6. **Check it.** `docker compose logs temperance` should print `Temperance gateway on udp 0.0.0.0:51820`. Then turn off Wi-Fi on a phone, connect with the app over mobile data, and confirm the device shows as active in the dashboard. Many routers cannot loop traffic from your own LAN back to the public address, so test from outside the home network.

Port forwarding cannot work if the router's WAN address is private (`10.x`, `100.64–127.x`, `172.16–31.x`, `192.168.x`), which happens behind carrier-grade NAT or a second router. Bridge the ISP modem, ask the ISP for a public IPv4 address, or run the gateway on a VPS (see [docs/deployment.md](docs/deployment.md#remote-gateway-optional)). Rootless Docker and Podman also work. UDP port forwarding behaves the same, but use a port above 1024.

The home-network DNS and router modes identify TVs and consoles by their LAN address. For those modes, run the container with `network_mode: host`, and for router mode also `user: "0"` and `cap_add: [NET_ADMIN]`. Host networking makes Docker skip the port mappings, so the router forwards straight to the host.

DNS and packet filtering cannot stop access through mobile data, other VPNs or DNS-over-HTTPS on devices that are not routed through the gateway. [docs/architecture.md](docs/architecture.md) describes what each control measures and its enforcement limits.

## Development

```sh
(cd web && npm run test:coverage)                                # policy service + dashboard (80% gate)
(cd web && npm run build && npx playwright test)                 # feature/UX + layout audits
(cd core && cargo llvm-cov --workspace)                          # Rust core, gateway + desktop
clients/android/gradlew -p clients/android unitTestCoverageCheck  # Android app (Robolectric, 80% gate)
xcodebuild -project clients/apple/Temperance.xcodeproj -scheme TemperanceMac -derivedDataPath build/apple \
  -resultBundlePath build/apple-tests.xcresult -enableCodeCoverage YES CODE_SIGNING_ALLOWED=NO test \
  && clients/apple/coverage.py build/apple-tests.xcresult        # Apple app (80% gate)
sh systest/run.sh                                                # client + server system tests (Docker, Linux)
```

The system tests ([systest/README.md](systest/README.md)) run the real server image and a headless client together in an isolated Docker network. The fake internet there can only be reached through the WireGuard tunnel. They cover enrolling, filtering, time limits with parent approval, pause, bedtime and revoking a device.

Every project must keep at least 80% line coverage from its unit tests. In CI the Rust gate applies to each crate separately, and generated UniFFI bindings are left out of the Android and Apple numbers. GitHub Actions run all of these, Playwright on both SQLite and PostgreSQL, the gateway's tunnel test and add-on builds on Linux (x64 and arm64), macOS and Windows, the router-mode test in network namespaces, Rust desktop builds for Windows (x64 and arm64) and macOS, the Android APK and the unsigned macOS/iOS apps.

Gateway layout (`core/temperance-gateway`): `wg.rs` runs WireGuard peers, `gateway.rs` admits packets, relays TCP/UDP flows and holds the policy lease, `policy.rs` turns the service's state document into per-flow verdicts with `temperance-core`, `dns.rs` filters and forwards DNS, `home.rs` generates router-mode nftables rules, `reach.rs` maps the VPN port on the router with UPnP and updates Dynu dynamic DNS, `node.rs` is the Node add-on, and `bin/temperance-gateway.rs` is the standalone CLI.

## Next milestones

1. Push/e-mail delivery of parent notifications.
2. IPv6 internet forwarding and operational metrics.
3. Physical-device acceptance testing and signed store releases.

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [MIT](LICENSE).
