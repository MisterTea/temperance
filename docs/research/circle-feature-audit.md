# Circle evidence and Temperance parity audit

Research date: 2026-10-11. This file is the completion checklist for the active feature-parity goal. A feature is complete only when its user flow, API/storage, and actual enforcement (where relevant) have been verified. A build or field in a schema is not proof of feature completion. Existing capabilities below are the inspected repository at commit 29299fb, not assumptions from a previous answer.

## What actually happened to Circle

The evidence does **not** establish that Circle Media Labs went out of business. [Aura announced its acquisition on December 9, 2021](https://www.aura.com/press/release/digital-security-provider-aura-acquires-parental-controls-leader-circle-media-labs), with plans to integrate the parental-control technology into Aura. [Circle's current official homepage](https://meetcircle.com/) directs customers to Aura and describes Circle-powered parental controls. [Google Play's Circle listing](https://play.google.com/store/apps/details?id=com.meetcircle.circle) is still present and reports a July 29, 2026 update. These support acquisition/product transition, not bankruptcy.

A narrower shutdown is documented: [NETGEAR's official service-plan notice](https://kb.netgear.com/000038872/What-are-the-available-service-plans-when-using-Circle-Smart-Parental-Controls-on-my-NETGEAR-router) says the Circle Go VPN servers, account services, and MyCircle mobile apps were discontinued on December 31, 2020; regular Circle subscriptions were unaffected. [NETGEAR's 2019 support discussion](https://community.netgear.com/discussions/en-home-circle/parental-controls--not-working--circle-with-disney-go-app-discontinued/1760363) distinguishes stopping new Circle Go signups from continuing existing service. This predates the acquisition. Neither source explains the financial cause. We must not invent a hardware-cost, profitability, performance, or subscription explanation as a verified cause.

User complaints provide design evidence, not causality: [Reddit's feature survey discussion](https://www.reddit.com/r/firewalla/comments/17lkdm3/) mentions schedule discoverability and Circle-related device performance problems. [Time-limit discussion](https://www.reddit.com/r/firewalla/comments/zfna4g/) discusses limits shared across devices and background traffic. [Replacing Circle discussion](https://www.reddit.com/r/firewalla/comments/jhzwb6/) asks for easier family controls. These are anecdotal reports, not a representative study or proof of why a company/product changed.

## Mitigations to implement and verify

| Issue supported by evidence | Temperance mitigation | Completion evidence |
| --- | --- | --- |
| Vendor-run VPN/account service can be retired | Self-hosted policy and VPN services; no vendor account/license dependency | Done: Docker/compose, Vercel, Cloudflare and bare-metal recipes (`docs/deployment.md`); MIT license |
| Product migration can strand configuration | Versioned export/import, portable storage, migration from existing SQLite | Done: backup/restore API + Settings UI with validation tests; legacy SQLite exporter; three storage backends behind one contract test |
| A cloud outage can disable household internet | Locally cached validated policy, offline accounting, explicit bounded outage behavior; expiring local enforcement leases still stop crashes | Done: `PolicyCache` grace/rollback tests; gateway falls back to cached policy; offline minutes replayed within 7 days |
| Platform/vendor lock-in | Next.js API with persistent SQL storage, Vercel and Cloudflare build recipes, Docker/self-host option | Done: SQLite (default) and PostgreSQL through one Kysely repository; Vercel project; OpenNext build in CI |
| Schedule discoverability/weekend differences | Visible day selectors, named Off/Focus windows, schedule conflict preview | Done: profile editor day selectors, weekday/weekend limits, named windows, and an overlap warning (“Homework and Bedtime overlap on Mon…”) including overnight windows; `schedule-conflicts.test.ts`, component and e2e profile tests |
| Background traffic counted as foreground usage | Explicit network-estimate semantics, category/site attribution, transparent history and diagnostics | Done: usage labelled as network minutes; category/site buckets; history explains every decision |
| Network interference/performance complaints | Routed WireGuard rather than ARP interception, bounded logging, gateway health/latency diagnostics | Done: no ARP spoofing; gateway heartbeat banner; per-device health (tunnel, handshake, captive portal, permissions) reported to admins |
| Subscription dependency | MIT code, no subscription/license gate; operator-controlled infrastructure costs | Done: no license gate anywhere in the code |

## Feature requirements

Sources: [2018 FCC Circle manual](https://fcc.report/FCC-ID/2AF7ECIRCLE3/4104775.pdf), [Home Plus app guide](https://device.report/m/b69b41f8da69a7e3524b876f481dcfc298e9e21638e430dd6f48d569d1bd8992_optim.pdf), [official quick start](https://meetcircle.com/pages/get-started), [website blocker guide](https://meetcircle.com/pages/website-blocker), [official history guide](https://meetcircle.com/pages/features-history), [None filter behavior](https://help.meetcircle.com/s/article/using-none-filter-level), [allow-list instructions](https://support.meetcircle.com/hc/en-us/articles/360052268151-Can-Circle-Block-All-Sites-Except-My-Allowed-List), and linked Reddit threads above. Manual generations differ; use the current documented behavior and record deliberate differences instead of silently merging contradictions.

| ID | Capability | Status | Evidence |
| --- | --- | --- | --- |
| F01 | Family profiles; rename, avatar, delete, assign devices | Done | Profile editor name/avatar; "Delete profile" (refuses while devices are assigned); `dashboard.test.tsx` "profile editor", `features.spec.ts` profile test |
| F02 | Home devices; unmanaged devices | Done | Each TV or console is added on Devices and follows that client's rules; device "Set unmanaged"; unregistered LAN addresses are not filtered |
| F03 | Whole-family / profile / device pause | Done | Overview "Pause family", per-profile and per-device Pause; packet enforcement in the Linux integration test; e2e "household pause" |
| F04 | Kid/Teen/Adult/None presets, editable categories | Done | Presets + 11 categories (incl. ads, proxy, malware feeds); golden cases `specs/policy-cases.json` in TS and Rust |
| F05 | Custom allow/block/unmanaged rules; one-click history actions | Done | Editor domain lists; History allow/deny/unmanaged buttons; component + e2e history tests |
| F06 | Strict allow-list mode | Done | `allow_only`; golden case; Linux packet gating test |
| F07 | SafeSearch / YouTube restricted | Done (DNS) | Gateway DNS rewrites; Rust gateway tests. Encrypted DNS can bypass (documented) |
| F08 | Ad/malware/proxy categories and feeds | Done | Category feed import in Settings; component test imports an ads feed |
| F09 | Shared daily limit across a profile's devices | Done | Minute de-duplication tests (service + gateway) |
| F10 | Weekday/weekend limits | Done | Weekday limit inputs; golden weekday-quota case |
| F11 | Per-category and per-site budgets with attribution | Done | Editor budgets; usage buckets; golden category-budget case; Linux quota test |
| F12 | Day-selectable overnight bedtime | Done | Bedtime days; start-day-anchored golden case |
| F13 | Named Off Time windows | Done | Schedules with mode Off; golden case; Rust `access_reason` test |
| F14 | Focus Time with chosen learning sites/categories | Done | Focus windows; golden focused-learning case |
| F15 | Rewards: extra time, late bedtime, skip a schedule; cancel; midnight expiry | Done | Requests tab; reward fields normalized per type; component + e2e tests; golden reward expiry case |
| F16 | Usage by day/week/month with comparison to the previous period and top categories | Done | Usage summary cards (▲/▼ % vs previous period, top 3 buckets); component + e2e tests |
| F17 | Visited/blocked history, filters, CSV, deletion, retention | Done | History tab filters, CSV export, delete history, retention setting; component + e2e tests |
| F18 | Child view: remaining time, next change, rule reason | Done | Shared Rust `child_status` used by desktop, Android, iOS and macOS apps |
| F19 | Client time requests with admin approve/decline | Done (beyond Circle) | Rust `time_request` in every app; Requests tab; tests in all layers |
| F20 | On-demand location of a consented device; child is told | Done | Devices "Locate" → device answers once (Android LocationManager, Apple CoreLocation, desktop declines) → map link with accuracy and age; child gets a notification; requests expire after 1 h; `location.test.ts`, component + e2e tests |
| F21 | Admin notifications: requests, new device, admin added, device removed, gateway offline, device health | Done in-app | Event feed and unread dot; gateway heartbeat banner ("offline since…") and reconnect event; "Phone: VPN permission is turned off"-style events when a device reports a new problem. Push/e-mail delivery is not implemented |
| F21b | Kid notifications: 15 min left, limit reached, bedtime/Off Time soon, reward received, request answered | Done | Shared Rust `child_alerts`; Android notifications, Apple local notifications, desktop alert list; Rust tests |
| F22 | Device identification, rename, reassign, revoke, last seen | Done for VPN devices | Inline rename, profile select, Revoke, "Last active" column; component + e2e tests. LAN discovery of non-VPN devices is not implemented (no ARP spoofing by design) |
| F23 | Home enforcement for devices that cannot install apps | Done | Devices → "Add a home-network device" (reserved LAN IPv4) → gateway `lan_devices`; gateway `--lan-*` options give DNS filtering and, as LAN router, packet leases, DNS redirection, DoT blocking and usage counters. `home-devices.test.ts`, component + e2e tests, `HomeDeviceTests`, and the privileged Linux integration test (routed, DNS-filtered, paused; other LAN devices untouched) |
| F24 | Off-network mobile enforcement | Built; device acceptance pending | WireGuard clients for macOS, iOS, Android and Windows build in CI (the Linux device app was dropped); Linux tunnel test; physical-device testing still required |
| F25 | Family sharing, recovery, export/import, audit | Done | Owner and admin accounts with their own passwords; OAuth password/refresh grants; portable backup/restore; event log |
| F26 | Unmanaged site exceptions across pause/bedtime/budgets | Done | Golden unmanaged case; Linux integration test |
| F27 | Captive-portal handling and permission diagnostics | Done | Shared Rust `captive_portal_probe`/`diagnose` (100% covered). Desktop: "Sign in to Wi-Fi" lowers the tunnel only when the gateway is unreachable, for at most 5 min, restores as soon as the probe is online, and admins are told afterwards. Android: detects the OS captive-portal state, VPN/notification/location permissions and handshake age, and opens Wi-Fi sign-in. Apple: `includeAllNetworks` already exempts captive-network sign-in; the app reports VPN, notification and location permissions. Devices tab shows each device's health |
| F28 | Privacy controls, no tracking SDKs | Done | No telemetry; retention, history deletion, export; location only on explicit request |
| F29 | Next.js service compatible with gateway/native protocol | Done | `/v1` protocol tests; native clients use it through the Rust core |
| F30 | Vercel and Cloudflare builds with persistent storage | Done | SQLite and PostgreSQL backends with a shared contract test; Vercel project; OpenNext build in CI |

## Reddit and review findings (2026-10-11 research) and how Temperance responds

| Complaint about Circle | Temperance response |
| --- | --- |
| ARP spoofing slows or destabilizes home networks; mesh/UniFi setups lose devices | Routed WireGuard VPN and DNS; no ARP interception |
| MAC randomization creates duplicate or unmanaged devices; MAC cloning bypasses rules | Devices are identified by enrolled WireGuard keys, not MAC addresses |
| Private DNS / VPNs bypass filtering | DNS on port 53 is forced to the gateway and DoT is blocked; DoH and other VPNs remain a documented limitation that needs OS management |
| Inaccurate time from background traffic and shared IPs | Usage is labelled as a network estimate; per-category/site attribution and history explain decisions |
| YouTube kept playing during Bedtime | Pause, bedtime and budgets stop forwarded connections, including existing ones, within ~5 s |
| Pausing the internet "as a summons" | Children see why access changed and what changes next, and can ask for time |
| No child-initiated requests | Built (F19) |
| No readable names for uncategorized traffic | History shows domain names for every decision |
| No way to manage two homes | One instance per household is self-hostable; run one per home (documented) |
| Product discontinued, vendor lock-in | MIT-licensed, self-hosted, portable backups, three storage backends |

The newer Aura site also advertises in-game voice/text monitoring via Kidas. That is a distinct Aura product integration, not established as a Circle app/manual feature. Do not invent a functioning game-monitoring service or mark it as Circle parity based on the current promotional page. New unrelated Aura products are outside the Circle feature checklist unless requested.

## Completion rule

Keep the goal active until this audit has direct evidence for the requested capabilities and deployment paths. Document limitations honestly; documentation alone does not complete an unimplemented feature. Do not describe a merely compatible Python service plus Next.js shell as the requested migration.

## Implemented tranche 1 (verification, 2026-10-11)

This is concrete progress, not a completion claim for the goal or the entire table above.

- Canonical Next.js App Router service implements `/api` and `/v1` directly. The deployment Dockerfile now builds Next.js; Vercel root configuration and Cloudflare OpenNext/Worker configuration are included. Next.js production and OpenNext builds pass. Local Cloudflare runtime executes authenticated enrollment, device/gateway state, time requests/approvals, and shares durable SQL state with an independent Next.js process.
- Real HTTP SQL tests verify persistence between separate repository instances and atomic concurrent updates. No production memory/file fallback exists. The pinned dependency graph passes `npm audit` with zero findings.
- The dashboard visibly saves weekday limits and Focus Time through authenticated API calls, and an independent SQL-backed read verifies those fields. New UI includes age presets, unmanaged rules, safe-search toggles, bedtime days, Off/Focus schedules, category/site budgets, rewards, usage periods, history actions/CSV, requests/approval, in-app events, settings, and backup controls. These UI/API paths still need broader acceptance coverage; field presence is not full feature completion.
- Twelve shared golden cases execute in both TypeScript and the Rust core used by the gateway and apps: weekday quota, overnight bedtime/start-day boundary, unmanaged exceptions, focused learning, reward skipping/expiry, category budget, age preset, and None semantics.
- Actual encrypted traffic through the embedded gateway (an in-test WireGuard client on Linux, macOS and Windows, and the Android app on an emulator) verifies browsing, DNS filtering, blocking when time runs out with existing connections closed, restoration by a reward, and expired leases; unit tests cover unmanaged exceptions, strict allow-lists and category budgets. Router mode is verified in Linux network namespaces with real nftables. Attribution is based on DNS-observed destination IPs; shared-IP overblocking and encrypted-DNS blind spots remain material limitations.
- The embedded gateway shares the service's process. A standalone gateway CLI keeps enforcing its last policy within the admin's offline grace when the service is unreachable (budgets do not advance meanwhile); a crashed gateway stops forwarding when its 15-second lease lapses.
- The legacy SQLite exporter preserves enrolled VPN public keys, device-token hashes, and minute totals in the versioned backup format. A source migration acceptance test and native origin-switch UX remain pending. It does not silently convert LAN/DNS-only devices to fake VPN enrollments.

Remaining work: push/e-mail delivery of admin notifications, and physical-device acceptance testing of the native VPN apps (F24). Android and Apple diagnostics are verified by compilation and the shared Rust tests, not yet on physical devices.
