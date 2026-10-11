# Circle evidence and Temperance parity audit

Research date: 2026-10-11. This file is the completion checklist for the active feature-parity goal. A feature is complete only when its user flow, API/storage, and actual enforcement (where relevant) have been verified. A build or field in a schema is not proof of feature completion. Existing capabilities below are the inspected repository at commit 29299fb, not assumptions from a previous answer.

## What actually happened to Circle

The evidence does **not** establish that Circle Media Labs went out of business. [Aura announced its acquisition on December 9, 2021](https://www.aura.com/press/release/digital-security-provider-aura-acquires-parental-controls-leader-circle-media-labs), with plans to integrate the parental-control technology into Aura. [Circle's current official homepage](https://meetcircle.com/) directs customers to Aura and describes Circle-powered parental controls. [Google Play's Circle listing](https://play.google.com/store/apps/details?id=com.meetcircle.circle) is still present and reports a July 29, 2026 update. These support acquisition/product transition, not bankruptcy.

A narrower shutdown is documented: [NETGEAR's official service-plan notice](https://kb.netgear.com/000038872/What-are-the-available-service-plans-when-using-Circle-Smart-Parental-Controls-on-my-NETGEAR-router) says the Circle Go VPN servers, account services, and MyCircle mobile apps were discontinued on December 31, 2020; regular Circle subscriptions were unaffected. [NETGEAR's 2019 support discussion](https://community.netgear.com/discussions/en-home-circle/parental-controls--not-working--circle-with-disney-go-app-discontinued/1760363) distinguishes stopping new Circle Go signups from continuing existing service. This predates the acquisition. Neither source explains the financial cause. We must not invent a hardware-cost, profitability, performance, or subscription explanation as a verified cause.

User complaints provide design evidence, not causality: [Reddit's feature survey discussion](https://www.reddit.com/r/firewalla/comments/17lkdm3/) mentions schedule discoverability and Circle-related device performance problems. [Time-limit discussion](https://www.reddit.com/r/firewalla/comments/zfna4g/) discusses limits shared across devices and background traffic. [Replacing Circle discussion](https://www.reddit.com/r/firewalla/comments/jhzwb6/) asks for easier family controls. These are anecdotal reports, not a representative study or proof of why a company/product changed.

## Mitigations to implement and verify

| Issue supported by evidence | Temperance mitigation | Completion evidence |
| --- | --- | --- |
| Vendor-run VPN/account service can be retired | Self-hosted policy and VPN services; no vendor account/license dependency | Existing source; deployment/recovery audit pending |
| Product migration can strand configuration | Versioned export/import, portable storage, migration from existing SQLite | Pending |
| A cloud outage can disable household internet | Locally cached validated policy, offline accounting, explicit bounded outage behavior; expiring local enforcement leases still stop crashes | Pending |
| Platform/vendor lock-in | Next.js API with persistent SQL storage, Vercel and Cloudflare build recipes, Docker/self-host option | Pending |
| Schedule discoverability/weekend differences | Visible day selectors, named Off/Focus windows, schedule conflict preview | Pending |
| Background traffic counted as foreground usage | Explicit network-estimate semantics, category/site attribution, transparent history and diagnostics | Existing total estimate; attribution/diagnostics pending |
| Network interference/performance complaints | Routed WireGuard rather than ARP interception, bounded logging, gateway health/latency diagnostics | Existing routed VPN; diagnostics pending |
| Subscription dependency | MIT code, no subscription/license gate; operator-controlled infrastructure costs | Existing license; operational guidance pending |

## Feature requirements

Sources: [2018 FCC Circle manual](https://fcc.report/FCC-ID/2AF7ECIRCLE3/4104775.pdf), [Home Plus app guide](https://device.report/m/b69b41f8da69a7e3524b876f481dcfc298e9e21638e430dd6f48d569d1bd8992_optim.pdf), [official quick start](https://meetcircle.com/pages/get-started), [website blocker guide](https://meetcircle.com/pages/website-blocker), [official history guide](https://meetcircle.com/pages/features-history), [None filter behavior](https://help.meetcircle.com/s/article/using-none-filter-level), [allow-list instructions](https://support.meetcircle.com/hc/en-us/articles/360052268151-Can-Circle-Block-All-Sites-Except-My-Allowed-List), and linked Reddit threads above. Manual generations differ; use the current documented behavior and record deliberate differences instead of silently merging contradictions.

| ID | Discussed capability / required verification | Current authoritative status |
| --- | --- | --- |
| F01 | Family profiles; rename, avatar, delete, assign devices | Name/assignment exist; avatar/delete pending |
| F02 | Home/default profile for shared/unassigned devices; guest/unmanaged devices | Pending; current VPN devices require an explicit profile |
| F03 | Whole-family/profile/device pause and resume | Profile packet enforcement tested; household/device pending |
| F04 | Kid/Teen/Adult/None filter presets and editable category defaults | Pending; three starter categories only |
| F05 | Custom allow/block/unmanaged site and app rules; one-click history actions | Allow/block exist; unmanaged and history actions pending |
| F06 | Strict allow-list mode | Pending |
| F07 | SafeSearch and YouTube restricted-mode enforcement | Pending |
| F08 | Ad/malware/proxy categories and maintainable filter feeds | Pending |
| F09 | Total daily limits shared across a profile's devices | Exists and tested as network estimate |
| F10 | Weekday/weekend daily limits | Pending |
| F11 | Per-category and individual site/app budgets and usage attribution | Pending |
| F12 | Day-selectable overnight bedtime and overlapping schedule correctness | Daily bedtime exists; weekday control pending |
| F13 | Named recurring Off Time windows | Pending |
| F14 | Focus Time allowing chosen learning sites/categories | Pending |
| F15 | Rewards: extra time, late bedtime, disable scheduled restrictions, edit/cancel, expire at local midnight | Pending |
| F16 | Usage summaries for day/week/month and historical periods | Pending |
| F17 | Visited/blocked domain history, profile/device/date filters, CSV export, deletion/retention | Gateway memory only; remote/history controls pending |
| F18 | Child view: remaining allowance, next schedule, rule reason | Native apps show basic totals; full view pending |
| F19 | Child extra-time requests and parent approval/denial | Pending |
| F20 | Location ping of a consented mobile device, freshness/accuracy, permissions | Pending |
| F21 | Parent notifications of requests, new/offline devices, policy failures/evasion | Pending |
| F22 | Device discovery/identification, rename/reassignment/revocation | VPN enrollment/rename/reassign/revoke exist; discovery pending |
| F23 | Router/home enforcement for devices that cannot install apps (TVs/consoles/IoT) | Standalone DNS exists; full home routing integration pending |
| F24 | Off-network/mobile enforcement | WireGuard clients/gateway source builds and Linux tunnel test exist; physical-device acceptance pending |
| F25 | Family/admin sharing, recovery, export/import, audit trail | Single admin secret exists; remaining pending |
| F26 | Unmanaged site exceptions across pause/bedtime/budgets without usage counting | Pending; current allow rules do not bypass schedules |
| F27 | Captive-portal handling and VPN/OS permission diagnostics | Pending |
| F28 | Transparent privacy controls and no advertising/tracking SDKs | No telemetry SDK exists; retention/export controls pending |
| F29 | Next.js service with existing native/gateway protocol compatibility | Pending |
| F30 | Vercel build, Cloudflare Worker build/runtime preview, persistent storage across instances | Pending |

The newer Aura site also advertises in-game voice/text monitoring via Kidas. That is a distinct Aura product integration, not established as a Circle app/manual feature. Do not invent a functioning game-monitoring service or mark it as Circle parity based on the current promotional page. New unrelated Aura products are outside the Circle feature checklist unless requested.

## Completion rule

Keep the goal active until this audit has direct evidence for the requested capabilities and deployment paths. Document limitations honestly; documentation alone does not complete an unimplemented feature. Do not describe a merely compatible Python service plus Next.js shell as the requested migration.

## Implemented tranche 1 (verification, 2026-10-11)

This is concrete progress, not a completion claim for the goal or the entire table above.

- Canonical Next.js App Router service implements `/api` and `/v1` directly. The deployment Dockerfile now builds Next.js; Vercel root configuration and Cloudflare OpenNext/Worker configuration are included. Next.js production and OpenNext builds pass. Local Cloudflare runtime executes authenticated enrollment, device/gateway state, time requests/approvals, and shares durable SQL state with an independent Next.js process.
- Real HTTP SQL tests verify persistence between separate repository instances and atomic concurrent updates. No production memory/file fallback exists. The pinned dependency graph passes `npm audit` with zero findings.
- The dashboard visibly saves weekday limits and Focus Time through authenticated API calls, and an independent SQL-backed read verifies those fields. New UI includes age presets, unmanaged rules, safe-search toggles, bedtime days, Off/Focus schedules, category/site budgets, rewards, usage periods, history actions/CSV, requests/approval, in-app events, settings, and backup controls. These UI/API paths still need broader acceptance coverage; field presence is not full feature completion.
- Twelve shared golden cases execute in both TypeScript and Python: weekday quota, overnight bedtime/start-day boundary, unmanaged exceptions, focused learning, reward skipping/expiry, category budget, age preset, and None semantics. Original Python and new service tests pass.
- Actual encrypted Linux traffic verifies unmanaged pause exceptions, strict allow-list packet gating, category quota denial/restoration, forced DNS filtering, ordinary pause/resume, expired leases, and revocation. Attribution is based on DNS-observed destination IPs; shared-IP overblocking and encrypted-DNS blind spots remain material limitations.
- Cache tests verify private mode-600 storage, restart, origin binding, rollback rejection, bounded grace, deduplication, quota accounting, and midnight reset. Full live service-outage/reconnect testing remains pending. Local enforcement leases are independent of cloud connectivity: a live agent can renew a cached policy within grace, but an agent crash still expires forwarding.
- The legacy SQLite exporter preserves enrolled VPN public keys, device-token hashes, and minute totals in the versioned backup format. A source migration acceptance test and native origin-switch UX remain pending. It does not silently convert LAN/DNS-only devices to fake VPN enrollments.

Remaining work includes mobile location/requests/child-status UI, home routing/discovery, complete rewards/history/notification flows, profile removal UI, shared administration/recovery, VPN/captive-portal diagnostics, operational performance/privacy hardening, native build and physical-device acceptance, and the final requirement-by-requirement audit. Keep the active goal open.
