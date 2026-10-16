# Temperance

[Product website](https://mistertea.github.io/temperance/) · [Privacy policy](https://mistertea.github.io/temperance/privacy.html)

Open source family VPN and DNS controls. Manage clients, devices, filters, pauses, bedtime and schedules, and daily time budgets from one program you run at home. Phones and computers are enforced through its built-in WireGuard VPN wherever they are; TVs and consoles on the home network are enforced through its DNS or (on Linux) router mode. There is no Temperance cloud service or telemetry.

**Status: beta preparation; release acceptance is still pending.** The reference setup is the Linux server package (`.deb` or `.rpm`) with SQLite on a dedicated machine such as a Raspberry Pi or mini PC, with device apps for macOS, Windows, Android, and iOS. Docker on an existing Linux server or NAS is supported for the VPN, UPnP and dynamic DNS. Other server and home-network modes are experimental. See the [release checklist](docs/beta-readiness.md) and [operations guide](docs/beta-operations.md). Temperance uses original code and a distinct interface.

## VPN apps and policy service

Temperance is one home program: the authenticated Next.js dashboard and policy service with a WireGuard gateway written in Rust embedded as a native add-on, plus device applications for **macOS, Windows, Android, and iOS**. It runs on Linux, macOS or Windows with a single forwarded UDP port. Admins update clients and create their sign-ins in the admin-password-protected dashboard. Devices generate VPN keys locally and install a full tunnel. The gateway applies DNS filters plus per-connection pauses, bedtime, and observed-network-minute budgets, re-checking policy every few seconds. A 15-second policy lease stops forwarding if enforcement stops.

- [Run Temperance at home](docs/deployment.md): the Linux `.deb`/`.rpm` package on a dedicated machine is the recommended setup; also tarball releases, installers for macOS and Windows, port forwarding and HTTPS. On an existing Linux server or NAS you can [use Docker](#run-with-docker) instead.
- [Router guide](docs/routers.md): automatic UPnP port forwarding, Dynu dynamic DNS, and manual steps for TP-Link, eero and Netgear routers
- [Admin devices](docs/remote-parents.md): open the family dashboard from work or mobile data, paired with a QR code, over the same UDP port and without a VPN or HTTPS setup
- [Build/install the device apps](clients/README.md)
- [Develop the web service, or host the dashboard on Vercel/Cloudflare with a separate gateway](web/README.md)
- [Circle research and feature-parity audit](docs/research/circle-feature-audit.md)
- [Architecture, API, and enforcement limits](docs/architecture.md)

All four apps and the gateway share one Rust business-logic layer, [`core/temperance-core`](core): the enrollment/refresh protocol, key generation, tunnel validation, the policy engine, the status view a client sees, alerts, time requests and location answers. It is linked natively into the Tauri desktop app for Windows and Linux and compiled through UniFFI into an XCFramework with Swift bindings (iOS, macOS) and Android `.so` libraries with Kotlin bindings. Platform code only provides secure storage, VPN APIs and UI; the core also does the networking, reaching home only through the gateway's WireGuard UDP port. The mobile apps embed WireGuard; the Apple apps use native SwiftUI/Network Extension. Windows uses the Tauri app (a React UI over the Rust core) and the official WireGuard tunnel service. On Linux the same app is for admins only; Linux computers can be protected as home-network devices behind the gateway.

The website uses a single admin password to manage policy. A client has the rules and the time budget. The apps take the dashboard's setup code (a QR code under **Devices**) and sign in with that client's username and password, without OAuth or a separate rules picker. Stored user passwords are salted hashes, and apps persist only scoped device credentials. Data lives in SQLite in the data directory by default, or in PostgreSQL when `TEMPERANCE_DATABASE_URL` points to one. Apple VPN builds require your signing team and entitlements for installation. Android debug APKs are test artifacts. Unmanaged-device VPN removal and comprehensive encrypted-DNS/content filtering remain limitations. The repository includes CI build artifacts and end-to-end tests with real encrypted traffic. Version tags publish a GitHub release with the server packages and client apps, then the matching container image on Docker Hub; they do not provision a server or publish app-store releases.

## Run locally

The web service is the Next.js app in [`web/`](web) and needs Node.js 24 or newer:

```sh
cd web && npm ci
cp .env.example .env.local   # set the two tokens; SQLite is the default database
npm run dev
```

Open **http://127.0.0.1:3000**, sign in with `TEMPERANCE_ADMIN_PASSWORD`, then add profiles and devices. To run the VPN gateway too, build the add-on once (`npm run build:gateway`, needs Rust) and set `TEMPERANCE_GATEWAY_LISTEN=0.0.0.0:51820`. See [docs/deployment.md](docs/deployment.md) to install it as a service, including DNS and router modes for devices on a home network.

## Run at home

The recommended setup is a dedicated, always-on Linux machine, such as a Raspberry Pi 4/5 with a 64-bit OS or a mini PC, running the server package from a [GitHub release](https://github.com/MisterTea/temperance/releases):

```sh
sudo apt install ./temperance_<version>_arm64.deb   # or _amd64; .rpm and a tarball are there too
```

It runs as a systemd service, creates `/etc/temperance/temperance.env` with a generated admin password, and supports every feature, including the Wi-Fi access point and router modes for TVs and consoles. [docs/deployment.md](docs/deployment.md) covers configuration, updates, port forwarding and HTTPS, plus native installers for macOS and Windows.

## Run with Docker

If you already run a Linux server or a NAS with Docker (Synology, Unraid, TrueNAS), you can install the published image (amd64 and arm64) with Docker Compose instead. It covers the VPN, UPnP and dynamic DNS; the access point and router modes need the server package.

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/MisterTea/temperance/main/deploy/docker/install.sh)"
```

The installer asks for your public hostname, timezone and HTTPS method. It writes `~/temperance/compose.yml` and a `.env` with a generated admin password, then starts the containers and waits for them to report healthy. Unless you answer no, it also starts an `updater` container ([Watchtower](https://github.com/nicholas-fedor/watchtower)), so **Settings → Software updates** in the dashboard installs new versions with one click; updates require an encrypted recovery snapshot first. Fresh installs generate a recovery passphrase in `.env`; save it separately and copy archives off the server. Unattended polling is disabled. Rerun the installer to upgrade by hand, or to turn the updater on for an older install. To set it up by hand, copy [`deploy/docker/compose.yml`](deploy/docker/compose.yml) and [`deploy/docker/.env.example`](deploy/docker/.env.example) (as `.env`) into one directory and run `docker compose up -d`.

Client devices and admin phones reach home only through the gateway's UDP port, so HTTPS is optional. To also open the dashboard in any browser away from home, `.env` picks a front end with `COMPOSE_PROFILES`:

- `caddy`: Caddy gets a Let's Encrypt certificate for `TEMPERANCE_PUBLIC_URL`.
- `cloudflared`: a Cloudflare Tunnel; route its public hostname to `http://localhost:8788`.
- Empty (the default if you don't need it): no front end, or point your own reverse proxy at the dashboard port.

The containers use the host's network (`network_mode: host`), so the gateway's UPnP request reaches the router and names the host's LAN address. The dashboard stays on `127.0.0.1:8788` (`TEMPERANCE_DASHBOARD_ADDRESS` and `TEMPERANCE_DASHBOARD_PORT`), and the updater's API on `127.0.0.1:8790`. Host networking needs a Linux host; on Docker Desktop for macOS or Windows, turn on **Settings → Resources → Network → Enable host networking** first.

### Port forwarding with Docker

Phones and laptops reach the gateway from outside your home, so their packets go from your router to the Docker host, where the container listens directly:

```
internet ──UDP 51820──▶ router ──UDP 51820──▶ Docker host (192.168.1.20) = container :51820
```

1. **Give the Docker host a fixed LAN address.** Reserve one in your router's DHCP settings. With Docker Desktop on macOS or Windows, this is the Mac's or PC's own address, not the address of Docker's internal VM.
2. **Let UPnP forward UDP 51820, or forward it by hand** to that address. On a Linux host the gateway asks the router itself; **Settings → Remote access** in the dashboard shows whether that worked. Docker Desktop's VM cannot reach the router by UPnP, so forward the port by hand there. The protocol must be UDP; TCP forwarding does nothing for WireGuard. With `COMPOSE_PROFILES=caddy`, also forward TCP 80 and 443 for the certificate and HTTPS. A Cloudflare Tunnel needs no inbound TCP ports. The [router guide](docs/routers.md) covers TP-Link, eero and Netgear.
3. **Advertise the outside port.** `TEMPERANCE_VPN_ENDPOINT` must be your public hostname (or IPv4 address) with the port the *router* exposes. If 51820 is taken, set `TEMPERANCE_WIREGUARD_PORT=51821` (the gateway then listens on 51821) and use `home.example.net:51821`.
4. **Allow it through the host firewall.** With host networking, `ufw` and `firewalld` apply to Temperance like any other program: allow UDP 51820 (for example `sudo ufw allow 51820/udp`). The dashboard listens on `127.0.0.1` only. On Windows, allow Docker Desktop through Windows Firewall when it asks.
5. **Check it.** `docker compose logs temperance` should print `Temperance gateway on udp 0.0.0.0:51820`. Then turn off Wi-Fi on a phone, connect with the app over mobile data, and confirm the device shows as active in the dashboard. Many routers cannot loop traffic from your own LAN back to the public address, so test from outside the home network.

Port forwarding cannot work if the router's WAN address is private (`10.x`, `100.64–127.x`, `172.16–31.x`, `192.168.x`), which happens behind carrier-grade NAT or a second router. Bridge the ISP modem, ask the ISP for a public IPv4 address, or run the gateway on a VPS (see [docs/deployment.md](docs/deployment.md#remote-gateway-optional)). Podman also works, including rootless Podman; keep the ports above 1024. Rootless Docker does not: its host network is a private namespace that the LAN cannot reach.

The home-network DNS and router modes identify TVs and consoles by their LAN address, which host networking already provides. Router mode also needs `user: "0"` and `cap_add: [NET_ADMIN]`.

DNS and packet filtering cannot stop access through mobile data, other VPNs or DNS-over-HTTPS on devices that are not routed through the gateway. [docs/architecture.md](docs/architecture.md) describes what each control measures and its enforcement limits.

## Development

The web test suite uses OpenSSL to create a temporary certificate for local SMTP integration tests. These tests exercise TLS and authentication against a loopback server and never contact an email provider.

```sh
(cd web && npm run test:coverage)                                # policy service + dashboard (80% gate)
(cd web && npm run build && npx playwright test)                 # feature/UX + layout audits
(cd clients/desktop && npm ci && npm run build && npm run coverage)  # desktop UI (80% gate; the Rust build embeds it)
(cd core && cargo llvm-cov --workspace)                          # Rust core, gateway + desktop
clients/android/gradlew -p clients/android unitTestCoverageCheck  # Android app (Robolectric, 80% gate)
xcodebuild -project clients/apple/Temperance.xcodeproj -scheme TemperanceMac -derivedDataPath build/apple \
  -resultBundlePath build/apple-tests.xcresult -enableCodeCoverage YES CODE_SIGNING_ALLOWED=NO test \
  && clients/apple/coverage.py build/apple-tests.xcresult        # Apple app (80% gate)
sh systest/run.sh                                                # app + server system tests (Docker, Linux)
```

The system tests ([systest/README.md](systest/README.md)) run the real server image and a headless app together in an isolated Docker network. The fake internet there can only be reached through the WireGuard tunnel. They cover enrolling, filtering, time limits with an admin's approval, pause, bedtime and revoking a device.

Every project must keep at least 80% line coverage from its unit tests. In CI the Rust gate applies to each crate separately, and generated UniFFI bindings are left out of the Android and Apple numbers. GitHub Actions run all of these, Playwright on both SQLite and PostgreSQL, the gateway's tunnel test and add-on builds on Linux (x64 and arm64), macOS and Windows, the router-mode test in network namespaces, the desktop UI tests, Tauri installers for Windows (x64 and arm64) and Linux, the Android APK and the unsigned macOS/iOS apps.

Gateway layout (`core/temperance-gateway`): `wg.rs` runs WireGuard peers, `gateway.rs` admits packets, relays TCP/UDP flows and holds the policy lease, `policy.rs` turns the service's state document into per-flow verdicts with `temperance-core`, `dns.rs` filters and forwards DNS, `home.rs` generates router-mode nftables rules, `reach.rs` maps the VPN port on the router with UPnP and updates Dynu dynamic DNS, `node.rs` is the Node add-on, and `bin/temperance-gateway.rs` is the standalone CLI.

## Release readiness

Settings includes server readiness, redacted support reports, SMTP delivery tests and failed-notice retry, recovery downloads and feed freshness. Update progress and outcomes survive dashboard reloads. Encrypted recovery runs daily when configured and before dashboard updates. Stable and beta update channels are separate.

Physical-device qualification, signed distribution, independent security review, household trials, IPv6 network qualification, and native push remain tracked in the [release checklist](docs/beta-readiness.md). Automated tests do not satisfy those release gates.

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [MIT](LICENSE).
