import { emergencyVerifier } from "./emergency";
import { z } from "zod";
import * as accounts from "./accounts";
import { bearer, hash, secrets, trustedOrigin, validateKey } from "./auth";
import { mutate, repository, type Repository } from "./database";
import * as service from "./service";
import * as updates from "./updates";
import type { Parent, State } from "./model";
import { localTime } from "./policy";

const FORWARDED = "x-temperance-forwarded";
// Non-zero: the Windows service (WinSW) restarts only on failure; systemd, launchd and Docker restart on any exit.
const RESTART_EXIT_CODE = 75;

class HTTPError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function json(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}
async function body(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > 1_048_576) throw new HTTPError(413, "Request too large");
  const reader = request.body?.getReader();
  if (!reader) throw new HTTPError(400, "JSON body required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const value = await reader.read();
    if (value.done) break;
    size += value.value.length;
    if (size > 1_048_576) {
      await reader.cancel();
      throw new HTTPError(413, "Request too large");
    }
    chunks.push(value.value);
  }
  const data = new Uint8Array(size);
  let cursor = 0;
  for (const chunk of chunks) {
    data.set(chunk, cursor);
    cursor += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw new HTTPError(400, "Invalid JSON");
  }
}
function date(value: string | null, fallback: string) {
  if (!value) return fallback;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(new Date(value).getTime())
  )
    throw new HTTPError(400, "Use a YYYY-MM-DD date");
  return value;
}
export async function handle(
  request: Request,
  path: string,
  repo?: Repository,
) {
  try {
    if (path === "healthz") return json({ ok: true });
    const write = request.method === "POST";
    repo ??= repository();
    await reconcileClients(repo);
    if (path === "v1/setup" || path === "v1/login" || path === "v1/logout")
      return await accountRoute(request, path, repo);
    if (path.startsWith("api/")) {
      const { state } = await repo.read();
      const actor = await principal(request, state);
      if (!actor) throw new HTTPError(401, "Admin sign-in required");
      if (
        write &&
        actor.role === "admin" &&
        !bearer(request) &&
        !trustedOrigin(request)
      )
        throw new HTTPError(403, "Same-origin requests required");
      if (actor.role === "parent") await seen(repo, actor.parent);
      if (!write) {
        const url = new URL(request.url);
        if (path === "api/state") return json(service.snapshot(state));
        if (path === "api/readiness") {
          const { readiness } = await import("./readiness");
          const result = await readiness(repo);
          return json(
            result,
            result.ready || url.searchParams.get("report") === "1" ? 200 : 503,
          );
        }
        if (path === "api/support") {
          const { supportBundle } = await import("./readiness");
          return json(supportBundle(state), 200, {
            "Content-Disposition":
              'attachment; filename="temperance-support.json"',
          });
        }
        if (path === "api/maintenance") {
          const { notificationStatus } = await import("./notifications");
          const { feedStatus } = await import("./feeds");
          return json({
            email: notificationStatus(state),
            feeds: feedStatus(state),
            recovery: {
              configured:
                (process.env.TEMPERANCE_BACKUP_PASSPHRASE?.length ?? 0) >= 16,
              last_backup_at: state.maintenance?.backup_at ?? null,
              error: state.maintenance?.backup_error ?? null,
            },
          });
        }
        if (path === "api/me")
          return json(
            actor.role === "parent"
              ? { role: "parent", id: actor.parent.id, name: actor.parent.name }
              : { role: "admin" },
          );
        if (path === "api/users")
          return json(accounts.users(state).map(accounts.publicUser));
        if (path === "api/update")
          return json({
            ...(await updates.status(url.searchParams.get("check") === "now")),
            attempt: await updates.updateAttempt(repo),
          });
        const today = service.snapshot(state).day;
        if (path === "api/usage")
          return json(
            service.usageSummary(
              state,
              date(url.searchParams.get("start"), today),
              date(url.searchParams.get("end"), today),
            ),
          );
        if (path === "api/history") {
          const pid = url.searchParams.get("profile_id"),
            device = url.searchParams.get("device_id"),
            start = date(url.searchParams.get("start"), today),
            end = date(url.searchParams.get("end"), today),
            blocked = url.searchParams.get("blocked");
          const rows = state.history
            .filter((h) => {
              const day = localTime(h.at, service.timezone()).day;
              return (
                (!pid || String(h.profile_id) === pid) &&
                (!device || h.device_id === device) &&
                day >= start &&
                day <= end &&
                (blocked === null || h.blocked === (blocked === "true"))
              );
            })
            .reverse();
          if (url.searchParams.get("format") === "csv") {
            const escape = (v: unknown) => {
              const text = String(v);
              return (
                '"' +
                (/^[=+@-]/.test(text) ? "'" : "") +
                text.replace(/"/g, '""') +
                '"'
              );
            };
            return new Response(
              [
                "timestamp,profile_id,device_id,domain,blocked,reason,category",
                ...rows.map((h) =>
                  [
                    new Date(h.at * 1000).toISOString(),
                    h.profile_id,
                    h.device_id,
                    h.domain,
                    h.blocked,
                    h.reason,
                    h.category,
                  ]
                    .map(escape)
                    .join(","),
                ),
              ].join("\n"),
              {
                headers: {
                  "Content-Type": "text/csv; charset=utf-8",
                  "Content-Disposition":
                    'attachment; filename="temperance-history.csv"',
                  "Cache-Control": "no-store",
                },
              },
            );
          }
          return json(rows);
        }
        if (path === "api/export")
          return json(
            {
              format: "temperance",
              schema: 2,
              exported_at: Math.floor(Date.now() / 1000),
              state: { ...state, refresh_tokens: undefined },
            },
            200,
            {
              "Content-Disposition":
                'attachment; filename="temperance-backup.json"',
            },
          );
      } else {
        if (path === "api/notifications/retry") {
          const { retryFailedNotifications } = await import("./notifications");
          try {
            return json(await retryFailedNotifications(repo));
          } catch {
            throw new HTTPError(409, "Configure SMTP before retrying email.");
          }
        }
        if (path === "api/notifications/test") {
          const { testMail } = await import("./notifications");
          try {
            await testMail(repo);
          } catch (e) {
            throw new HTTPError(
              409,
              e instanceof Error ? e.message : "Delivery test failed",
            );
          }
          return json({ ok: true });
        }
        if (path === "api/recovery") {
          // Download only. Restoring identity is an offline operation on a new host.
          const { recoveryJob } = await import("./recovery");
          try {
            return new Response(await recoveryJob("export"), {
              headers: {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
                "Content-Disposition":
                  'attachment; filename="temperance-recovery.json"',
                "X-Content-Type-Options": "nosniff",
              },
            });
          } catch {
            throw new HTTPError(
              409,
              "Configure SQLite recovery, gateway identity, and a recovery passphrase before downloading.",
            );
          }
        }
        if (path === "api/restart") {
          setTimeout(() => process.exit(RESTART_EXIT_CODE), 250);
          return json({ restarting: true });
        }
        if (path === "api/update") {
          try {
            await updates.requestUpdate(repo);
          } catch (e) {
            throw new HTTPError(
              409,
              e instanceof Error ? e.message : "Update failed",
            );
          }
          return json({ updating: true });
        }
        const data = await body(request);
        const result = await mutate(repo, async (state) => {
          switch (path) {
            case "api/setup/client": {
              const input = z
                .object({
                  profile: serviceProfileSchema,
                  password: z.string().min(8).max(200),
                })
                .parse(data);
              const id = state.nextProfileId;
              service.saveProfile(state, { ...input.profile, id: undefined });
              await accounts.createUser(state, {
                username: input.profile.name,
                password: input.password,
                profile_id: id,
              });
              return service.snapshot(state);
            }
            case "api/users": {
              const user = await accounts.createUser(state, data);
              service.changed(
                state,
                "account",
                `Client user ${user.username} created`,
              );
              return accounts.publicUser(user);
            }
            case "api/users/update": {
              const user = await accounts.updateUser(state, data);
              service.changed(
                state,
                "account",
                `Client user ${user.username} updated`,
              );
              return accounts.publicUser(user);
            }
            case "api/users/delete": {
              const id = z.object({ id: z.string() }).parse(data).id;
              accounts.deleteUser(state, id);
              service.changed(state, "account", "Client user removed");
              return accounts.users(state).map(accounts.publicUser);
            }
            case "api/profiles":
              return service.saveProfile(state, data);
            case "api/profiles/delete":
              return service.deleteProfile(
                state,
                z.object({ id: z.number().int() }).parse(data).id,
              );
            case "api/devices":
              return service.saveDevice(state, data);
            case "api/devices/home":
              return service.addHomeDevice(state, data);
            case "api/devices/delete":
              return service.revokeDevice(
                state,
                z.object({ ip: z.string() }).parse(data).ip,
              );
            case "api/devices/locate":
              return service.requestLocation(
                state,
                z.object({ ip: z.string() }).parse(data).ip,
              );
            case "api/parents/pairing":
              return service.issueParentCode(state);
            case "api/parents/revoke": {
              const id = z.object({ id: z.string() }).parse(data).id;
              if (actor.role === "parent" && actor.parent.id === id)
                throw new HTTPError(
                  400,
                  "Remove this phone from another device, or from the dashboard at home",
                );
              return service.revokeParent(state, id);
            }
            case "api/parents/rename": {
              const body = z
                .object({
                  id: z.string(),
                  name: z.string().trim().min(1).max(80),
                })
                .parse(data);
              if (actor.role === "parent" && actor.parent.id !== body.id)
                throw new HTTPError(400, "You can only rename this phone");
              return service.renameParent(state, body.id, body.name);
            }
            case "api/enrollment": {
              const body = z
                .union([
                  z.object({ admin: z.literal(true) }),
                  z.object({ profile_id: z.number().int().positive() }),
                ])
                .parse(data);
              return service.issueCode(
                state,
                "admin" in body ? "admin" : body.profile_id,
              );
            }
            case "api/rewards":
              return service.reward(state, data);
            case "api/rewards/delete":
              return service.cancelReward(
                state,
                z.object({ id: z.string() }).parse(data).id,
              );
            case "api/requests":
              return service.answerRequest(state, data);
            case "api/settings":
              return service.settings(state, data);
            case "api/setup/complete":
              return service.completeSetup(state);
            case "api/feeds":
              return service.addFeed(state, data);
            case "api/events/read":
              state.events.forEach((e) => (e.read = true));
              return service.snapshot(state);
            case "api/history/delete": {
              const filter = z
                .object({
                  profile_id: z.number().int().optional(),
                  device_id: z.string().optional(),
                  confirm: z.literal("DELETE"),
                })
                .parse(data);
              state.history = state.history.filter(
                (h) =>
                  (filter.profile_id !== undefined &&
                    h.profile_id !== filter.profile_id) ||
                  (filter.device_id !== undefined &&
                    h.device_id !== filter.device_id),
              );
              return service.snapshot(state);
            }
            case "api/import": {
              const backup = z
                .object({
                  confirm: z.literal("RESTORE"),
                  backup: z.object({
                    format: z.literal("temperance"),
                    schema: z.literal(2),
                    state: z.unknown(),
                  }),
                })
                .parse(data);
              const candidate = validateBackup(backup.backup.state);
              candidate.version = state.version + 1;
              Object.assign(state, candidate);
              return service.snapshot(state);
            }
            default:
              throw new HTTPError(404, "Not found");
          }
        });
        return json(result);
      }
    }
    if (path === "v1/device/login" && write) {
      const input = z
        .object({
          username: z.string().max(40),
          password: z.string().max(200),
          name: z.string().trim().min(1).max(80),
          public_key: z.string().transform(validateKey),
        })
        .parse(await body(request));
      const result = await mutate(repo, async (state) => {
        const user = await accounts.authenticate(
          state,
          input.username,
          input.password,
        );
        if (!user) return undefined;
        const code = await service.issueCode(state, user.profile_id!);
        const enrolled = await service.enroll(state, {
          code: code.code,
          name: input.name,
          public_key: input.public_key,
        });
        const device = state.devices.find((d) => d.id === enrolled.device_id)!;
        device.user_id = user.id;
        return { ...enrolled, user: accounts.publicUser(user) };
      });
      if (!result) throw new HTTPError(401, "Invalid username or password");
      return json({
        ...result,
        emergency_unlock: await emergencyVerifier(result.device_id),
      });
    }
    if (path === "v1/enroll" && write) {
      const data = await body(request);
      const enrolled = await mutate(repo, (state) =>
        service.enroll(state, data),
      );
      return json({
        ...enrolled,
        emergency_unlock: await emergencyVerifier(enrolled.device_id),
      });
    }
    if (path === "v1/gateway/parents/pair" && write) {
      if (!(await fromGateway(request)))
        throw new HTTPError(401, "Unauthorized");
      const data = await body(request);
      return json(
        await mutate(repo, (state) => service.pairParent(state, data)),
      );
    }
    // Enrollment body is read outside the optimistic retry so it is replayable.
    if (path === "v1/gateway/state" || path === "v1/gateway/activity") {
      if ((await hash(bearer(request))) !== (await hash(secrets().gateway)))
        throw new HTTPError(401, "Unauthorized");
      if (!write && path.endsWith("/state")) {
        const current = (await repo.read()).state;
        if (
          !current.gateway_seen ||
          Date.now() / 1000 - current.gateway_seen >= service.GATEWAY_HEARTBEAT
        )
          await mutate(repo, (state) => service.gatewaySeen(state));
        return json(service.gatewayState((await repo.read()).state));
      }
      if (write && path.endsWith("/activity")) {
        const data = await body(request);
        return json(
          await mutate(repo, (state) => service.account(state, data)),
        );
      }
    }
    if (path.startsWith("v1/device/")) {
      const token = bearer(request),
        state = (await repo.read()).state,
        device = await service.authenticatedDevice(state, token);
      if (!device) throw new HTTPError(401, "Invalid or revoked device");
      if (!write && path === "v1/device/state")
        return json({
          ...service.clientState(state, device),
          emergency_unlock: await emergencyVerifier(device.id),
        });
      if (write && path === "v1/device/requests") {
        const data = await body(request);
        return json(
          await mutate(repo, async (state) => {
            const current = await service.authenticatedDevice(state, token);
            if (!current) throw new HTTPError(401, "Device revoked");
            return service.requestTime(state, current, data);
          }),
        );
      }
      if (write && path === "v1/device/location") {
        const data = await body(request);
        return json(
          await mutate(repo, async (state) => {
            const current = await service.authenticatedDevice(state, token);
            if (!current) throw new HTTPError(401, "Device revoked");
            return service.reportLocation(state, current, data);
          }),
        );
      }
      if (write && path === "v1/device/diagnostics") {
        const data = await body(request);
        return json(
          await mutate(repo, async (state) => {
            const current = await service.authenticatedDevice(state, token);
            if (!current) throw new HTTPError(401, "Device revoked");
            return service.reportDiagnostics(state, current, data);
          }),
        );
      }
    }
    throw new HTTPError(404, "Not found");
  } catch (error) {
    if (error instanceof HTTPError)
      return json({ error: error.message }, error.status);
    if (error instanceof accounts.AuthError)
      return json({ error: error.message }, 400);
    if (error instanceof z.ZodError)
      return json(
        {
          error: error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        },
        400,
      );
    if (
      error instanceof Error &&
      !/database|SQL|fetch|URL|configured|Configure|network|Unauthorized|connection/i.test(
        error.message,
      )
    )
      return json({ error: error.message }, 400);
    console.error("Temperance request failed:", error);
    return json({ error: "Service configuration or storage unavailable" }, 503);
  }
}
const cookieName = "temperance_session";
function sessionCookie(request: Request, value: string, maxAge: number) {
  return `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${request.headers.get("origin")?.startsWith("https:") ? "; Secure" : ""}`;
}
function cookie(request: Request) {
  return (request.headers.get("cookie") ?? "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1);
}
type Actor = { role: "admin" } | { role: "parent"; parent: Parent };
/** The gateway proves it forwarded a request with its own secret: the per-run
 * one the embedded gateway was started with, or the standalone gateway's token. */
async function fromGateway(request: Request) {
  const presented = request.headers.get(FORWARDED) ?? (bearer(request) || null);
  if (presented === null) return false;
  const digest = await hash(presented);
  for (const secret of [
    process.env.TEMPERANCE_FORWARD_SECRET,
    process.env.TEMPERANCE_GATEWAY_TOKEN,
  ])
    if (secret && secret.length >= 32 && digest === (await hash(secret)))
      return true;
  return false;
}
// Only the admin password/session, or an admin device paired by it, can
// change family policies or client sign-ins. The paired-device actor is still
// named `parent` because that is the wire header.
async function principal(
  request: Request,
  state: State,
): Promise<Actor | null> {
  if (request.headers.has(FORWARDED)) {
    if (!(await fromGateway(request))) return null;
    const parent = service.activeParent(
      state,
      request.headers.get("x-temperance-parent") ?? "",
    );
    return parent ? { role: "parent", parent } : null;
  }
  const token = bearer(request);
  if (token && (await hash(token)) === (await hash(secrets().admin)))
    return { role: "admin" };
  return (await accounts.verifyAdminSession(cookie(request) ?? ""))
    ? { role: "admin" }
    : null;
}
/** Replace a client's leftover display name with its username, once. */
async function reconcileClients(repo: Repository) {
  const { state } = await repo.read();
  if (!accounts.clientNameDrift(state)) return;
  await mutate(repo, (current) => accounts.adoptClientUsernames(current));
}
/** Last-seen for the dashboard's list; written at most once a minute. */
async function seen(repo: Repository, parent: Parent) {
  const at = Math.floor(Date.now() / 1000);
  if (parent.last_seen && at - parent.last_seen < 60) return;
  await mutate(repo, (state) => {
    const current = service.activeParent(state, parent.id);
    if (current) current.last_seen = at;
  });
}
const FAILED_LOGIN_WINDOW = 15 * 60 * 1000;
const failedLogins = new Map<string, number[]>();
function recentFailures(key: string, at: number) {
  const recent = (failedLogins.get(key) ?? []).filter(
    (t) => at - t < FAILED_LOGIN_WINDOW,
  );
  if (recent.length) failedLogins.set(key, recent);
  else failedLogins.delete(key);
  return recent;
}
/** Ten wrong passwords from one address, or a hundred overall, pause sign-in for 15 minutes. */
function loginAllowed(request: Request, at = Date.now()) {
  const address =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "direct";
  return {
    ok:
      recentFailures(address, at).length < 10 &&
      recentFailures("*", at).length < 100,
    fail() {
      for (const key of [address, "*"])
        failedLogins.set(key, [...recentFailures(key, at), at]);
    },
  };
}
function sameOrigin(request: Request) {
  if (!trustedOrigin(request))
    throw new HTTPError(403, "Same-origin requests required");
}
async function accountRoute(request: Request, path: string, repo: Repository) {
  if (path === "v1/setup" && request.method === "GET")
    return json({ needs_setup: false, auth: "admin_password" });
  if (request.method !== "POST") throw new HTTPError(404, "Not found");
  sameOrigin(request);
  if (path === "v1/logout")
    return json({}, 200, { "Set-Cookie": sessionCookie(request, "", 0) });
  if (path !== "v1/login") throw new HTTPError(404, "Not found");
  const input = z
    .object({ password: z.string().max(200) })
    .parse(await body(request));
  const limit = loginAllowed(request);
  if (!limit.ok)
    throw new HTTPError(
      429,
      "Too many wrong passwords. Wait 15 minutes, then try again.",
    );
  if ((await hash(input.password)) !== (await hash(secrets().admin))) {
    limit.fail();
    throw new HTTPError(401, "Invalid admin password");
  }
  return json({}, 200, {
    "Set-Cookie": sessionCookie(request, await accounts.adminSession(), 3600),
  });
}
function validateBackup(value: unknown): State {
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    id = z.number().int().positive(),
    stamp = z.number().finite().nonnegative();
  const common = {
    id: z.string().uuid(),
    name: z.string().min(1).max(80),
    profile_id: z.number().int().nonnegative(),
    admin: z.boolean().optional(),
    user_id: z.string().uuid().optional(),
    revoked: z.boolean(),
    paused: z.boolean(),
    managed: z.boolean(),
    last_seen: stamp.optional(),
    location: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        accuracy: z.number().nonnegative(),
        at: stamp,
      })
      .optional(),
    location_requested: stamp.optional(),
    diagnostics: z
      .object({
        at: stamp,
        issues: z
          .array(
            z.object({
              code: z.string().max(40),
              severity: z.enum(["error", "warning", "info"]),
              message: z.string().max(120),
              action: z.string().max(200),
            }),
          )
          .max(10),
      })
      .optional(),
  };
  // The home variant is tried first: validateKey throws rather than failing the union branch.
  const device = z.union([
    z.object({
      ...common,
      kind: z.literal("home"),
      ip: z.string().refine(service.isHomeAddress),
      public_key: z.literal(""),
      token_hash: z.literal(""),
    }),
    z.object({
      ...common,
      kind: z.undefined().optional(),
      ip: z.string().regex(/^10\.77\.0\.\d{1,3}$/),
      public_key: z.string().transform(validateKey),
      token_hash: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ]);
  const iamUser = z.object({
    id: z.string().uuid(),
    username: accounts.username,
    password_hash: z
      .string()
      .regex(/^pbkdf2-sha256\$[0-9]+\$[a-f0-9]{32}\$[a-f0-9]{64}$/),
    role: z.enum(["user", "owner", "parent"]),
    profile_id: id.optional(),
    disabled: z.boolean().optional(),
    session_version: z.number().int().positive(),
    created_at: stamp,
    failed_logins: z.number().int().nonnegative(),
    locked_until: stamp.optional(),
  });
  const schema = z.object({
    users: z.array(iamUser).max(253).optional(),
    schema: z.literal(2),
    version: z.number().int().positive(),
    nextProfileId: id,
    profiles: z.array(serviceProfileSchema).max(253),
    devices: z.array(device).max(253),
    codes: z
      .array(
        z.object({
          hash: z.string().regex(/^[a-f0-9]{64}$/),
          profile_id: z.number().int().nonnegative(),
          admin: z.boolean().optional(),
          expires: stamp,
        }),
      )
      .max(1000),
    rewards: z
      .array(
        z.object({
          id: z.string(),
          profile_id: id,
          day: date,
          kind: z.enum(["extra_time", "late_bedtime", "skip_window"]),
          minutes: z.number().int().min(1).max(1440).optional(),
          bedtime: z
            .string()
            .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
            .optional(),
          window_id: z.string().optional(),
          scope: z.string().optional(),
        }),
      )
      .max(1000),
    usage: z.record(
      date,
      z.record(
        z.string(),
        z.record(z.string(), z.array(z.number().int().nonnegative()).max(1440)),
      ),
    ),
    history: z
      .array(
        z.object({
          id: z.string(),
          at: stamp,
          device_id: z.string(),
          profile_id: id,
          domain: z.string().max(253),
          blocked: z.boolean(),
          reason: z.string().max(100),
          category: z.string().max(40),
        }),
      )
      .max(20000),
    requests: z
      .array(
        z.object({
          id: z.string(),
          device_id: z.string(),
          profile_id: id,
          minutes: z.number().int().min(1).max(180),
          message: z.string().max(300),
          status: z.enum(["pending", "approved", "denied"]),
          at: stamp,
        }),
      )
      .max(500),
    events: z
      .array(
        z.object({
          id: z.string(),
          at: stamp,
          kind: z.string().max(100),
          message: z.string().max(500),
          read: z.boolean(),
        }),
      )
      .max(500),
    paused: z.boolean(),
    home_profile_id: id.optional(),
    setup_completed_at: stamp.optional(),
    extra_domains: z.record(
      z.string(),
      z.array(z.string().max(253)).max(20000),
    ),
    retention_days: z.number().int().min(1).max(90),
    offline_grace_seconds: z
      .number()
      .int()
      .min(0)
      .max(7 * 86400),
    network: z
      .object({
        upnp: z.boolean(),
        ddns: z
          .object({
            provider: z.literal("dynu"),
            hostname: z.string().refine(service.isHostname),
            username: z.string().min(1).max(100),
            password: z.string().min(1).max(200),
          })
          .optional(),
      })
      .optional(),
    parents: z
      .array(
        z.object({
          id: z.string().max(100),
          name: z.string().max(80),
          key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          created_at: stamp,
          last_seen: stamp.optional(),
          revoked: z.boolean().optional(),
        }),
      )
      .max(100)
      .optional(),
  });
  const s = schema.parse(value) as State;
  if (
    s.profiles.some((p) => !p.id) ||
    new Set(s.profiles.map((p) => p.id)).size !== s.profiles.length ||
    s.nextProfileId <= Math.max(0, ...s.profiles.map((p) => p.id))
  )
    throw new HTTPError(400, "Invalid profile IDs");
  const ids = new Set(s.profiles.map((p) => p.id));
  const users = s.users ?? [];
  if (
    new Set(users.map((u) => u.id)).size !== users.length ||
    new Set(users.map((u) => u.username)).size !== users.length
  )
    throw new HTTPError(400, "Duplicate backup users");
  for (const u of users)
    if (
      (u.role === "user" && !u.profile_id) ||
      (u.profile_id && !ids.has(u.profile_id))
    )
      throw new HTTPError(400, "Invalid backup user profile");
  for (const d of s.devices)
    if (d.user_id && !users.some((u) => u.id === d.user_id))
      throw new HTTPError(400, "Invalid backup device user");
  const vpn = s.devices.filter((d) => d.kind !== "home");
  if (
    new Set(s.devices.map((d) => d.ip)).size !== s.devices.length ||
    new Set(s.devices.map((d) => d.id)).size !== s.devices.length ||
    new Set(vpn.map((d) => d.public_key)).size !== vpn.length
  )
    throw new HTTPError(400, "Duplicate backup devices");
  for (const d of s.devices) {
    const n = Number(d.ip.split(".").at(-1));
    const badAddress = d.kind !== "home" && (n < 2 || n > 254);
    const badProfile = d.admin ? d.profile_id !== 0 : !ids.has(d.profile_id);
    if (badAddress || badProfile)
      throw new HTTPError(400, "Invalid backup device");
  }
  for (const code of s.codes)
    if (!(code.admin && code.profile_id === 0) && !ids.has(code.profile_id))
      throw new HTTPError(400, "Invalid backup profile reference");
  for (const r of [...s.rewards, ...s.requests])
    if (!ids.has(r.profile_id))
      throw new HTTPError(400, "Invalid backup profile reference");
  if (s.home_profile_id && !ids.has(s.home_profile_id))
    throw new HTTPError(400, "Invalid home profile");
  return structuredClone(s);
}
import { profileSchema as serviceProfileSchema } from "./policy";
