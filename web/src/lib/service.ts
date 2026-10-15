import { z } from "zod";
import { clientUsername, users as accountUsers } from "./accounts";
import { hash, randomToken, validateKey } from "./auth";
import { FREE_DOMAINS } from "./free-domains";
import { homeNetwork, inNetwork, nextHomeAddress } from "./home-lan";
import {
  type Device,
  type NetworkSettings,
  type Parent,
  type ReachStatus,
  type State,
} from "./model";
import {
  accessReason,
  activeWindows,
  bedtimeNight,
  CATALOG,
  classify,
  dailyLimit,
  localTime,
  normalizeDomain,
  profileSchema,
  used,
  type Profile,
  type Reward,
} from "./policy";

const now = () => Math.floor(Date.now() / 1000);
const publicDevice = (d: Device) => ({
  id: d.id,
  kind: d.kind ?? ("vpn" as const),
  ip: d.ip,
  name: d.name,
  profile_id: d.profile_id,
  admin: d.admin || undefined,
  user_id: d.user_id,
  paused: d.paused,
  managed: d.managed,
  last_seen: d.last_seen,
  location: d.location,
  location_requested: d.location_requested,
  diagnostics: d.diagnostics,
});
export function prune(state: State, at = now()) {
  const cutoff = localTime(at - state.retention_days * 86400, timezone()).day;
  state.history = state.history
    .filter((h) => localTime(h.at, timezone()).day >= cutoff)
    .slice(-20000);
  for (const day of Object.keys(state.usage))
    if (day < cutoff) delete state.usage[day];
  state.rewards = state.rewards.filter(
    (r) => r.day >= localTime(at - 86400, timezone()).day,
  );
  state.codes = state.codes.filter((c) => c.expires > at);
  if (state.parent_codes)
    state.parent_codes = state.parent_codes.filter((c) => c.expires > at);
  state.events = state.events.slice(-500);
  state.requests = state.requests.slice(-500);
}
export function timezone() {
  const zone = process.env.TEMPERANCE_TIMEZONE ?? "UTC";
  new Intl.DateTimeFormat("en", { timeZone: zone });
  return zone;
}
/** Today's rewards, plus a late bedtime for a night that started yesterday. */
function currentReward(state: State, r: Reward, at: number) {
  if (r.day === localTime(at, timezone()).day) return true;
  const p = state.profiles.find((p) => p.id === r.profile_id);
  return (
    r.kind === "late_bedtime" && !!p && r.day === bedtimeNight(p, at, timezone())
  );
}
export function effectiveProfile(state: State, profile: Profile, at = now()) {
  const day = localTime(at, timezone()).day;
  return {
    ...profile,
    used: used(state.usage, day, profile.id),
    usage_minutes: state.usage[day]?.[profile.id] ?? {},
    bucket_usage: Object.fromEntries(
      Object.keys(state.usage[day]?.[profile.id] ?? {}).map((bucket) => [
        bucket,
        used(state.usage, day, profile.id, bucket),
      ]),
    ),
    rewards: state.rewards.filter(
      (r) => r.profile_id === profile.id && currentReward(state, r, at),
    ),
    access_reason: accessReason(
      profile,
      at,
      timezone(),
      state.usage,
      state.rewards,
      state.paused,
    ),
    effective_limit: dailyLimit(profile, at, timezone(), state.rewards),
  };
}
export function snapshot(state: State, at = now()) {
  const day = localTime(at, timezone()).day;
  const profiles = state.profiles.map((p) => effectiveProfile(state, p, at));
  return {
    schema: 2,
    version: state.version,
    day,
    timezone: timezone(),
    vpn: true,
    profiles,
    devices: state.devices.filter((d) => !d.revoked).map(publicDevice),
    rewards: state.rewards.filter((r) => currentReward(state, r, at)),
    requests: state.requests,
    events: state.events,
    categories: Object.fromEntries(
      Object.entries(CATALOG).map(([k, v]) => [k, v.domains]),
    ),
    catalog: CATALOG,
    extra_domains: state.extra_domains,
    free_domains: freeDomains(state),
    free_domains_default: !state.free_domains,
    paused: state.paused,
    home_profile_id: state.home_profile_id,
    retention_days: state.retention_days,
    offline_grace_seconds: state.offline_grace_seconds,
    gateway_seen: state.gateway_seen,
    network: publicNetwork(state),
    network_status: state.network_status ?? null,
    vpn_endpoint: configuredEndpoint(),
    parents: activeParents(state).map(publicParent),
    parent_access: {
      available: !!state.remote_pin && !!remoteEndpoint(state),
      host: remoteEndpoint(state)?.host ?? null,
    },
    device_setup: deviceSetupLink(state),
    home_network: homeNetwork(),
    needs_onboarding: !state.setup_completed_at && state.profiles.length === 0,
    total: profiles.reduce((sum, p) => sum + p.used, 0),
    blocked: profiles.filter((p) => p.access_reason !== "allowed").length,
    recent: state.history.slice(-100).reverse(),
  };
}
const network = (state: State) => state.network ?? { upnp: true };
export const freeDomains = (state: State) =>
  state.free_domains ?? [...FREE_DOMAINS];
/** Network settings for the dashboard: the Dynu password never leaves the server. */
function publicNetwork(state: State) {
  const { upnp, ddns } = network(state);
  return {
    upnp,
    ddns: ddns
      ? {
          provider: ddns.provider,
          hostname: ddns.hostname,
          username: ddns.username,
          has_password: !!ddns.password,
        }
      : null,
  };
}
function configuredEndpoint() {
  try {
    return vpnEndpoint();
  } catch {
    return null;
  }
}
/** Where parent phones find home: the Dynu hostname when set, on the VPN port. */
function remoteEndpoint(state: State) {
  const endpoint = configuredEndpoint();
  if (!endpoint) return null;
  const split = endpoint.lastIndexOf(":");
  return {
    host: network(state).ddns?.hostname ?? endpoint.slice(0, split),
    port: Number(endpoint.slice(split + 1)),
  };
}
const activeParents = (state: State) =>
  (state.parents ?? []).filter((p) => !p.revoked);
const publicParent = (p: Parent) => ({
  id: p.id,
  name: p.name,
  created_at: p.created_at,
  last_seen: p.last_seen,
});
const household = () => process.env.TEMPERANCE_HOUSEHOLD_NAME?.trim() ?? "";
function base64url(text: string) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
/** Where a client's device finds home (shown as a QR code). It is not a secret:
 * the device still signs in with its client user's password. */
function deviceSetupLink(state: State) {
  const endpoint = remoteEndpoint(state);
  if (!state.remote_pin || !endpoint) return null;
  const payload = {
    v: 1,
    host: endpoint.host,
    port: endpoint.port,
    pin: state.remote_pin,
    household: household(),
  };
  return "temperance://home#" + base64url(JSON.stringify(payload));
}
/** A one-use link (shown as a QR code) that pairs an admin's phone for ten minutes. */
export async function issueParentCode(state: State) {
  const endpoint = remoteEndpoint(state);
  if (!state.remote_pin)
    throw new Error(
      "Admin devices connect through the home gateway, which hasn’t checked in yet",
    );
  if (!endpoint)
    throw new Error(
      "Set TEMPERANCE_VPN_ENDPOINT so admin devices know where to find home",
    );
  const code = randomToken();
  (state.parent_codes ??= []).push({
    hash: await hash(code),
    expires: now() + 600,
  });
  prune(state);
  const payload = {
    v: 1,
    host: endpoint.host,
    port: endpoint.port,
    pin: state.remote_pin,
    code,
    household: household(),
  };
  return {
    link: "temperance://pair#" + base64url(JSON.stringify(payload)),
    expires_in: 600,
  };
}
const pairInput = z.object({
  code: z.string().max(100),
  name: z.string().trim().min(1).max(80),
  key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
/** Called by the gateway once a phone has proved it holds `key`. */
export async function pairParent(state: State, input: unknown) {
  const data = pairInput.parse(input);
  const codeHash = await hash(data.code);
  const code = (state.parent_codes ?? []).find(
    (c) => c.hash === codeHash && c.expires > now(),
  );
  if (!code)
    throw new Error(
      "That pairing code has expired or was already used. Create a new one under Devices.",
    );
  state.parent_codes = state.parent_codes!.filter((c) => c !== code);
  const parents = (state.parents ??= []);
  if (parents.some((p) => !p.revoked && p.key === data.key))
    throw new Error("This phone is already paired");
  const parent: Parent = {
    id: "par_" + crypto.randomUUID(),
    name: data.name,
    key: data.key,
    created_at: now(),
  };
  parents.push(parent);
  changed(
    state,
    "account",
    `${parent.name} can now open the dashboard away from home`,
  );
  return { id: parent.id, household: household() };
}
export function activeParent(state: State, id: string) {
  return activeParents(state).find((p) => p.id === id);
}
export function revokeParent(state: State, id: string) {
  const parent = activeParent(state, id);
  if (!parent) throw new Error("That admin device is not paired");
  parent.revoked = true;
  changed(
    state,
    "account",
    `${parent.name} can no longer open the dashboard away from home`,
  );
  return snapshot(state);
}
export function renameParent(state: State, id: string, name: string) {
  const parent = (state.parents ?? []).find((p) => p.id === id && !p.revoked);
  if (!parent) throw new Error("That admin device is not paired");
  parent.name = name;
  changed(state, "account", `${parent.name} renamed`);
  return snapshot(state);
}
function profile(state: State, id: number) {
  const found = state.profiles.find((p) => p.id === id);
  if (!found) throw new Error("Client does not exist");
  return found;
}
function event(state: State, kind: string, message: string) {
  state.events.push({
    id: crypto.randomUUID(),
    at: now(),
    kind,
    message,
    read: false,
  });
}
export function changed(state: State, kind: string, message: string) {
  state.version++;
  event(state, kind, message);
  prune(state);
}
export function completeSetup(state: State) {
  if (!state.setup_completed_at) {
    state.setup_completed_at = now();
    changed(state, "account", "First-run setup finished");
  }
  return snapshot(state);
}
export function saveProfile(state: State, input: unknown) {
  const data = profileSchema.parse(input);
  const existing = data.id ? profile(state, data.id) : null;
  const saved = { ...data, id: existing?.id ?? state.nextProfileId++ };
  const linked = accountUsers(state).find((u) => u.profile_id === saved.id);
  if (linked) {
    const name = clientUsername(saved.name);
    if (
      accountUsers(state).some(
        (u) => u.id !== linked.id && u.username === name,
      )
    )
      throw new Error("That username is taken");
    saved.name = name;
    linked.username = name;
  }
  if (existing)
    state.profiles = state.profiles.map((p) => (p.id === saved.id ? saved : p));
  else state.profiles.push(saved);
  changed(
    state,
    "policy",
    `Client ${saved.name} ${existing ? "updated" : "created"}`,
  );
  return snapshot(state);
}
export function deleteProfile(state: State, id: number) {
  profile(state, id);
  if (state.devices.some((d) => !d.revoked && d.profile_id === id))
    throw new Error("Reassign or revoke this client’s devices first");
  state.users = (state.users ?? []).filter((u) => u.profile_id !== id);
  state.profiles = state.profiles.filter((p) => p.id !== id);
  state.rewards = state.rewards.filter((r) => r.profile_id !== id);
  if (state.home_profile_id === id) delete state.home_profile_id;
  changed(state, "policy", "Client removed");
  return snapshot(state);
}
/** A parent's device has no child client. `0` is that sentinel, never a profile id. */
export function adminClient(): Profile {
  return {
    ...profileSchema.parse({ name: "admin", filter_level: "none", avatar: "" }),
    id: 0,
  };
}
export async function issueCode(state: State, id: number | "admin") {
  if (id !== "admin") profile(state, id);
  const code = randomToken();
  state.codes.push({
    hash: await hash(code),
    profile_id: id === "admin" ? 0 : id,
    ...(id === "admin" ? { admin: true } : {}),
    expires: now() + 600,
  });
  prune(state);
  return { code, expires_in: 600 };
}
export function isHomeAddress(ip: string) {
  const parts = ip.split(".");
  if (
    parts.length !== 4 ||
    parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)
  )
    return false;
  const [a, b, c, d] = parts.map(Number);
  if (d === 0 || d === 255 || (a === 10 && b === 77 && c === 0)) return false;
  return (
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}
const homeInput = z.object({
  name: z.string().trim().min(1).max(80),
  ip: z.string().trim().optional().or(z.literal("")),
  profile_id: z.number().int().positive(),
});
export function addHomeDevice(state: State, input: unknown) {
  const data = homeInput.parse(input);
  profile(state, data.profile_id);
  const lan = homeNetwork();
  if (!lan) throw new Error("Turn on access point mode before adding a device");
  const used = state.devices.filter((d) => !d.revoked).map((d) => d.ip);
  let ip = data.ip ?? "";
  if (!ip) {
    ip = nextHomeAddress(lan, used) ?? "";
    if (!ip) throw new Error("There are no free addresses on this subnet");
  } else if (!isHomeAddress(ip)) {
    throw new Error("Use a private IPv4 address");
  } else if (
    lan &&
    (ip === lan.gateway || !inNetwork(ip, lan.gateway, lan.prefix))
  ) {
    throw new Error(
      `Use an address on ${lan.gateway}/${lan.prefix} other than ${lan.gateway}`,
    );
  }
  if (used.includes(ip)) throw new Error("A device already uses that address");
  state.devices = state.devices.filter((d) => d.ip !== ip);
  state.devices.push({
    id: crypto.randomUUID(),
    kind: "home",
    name: data.name,
    ip,
    profile_id: data.profile_id,
    public_key: "",
    token_hash: "",
    revoked: false,
    paused: false,
    managed: true,
  });
  changed(state, "new_device", `${data.name} added on the home network`);
  return snapshot(state);
}
const deviceInput = z.object({
  ip: z.string().regex(/^(?:\d{1,3}\.){3}\d{1,3}$/),
  name: z.string().trim().min(1).max(80),
  profile_id: z.number().int().nonnegative(),
  paused: z.boolean().optional(),
  managed: z.boolean().optional(),
});
export function saveDevice(state: State, input: unknown) {
  const data = deviceInput.parse(input);
  const device = state.devices.find((d) => d.ip === data.ip && !d.revoked);
  if (!device) throw new Error("Enroll a VPN device first");
  if (device.admin) {
    if (data.profile_id !== 0)
      throw new Error(
        "An admin device stays an admin. Remove it and enroll it again to follow a client.",
      );
  } else if (data.profile_id === 0) {
    throw new Error(
      "A client's device stays with that client. Remove it and enroll it again to make it an admin device.",
    );
  } else {
    profile(state, data.profile_id);
    const owner =
      device.user_id && (state.users ?? []).find((u) => u.id === device.user_id);
    if (owner && owner.profile_id !== data.profile_id)
      throw new Error("This device follows the client who signed in");
  }
  Object.assign(device, data);
  if (device.admin) device.profile_id = 0;
  if (device.kind === "home") delete device.location_requested;
  changed(state, "device", `Device ${device.name} updated`);
  return snapshot(state);
}
export function revokeDevice(state: State, ip: string) {
  const device = state.devices.find((d) => d.ip === ip && !d.revoked);
  if (!device) throw new Error("Device does not exist");
  device.revoked = true;
  changed(state, "device", `Device ${device.name} revoked`);
  return snapshot(state);
}
/** A DNS name such as `home.example.net` (lowercase, not an IP address). */
export function isHostname(host: string) {
  const labels = host.split(".");
  return (
    host.length <= 253 &&
    labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) &&
    !/^\d+$/.test(labels.at(-1)!)
  );
}
/** `ipv4:port` or `hostname:port` (dynamic DNS for a home gateway). */
export function vpnEndpoint(value = process.env.TEMPERANCE_VPN_ENDPOINT ?? "") {
  const match = /^([a-zA-Z0-9.-]{1,253}):(\d{1,5})$/.exec(value);
  const host = match?.[1].toLowerCase() ?? "";
  const port = Number(match?.[2]);
  const labels = host.split(".");
  const valid = /^[\d.]+$/.test(host)
    ? labels.length === 4 && labels.every((n) => n !== "" && Number(n) <= 255)
    : isHostname(host);
  if (!match || !valid || port < 1 || port > 65535)
    throw new Error(
      "Configure TEMPERANCE_VPN_ENDPOINT as host:port (IPv4 address or DNS name)",
    );
  return `${host}:${port}`;
}
export function provisioning(device: Device) {
  const endpoint = vpnEndpoint();
  const serverKey = validateKey(process.env.TEMPERANCE_VPN_PUBLIC_KEY);
  const octet = Number(device.ip.split(".").at(-1));
  return {
    address: device.ip + "/32",
    address_v6: `fd77::${octet.toString(16)}/128`,
    dns: "10.77.0.1",
    endpoint,
    public_key: serverKey,
    allowed_ips: "0.0.0.0/0, ::/0",
    keepalive: 25,
  };
}
export function clientState(state: State, device: Device, at = now()) {
  const p = device.admin ? adminClient() : profile(state, device.profile_id),
    policy = effectiveProfile(state, p, at);
  const bedtime =
    p.bedtime.enabled === false
      ? { ...policy.bedtime, start: "", end: "" }
      : policy.bedtime;
  const reason = !device.managed
    ? "unmanaged"
    : device.paused
      ? "device pause"
      : policy.access_reason;
  return {
    device_id: device.id,
    version: state.version,
    policy: { ...policy, bedtime, timezone: timezone() },
    tunnel: provisioning(device),
    status: {
      reason,
      remaining_minutes:
        policy.effective_limit === 0
          ? null
          : Math.max(0, policy.effective_limit - policy.used),
      active_windows: activeWindows(p, at, timezone(), state.rewards),
      observed_at: at,
    },
    requests: state.requests.filter((r) => r.device_id === device.id),
    location_requested: locationPending(device, at),
  };
}
const LOCATION_REQUEST_TTL = 3600;
const locationPending = (device: Device, at = now()) =>
  !!device.location_requested &&
  at - device.location_requested < LOCATION_REQUEST_TTL;
export function requestLocation(state: State, ip: string) {
  const device = state.devices.find((d) => d.ip === ip && !d.revoked);
  if (!device) throw new Error("Device does not exist");
  if (device.kind === "home")
    throw new Error("Home devices cannot share a location");
  device.location_requested = now();
  event(state, "location", `Location requested from ${device.name}`);
  return snapshot(state);
}
const locationInput = z.union([
  z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracy: z.number().nonnegative().max(1e6),
  }),
  z.object({ unavailable: z.string().trim().min(1).max(120) }),
]);
export function reportLocation(state: State, device: Device, input: unknown) {
  const data = locationInput.parse(input);
  if (!locationPending(device))
    throw new Error("No location request is pending");
  delete device.location_requested;
  if ("unavailable" in data) {
    event(
      state,
      "location",
      `${device.name} could not share its location: ${data.unavailable}`,
    );
    return { ok: true };
  }
  device.location = { ...data, at: now() };
  event(state, "location", `${device.name} shared its location`);
  return { ok: true };
}
const issueSchema = z.object({
  code: z.string().regex(/^[a-z_]{1,40}$/),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string().trim().min(1).max(120),
  action: z.string().trim().max(200).default(""),
});
const diagnosticsInput = z.object({ issues: z.array(issueSchema).max(10) });
export function reportDiagnostics(
  state: State,
  device: Device,
  input: unknown,
) {
  const { issues } = diagnosticsInput.parse(input);
  const before = new Set(device.diagnostics?.issues.map((i) => i.code));
  for (const issue of issues)
    if (issue.severity !== "info" && !before.has(issue.code))
      event(state, "device_health", `${device.name}: ${issue.message}`);
  device.diagnostics = { at: now(), issues };
  return { ok: true };
}
export const GATEWAY_HEARTBEAT = 60;
export function gatewaySeen(state: State, at = now()) {
  if (state.gateway_seen && at - state.gateway_seen < GATEWAY_HEARTBEAT)
    return false;
  if (state.gateway_seen && at - state.gateway_seen > 5 * GATEWAY_HEARTBEAT)
    event(state, "gateway", "VPN gateway reconnected");
  state.gateway_seen = at;
  return true;
}
export async function authenticatedDevice(state: State, token: string) {
  const tokenHash = await hash(token);
  return state.devices.find(
    (d) =>
      !d.revoked &&
      d.token_hash === tokenHash &&
      (!d.user_id ||
        (state.users ?? []).some(
          (u) =>
            u.id === d.user_id && !u.disabled && u.profile_id === d.profile_id,
        )),
  );
}
export async function enroll(state: State, input: unknown) {
  const data = z
      .object({
        code: z.string().max(100),
        name: z.string().trim().min(1).max(80),
        public_key: z.string(),
      })
      .parse(input),
    publicKey = validateKey(data.public_key);
  const codeHash = await hash(data.code),
    code = state.codes.find((c) => c.hash === codeHash && c.expires > now());
  if (!code) throw new Error("Enrollment code expired or already used");
  if (state.devices.some((d) => d.public_key === publicKey))
    throw new Error("Key already enrolled; use a fresh key");
  const ip = Array.from({ length: 253 }, (_, n) => `10.77.0.${n + 2}`).find(
    (ip) => !state.devices.some((d) => d.ip === ip),
  );
  if (!ip) throw new Error("Gateway address pool exhausted");
  const token = randomToken(),
    device: Device = {
      id: crypto.randomUUID(),
      ip,
      name: data.name,
      profile_id: code.admin ? 0 : code.profile_id,
      ...(code.admin ? { admin: true } : {}),
      public_key: publicKey,
      token_hash: await hash(token),
      revoked: false,
      paused: false,
      managed: true,
      last_seen: now(),
    };
  provisioning(device);
  state.devices.push(device);
  state.codes = state.codes.filter((c) => c !== code);
  changed(state, "new_device", `${device.name} enrolled`);
  return { token, ...clientState(state, device) };
}
export function gatewayState(state: State, at = now()) {
  const { home_network: _network, ...view } = snapshot(state, at);
  const profiles = state.devices.some((d) => !d.revoked && d.admin)
    ? [...view.profiles, effectiveProfile(state, adminClient(), at)]
    : view.profiles;
  return {
    ...view,
    profiles,
    issued_at: at,
    policy_schema: 2,
    offline_grace_seconds: state.offline_grace_seconds,
    network: { upnp: network(state).upnp, ddns: network(state).ddns ?? null },
    parents: activeParents(state).map((p) => ({ id: p.id, key: p.key })),
    peers: state.devices
      .filter((d) => !d.revoked && d.kind !== "home")
      .map((d) => ({
        id: d.id,
        ip: d.ip,
        public_key: d.public_key,
        profile_id: d.profile_id,
        paused: d.paused,
        managed: d.managed,
      })),
    lan_devices: state.devices
      .filter((d) => !d.revoked && d.kind === "home")
      .map((d) => ({
        id: d.id,
        ip: d.ip,
        profile_id: d.profile_id,
        paused: d.paused,
        managed: d.managed,
      })),
  };
}
const reachStatus = z.object({
  state: z.enum(["ok", "warning", "error", "off"]),
  ip: z.string().max(45).nullable(),
  message: z.string().max(500),
  at: z.number(),
});
const activityInput = z.object({
  active_devices: z.array(z.string()).max(253).default([]),
  activity: z
    .array(
      z.object({
        device_id: z.string(),
        minute: z.number().int().optional(),
        buckets: z.array(z.string().max(300)).max(40).default(["total"]),
      }),
    )
    .max(1000)
    .default([]),
  history: z
    .array(
      z.object({
        id: z.string().max(100),
        device_id: z.string(),
        at: z.number(),
        domain: z.string().max(253),
        blocked: z.boolean(),
        reason: z.string().max(100),
        category: z.string().max(40).default("other"),
      }),
    )
    .max(500)
    .default([]),
  network: z
    .object({ upnp: reachStatus.nullable(), ddns: reachStatus.nullable() })
    .optional(),
  remote: z.object({ pin: z.string().max(100) }).optional(),
});
/** Store the gateway's reachability report; problems and recoveries become events. */
function recordNetwork(
  state: State,
  report: { upnp: ReachStatus | null; ddns: ReachStatus | null },
  at: number,
) {
  const before = state.network_status;
  state.network_status = { ...report, reported_at: at };
  const names = { upnp: "Port forwarding", ddns: "Dynamic DNS" };
  for (const key of ["upnp", "ddns"] as const) {
    const status = report[key],
      old = before?.[key];
    if (!status || status.message === old?.message) continue;
    if (status.state === "error" || status.state === "warning")
      event(state, "network", `${names[key]}: ${status.message}`.slice(0, 500));
    else if (
      status.state === "ok" &&
      (old?.state === "error" || old?.state === "warning")
    )
      event(state, "network", `${names[key]} works again`);
  }
}
export function account(state: State, input: unknown) {
  const data = activityInput.parse(input),
    at = now();
  if (data.network) recordNetwork(state, data.network, at);
  if (data.remote) state.remote_pin = data.remote.pin;
  const entries = [
    ...data.active_devices.map((device_id) => ({
      device_id,
      minute: Math.floor(at / 60),
      buckets: ["total"],
    })),
    ...data.activity,
  ];
  for (const entry of entries) {
    const device = state.devices.find(
      (d) => d.id === entry.device_id && !d.revoked,
    );
    if (!device) continue;
    if (device.admin) {
      device.last_seen = at;
      continue;
    }
    const p = profile(state, device.profile_id);
    if (!device.managed || !p.managed || p.filter_level === "none") continue;
    const minute = entry.minute ?? Math.floor(at / 60);
    if (
      minute > Math.floor(at / 60) + 1 ||
      minute < Math.floor(at / 60) - 7 * 1440
    )
      throw new Error("Activity timestamp outside recovery window");
    const day = localTime(minute * 60, timezone()).day;
    const daily = (state.usage[day] ??= {});
    const usage = (daily[p.id] ??= {});
    for (const bucket of entry.buckets) {
      if (
        bucket !== "total" &&
        !/^((category|site):[a-z0-9.-]+|group:[a-z0-9-]+)$/.test(bucket)
      )
        throw new Error("Invalid usage bucket");
      const list = (usage[bucket] ??= []);
      if (!list.includes(minute)) list.push(minute);
    }
    device.last_seen = at;
  }
  const known = new Set(state.history.map((h) => h.id));
  for (const h of data.history) {
    const device = state.devices.find(
      (d) => d.id === h.device_id && !d.revoked,
    );
    if (!device || device.admin || known.has(h.id)) continue;
    const p = profile(state, device.profile_id);
    if (!device.managed || !p.managed || p.filter_level === "none") continue;
    if (h.at > at + 60 || h.at < at - state.retention_days * 86400) continue;
    state.history.push({
      ...h,
      profile_id: p.id,
      domain: h.domain ? new URL("https://" + h.domain).hostname : "",
    });
    known.add(h.id);
  }
  prune(state);
  return { ok: true };
}
const rewardSchema = z.object({
  id: z.string().optional(),
  profile_id: z.number().int().positive(),
  kind: z.enum(["extra_time", "late_bedtime", "skip_window"]),
  minutes: z.number().int().min(1).max(1440).optional(),
  bedtime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional(),
  window_id: z.string().optional(),
  scope: z
    .string()
    .regex(/^(total|category:[a-z]+|site:[a-z0-9.-]+|group:[a-z0-9-]+)$/)
    .default("total"),
});
export function reward(state: State, input: unknown) {
  const data = rewardSchema.parse(input);
  const p = profile(state, data.profile_id);
  if (data.kind === "extra_time" && !data.minutes)
    throw new Error("Set reward minutes");
  if (data.kind === "late_bedtime" && !data.bedtime)
    throw new Error("Set the new bedtime");
  if (
    data.kind === "skip_window" &&
    !p.schedules.some((s) => s.id === data.window_id)
  )
    throw new Error("Choose a schedule to skip");
  const value = {
    profile_id: data.profile_id,
    kind: data.kind,
    scope: data.scope,
    ...(data.kind === "extra_time"
      ? { minutes: data.minutes }
      : data.kind === "late_bedtime"
        ? { bedtime: data.bedtime }
        : { window_id: data.window_id }),
    id: data.id ?? crypto.randomUUID(),
    day:
      data.kind === "late_bedtime"
        ? bedtimeNight(p, now(), timezone())
        : localTime(now(), timezone()).day,
  };
  state.rewards = state.rewards.filter((r) => r.id !== value.id);
  state.rewards.push(value);
  changed(state, "reward", `Reward sent to ${p.name}`);
  return snapshot(state);
}
export function cancelReward(state: State, id: string) {
  state.rewards = state.rewards.filter((r) => r.id !== id);
  changed(state, "reward", "Reward cancelled");
  return snapshot(state);
}
export function requestTime(state: State, device: Device, input: unknown) {
  const data = z
    .object({
      minutes: z.number().int().min(1).max(180),
      message: z.string().trim().max(300).default(""),
    })
    .parse(input);
  if (
    state.requests.some(
      (r) => r.device_id === device.id && r.status === "pending",
    )
  )
    throw new Error("You already have a pending request");
  const request = {
    ...data,
    id: crypto.randomUUID(),
    at: now(),
    device_id: device.id,
    profile_id: device.profile_id,
    status: "pending" as const,
  };
  state.requests.push(request);
  event(
    state,
    "time_request",
    `${device.name} requested ${data.minutes} extra minutes`,
  );
  return request;
}
export function answerRequest(state: State, input: unknown) {
  const data = z.object({ id: z.string(), approve: z.boolean() }).parse(input);
  const request = state.requests.find(
    (r) => r.id === data.id && r.status === "pending",
  );
  if (!request) throw new Error("Pending request not found");
  request.status = data.approve ? "approved" : "denied";
  if (data.approve)
    reward(state, {
      profile_id: request.profile_id,
      kind: "extra_time",
      minutes: request.minutes,
    });
  changed(state, "time_request", `Time request ${request.status}`);
  return snapshot(state);
}
export function settings(state: State, input: unknown) {
  const data = z
    .object({
      paused: z.boolean().optional(),
      retention_days: z.number().int().min(1).max(90).optional(),
      offline_grace_seconds: z
        .number()
        .int()
        .min(0)
        .max(7 * 86400)
        .optional(),
      network: networkInput.optional(),
      /** `null` goes back to the built-in list. */
      free_domains: z.array(freeDomain).max(1000).nullable().optional(),
    })
    .parse(input);
  const { network: reach, free_domains: free, ...household } = data;
  if (reach) state.network = networkSettings(state, reach);
  if (free === null) delete state.free_domains;
  else if (free) state.free_domains = [...new Set(free)];
  Object.assign(state, household);
  changed(
    state,
    "settings",
    reach
      ? "Remote access settings updated"
      : free !== undefined
        ? "Free domains updated"
        : "Household settings updated",
  );
  return snapshot(state);
}
/** A leading `*.` is accepted because every entry already covers its subdomains. */
const freeDomain = z.string().transform((value, ctx) => {
  try {
    return normalizeDomain(value.trim().replace(/^\*\./, ""));
  } catch {
    ctx.addIssue({ code: "custom", message: `${value} is not a domain name` });
    return z.NEVER;
  }
});
const networkInput = z.object({
  upnp: z.boolean(),
  ddns: z
    .object({
      provider: z.literal("dynu").default("dynu"),
      hostname: z
        .string()
        .trim()
        .toLowerCase()
        .refine(
          (h) => isHostname(h) && h.includes("."),
          "Use the full Dynu hostname, e.g. myhome.ddnsfree.com",
        ),
      username: z.string().trim().min(1).max(100),
      password: z.string().max(200).default(""),
    })
    .nullable(),
});
/** A blank password keeps the saved one, so the dashboard never has to show it. */
function networkSettings(
  state: State,
  input: z.infer<typeof networkInput>,
): NetworkSettings {
  if (!input.ddns) return { upnp: input.upnp };
  const password = input.ddns.password || state.network?.ddns?.password;
  if (!password) throw new Error("Enter the Dynu IP update password");
  return { upnp: input.upnp, ddns: { ...input.ddns, password } };
}
export function usageSummary(state: State, start: string, end: string) {
  return Object.entries(state.usage)
    .filter(([day]) => day >= start && day <= end)
    .map(([day, profiles]) => ({
      day,
      profiles: Object.fromEntries(
        Object.entries(profiles).map(([id, buckets]) => [
          id,
          Object.fromEntries(
            Object.entries(buckets).map(([bucket, list]) => [
              bucket,
              list.length,
            ]),
          ),
        ]),
      ),
    }));
}
export function addFeed(state: State, input: unknown) {
  const data = z
    .object({
      category: z.enum(Object.keys(CATALOG) as ["social", ...string[]]),
      domains: z.array(z.string()).max(20000),
    })
    .parse(input);
  state.extra_domains[data.category] = [
    ...new Set(data.domains.map(normalizeDomain)),
  ];
  changed(state, "feed", `Updated ${data.category} category feed`);
  return snapshot(state);
}
