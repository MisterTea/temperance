# Temperance Next.js policy service

This is the canonical web service. It implements the `/v1` WireGuard enrollment/device/gateway protocol in TypeScript. At home it is also the VPN gateway: with `TEMPERANCE_GATEWAY_LISTEN` set, `src/instrumentation.ts` starts the embedded Rust gateway (`gateway-addon/`, built from `core/temperance-gateway`) in the same process, so one program serves the dashboard, the API and WireGuard. A gateway on another machine can instead run the standalone `temperance-gateway` binary, which polls `/v1/gateway/*`.

The Next.js App Router serves the family dashboard and authenticated API. One deployment manages one household; do not publish it as a shared multi-tenant SaaS without additional account isolation.

## Storage

SQLite is the default: without `TEMPERANCE_DATABASE_URL` the household lives in `$TEMPERANCE_DATA_DIR/temperance.sqlite3` (`./data` next to the app when unset; never `/tmp`). Both backends go through one [Kysely](https://kysely.dev) repository, so there is a single copy of every query, and schema changes are Kysely migrations in `src/lib/migrations/`. The household is one versioned document updated with an atomic revision compare-and-swap, so concurrent requests and multiple server instances never lose writes.

| `TEMPERANCE_DATABASE_URL` | Backend | Good for |
| --- | --- | --- |
| unset, `sqlite:/path/temperance.sqlite3` (or `file:`, or a path ending in `.db`/`.sqlite3`) | SQLite via Node 24's built-in `node:sqlite` (WAL, busy timeout); `better-sqlite3` is used if `node:sqlite` is unavailable | The home server, a Docker volume |
| `postgres://user:pass@host:5432/db` | PostgreSQL via `pg` | Vercel, Cloudflare Workers, multi-instance, managed Postgres (Neon, Supabase, RDS) |

SQLite needs a persistent local disk, so it is not suitable for Vercel Functions or Workers; use PostgreSQL there.

## Simple password authentication

Set `TEMPERANCE_ADMIN_PASSWORD` (at least 10 characters) on the server. The website asks only for this password; there is no OAuth setup or administrator username. Its HttpOnly/SameSite session is limited to the website. Existing `TEMPERANCE_ADMIN_TOKEN` installations temporarily use that value as the admin password until the new variable is configured.

In Clients, create a username/password and assign its family profile. The macOS/iOS, Android and Windows apps take the setup code from the Devices tab and those client credentials, then call `POST /v1/device/login` with their locally generated WireGuard public key and device name, through the gateway's UDP port. The server selects the profile assigned to that username; clients cannot choose another profile or administer policies. Passwords travel only over QUIC pinned to the gateway's key (or inside the tunnel) and are never saved by the client. The device keeps its scoped credential in the platform keychain/private storage for subsequent policy requests. No OAuth grants, client IDs, refresh-token exchange, admin sign-in, or enrollment-code copying are required.

Passwords are stored as salted PBKDF2-SHA256 hashes. Admins can reassign profiles, disable/delete users or set new passwords. Disabling/deleting a user or setting a new password revokes its existing VPN devices; those clients must be reset and signed in again. Existing unlinked devices remain compatible during migration. Old parent/owner account records do not grant website access; assign their profiles explicitly if converting them to client users. The gateway still uses its independent `TEMPERANCE_GATEWAY_TOKEN`.

## Local development

Requires Node 24+. The example environment uses a local SQLite file, so no database server is needed:

```sh
cd web
npm ci
cp .env.example .env.local
# Fill in independent random secrets, your gateway's public key and endpoint.
npm run dev
```

To develop against PostgreSQL instead, run `docker run --rm -p 127.0.0.1:5432:5432 -e POSTGRES_PASSWORD=dev postgres:17-alpine` and set `TEMPERANCE_DATABASE_URL=postgres://postgres:dev@127.0.0.1:5432/postgres`. Native apps reach the service only through the gateway, so run it with `TEMPERANCE_GATEWAY_LISTEN` to test them.

To run the embedded gateway locally, build the add-on once (`npm run build:gateway`, needs Rust) and set `TEMPERANCE_GATEWAY_LISTEN=0.0.0.0:51820`. The gateway's WireGuard key is generated into the data directory (`gateway.key`, mode 600) and its public key is handed to devices automatically; leave `TEMPERANCE_VPN_PUBLIC_KEY` unset. CI publishes prebuilt add-ons for linux-x64, linux-arm64, darwin-arm64, darwin-x64 and win32-x64.

Use `npm run build && npm start` to exercise the standalone production server. The start script copies static assets to the standalone output. Use a reverse proxy for self-hosted HTTPS. The root `deploy/Dockerfile` and Compose recipe now build this Next.js service.

## Vercel

Import `MisterTea/temperance` and set the project root directory to **web**. Next.js is auto-detected; `vercel.json` records the framework. Create/connect a persistent PostgreSQL database (e.g. Neon from the Vercel Marketplace) and configure every variable from `.env.example` in Vercel's server-side environment settings. Set `TEMPERANCE_PUBLIC_URL` to the actual stable HTTPS domain. Never prefix secrets with `NEXT_PUBLIC_`.

Build command: `npm run build`. Vercel cannot host the VPN gateway or SQLite; run the standalone `temperance-gateway` binary at home and point it at the Vercel URL. A new process or cold start must read the same SQL database. Verify authentication, enrollment, a policy change reaching the gateway, and data persistence after redeploy before enrolling real devices. Vercel deployments in this repository are configuration/build verified; no account or paid hosting resource is automatically provisioned.

## Cloudflare Workers

The project uses Cloudflare's documented OpenNext adapter with pinned compatible versions: Next.js 16.3.8 and OpenNext 1.20.10. Next.js 16.4 currently changes preview-manifest loading in a way that fails this adapter's runtime; do not upgrade only the framework without running the Worker smoke test. The build includes a patched-safe glob dependency override; `npm audit` is clean for the pinned graph.

```sh
npm ci
npm run cloudflare:build
# Set secrets first through Wrangler's prompted inputs or Cloudflare's dashboard.
npx wrangler secret put TEMPERANCE_ADMIN_PASSWORD
npx wrangler secret put TEMPERANCE_GATEWAY_TOKEN
npx wrangler secret put TEMPERANCE_DATABASE_URL   # postgres://…
# Configure the remaining server-side values in Cloudflare's dashboard or secrets.
npm run cloudflare:deploy
```

`wrangler.jsonc` enables `nodejs_compat`, static assets, and the adapter's self-reference service binding. Use PostgreSQL (reached through `pg-cloudflare` sockets), not a local file or Worker-memory map. For local runtime verification, copy the environment values into a private `.dev.vars` with a localhost origin matching the preview port, run `npm run cloudflare:build`, then `npx wrangler dev --port 3001`. No Cloudflare login is required for local preview. Full-stack deployments target **Workers**, not a static Pages export. `cloudflare:deploy` is a deliberate operator step and is not run automatically by the assistant or CI.

## Tests

```sh
npm run typecheck
npm run test:coverage                      # unit + React component tests, 80% gate
TEMPERANCE_TEST_POSTGRES_URL=postgres://… npm test   # also run the storage contract on PostgreSQL
npm run build && npx playwright test       # feature/UX tests on SQLite
E2E_DATABASE_URL=postgres://… npx playwright test             # same suite on PostgreSQL
```

Component tests render the dashboard in jsdom and route its `fetch` calls to the real API handler, so UI and API are exercised together. Playwright runs every feature flow at desktop (1440×900), tablet (820×1180), and Pixel 7 sizes and audits each screen for horizontal scrolling, content outside the viewport, clipped text, overlapping controls or text, broken images, and touch targets under 24px; screenshots are attached to the HTML report. The storage contract test (seeded first read, compare-and-swap conflicts, concurrent writers on independent connections) runs on SQLite and, when configured, PostgreSQL. Shared policy cases in `specs/policy-cases.json` run in TypeScript and Rust. `tests/gateway.test.ts` drives the in-process gateway loop with a fake add-on; the gateway itself is tested end to end in `core/temperance-gateway/tests/tunnel.rs`. Unit tests alone do not prove parity or physical-client operation; follow `docs/research/circle-feature-audit.md` for remaining work.

## Migrating an existing Temperance instance

Instances that ran the former Python control service can move to Next.js. Keep the original SQLite database and gateway private key backed up. Export the old control-plane database without modifying it:

```sh
python3 scripts/export_legacy_policy.py data/control.sqlite3 \
  --output /private/path/temperance-migration.json --timezone America/Chicago
```

Configure Next.js with the same VPN endpoint/public key and gateway/admin secrets. Sign in, restore the generated file through Settings, and retain the same HTTPS origin so existing native clients continue to work. Point the gateway's `--service` URL at that origin. If you change the origin, native clients currently need an administrator reset/re-enrollment until the planned origin-migration UI is implemented. VPN peer public keys and device-token hashes are preserved. DNS-only LAN assignments are not converted into fake VPN enrollments; re-add them as home-network devices (see `docs/deployment.md`). Code expiration and one-use enrollment semantics remain unchanged. Existing clients' enrollment response shape remains compatible.
