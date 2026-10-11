import { z } from "zod";
import * as accounts from "./accounts";
import { bearer, hash, origin, secrets, validateKey } from "./auth";
import { mutate, repository, type Repository } from "./database";
import * as service from "./service";
import type { State } from "./model";
import { localTime } from "./policy";

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
    if (
      path.startsWith("v1/oauth/") ||
      path === "v1/setup" ||
      path === "v1/login" ||
      path === "v1/logout"
    )
      return await accountRoute(request, path, repo);
    if (path.startsWith("api/")) {
      const { state } = await repo.read();
      const actor = await principal(request, state);
      if (!actor) throw new HTTPError(401, "Parent sign-in required");
      if (
        write &&
        !bearer(request) &&
        request.headers.get("origin") !== origin()
      )
        throw new HTTPError(403, "Same-origin requests required");
      if (!write) {
        const url = new URL(request.url),
          today = service.snapshot(state).day;
        if (path === "api/state") return json(service.snapshot(state));
        if (path === "api/me")
          return json(
            actor === "service"
              ? { role: "service" }
              : accounts.publicUser(actor),
          );
        if (path === "api/users")
          return json(accounts.users(state).map(accounts.publicUser));
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
              state: { ...state, users: undefined, refresh_tokens: undefined },
            },
            200,
            {
              "Content-Disposition":
                'attachment; filename="temperance-backup.json"',
            },
          );
      } else {
        const data = await body(request);
        const result = await mutate(repo, async (state) => {
          const self =
            actor === "service"
              ? undefined
              : accounts.users(state).find((u) => u.id === actor.id);
          switch (path) {
            case "api/users": {
              if (self && self.role !== "owner")
                throw new HTTPError(403, "Only the owner can add parents");
              const user = await accounts.createUser(state, data);
              service.changed(
                state,
                "account",
                `Parent ${user.username} added`,
              );
              return accounts.publicUser(user);
            }
            case "api/users/delete": {
              const id = z.object({ id: z.string() }).parse(data).id;
              accounts.deleteUser(state, self ?? { role: "owner", id: "" }, id);
              service.changed(state, "account", "Parent account removed");
              return accounts.users(state).map(accounts.publicUser);
            }
            case "api/password":
              if (!self) throw new HTTPError(400, "Sign in as a parent");
              await accounts.changePassword(state, self, data);
              return { ok: true };
            case "api/profiles":
              return service.saveProfile(state, data);
            case "api/profiles/delete":
              return service.deleteProfile(
                state,
                z.object({ id: z.number().int() }).parse(data).id,
              );
            case "api/devices":
              return service.saveDevice(state, data);
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
            case "api/enrollment":
              return service.issueCode(
                state,
                z.object({ profile_id: z.number().int() }).parse(data)
                  .profile_id,
              );
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
    if (path === "v1/enroll" && write) {
      const data = await body(request);
      return json(await mutate(repo, (state) => service.enroll(state, data)));
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
        return json(service.clientState(state, device));
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
function sessionCookie(value: string, maxAge: number) {
  return `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${origin().startsWith("https:") ? "; Secure" : ""}`;
}
function cookie(request: Request) {
  return (request.headers.get("cookie") ?? "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1);
}
// The admin secret remains a service credential for automation and first-run setup.
async function principal(request: Request, state: State) {
  const token = bearer(request);
  if (token && (await hash(token)) === (await hash(secrets().admin)))
    return "service" as const;
  const value = token || cookie(request);
  return value ? accounts.verifyAccess(state, value) : undefined;
}
async function form(request: Request): Promise<Record<string, unknown>> {
  if (
    (request.headers.get("content-type") ?? "").startsWith(
      "application/x-www-form-urlencoded",
    )
  )
    return Object.fromEntries(new URLSearchParams(await request.text()));
  return body(request);
}
function sameOrigin(request: Request) {
  if (request.headers.get("origin") !== origin())
    throw new HTTPError(403, "Same-origin requests required");
}
async function accountRoute(request: Request, path: string, repo: Repository) {
  if (path === "v1/setup" && request.method === "GET") {
    const { state } = await repo.read();
    return json({ needs_setup: accounts.users(state).length === 0 });
  }
  if (request.method !== "POST") throw new HTTPError(404, "Not found");
  if (path === "v1/logout") {
    return json({}, 200, { "Set-Cookie": sessionCookie("", 0) });
  }
  const data = await form(request);
  if (path === "v1/setup") {
    sameOrigin(request);
    const input = z
      .object({
        setup_token: z.string(),
        username: z.string(),
        password: z.string(),
      })
      .parse(data);
    if ((await hash(input.setup_token)) !== (await hash(secrets().admin)))
      throw new HTTPError(401, "Invalid setup token");
    const token = await mutate(repo, async (state) => {
      if (accounts.users(state).length)
        throw new HTTPError(409, "Setup is already complete");
      const user = await accounts.createUser(state, input, "owner");
      service.changed(state, "account", `Owner ${user.username} created`);
      return accounts.accessToken(user);
    });
    return json({ ok: true }, 200, {
      "Set-Cookie": sessionCookie(token, 3600),
    });
  }
  if (path === "v1/login") {
    sameOrigin(request);
    const input = z
      .object({ username: z.string(), password: z.string() })
      .parse(data);
    const token = await mutate(repo, async (state) => {
      const user = await accounts.authenticate(
        state,
        input.username,
        input.password,
      );
      return user ? accounts.accessToken(user) : undefined;
    });
    if (!token) throw new HTTPError(401, "Invalid username or password");
    return json({}, 200, { "Set-Cookie": sessionCookie(token, 3600) });
  }
  if (path === "v1/oauth/revoke") {
    const input = z.object({ token: z.string() }).parse(data);
    await mutate(repo, (state) => accounts.revoke(state, input.token));
    return json({});
  }
  if (path === "v1/oauth/token") {
    const grant = z
      .discriminatedUnion("grant_type", [
        z.object({
          grant_type: z.literal("password"),
          username: z.string(),
          password: z.string(),
          client_id: z.string().max(80).default("temperance"),
        }),
        z.object({
          grant_type: z.literal("refresh_token"),
          refresh_token: z.string(),
        }),
      ])
      .safeParse(data);
    if (!grant.success)
      return json(
        {
          error: "unsupported_grant_type",
          error_description: "Use password or refresh_token",
        },
        400,
      );
    const g = grant.data;
    const tokens = await mutate(repo, async (state) => {
      if (g.grant_type === "refresh_token") {
        try {
          return await accounts.refreshTokens(state, g.refresh_token);
        } catch {
          return undefined;
        }
      }
      const user = await accounts.authenticate(state, g.username, g.password);
      return user ? accounts.issueTokens(state, user, g.client_id) : undefined;
    });
    if (!tokens)
      return json(
        {
          error: "invalid_grant",
          error_description: "Invalid credentials or token",
        },
        400,
        { Pragma: "no-cache" },
      );
    return json(tokens, 200, { Pragma: "no-cache" });
  }
  throw new HTTPError(404, "Not found");
}
function validateBackup(value: unknown): State {
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    id = z.number().int().positive(),
    stamp = z.number().finite().nonnegative();
  const device = z.object({
    id: z.string().uuid(),
    ip: z.string().regex(/^10\.77\.0\.\d{1,3}$/),
    name: z.string().min(1).max(80),
    profile_id: id,
    public_key: z.string().transform(validateKey),
    token_hash: z.string().regex(/^[a-f0-9]{64}$/),
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
  });
  const schema = z.object({
    schema: z.literal(2),
    version: z.number().int().positive(),
    nextProfileId: id,
    profiles: z.array(serviceProfileSchema).max(253),
    devices: z.array(device).max(253),
    codes: z
      .array(
        z.object({
          hash: z.string().regex(/^[a-f0-9]{64}$/),
          profile_id: id,
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
  });
  const s = schema.parse(value) as State;
  if (
    s.profiles.some((p) => !p.id) ||
    new Set(s.profiles.map((p) => p.id)).size !== s.profiles.length ||
    s.nextProfileId <= Math.max(0, ...s.profiles.map((p) => p.id))
  )
    throw new HTTPError(400, "Invalid profile IDs");
  const ids = new Set(s.profiles.map((p) => p.id));
  if (
    new Set(s.devices.map((d) => d.ip)).size !== s.devices.length ||
    new Set(s.devices.map((d) => d.id)).size !== s.devices.length ||
    new Set(s.devices.map((d) => d.public_key)).size !== s.devices.length
  )
    throw new HTTPError(400, "Duplicate backup devices");
  for (const d of s.devices) {
    const n = Number(d.ip.split(".").at(-1));
    if (!ids.has(d.profile_id) || n < 2 || n > 254)
      throw new HTTPError(400, "Invalid backup device");
  }
  for (const r of [...s.codes, ...s.rewards, ...s.requests])
    if (!ids.has(r.profile_id))
      throw new HTTPError(400, "Invalid backup profile reference");
  if (s.home_profile_id && !ids.has(s.home_profile_id))
    throw new HTTPError(400, "Invalid home profile");
  return structuredClone(s);
}
import { profileSchema as serviceProfileSchema } from "./policy";
