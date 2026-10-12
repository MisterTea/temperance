import { z } from "zod";
import { hash, secrets } from "./auth";
import type { State, User } from "./model";

const ITERATIONS = 600_000;
const now = () => Math.floor(Date.now() / 1000);
const hex = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
const unhex = (text: string) =>
  Uint8Array.from(text.match(/../g) ?? [], (n) => parseInt(n, 16));
export class AuthError extends Error {
  constructor(
    public code: "invalid_grant" | "invalid_request" | "invalid_token",
    message: string,
  ) {
    super(message);
  }
}
async function derive(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return hex(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: salt as BufferSource,
        iterations,
      },
      key,
      256,
    ),
  );
}
export async function hashPassword(password: string, iterations = ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${iterations}$${hex(salt)}$${await derive(password, salt, iterations)}`;
}
function equal(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export async function verifyPassword(password: string, stored: string) {
  const [scheme, iterations, salt, expected] = stored.split("$");
  const n = Number(iterations);
  if (
    scheme !== "pbkdf2-sha256" ||
    !Number.isInteger(n) ||
    n < 1000 ||
    n > 1_000_000 ||
    !/^[a-f0-9]{32}$/.test(salt ?? "") ||
    !/^[a-f0-9]{64}$/.test(expected ?? "")
  )
    return false;
  return equal(await derive(password, unhex(salt), n), expected);
}
export const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,40}$/, "Use 3–40 letters, digits, dots or dashes");
export const password = z
  .string()
  .min(10, "Use at least 10 characters")
  .max(200);
export const users = (state: State) => (state.users ??= []);
export const publicUser = (u: User) => ({
  id: u.id,
  username: u.username,
  profile_id: u.profile_id,
  disabled: u.disabled ?? false,
  created_at: u.created_at,
});
function assignedProfile(state: State, id: number) {
  if (!state.profiles.some((p) => p.id === id))
    throw new Error("Choose an existing family profile");
}
export async function createUser(state: State, input: unknown) {
  const data = z
    .object({ username, password, profile_id: z.number().int().positive() })
    .parse(input);
  assignedProfile(state, data.profile_id);
  if (users(state).some((u) => u.username === data.username))
    throw new Error("That username is taken");
  const user: User = {
    id: crypto.randomUUID(),
    username: data.username,
    password_hash: await hashPassword(data.password),
    profile_id: data.profile_id,
    role: "user",
    disabled: false,
    session_version: 1,
    created_at: now(),
    failed_logins: 0,
  };
  users(state).push(user);
  state.version++;
  return user;
}
export async function updateUser(state: State, input: unknown) {
  const data = z
    .object({
      id: z.string(),
      username: username.optional(),
      password: password.optional(),
      profile_id: z.number().int().positive().optional(),
      disabled: z.boolean().optional(),
    })
    .parse(input);
  const u = users(state).find((u) => u.id === data.id);
  if (!u) throw new Error("User does not exist");
  if (
    data.username &&
    users(state).some(
      (other) => other.id !== u.id && other.username === data.username,
    )
  )
    throw new Error("That username is taken");
  if (data.profile_id !== undefined) {
    assignedProfile(state, data.profile_id);
    u.profile_id = data.profile_id;
    for (const d of state.devices)
      if (d.user_id === u.id && !d.revoked) d.profile_id = data.profile_id;
  }
  if (data.username) u.username = data.username;
  if (data.disabled !== undefined) u.disabled = data.disabled;
  if (data.password) {
    u.password_hash = await hashPassword(data.password);
    u.session_version++;
    u.failed_logins = 0;
    delete u.locked_until;
    for (const d of state.devices) if (d.user_id === u.id) d.revoked = true;
  }
  if (u.disabled)
    for (const d of state.devices) if (d.user_id === u.id) d.revoked = true;
  state.version++;
  return u;
}
export function deleteUser(state: State, id: string) {
  if (!users(state).some((u) => u.id === id))
    throw new Error("User does not exist");
  for (const d of state.devices) if (d.user_id === id) d.revoked = true;
  state.users = users(state).filter((u) => u.id !== id);
  state.version++;
}
export async function authenticate(state: State, name: string, secret: string) {
  const u = users(state).find((u) => u.username === name.trim().toLowerCase());
  if (
    !u ||
    u.disabled ||
    !u.profile_id ||
    !state.profiles.some((p) => p.id === u.profile_id)
  ) {
    await hashPassword(secret, 1000);
    return undefined;
  }
  if ((u.locked_until ?? 0) > now()) return undefined;
  if (await verifyPassword(secret, u.password_hash)) {
    u.failed_logins = 0;
    delete u.locked_until;
    return u;
  }
  u.failed_logins++;
  if (u.failed_logins >= 10) {
    u.locked_until = now() + 900;
    u.failed_logins = 0;
  }
  return undefined;
}
async function signingKey() {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("temperance-admin:" + secrets().admin),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function adminSession() {
  const payload = `a1.${now() + 3600}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(),
    new TextEncoder().encode(payload),
  );
  return payload + "." + hex(signature);
}
export async function verifyAdminSession(token: string) {
  const [kind, expiry, signature, ...rest] = token.split(".");
  if (
    kind !== "a1" ||
    rest.length ||
    !/^\d+$/.test(expiry ?? "") ||
    Number(expiry) <= now() ||
    !/^[a-f0-9]{64}$/.test(signature ?? "")
  )
    return false;
  return crypto.subtle.verify(
    "HMAC",
    await signingKey(),
    unhex(signature) as BufferSource,
    new TextEncoder().encode(`${kind}.${expiry}`),
  );
}
