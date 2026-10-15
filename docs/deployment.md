> Beta reference setup: Linux with Docker and SQLite. Other deployment modes below remain experimental until their acceptance records pass. See [beta operations and recovery](beta-operations.md).

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

`sh -c "$(curl -fsSL https://raw.githubusercontent.com/MisterTea/temperance/main/deploy/docker/install.sh)"` installs the `mistertea/temperance` image (amd64 and arm64) with Docker Compose in `~/temperance`. It can also run Caddy or a Cloudflare Tunnel for HTTPS. See [Run with Docker](../README.md#run-with-docker) in the README for the manual setup and for port forwarding through Docker. Data, including the gateway key, lives in the `temperance-data` volume (`/data` in the container). To build the image from a checkout instead, run `docker compose -f deploy/docker/compose.yml -f deploy/docker/compose.build.yml up -d --build`.

### Any OS: from a checkout

You need Node.js 24 or newer and a checkout of this repository. These installers build the web app, include the gateway add-on, register a service that starts at boot, and create an environment file with a generated admin password. Put a prebuilt add-on from the CI `gateway-<platform>` artifact at `web/gateway-addon/temperance-gateway.<platform>-<arch>.node` to skip the Rust build; otherwise install Rust (`rustup`) first.

| OS | Command | Data, settings and secrets |
| --- | --- | --- |
| Linux (systemd) | `sudo deploy/home/install-linux.sh` | `/var/lib/temperance`, `/etc/temperance/temperance.env` |
| macOS (launchd) | `deploy/home/install-macos.sh` | `~/Library/Application Support/Temperance` |
| Windows (service) | `powershell -ExecutionPolicy Bypass -File deploy\home\install-windows.ps1` (elevated) | `%ProgramData%\Temperance` |

On macOS the service is a launch agent of the signed-in user, so enable automatic login on a dedicated Mac. The Windows installer runs Node under [WinSW](https://github.com/winsw/winsw) and opens UDP 51820 in Windows Firewall; rerun it after editing the environment file.

Edit the environment file (see `deploy/.env.example`):

- `TEMPERANCE_PUBLIC_URL` — the address you open the dashboard at, such as `http://192.168.1.20:3000` (step 3).
- `TEMPERANCE_VPN_ENDPOINT` — `host:51820`, where `host` is your public IPv4 address or, better, a dynamic DNS name that follows it, such as `myhome.ddnsfree.com:51820`. Temperance can keep a free [Dynu](https://www.dynu.com/) name up to date itself (dashboard **Settings → Remote access**, see the [router guide](routers.md#dynamic-dns-with-dynu)); your router's DDNS feature, DuckDNS or Cloudflare work too. Clients resolve the name again when the address changes. The port is the one the router exposes, and the gateway asks the router to forward that port.
- `TEMPERANCE_TIMEZONE` — the family's IANA timezone.
- `TEMPERANCE_GATEWAY_LISTEN` — `0.0.0.0:51820` to run the embedded gateway. Leave it unset only when a separate gateway host runs the CLI (below).

Restart the service after changes (`sudo systemctl restart temperance`; on macOS `launchctl kickstart -k gui/$(id -u)/org.temperance.server`).

Data lives in SQLite at `<data dir>/temperance.sqlite3` unless `TEMPERANCE_DATABASE_URL` points to PostgreSQL (`postgres://user:pass@host:5432/temperance`). The gateway's private key is created on first start at `<data dir>/gateway.key` (mode 600), and its public key is handed to clients automatically; set `TEMPERANCE_GATEWAY_PRIVATE_KEY` to supply one instead. Next to it, `<data dir>/parent.key` is the gateway's key for [admin devices](remote-parents.md), which reach the dashboard over the same UDP port. The file keeps the name `parent.key`. The embedded gateway forwards their requests to the dashboard with a secret generated at each start (`TEMPERANCE_FORWARD_SECRET`; set it yourself only if something else needs it). Client devices use the same key: they sign in and fetch their rules over that port too (step 4). Set `TEMPERANCE_HOUSEHOLD_NAME` to the name admins see after pairing, or `TEMPERANCE_REMOTE_PARENTS=off` to turn admin-device access off (client devices are not affected).

Before tagging a stable release, complete the [release qualification](beta-readiness.md), including signed candidate artifacts and evidence for the exact source. Then push a `v<version>` tag. `.github/workflows/release.yml` then cross-builds the add-ons against glibc 2.28 with `cargo zigbuild` and fails if either needs a newer symbol. It packages them with `deploy/linux/package.sh`, boots the result on Debian 10 and Rocky Linux 8, builds the Linux desktop app, creates the GitHub release with every file and a `SHA256SUMS`, and only then pushes the multi-arch image to Docker Hub (`mistertea/temperance`) and GHCR, tagged with the git tag (`v0.6.0`), the version (`0.6.0`), and `latest` or `beta`. A `vX.Y.Z-beta.N` tag without passing evidence still publishes, as a prerelease marked as an unqualified preview: the workflow builds a debug-signed Android APK and unsigned Windows installers itself, and there are no Apple builds. Stable households never see prereleases or the `beta` image. Running `deploy/linux/package.sh` locally (after `npm run build` in `web/`) produces the same files in `dist/`; it needs `nfpm` for the `.deb` and `.rpm`.

### Updating

The dashboard footer shows the running version, and **Settings → Software updates** says when a newer release exists. To find out, the server asks the GitHub releases API every six hours, sending nothing but its version; set `TEMPERANCE_UPDATE_CHECK=off` to stop that. Development builds (from a checkout between tags) never report themselves as outdated.

- **Docker with the updater:** choose **Update to …**. The dashboard asks the `updater` container (Watchtower, enabled with `COMPOSE_PROFILES=updater` and a `TEMPERANCE_UPDATER_TOKEN` in `.env`) to pull the new image and recreate the Temperance container. Data in the volume is kept, and the page reconnects when the new version is up. The updater only touches the Temperance container, and only it can reach the Docker socket; its API is not published outside the Compose network. Unattended Watchtower polling is disabled so updates cannot bypass the required pre-update recovery snapshot. Configure `TEMPERANCE_BACKUP_PASSPHRASE` first.
- **Docker without the updater:** `docker compose pull && docker compose up -d` in the install folder, or rerun the installer.
- **Linux packages and tarball:** download the new release and install it over the old one (the commands are in the table above, and the dashboard shows them for this machine's architecture). The service unit cannot write its own program files, so it does not update itself.
- **From a checkout:** `git pull`, then rerun the installer you used.

Internet access through the embedded gateway stops while Temperance restarts. Devices keep their VPN configuration and reconnect when the gateway is available.

## 2. Forward UDP 51820

**UDP 51820** is the only port that must be open to the internet. It carries the family VPN, client devices signing in and fetching their rules, and [admin devices](remote-parents.md) opening the dashboard away from home. Reserve the Temperance machine's LAN address in DHCP so it does not change.

The gateway asks the router to forward the port with UPnP, renews the mapping every 20 minutes and removes it on shutdown. Check **Settings → Remote access** in the dashboard: a green status line means it worked. If the router has UPnP turned off or does not support it, forward the port by hand. The [router guide](routers.md) has step-by-step instructions for TP-Link (Archer and Deco), Amazon eero and Netgear (Nighthawk and Orbi) routers. UPnP can be turned off on the same page.

If your router's own internet address is private (`10.x`, `100.64–127.x`, `172.16–31.x`, `192.168.x`), there is another router in front of it or your ISP uses carrier-grade NAT; the dashboard warns about this. Bridge the ISP's box, ask the ISP for a public address, or run the gateway on a small VPS with the CLI (below).

## 3. The dashboard on your home network

The server listens on port 3000. Anyone on the home network can open it over plain HTTP at the server's LAN name or address (for example `http://192.168.1.20:3000`); sign-in only checks that the page came from the address the browser used. No certificate or domain is needed: client devices never use this port, and [admin devices](remote-parents.md) reach the dashboard from anywhere through the gateway. Do not forward port 3000 to the internet as plain HTTP. If you also want to open the dashboard in any browser away from home, put HTTPS in front of it:

- **Cloudflare Tunnel** (no inbound port): `cloudflared tunnel --url http://localhost:3000`, or a named tunnel routing your hostname to `http://localhost:3000`. Set `TEMPERANCE_PUBLIC_URL` to that hostname.
- **Caddy** (automatic Let's Encrypt): forward TCP 80 and 443 too, and use `deploy/Caddyfile` with `TEMPERANCE_POLICY_HOST` set to your hostname and `TEMPERANCE_UPSTREAM=127.0.0.1:3000`. The Docker setup includes both of these as optional services.

Client devices reach home only through the gateway's UDP port, so they can always ask for more time, even while paused: inside the tunnel they talk to `10.77.0.1`, and before the tunnel is up (or when it can't connect) they use QUIC with the gateway's pinned key. The gateway also exempts the `TEMPERANCE_PUBLIC_URL` and `TEMPERANCE_VPN_ENDPOINT` hostnames from filtering.

## 4. First run

Open the dashboard, sign in once with the admin password to create the owner account, then add a client. A client has the rules and the time budget. Add a username and password on that client so a phone can sign in. Then open **Devices**: once the gateway has started, **Set up a client's device** shows a QR code and a **Copy setup code** button. The setup code (`temperance://home#…`) carries your `TEMPERANCE_VPN_ENDPOINT` and the gateway's key; it is not a secret, but it only works with the client's username and password. On the client's device, scan the code (Android, iPhone) or paste it (Mac, Windows), sign in, allow the VPN, and test browsing, pause, bedtime, filtering and budgets before setting up other devices.

## Home-network devices (TVs, consoles, speakers)

Devices that cannot run the VPN app are added under **Devices → Add a home-network device**, and only while the access point is on. Temperance chooses an address on that subnet and shows how to type that address, the subnet mask, the router and the DNS server into the device. The device is set up by hand, so the network does not hand out addresses.

- **DNS mode** (any OS): set `TEMPERANCE_GATEWAY_HOME_DNS=0.0.0.0:53` and `TEMPERANCE_GATEWAY_LAN_NETWORKS=192.168.1.0/24`, then hand out the server's LAN address as the DNS server in DHCP. Domain rules, categories, SafeSearch/YouTube restrictions, pause, bedtime and schedules apply to lookups from devices you add on the dashboard, and history is recorded for those devices. An address you have not added is forwarded unfiltered. Port 53 needs `CAP_NET_BIND_SERVICE` on Linux (the systemd unit grants it) and is free on macOS and Windows unless another resolver uses it.
- **Router mode** (Linux only): also set `TEMPERANCE_GATEWAY_ROUTER=eth1,192.168.1.2,eth0` (LAN interface, the server's LAN address, uplink interface), enable `net.ipv4.ip_forward=1`, install `nftables`, and make the server the LAN's default gateway in DHCP. Forwarded traffic of registered devices is then leased like VPN peers: pause, bedtime, Off Time, daily and category/site budgets, and strict allow-lists stop packets, DNS on port 53 is redirected to Temperance, DNS-over-TLS is blocked, and usage minutes are counted. Temperance manages only its own `temperance_home` and `temperance_home_nat` tables and masquerades only registered devices.
- **Access point** (Linux only): set `TEMPERANCE_GATEWAY_AP=wlan0;192.168.50.1/24;Temperance;a-long-password` (interface, its address, network name, WPA2 password). Temperance starts hostapd on 5 GHz channel 165 (20 MHz, clear of the usual 80 MHz home-router channels) and — unless `TEMPERANCE_GATEWAY_HOME_DNS=off` — answers DNS at that address. Registered devices on the access point are routed and counted the same way as router mode, using the machine's default-route interface as the uplink. Install `hostapd`. The network name is 1–32 bytes and the password is 8–63 characters. Add each device in the dashboard and set the address it shows on the device. Unregistered devices are not forwarded to the internet.

Like VPN peers, home devices fail closed: if the server stops or its policy lease (15 seconds) lapses, their internet access through Temperance stops. A device can evade DNS mode with a hard-coded resolver or encrypted DNS; router mode closes plain and TLS DNS, but not DNS-over-HTTPS.

## Remote gateway (optional)

The dashboard can run elsewhere (for example on Vercel with PostgreSQL, see `web/README.md`) while a home or VPS machine runs only the gateway:

```sh
cd core && cargo build --release -p temperance-gateway --features cli
TEMPERANCE_GATEWAY_TOKEN='same as the service' target/release/temperance-gateway \
  --service https://temperance.example.com --key-file /var/lib/temperance/gateway.key
```

It prints its public key; set `TEMPERANCE_VPN_PUBLIC_KEY` on the service to that value. It polls `/v1/gateway/state` and posts activity every 5 seconds. `--home-dns`, `--lan-network` and `--router-*` enable the home-network modes. The dashboard's UPnP and Dynu settings reach the CLI with the state; pass `--public-port` when the router exposes a different port than `--listen`. Add `--parent-key-file /var/lib/temperance/parent.key`: client devices sign in and fetch their rules through it, and so do [admin devices](remote-parents.md). The CLI forwards their requests to `--service`, authenticated with `TEMPERANCE_GATEWAY_TOKEN`. Without it there is no setup code and devices can't sign in.

## Backups and secrets

Back up the data directory: `temperance.sqlite3` (stop the service, or use `sqlite3 temperance.sqlite3 ".backup copy.sqlite3"`) or your PostgreSQL database with `pg_dump`, and `gateway.key` and `parent.key`. The dashboard's Settings page also downloads a backup. Losing the database requires re-enrollment; losing the gateway key requires re-provisioning devices; losing `parent.key` requires setting up client devices and pairing admin phones again, since they pin it. Rotate a compromised admin password or gateway token in the environment file and restart. Revoke individual devices with the dashboard's Remove action, and admin phones with **Revoke** under **Devices → Admin devices**. After ten wrong admin passwords from one address (or a hundred overall) in 15 minutes, sign-in pauses for up to 15 minutes. Do not use the VPN subnet `10.77.0.0/24` elsewhere on your network.
