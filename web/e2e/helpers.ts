import {
  test as base,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { randomBytes } from "node:crypto";
import { ADMIN_TOKEN, GATEWAY_TOKEN } from "../playwright.config";
import { shiftClock } from "./clock.mjs";

/** Pages share the run's shifted clock with the server and the test runner. */
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.addInitScript(
      shiftClock,
      Number(process.env.E2E_CLOCK_OFFSET_MS),
    );
    await use(context);
  },
});

export const OWNER = { password: ADMIN_TOKEN };

export const admin = { Authorization: "Bearer " + ADMIN_TOKEN };
export const gateway = { Authorization: "Bearer " + GATEWAY_TOKEN };
/** What the gateway adds to a paired parent phone's requests. */
export const forwarded = (parent?: string) => ({
  "x-temperance-forwarded": GATEWAY_TOKEN,
  ...(parent ? { "x-temperance-parent": parent } : {}),
});

/** Seeded keys must be unique across tests; unseeded ones are random. */
export function deviceKey(seed?: number) {
  if (seed === undefined) return randomBytes(32).toString("base64");
  return Buffer.from(
    Array.from({ length: 32 }, (_, n) => (n * 7 + seed) % 256),
  ).toString("base64");
}

export async function api<T = unknown>(
  request: APIRequestContext,
  path: string,
  data?: unknown,
  headers: Record<string, string> = admin,
): Promise<T> {
  const response =
    data === undefined
      ? await request.get(path, { headers })
      : await request.post(path, { headers, data });
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return response.json();
}

type Snapshot = { profiles: { id: number; name: string }[] };
export async function profileNamed(request: APIRequestContext, name: string) {
  const state = await api<Snapshot>(request, "/api/state");
  return state.profiles.find((p) => p.name === name);
}

export async function ensureProfile(
  request: APIRequestContext,
  name: string,
  extra: Record<string, unknown> = {},
) {
  const existing = await profileNamed(request, name);
  if (existing) return existing.id;
  const state = await api<Snapshot>(request, "/api/profiles", {
    name,
    ...extra,
  });
  return state.profiles.find((p) => p.name === name)!.id;
}

export async function enrollDevice(
  request: APIRequestContext,
  profileId: number,
  name: string,
  seed: number,
) {
  const { code } = await api<{ code: string }>(request, "/api/enrollment", {
    profile_id: profileId,
  });
  return api<{ token: string; device_id: string }>(
    request,
    "/v1/enroll",
    { code, name, public_key: deviceKey(seed) },
    {},
  );
}

/** Fails the test if the page has console errors or uncaught exceptions. */
export function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of 401/.test(m.text()))
      errors.push("console: " + m.text());
  });
  return () => expect(errors, "browser errors").toEqual([]);
}
