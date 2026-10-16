# VPN architecture and protocol

```mermaid
flowchart LR
  Admin[Admin dashboard] -->|Authenticated updates| Control[Next.js policy service + SQLite/PostgreSQL]
  App[Temperance device app] -->|Full-tunnel WireGuard, UDP 51820| Gateway[Embedded Rust gateway]
  App -->|Sign-in + policy status: inside the tunnel, or pinned QUIC on UDP 51820| Gateway
  Gateway -->|Device routes only| Control
  Control <-->|In-process state + activity every 5 seconds| Gateway
  Gateway --> DNS[Profile-aware DNS]
  Gateway --> Flows[Per-flow TCP/UDP relay: pause / bedtime / budgets]
  Flows --> Internet
```

Temperance is one program: the Next.js policy service in `web/` with the WireGuard gateway (`core/temperance-gateway`) loaded as a native Node add-on. `web/src/instrumentation.ts` starts it when `TEMPERANCE_GATEWAY_LISTEN` is set, and `web/src/lib/gateway.ts` hands it the gateway state document and accounts its activity every 5 seconds. The same crate builds a standalone `temperance-gateway` CLI that speaks the `/v1/gateway/*` API to a service hosted elsewhere. The policy rules themselves live in `core/temperance-core`, shared with the device apps and checked against `specs/policy-cases.json` alongside the TypeScript implementation. Devices generate private keys locally; only public keys are enrolled. An admin creates a random enrollment code for one client. It expires after 10 minutes and is consumed atomically with enrollment. The response contains a scoped device token, assigned tunnel addresses, gateway public key, endpoint, policy version, and current policy. Device tokens are stored as hashes at the service. Codes and keys are never embedded in repository configuration.

An instance manages one household and one WireGuard gateway, with up to 253 lifetime IPv4 assignments. Revoked addresses are not reused. Deploy separate instances for separate households. Profile/device changes increment the monotonic policy version. Device tokens only read that device's state; gateway and admin tokens have distinct privileges.

Client accounts sign in with a username and password. Passwords are never stored: each is a salted PBKDF2-HMAC-SHA256 hash (600,000 iterations, WebCrypto, so it runs on Node, Vercel, and Cloudflare). Ten consecutive failures lock an account for 15 minutes. Browser sessions and OAuth access tokens are the same HMAC-signed, one-hour token bound to the account's session version, so a password change or account removal revokes them; refresh tokens are random, stored only as SHA-256 hashes, and rotated on every use. The admin adds those sign-ins from the dashboard, which itself uses the admin password. `TEMPERANCE_ADMIN_TOKEN` creates the first owner and remains a bearer credential for automation. Deploy the control plane behind HTTPS; it does not implement its own certificate issuance.

The gateway runs WireGuard in userspace (boringtun) and terminates each peer's TCP and UDP flows in a userspace network stack, opening its own outbound sockets for allowed ones. It needs no root, TUN device, kernel module or firewall rules, so it runs the same way on Linux, macOS and Windows. A decrypted packet is accepted only when its source is the sending peer's own `/32`, which binds every tunnel address to one WireGuard key. Device routes capture IPv4 and IPv6, but the gateway drops IPv6 and every private/reserved destination (including other peers and your LAN). Its only local services are DNS on `10.77.0.1:53` and the dashboard at `http://10.77.0.1`.

Every flow is decided when it opens and decided again on every state update (at least every 5 seconds) and every 2 seconds in between. Pause, bedtime, Off Time, strict allow-lists and budget exhaustion therefore close existing connections as well as refusing new ones. Policy is held under a 15-second lease renewed by each state update: if the update loop stops, forwarding stops. The embedded gateway shares the service's process, so a service outage is a gateway outage. A standalone CLI that loses its service keeps enforcing its last policy within the configured offline grace, with schedules evaluated live; budgets do not advance until the service is back, and buffered activity is reported then. Device revocation propagates on the next state update by removing the WireGuard peer.

Usage is **observed allowed network minutes**, not foreground screen time. The gateway records, per device and minute, the buckets (total, category, site, app group) of the destinations it carried traffic to, using the names it resolved for that device. A name stays attached to an address for its DNS answer's lifetime and for 10 minutes after the device last exchanged traffic with that address, so a stream that outlives the answer, or a reconnect from a cached answer, keeps its category. Only allowed traffic extends an attribution: a blocked address lapses with its DNS answer, so an allowed site on a shared address is never locked out for long. These attributions are saved to `destinations.json` in the data directory every minute and at shutdown, so a restart or upgrade keeps them, and none outlives the longest DNS lifetime plus 10 minutes. A restart never costs a client time: only carried traffic counts, so downtime is never charged, and a minute reported both before and after a restart counts once. A restart can at most give back a little time, from the minute in progress when it stopped. A bucket counts only after 32 KB in that minute, so pings and keepalives are not charged; the service then counts each qualifying minute once per profile and bucket, even for simultaneous devices. Handshakes, DNS and refused traffic do not count. A reached budget closes traffic at the next state update. **Free domains** (Settings, seeded with OS and app-store updates, push notifications, connectivity checks, time sync and certificate checks for Android and its manufacturers, Apple, Windows, Linux and game consoles) never count, stay out of history, and remain reachable after a budget runs out or during focus time and allow-lists. Pause, bedtime, Off Time and a client's own blocked sites still apply. An address counts if the device also resolved a non-free name to it, so a CDN shared with video does not become free.
The gateway answers DNS itself and forwards allowed queries upstream (`TEMPERANCE_GATEWAY_DNS_UPSTREAM`, default 1.1.1.1). DNS sent to any other resolver on port 53 is answered by the gateway as well, and port 853 (DNS-over-TLS) is refused. Domain filtering refuses names before forwarding; SafeSearch and YouTube Restricted Mode answer the original name with the addresses of the restricted endpoint. The video and social categories list each service's own app, API and media CDN domains (`nflxvideo.net`, `googlevideo.com`, `tiktokcdn-us.com`) so streamed minutes count against the right limit. YouTube has its own category within Video & streaming: its minutes count toward both budgets, so YouTube can have a smaller budget inside the video one; blocking YouTube leaves other streaming alone, while blocking video (or allowing it during focus time) covers YouTube too. The other starter category lists remain small, and importing a feed for a category replaces its built-in list. DNS over HTTPS, direct IP connections, shared CDNs, VPN/proxy overlays, and cached DNS can bypass domain/category filtering. **The implementation does not claim comprehensive web content filtering.** Pause/bedtime/budgets still deny entire connections even in these cases. The dashboard and VPN endpoint hostnames are exempt from policy so devices can reach their status and ask for more time while blocked.

Home-network devices are enforced in DNS mode (any OS: the gateway answers their DNS on the LAN) or Linux router mode, where the gateway manages its own `temperance_home` and `temperance_home_nat` nftables tables with the same 15-second lease, per-device counters, DNS redirection and masquerading of registered devices only. It never touches other firewall tables.

Network enforcement applies while devices route through this VPN. Preventing VPN removal, route changes, another VPN, and off-tunnel access requires OS-level administration: Android always-on lockdown/device owner; Apple managed-device restrictions; restricted desktop accounts and host firewall policy. The application alone cannot take ownership of an unmanaged personal device. Apple on-demand connection is automatic reconnection, not a supervised-device always-on guarantee. Linux's systemd tunnel starts at boot; Windows uses the WireGuard tunnel service. macOS/iOS use Network Extension; Android embeds the official GoBackend VPN service.

## API

All JSON writes are bounded to 64 KiB.

Device apps never use the dashboard's TCP port. They reach home only through the gateway's UDP port, using the dashboard's setup code (`temperance://home#` + base64url JSON `{v:1,host,port,pin,household}`): `pin` is the SHA-256 fingerprint of the gateway's QUIC key (the same key [admin devices](remote-parents.md) pin). While the tunnel is up, the core sends plain HTTP to `10.77.0.1:80` inside it, which the gateway splices to the dashboard. Otherwise (signing in, a stale tunnel, a revoked peer) it opens QUIC (`temperance-device/1` ALPN, TLS 1.3) to the gateway and refuses any other key. The gateway forwards only `/v1/enroll` and `/v1/device/*` from that channel, strips forwarding and Temperance headers, and adds the peer's address as `X-Forwarded-For`. Device requests carry their own credential (username/password or device token), so the channel needs no extra key.

| Method | Path | Credential | Purpose |
| --- | --- | --- | --- |
| GET | `/v1/setup` | None | `{needs_setup}` before the first owner exists |
| POST | `/v1/setup` | `TEMPERANCE_ADMIN_TOKEN` as `setup_token` + matching Origin | Create the owner account (once) |
| POST | `/v1/login` | Username + password + matching Origin | One-hour HttpOnly browser session |
| POST | `/v1/logout` | None | Clear the browser session |
| POST | `/v1/oauth/token` | `grant_type=password` (username/password) or `refresh_token` | OAuth 2.0 bearer access token (1 h) + rotating refresh token (30 d) |
| POST | `/v1/oauth/revoke` | Refresh token | Revoke a refresh token |
| GET | `/api/me`, `/api/users` | Admin | Current account; client sign-ins |
| POST | `/api/users`, `/api/users/delete` | Admin | Add / remove client sign-ins |
| POST | `/api/password` | Admin | Change own password (signs out other sessions) |
| GET | `/api/state` | Admin | Dashboard configuration and usage |
| POST | `/api/profiles` | Admin | Create/update a client, increment revision |
| POST | `/api/devices` | Admin | Assign/change device profile |
| POST | `/api/devices/delete` | Admin | Revoke enrolled peer and token, or remove a home-network device |
| POST | `/api/devices/home` | Admin | `{name,profile_id}` → choose an address on the home subnet and register a TV or console |
| POST | `/api/devices/locate` | Admin | Ask a consenting device for its location once |
| POST | `/api/enrollment` | Admin | `{profile_id}` → short-lived one-use code |
| POST | `/v1/enroll` | Enrollment code | `{code,name,public_key}` → device token/state |
| GET | `/v1/device/state` | Device bearer | Its own policy and VPN provisioning |
| POST | `/v1/device/requests` | Device bearer | Ask an admin for more time |
| POST | `/v1/device/location` | Device bearer | Answer a pending location request |
| POST | `/v1/device/diagnostics` | Device bearer | `{issues:[{code,severity,message,action}]}` → device health on the dashboard |
| GET | `/v1/gateway/state` | Gateway bearer | Policies, VPN `peers`, and home-network `lan_devices` |
| POST | `/v1/gateway/activity` | Gateway bearer | `{activity:[{device_id,minute,buckets}],history}` → minute accounting (the embedded gateway calls the same code in-process) |
| GET | `/healthz` | None | Liveness only |

If an enrollment response is lost after a code was consumed, revoke the partial enrollment in the dashboard and enroll again with a fresh code/key. Devices retain VPN configuration when policy status requests fail; they never disconnect merely because a device token was revoked. Removing the corresponding peer at the gateway denies that VPN's data path. A fully revoked device must be reset locally by an admin before enrolling again.

The service retains usage minutes for 30 days. The gateway batches domain decisions to the policy service for the admin history view, excluding unmanaged traffic, keeping at most 500 unsent entries in memory; admin retention and deletion controls apply at the service. Production distribution of compiled apps requires appropriate platform signing and should pin/test dependencies before each release. Third-party WireGuard components retain their upstream licenses; Temperance's own code is MIT.

## Verification

```sh
(cd web && npm run test:coverage)                                # TypeScript, >=80% gate
(cd web && npm run build && npx playwright test)                 # Feature/UX + layout audits
(cd clients/desktop && npm ci && npm run build && npm run coverage)  # Desktop UI, >=80% gate
(cd core && cargo llvm-cov --workspace --fail-under-lines 80)    # Rust core, gateway + desktop
clients/android/e2e/real-server.sh                               # Android app through the real gateway
```

`cargo test -p temperance-gateway` includes an end-to-end tunnel test that needs no privileges: an in-test WireGuard client with its own TCP/IP stack browses through the gateway, gets blocked, runs out of budget, is restored by a reward, and loses access when the policy lease lapses. CI runs it on Linux, macOS and Windows. The Android e2e does the same with the real app on an emulator.

Router mode has a Linux integration test that creates network namespaces, veth links and nftables tables, so it runs only in a disposable VM or privileged container (CI does this on its Ubuntu runner):

```sh
docker build -f deploy/Dockerfile.test -t temperance-test .
docker run --rm --privileged temperance-test
```

It verifies routing and counting a registered home device, DNS redirection and filtering, pause and resume without touching unregistered devices, and failing closed when the lease lapses or the gateway stops. App build and CI jobs separately verify Android APK compilation, macOS/iOS unsigned builds, and Tauri desktop installers for Windows and Linux. Physical-device VPN consent, boot recovery, platform signing, and managed-device lockdown still require device acceptance testing.

## Version-two policy additions

The Next.js dashboard edits day-specific total limits, start-day-anchored overnight bedtime, named Off/Focus windows, category/site quotas, unmanaged exceptions, search restrictions, and midnight-expiring rewards. Focus/strict allow-lists deny unknown destinations and admit only flows to addresses the device resolved from permitted names. Category/site usage comes from admitted flows, and reports are deduplicated by profile/bucket/minute across devices. DNS TTL expiry and shared hosting can affect attribution; multiple domains on one IP may cause conservative overblocking, while an unmanaged exception can permit other content on that same IP. These limits are visible in the feature audit and do not establish comprehensive content inspection.

The gateway's private key is the only secret it stores (`gateway.key`, mode 600, in the data directory). Minute IDs prevent retried activity batches and simultaneous devices from counting twice. The admin chooses a bounded offline grace (0–168 hours) for standalone gateways. Discontinuing a hosting account is recoverable through the MIT source, portable SQL database/backup, and self-hosted VPN rather than an unavailable vendor license server.

The TypeScript API maintains native `/v1/enroll`, `/v1/device/state`, and `/v1/gateway/*` response compatibility. New endpoints include rewards, usage, history/CSV, time requests, notifications, settings, category feeds, backup/import, and profile removal. Native client UI, mobile permissions/location, home routing, shared administration, and full acceptance remain active feature work; see `docs/research/circle-feature-audit.md`.
