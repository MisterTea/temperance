import { z } from "zod";
import { hash, randomToken, secrets } from "./auth";
import type { State, User } from "./model";

const ITERATIONS = 600_000;
const ACCESS_SECONDS = 3600;
const REFRESH_SECONDS = 30 * 86400;
const LOCK_AFTER = 10;
const LOCK_SECONDS = 15 * 60;
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
  if (scheme !== "pbkdf2-sha256" || !expected) return false;
  return equal(
    await derive(password, unhex(salt), Number(iterations)),
    expected,
  );
}

export const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,40}$/, "Use 3-40 letters, digits, dots, dashes");
export const password = z
  .string()
  .min(10, "Use at least 10 characters")
  .max(200);

export const users = (state: State) => (state.users ??= []);
export const publicUser = (u: User) => ({
  id: u.id,
  username: u.username,
  role: u.role,
  created_at: u.created_at,
});

export async function createUser(
  state: State,
  input: unknown,
  role?: User["role"],
) {
  const data = z
    .object({
      username,
      password,
      role: z.enum(["owner", "parent"]).default("parent"),
    })
    .parse(input);
  if (users(state).some((u) => u.username === data.username))
    throw new Error("That username is taken");
  const user: User = {
    id: crypto.randomUUID(),
    username: data.username,
    password_hash: await hashPassword(data.password),
    role: role ?? data.role,
    session_version: 1,
    created_at: now(),
    failed_logins: 0,
  };
  users(state).push(user);
  return user;
}
export function deleteUser(
  state: State,
  actor: Pick<User, "id" | "role">,
  id: string,
) {
  const target = users(state).find((u) => u.id === id);
  if (!target) throw new Error("Account does not exist");
  if (actor.role !== "owner" && actor.id !== id)
    throw new Error("Only the owner can remove other parents");
  if (
    target.role === "owner" &&
    users(state).filter((u) => u.role === "owner").length === 1
  )
    throw new Error("Keep at least one owner account");
  state.users = users(state).filter((u) => u.id !== id);
  state.refresh_tokens = (state.refresh_tokens ?? []).filter(
    (t) => t.user_id !== id,
  );
}
export async function changePassword(state: State, user: User, input: unknown) {
  const data = z
    .object({ current_password: z.string(), new_password: password })
    .parse(input);
  if (!(await verifyPassword(data.current_password, user.password_hash)))
    throw new AuthError("invalid_grant", "Current password is incorrect");
  user.password_hash = await hashPassword(data.new_password);
  user.session_version++;
  state.refresh_tokens = (state.refresh_tokens ?? []).filter(
    (t) => t.user_id !== user.id,
  );
}

// Failed attempts are recorded even when the caller rejects, so the lockout
// cannot be bypassed by retrying while a mutation is rolled back.
export async function authenticate(
  state: State,
  name: string,
  secret: string,
): Promise<User | undefined> {
  const user = users(state).find(
    (u) => u.username === name.trim().toLowerCase(),
  );
  if (!user) {
    await hashPassword(secret, 1000);
    return undefined;
  }
  if ((user.locked_until ?? 0) > now()) return undefined;
  if (await verifyPassword(secret, user.password_hash)) {
    user.failed_logins = 0;
    delete user.locked_until;
    return user;
  }
  user.failed_logins++;
  if (user.failed_logins >= LOCK_AFTER) {
    user.locked_until = now() + LOCK_SECONDS;
    user.failed_logins = 0;
  }
  return undefined;
}

async function signingKey() {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("temperance-access:" + secrets().admin),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function accessToken(user: User, seconds = ACCESS_SECONDS) {
  const payload = `u1.${user.id}.${user.session_version}.${now() + seconds}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(),
    new TextEncoder().encode(payload),
  );
  return payload + "." + hex(signature);
}
export async function verifyAccess(state: State, token: string) {
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== "u1") return undefined;
  const [, id, version, expiry, signature] = parts;
  if (!/^[a-f0-9]{64}$/.test(signature) || Number(expiry) <= now())
    return undefined;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await signingKey(),
    unhex(signature) as BufferSource,
    new TextEncoder().encode(parts.slice(0, 4).join(".")),
  );
  if (!valid) return undefined;
  return users(state).find(
    (u) => u.id === id && String(u.session_version) === version,
  );
}
export async function issueTokens(state: State, user: User, clientId: string) {
  const refresh = randomToken();
  state.refresh_tokens = [
    ...(state.refresh_tokens ?? []).filter((t) => t.expires > now()),
    {
      hash: await hash(refresh),
      user_id: user.id,
      client_id: clientId,
      expires: now() + REFRESH_SECONDS,
    },
  ].slice(-200);
  return {
    access_token: await accessToken(user),
    token_type: "Bearer",
    expires_in: ACCESS_SECONDS,
    refresh_token: refresh,
    scope: "family:admin",
  };
}
export async function refreshTokens(state: State, token: string) {
  const digest = await hash(token);
  const found = (state.refresh_tokens ?? []).find(
    (t) => t.hash === digest && t.expires > now(),
  );
  const user = found && users(state).find((u) => u.id === found.user_id);
  if (!found || !user)
    throw new AuthError("invalid_grant", "Refresh token is invalid or expired");
  state.refresh_tokens = state.refresh_tokens!.filter((t) => t !== found);
  return issueTokens(state, user, found.client_id);
}
export async function revoke(state: State, token: string) {
  const digest = await hash(token);
  state.refresh_tokens = (state.refresh_tokens ?? []).filter(
    (t) => t.hash !== digest,
  );
}
