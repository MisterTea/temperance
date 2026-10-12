# Run Temperance at home

Temperance is one program: the Next.js dashboard and policy API with the WireGuard gateway embedded as a native add-on (`core/temperance-gateway`). Run it on an always-on machine at home — a mini PC, a Raspberry Pi 4/5, a Mac mini, or a Windows PC — and phones and laptops tunnel back to it from anywhere. The gateway is a userspace WireGuard and TCP/UDP relay: it needs no root, no kernel module and no firewall changes, on Linux, macOS and Windows alike.

## 1. Install

### Linux: release packages

Each [GitHub release](https://github.com/MisterTea/temperance/releases) has ready-to-run builds for x64 and arm64 (Raspberry Pi 4/5 with a 64-bit OS). They include their own Node.js and need glibc 2.28 or newer: Debian 10+, Ubuntu 20.04+, RHEL/Rocky/Alma 8+, Fedora, openSUSE Leap 15.3+, Raspberry Pi OS (64-bit) and most others. Alpine (musl) is not supported; use the container image there.

| Format | Install |
| --- | --- |
| Debian, Ubuntu, Raspberry Pi OS | `sudo apt install ./temperance_<version>_arm64.deb` (or `_amd64`) |
| Fedora, RHEL, openSUSE | `sudo dnf install ./temperance-<version>-1.x86_64.rpm` (or `.aarch64`; `zypper install` on openSUSE) |
| Any distribution with systemd | `tar xzf temperance-<version>-linux-x64.tar.gz && sudo ./temperance-<version>-linux-x64/install.sh` |

All of them run the same service. The packages and the tarball install to `/opt/temperance`, start `temperance.service` as an unprivileged dynamic user, and create `/etc/temperance/temperance.env` with a generated admin password on first install. Upgrades keep your settings, data and gateway key, and so does removal. Verify downloads against the release's `SHA256SUMS`.

### Docker (any OS, NAS boxes)

`sh -c "$(curl -fsSL https://raw.githubusercontent.com/MisterTea/temperance/main/deploy/docker/install.sh)"` installs the `ghcr.io/mistertea/temperance` image (amd64 and arm64) with Docker Compose in `~/temperance`. It can also run Caddy or a Cloudflare Tunnel for HTTPS. See [Run with Docker](../README.md#run-with-docker) in the README for the manual setup and for port forwarding through Docker. Data, including the gateway key, lives in the `temperance-data` volume (`/data` in the container). To build the image from a checkout instead, run `docker compose -f deploy/docker/compose.yml -f deploy/docker/compose.build.yml up -d --build`.

### Any OS: from a checkout

You need Node.js 24 or newer and a checkout of this repository. These installers build the web app, include the gateway add-on, register a service that starts at boot, and create an environment file with a generated admin password. Put a prebuilt add-on from the CI `gateway-<platform>` artifact at `web/gateway-addon/temperance-gateway.<platform>-<arch>.node` to skip the Rust build; otherwise install Rust (`rustup`) first.

| OS | Command | Data, settings and secrets |
| --- | --- | --- |
| Linux (systemd) | `sudo deploy/home/install-linux.sh` | `/var/lib/temperance`, `/etc/temperance/temperance.env` |
| macOS (launchd) | `deploy/home/install-macos.sh` | `~/Library/Application Support/Temperance` |
| Windows (service) | `powershell -ExecutionPolicy Bypass -File deploy\home\install-windows.ps1` (elevated) | `%ProgramData%\Temperance` |

On macOS the service is a launch agent of the signed-in user, so enable automatic login on a dedicated Mac. The Windows installer runs Node under [WinSW](https://github.com/winsw/winsw) and opens UDP 51820 in Windows Firewall; rerun it after editing the environment file.

Edit the environment file (see `deploy/.env.example`):

- `TEMPERANCE_PUBLIC_URL` — the HTTPS address of your dashboard (step 3).
- `TEMPERANCE_VPN_ENDPOINT` — `host:51820`, where `host` is your public IPv4 address or, better, a dynamic DNS name that follows it (your router's DDNS feature, DuckDNS, Cloudflare, …). Clients resolve the name again when the address changes.
- `TEMPERANCE_TIMEZONE` — the family's IANA timezone.
- `TEMPERANCE_GATEWAY_LISTEN` — `0.0.0.0:51820` to run the embedded gateway. Leave it unset only when a separate gateway host runs the CLI (below).

Restart the service after changes (`sudo systemctl restart temperance`; on macOS `launchctl kickstart -k gui/$(id -u)/org.temperance.server`).

Data lives in SQLite at `<data dir>/temperance.sqlite3` unless `TEMPERANCE_DATABASE_URL` points to PostgreSQL (`postgres://user:pass@host:5432/temperance`). The gateway's private key is created on first start at `<data dir>/gateway.key` (mode 600), and its public key is handed to clients automatically; set `TEMPERANCE_GATEWAY_PRIVATE_KEY` to supply one instead.

To cut a release, push a `v<version>` tag. `.github/workflows/release.yml` then cross-builds the add-ons against glibc 2.28 with `cargo zigbuild` and fails if either needs a newer symbol. It packages them with `deploy/linux/package.sh`, boots the result on Debian 10 and Rocky Linux 8, publishes the multi-arch image, and attaches the files to the release. Running `deploy/linux/package.sh` locally (after `npm run build` in `web/`) produces the same files in `dist/`; it needs `nfpm` for the `.deb` and `.rpm`.

## 2. Forward UDP 51820

In your router's admin page, forward **UDP 51820** to the Temperance machine's LAN address, and reserve that address in DHCP so it does not change. This is the only port that must be open to the internet. If your ISP uses carrier-grade NAT (no public IPv4), ask for a public address or run the gateway on a small VPS with the CLI (below).

## 3. HTTPS for the dashboard

The server listens on port 3000. Do not forward it as plain HTTP. Choose one:

- **Cloudflare Tunnel** (no inbound port): `cloudflared tunnel --url http://localhost:3000`, or a named tunnel routing your hostname to `http://localhost:3000`. Set `TEMPERANCE_PUBLIC_URL` to that hostname.
- **Caddy** (automatic Let's Encrypt): forward TCP 80 and 443 too, and use `deploy/Caddyfile` with `TEMPERANCE_POLICY_HOST` set to your hostname and `TEMPERANCE_UPSTREAM=127.0.0.1:3000`. The Docker setup includes both of these as optional services.

Enrolled devices can always reach the dashboard and policy API, even while paused: the gateway exempts the `TEMPERANCE_PUBLIC_URL` and `TEMPERANCE_VPN_ENDPOINT` hostnames from filtering, and `http://10.77.0.1` inside the tunnel is the local dashboard.

## 4. First run

Open the dashboard, sign in once with the admin password to create the owner account, create a family profile, and create an enrollment code. Enroll a test device, start its VPN, and test browsing, pause, bedtime, filtering and budgets before enrolling other devices.

## Home-network devices (TVs, consoles, speakers)

Devices that cannot run the VPN app are added under **Devices → Add a home-network device** with the private IPv4 address you reserved for them in DHCP.

- **DNS mode** (any OS): set `TEMPERANCE_GATEWAY_HOME_DNS=0.0.0.0:53` and `TEMPERANCE_GATEWAY_LAN_NETWORKS=192.168.1.0/24`, then hand out the server's LAN address as the DNS server in DHCP. Domain rules, categories, SafeSearch/YouTube restrictions, pause, bedtime and schedules apply to lookups, and history is recorded per device. Devices you have not registered follow the Home profile if one is set, otherwise their lookups are forwarded unfiltered. Port 53 needs `CAP_NET_BIND_SERVICE` on Linux (the systemd unit grants it) and is free on macOS and Windows unless another resolver uses it.
- **Router mode** (Linux only): also set `TEMPERANCE_GATEWAY_ROUTER=eth1,192.168.1.2,eth0` (LAN interface, the server's LAN address, uplink interface), enable `net.ipv4.ip_forward=1`, install `nftables`, and make the server the LAN's default gateway in DHCP. Forwarded traffic of registered devices is then leased like VPN peers: pause, bedtime, Off Time, daily and category/site budgets, and strict allow-lists stop packets, DNS on port 53 is redirected to Temperance, DNS-over-TLS is blocked, and usage minutes are counted. Temperance manages only its own `temperance_home` and `temperance_home_nat` tables and masquerades only registered devices.

Like VPN peers, home devices fail closed: if the server stops or its policy lease (15 seconds) lapses, their internet access through Temperance stops. A device can evade DNS mode with a hard-coded resolver or encrypted DNS; router mode closes plain and TLS DNS, but not DNS-over-HTTPS.

## Remote gateway (optional)

The dashboard can run elsewhere (for example on Vercel with PostgreSQL, see `web/README.md`) while a home or VPS machine runs only the gateway:

```sh
cd core && cargo build --release -p temperance-gateway --features cli
TEMPERANCE_GATEWAY_TOKEN='same as the service' target/release/temperance-gateway \
  --service https://temperance.example.com --key-file /var/lib/temperance/gateway.key
```

It prints its public key; set `TEMPERANCE_VPN_PUBLIC_KEY` on the service to that value. It polls `/v1/gateway/state` and posts activity every 5 seconds. `--home-dns`, `--lan-network` and `--router-*` enable the home-network modes.

## Backups and secrets

Back up the data directory: `temperance.sqlite3` (stop the service, or use `sqlite3 temperance.sqlite3 ".backup copy.sqlite3"`) or your PostgreSQL database with `pg_dump`, and `gateway.key`. The dashboard's Settings page also downloads a backup. Losing the database requires re-enrollment; losing the gateway key requires re-provisioning clients. Rotate a compromised admin password or gateway token in the environment file and restart. Revoke individual devices with the dashboard's Remove action. Do not use the VPN subnet `10.77.0.0/24` elsewhere on your network.
