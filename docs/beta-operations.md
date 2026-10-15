# Beta operations

The reference beta setup is **one household, Linux, Docker Compose, SQLite**. Android, iOS, macOS and Windows apps are beta targets, pending the physical-device and signed-build evidence in [release readiness](beta-readiness.md). Other server platforms, remote gateways and home-network modes remain experimental.

## Installation and first device

1. Install using the Docker instructions in the README. Keep the data volume persistent and reserve the server's LAN address in your router. Do not use `10.77.0.0/24` on the host, LAN or remote device networks.
2. Forward the configured UDP port. Container UPnP status alone does not establish internet reachability. CGNAT may require a public address from the ISP or a different deployment; a local green check cannot solve it.
3. Open the dashboard, sign in with the generated admin password and create the first client, password and starting rules in the wizard.
4. Install a designated beta app, scan/paste the Devices setup code, sign in and allow the VPN. Do not substitute unsigned Apple builds or Android debug builds for beta distribution.
5. Browse, pause, resume and request/approve extra time. Repeat over mobile data or a separate external network. Under Settings, review Server readiness and test email if configured.
6. Download an encrypted recovery archive, save its passphrase separately and copy the archive off the host. Complete a replacement-host restore drill before relying on the installation.

Usage is **estimated allowed network minutes**, not foreground screen time. Domain/category filtering has encrypted-DNS, direct-IP and shared-hosting limitations. Devices without OS management can disable or uninstall their VPN. DNS-only mode cannot reliably stop existing connections or count activity. The embedded gateway stops carrying traffic when the server stops, including during restart and upgrade.

## Email

Background jobs run automatically with the embedded gateway. A separate persistent Node policy server must opt in with `TEMPERANCE_MAINTENANCE=on`. Request-scoped serverless and Worker deployments do not run these jobs.

Set `TEMPERANCE_SMTP_HOST`, `TEMPERANCE_SMTP_PORT` (default 587), `TEMPERANCE_SMTP_FROM`, `TEMPERANCE_SMTP_TO` and optional `TEMPERANCE_SMTP_USER` / `TEMPERANCE_SMTP_PASSWORD` in `.env`, then recreate the container so it receives the new environment. There is one recipient. Port 465 uses TLS; other ports require STARTTLS and valid certificates. For a private mail server, optionally set `TEMPERANCE_SMTP_CA_FILE` to a PEM trust bundle mounted read-only inside the container. Certificate and hostname verification remain enabled. Back up this external file separately: recovery archives preserve its configured path, not the file itself. SMTP configuration is operator controlled and is never returned by an API.

Use **Settings → Send test email**. New requests, device changes, health problems and administration/network events produce generic notices without names, browsing history, request text, locations or credentials. Open the dashboard or paired admin app to act; messages contain no approval token.

Enabling mail skips historical events. Delivery reservations and results persist in SQLite. The worker polls once a minute, sends at most five queued messages per tick and retries failures up to five times with backoff. Settings shows pending/exhausted deliveries and generic errors. Use **Retry failed email** in Settings after correcting the delivery problem; this requeues exhausted notices and preserves their Message-ID. Delivered notices are not requeued. Ordinary ticks do not resend delivered events. SMTP cannot guarantee exactly-once delivery: a crash after acceptance and before the local commit can produce a duplicate with the same Message-ID. New notices come from the retained 500-event history. Queued notices retain only their generic event kind and may outlive that history, allowing a failed delivery to be retried later. The queue is bounded to approximately 1,000 records; it is not a permanent mail archive.

A stopped server cannot send its own outage email. Run a separate uptime monitor against the server. `/healthz` is public liveness only; `/api/readiness` requires an admin bearer token and checks database access and gateway freshness. Do not expose credentials in public monitor URLs. Add `?report=1` to retrieve a normal dashboard report without a 503 response when a check fails. Docker's health check uses readiness; it does not establish external UDP reachability.

## Category feeds

Set `TEMPERANCE_FEEDS` to a JSON array in `.env`, wrapped in single quotes, for example:

```dotenv
TEMPERANCE_FEEDS='[{"category":"ads","url":"https://your-reviewed-source.example/ads.txt","attribution":"Source maintainer","license":"Source license"}]'
```

The example is a placeholder, not a provisioned feed. Select a maintained source, review its redistribution terms and category accuracy, and record attribution before enabling it. No third-party category corpus is bundled or represented as validated by this release.

Each category accepts one HTTPS source on port 443, reachable by public IPv4, without credentials or redirects. Domain-per-line and conventional hosts-file forms are supported; adblock syntax is not. Lists are bounded at 2 MiB and 20,000 distinct domains per category. Oversized sources require a reviewed smaller subset. Downloads pin the validated DNS address while retaining TLS hostname verification.

The worker checks hourly. It refuses empty, malformed and unexpectedly shrunken lists, preserving the previous list. Settings shows freshness, source attribution and failure status. Automatic refresh replaces manual imports for that category. To correct a false block, use History to allow the domain for the affected client. Starter lists alone do not establish useful category coverage; corpus qualification remains a beta gate.

## Encrypted disaster recovery

Configuration export (`/api/export`) is plaintext and omits gateway key files. Treat it as sensitive and use it only for policy migration. Disaster recovery format **`temperance-recovery`, schema 1**, is separate: a consistent SQLite snapshot, `gateway.key`, `parent.key`, and `TEMPERANCE_*` operator settings, authenticated with AES-256-GCM and a scrypt-derived key. It excludes the recovery passphrase, transient forward secret, old data/database paths and build-version override. Non-Temperance environment values and Docker/front-end settings still require a separate protected copy of the installation `.env` and Compose file.

Set `TEMPERANCE_BACKUP_PASSPHRASE` to a unique passphrase of at least 16 characters and restart. Fresh Docker installs generate it. Keep a copy in a password manager separate from the archives. Daily snapshots keep the most recent seven archives under `/data/backups`, mode 600. **The volume is not offsite storage**: copy archives elsewhere. Backups and encryption run in a separate process to avoid blocking policy refresh. PostgreSQL recovery is not included; use `pg_dump` and separately protect gateway identity and configuration.

Create one manually:

```sh
docker compose exec -T temperance node scripts/recovery.cjs backup
```

Or download an encrypted archive from Settings. To restore, use Node 24+ and the recovery tool from the same release on a trusted machine:

```sh
read -rs TEMPERANCE_BACKUP_PASSPHRASE
export TEMPERANCE_BACKUP_PASSPHRASE
node scripts/recovery.cjs restore /safe/recovery.json /safe/new-data
unset TEMPERANCE_BACKUP_PASSPHRASE
```

The target must not exist. The tool authenticates the archive, checks database integrity and household schema, stages files with restrictive permissions, and refuses to replace existing data. It restores into `/safe/new-data` with `recovery.env` alongside the database and keys. Keep that file private; its dollar escaping targets Docker Compose. Review and merge its settings into a separate installation `.env`, retain the new host's paths/ports/front-end configuration, and supply the separately saved recovery passphrase.

Run a **matching server version** against the restored directory. For Docker, mount it at `/data` and give the container's UID 10001 read/write ownership; do this only on the restored directory. Preserve the public endpoint or update DNS to the replacement host. Never run the original and replacement gateways simultaneously with the same identity. Review changes since the snapshot, especially revoked devices and rotated credentials: an older snapshot restores their earlier state. Revoke or rotate them again before reopening public access. Verify device reconnection, pause/resume, requests, usage and admin pairing before retiring the original. A restore test that merely opens SQLite does not satisfy physical-device acceptance.

## Updates and rollback

The primary image is [`mistertea/temperance`](https://hub.docker.com/r/mistertea/temperance) on Docker Hub. Releases also publish `ghcr.io/mistertea/temperance` as a mirror; existing installations can continue using it. Both registries receive the same multi-platform build and stable/beta tagging rules.

The `:latest` image, the default, always points to the newest release, stable or beta, and the dashboard offers every release to it. To receive only stable releases, set `TEMPERANCE_IMAGE=mistertea/temperance:stable` with `TEMPERANCE_UPDATE_CHANNEL=stable`; for only betas, `:beta` with `beta`. An explicit image version disables dashboard auto-update; a mismatched image/channel also disables it. A tag moves only when its release is the newest of that kind, so publishing an older patch never moves `:latest` backwards.

The dashboard creates a recovery snapshot before asking Watchtower to update. Snapshot failure blocks the update. The server records preparation, dispatch and the final result, so progress survives a dashboard reload. Only one update attempt can run at a time. Starting the requested version confirms success; an unexpected version or a ten-minute deadline records failure and permits a retry. Unattended Watchtower polling is disabled because it bypasses that safety step. Manual replacement also requires taking a backup first. The installer refuses to replace a running installation if its recovery command fails; installations predating the recovery tool need a stopped-service copy of their data volume, `.env` and Compose file before their first upgrade. Do not delete that copy after the first successful boot.

For a failed upgrade: retain the failed volume for investigation, stop the server, restore the pre-update archive into a new directory, and start the **previous exact image version** with that directory. Do not run an older binary against a migrated database and assume migrations are reversible. Verify device connectivity and rules before resuming household use. Keep release notes and old image versions available for this purpose.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No internet on every protected device | Server readiness, gateway policy lease, host internet and storage; the gateway fails closed. |
| Works on home Wi-Fi only | Public endpoint, router UDP forwarding, firewall, CGNAT and an external-network test. |
| One device disconnected | VPN consent/always-on settings, captive portal, last handshake and permission diagnostics. |
| A site is blocked unexpectedly | History rule reason, client exceptions, category source freshness and shared-hosting limits. |
| Requests never reach email | SMTP delivery test, queued/exhausted counts, recipient spam folder and TLS configuration. |
| Update refused | Recovery passphrase, SQLite storage, key files, disk space and image/channel alignment. |

Download the support report from Settings and review it before attaching it to a bug report. It includes versions, platform, local operational counters and aggregate health/counts; it excludes household names, browsing logs, locations, addresses and credentials. Use private reporting for vulnerabilities.

## Emergency VPN shutdown during a server outage

On a protected Android, iPhone/iPad, Mac or Windows client, open **Admin emergency unlock**, enter the **household admin password** used for the dashboard, and choose **Turn off VPN**. This works without reaching the server. The client's own sign-in password does not unlock it. Filtering and time limits stop on that device; the VPN stays off across app restarts until **Turn on VPN** (Windows: **Start protection**) is selected. Turning protection back on does not need the admin password.

Update the server and apps and let each client enroll or refresh once while the server is available before relying on emergency access. Older cached identities have no offline verifier and explain this when unlock is attempted. The device stores a separate salted PBKDF2 verifier in its protected identity storage, never the admin password or a dashboard session. Failed attempts impose a persisted 30-second cooldown. This requires a strong household password: anyone who extracts client secrets can attempt offline password guesses. It is not tamper resistance against a device administrator.

On Android, **Always-on VPN → Block connections without VPN** can still block internet after the tunnel stops. An admin must turn that Android setting off in VPN settings, using any system authentication required by the device. Device-owner/MDM policies may prevent that change. Temperance cannot override them. On Apple platforms, emergency shutdown disables on-demand reconnect as well as stopping the tunnel. Windows removes the tunnel service until protection is started again.

If the household admin password changes, clients receive a replacement verifier on their next successful refresh. An offline client still accepts the previously synced password until then. The unlock is available whenever an admin needs it; deliberately making the server unreachable alone never turns off protection.
