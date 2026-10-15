# Release readiness

**Current status: beta preparation, not customer-qualified.** An implementation or CI build is not physical-device evidence. `release-evidence.json` deliberately starts with pending gates. The release workflow refuses publication until evidence for the exact version and source fingerprint passes `scripts/check-release.mjs`.

## Work ledger

Owners below are accountable roles to assign before qualification, not claims that someone has accepted an assignment.

| Priority | Workstream / owner | Implementation and remaining evidence | Depends on |
| --- | --- | --- | --- |
| P0 | Promise / product maintainer | Docker/SQLite reference scope, network-minute wording, outage and filtering disclosures; verify every app/store listing agrees. | Supported scope |
| P0 | Setup / server maintainer | Atomic first-client rules + sign-in; readiness, gateway lease and subnet checks. Still qualify fresh-host install and external UDP reachability. | Release artifacts |
| P0 | Distribution / release maintainer | Android no longer uses debug signing for release; signed-build tooling and version inputs. Actual certificates, entitlements, notarization, beta channels and installation/upgrade/uninstall evidence required. | Developer accounts and signing credentials |
| P0 | Device reliability / device QA | Existing traffic tests plus shared policy tests. Complete the physical-device matrix below using signed artifacts. | Signed builds, supported server |
| P0 | Filtering / filter maintainer | Optional validated HTTPS refresh, freshness and last-known-good behavior. Select licensed maintained category corpora and measure true/false blocks before making coverage claims. | Reviewed source terms and corpus |
| P0 | Recovery / release maintainer | Encrypted SQLite/key/config archive, daily retention, offline restore, pre-update snapshot, durable update outcomes and concurrent-update exclusion. Complete replacement-host reconnection and previous-version recovery drill. | Persistent volume, separate passphrase/offsite copy |
| P0 | Security / security reviewer | Authenticated operational APIs, allowlisted diagnostics, bounded feed fetching and TLS mail. Independent review of all trust boundaries and no unresolved critical/high findings required. Enable GitHub private reporting. | Stable candidate, developer accounts |
| P1 | Notifications / server maintainer | Optional SMTP with durable reservations, backoff, manual retry and generic status. Local integration tests exercise real STARTTLS, authentication, untrusted certificates, missing TLS and recipient rejection. Qualify a real TLS provider and external uptime monitoring; native push deferred. | Operator SMTP configuration |
| P1 | UX / product QA | Settings operations panel and guided first sign-in; complete keyboard, screen-reader, large-text, offline/revoked and schedule usability review. | Candidate apps and dashboard |
| P1 | Support / maintainer | Redacted support report, bug template, recovery/troubleshooting guide, dependency updates. Assign response expectations and publish known issues for every release. | Maintainer availability |
| P1 | Beta / beta coordinator | Recruit 5–10 assisted households, expand to 20–30 after gates pass; no household participation has been recorded. | P0 qualification |
| P2 | Network / gateway maintainer | IPv6 internet forwarding remains unimplemented; validate dual-stack, MTU, carriers, meshes and restrictive networks. | Traffic-policy regression matrix |
| P2 | Capacity / gateway maintainer | Run concurrent traffic and sustained-load tests on Raspberry Pi-class and x64 hardware; measure SQLite contention, storage growth and device-address exhaustion before choosing migrations/reuse. | Reproducible benchmarks |
| P2 | Stable operations / release maintainer | Native push, production app distribution, dependency notices/support policy, 4-week expanded beta evidence. | Successful beta |
| P3 | Additional modes / respective maintainer | Qualify Linux packages, NAS variants, macOS/Windows servers, remote gateway, router/AP modes independently. | Reference beta stable |

## Device and enforcement acceptance

For **each** Android, iOS, macOS and Windows result record: release version, artifact SHA-256, server image digest, physical device/model, OS version, date, tester, steps, expected/observed outcome and evidence link. Use synthetic household data.

| Journey | Required scenarios |
| --- | --- |
| Install and enroll | Fresh install, invalid credentials, expired/revoked identity, scan/paste, VPN consent, allow permissions, local and external connection. |
| Enforce | Pause/resume, existing TCP/UDP flows, bedtime, Off/Focus, strict allow-list, total/category/site/group budgets, simultaneous devices, rewards and revocation. |
| Time | Overnight windows, midnight reset/expiry, DST transitions, clock changes and household timezone changes. |
| Request | Request while blocked, receive notice while dashboard closed, approve/decline, update client status, no duplicate approvals. |
| Lifecycle | Sleep/wake, app termination, reboot, OS update, battery saver, notification denial, VPN removal and recovery. |
| Network | Wi-Fi/mobile transition, IP/DDNS change, captive portal, packet loss, DNS outage, gateway outage/restart, restoration and lease expiry. |
| Upgrade/recovery | Previous supported app + new server and new app + previous supported server; failed upgrade; replacement host with preserved keys; admin pairing and device traffic restored. |
| Accessibility | Keyboard-only dashboard, screen reader, 200% text, narrow phone/landscape, focus after errors, status announcements and permission guidance. |

CI also runs `web/scripts/acceptance.mjs` against the packaged standalone server with the real embedded gateway: authenticated readiness, atomic client creation, encrypted backup, preserved gateway/remote identities and replacement-server startup. Linux release tarballs repeat this on Debian 10 and Rocky Linux 8. This is automated package evidence, not physical-device reconnection evidence.

Test failure injection for unavailable/full storage, conflicting admin changes, malformed/oversized imports, corrupt recovery archives and bad/stale feeds. Build all affected apps; do not infer VPN operation from an unsigned Apple build or emulator-only evidence.

## Beta program and release gates

Initial invitation gate: all P0 checks, accessibility and automated acceptance pass for the designated candidate. The automated beta gate covers this initial invitation, not successful household trials.

Expansion gate: all four platforms pass physical qualification; at least 80% of participating technical households set up without live help; upgrade/recovery drills pass; no unresolved critical/high security, data-loss or advertised-enforcement failures; at least two weeks of household use without an unresolved blocker. Record this as `beta_households` evidence before 1.0.

1.0 gate: all beta evidence, qualified IPv6/network behavior, published capacity/soak results, four consecutive weeks in the expanded cohort without unresolved blockers, current security review, production distribution on every supported app platform and a verified upgrade/restore path. Store the cohort report as `stable_households` evidence and production artifact/install records as `production_distribution`.

Collect setup completion/time, reconnect failures, false blocks, crashes, upgrade failures and support requests through interviews and voluntary redacted reports. No mandatory telemetry. Obtain household consent, keep participant identities out of Git, record aggregate evidence only, and prioritize lost access/data and enforcement failures over features.

## Recording evidence

Record the signed candidate workflow run ID as `checks.signed_distribution.run_id`; release qualification downloads that run’s version-matching artifacts and verifies their manifests and hashes before publishing any image. Those verified app artifacts are attached to the final release alongside server packages. Candidate artifacts expire after 30 days; retain or rebuild/requalify them before expiry.

Fill each applicable entry in `release-evidence.json` with `status: "passed"`, assigned `owner`, an `evidence` reference and ISO `verified_at` timestamp. Set `version` to the exact tag including `v`; commit all source files before calculating `source_digest` with `node scripts/check-release.mjs --fingerprint`. The evidence file itself is excluded from the digest; source changes invalidate qualification. Links and reviewer attestations require human review—the script checks completeness and source binding, not truthfulness of a report.

Run `node scripts/check-release.mjs beta vX.Y.Z-beta.N` or `node scripts/check-release.mjs stable vX.Y.Z`. A failed gate prevents release publication. Never mark external tests passed merely to make the workflow green.

Use **Signed candidate apps** with an intended version, source commit/branch and a monotonically increasing store build number before creating the publication tag. Jobs run on disposable runners in the `beta-signing` environment. They create artifacts only; they do not upload to app stores or invite testers. Configure Android upload-key secrets, a Windows code-signing PFX and RFC 3161 timestamp URL, and Apple certificate/API credentials with the app identifiers and Network Extension entitlements provisioned. `scripts/signed-apple.sh` expects the P12 to include both Apple Distribution and Developer ID Application identities. Review automatic provisioning behavior before enabling credentials. Actual signing workflows remain unqualified until run with those credentials; no signed artifacts were produced by the repository changes alone.

Qualify the resulting artifact hashes against the source fingerprint, then commit only the evidence file and create the release tag on that commit. The source fingerprint excludes the evidence file, so this does not require moving a tested tag. Rebuild/requalify after any other source change. Release maintainers must retain the artifact hashes and CI source commit with the evidence.

Each release note must identify supported server/app combinations, tested artifact hashes, changes, migration/rollback steps, known issues and workarounds, filtering limitations, unresolved nonblocking findings and how to obtain support. Keep a source/license inventory for bundled WireGuard, native libraries, npm/Gradle dependencies and redistributed feeds.

## Docker Hub publishing setup

The release workflow publishes the same amd64/arm64 build to Docker Hub (`mistertea/temperance`) and GHCR. Set repository Actions secret `DOCKERHUB_TOKEN` to a Docker Hub personal access token with write access to that repository; optionally set Actions variable `DOCKERHUB_USERNAME` (default `mistertea`). Enter the token in GitHub's encrypted secrets UI, not in source or chat. GHCR continues using `GITHUB_TOKEN`.

Release qualification still runs before publication. A missing Hub credential stops publishing with an explicit error. Stable releases update `latest`; `-beta.N` releases update `beta` without moving `latest`. Explicit version tags are also published. Docker Hub repository creation alone does not publish an image or satisfy the qualification gates.

Emergency-access acceptance: after one online sync, disconnect the server and use the household admin password on each supported client to disable the VPN. Confirm incorrect passwords and repeated attempts fail, the app restarts without reconnecting, normal internet returns, and an explicit resume restores protection. Include Android always-on/lockdown settings, Apple on-demand reconnect, Windows service removal, storage failures and password rotation while a device is offline. Automated shared-core and app tests support this work; actual OS traffic/reboot qualification remains required.
