import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestRepository } from "../src/lib/database";
import { handle } from "../src/lib/http";
import * as updates from "../src/lib/updates";

const ADMIN = "a".repeat(48);
const ORIGIN = "http://127.0.0.1:3000";
const RELEASE = {
  tag_name: "v0.6.0",
  html_url: "https://github.com/MisterTea/temperance/releases/tag/v0.6.0",
  body: "Dashboard updates",
  published_at: "2026-10-12T00:00:00Z",
};
const ENV = [
  "TEMPERANCE_BUILD_VERSION",
  "TEMPERANCE_INSTALL",
  "TEMPERANCE_UPDATER_TOKEN",
  "TEMPERANCE_UPDATER_URL",
  "TEMPERANCE_UPDATE_CHECK",
];

let calls: { url: string; init?: RequestInit }[];
function stubFetch(answer: (url: string) => Response) {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return answer(url);
  });
}
const github = () => stubFetch(() => Response.json(RELEASE));

beforeEach(() => {
  for (const name of ENV) delete process.env[name];
  Object.assign(process.env, {
    TEMPERANCE_ADMIN_TOKEN: ADMIN,
    TEMPERANCE_GATEWAY_TOKEN: "g".repeat(48),
    TEMPERANCE_VPN_ENDPOINT: "192.0.2.1:51820",
    TEMPERANCE_VPN_PUBLIC_KEY: btoa(
      String.fromCharCode(...Array.from({ length: 32 }, (_, n) => n)),
    ),
    TEMPERANCE_TIMEZONE: "America/Chicago",
    TEMPERANCE_PUBLIC_URL: ORIGIN,
    TEMPERANCE_BUILD_VERSION: "0.5.4",
  });
  updates.resetForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("versions", () => {
  it("compares release versions numerically", () => {
    expect(updates.newer("0.6.0", "0.5.4")).toBe(true);
    expect(updates.newer("0.10.0", "0.9.9")).toBe(true);
    expect(updates.newer("1.0.0", "0.99.0")).toBe(true);
    expect(updates.newer("0.5.4", "0.5.4")).toBe(false);
    expect(updates.newer("0.5.3", "0.5.4")).toBe(false);
  });
  it("never calls a development build outdated", () => {
    expect(updates.newer("0.6.0", "dev")).toBe(false);
    expect(updates.newer("0.6.0", "0.0.0~dev.abc1234")).toBe(false);
    expect(updates.newer("0.6.0", "0.5.4-3-gabc1234")).toBe(false);
  });
});

describe("release check", () => {
  it("reports the newest release and caches it for six hours", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    github();
    const status = await updates.status();
    expect(status).toMatchObject({
      current: "0.5.4",
      install: "other",
      can_update: false,
      available: true,
      latest: { version: "0.6.0", url: RELEASE.html_url },
    });
    expect(calls[0].url).toMatch(/releases\/latest$/);
    await updates.status();
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(6 * 3600_000 + 1);
    await updates.status();
    expect(calls).toHaveLength(2);
    await updates.status(true);
    expect(calls).toHaveLength(3);
  });
  it("is up to date on the newest release", async () => {
    github();
    process.env.TEMPERANCE_BUILD_VERSION = "0.6.0";
    expect((await updates.status()).available).toBe(false);
  });
  it("reports failures and keeps the last known release", async () => {
    github();
    await updates.status();
    stubFetch(() => new Response("rate limited", { status: 403 }));
    const status = await updates.status(true);
    expect(status.error).toBe("GitHub answered 403");
    expect(status.latest?.version).toBe("0.6.0");
  });
  it("is quiet before the first release is published", async () => {
    stubFetch(() => new Response("Not Found", { status: 404 }));
    const status = await updates.status();
    expect(status).toMatchObject({ available: false, checks: true });
    expect(status.latest).toBeUndefined();
    expect(status.error).toBeUndefined();
  });
  it("never contacts GitHub when checks are off", async () => {
    github();
    process.env.TEMPERANCE_UPDATE_CHECK = "off";
    const status = await updates.status(true);
    expect(calls).toHaveLength(0);
    expect(status).toMatchObject({ checks: false, available: false });
  });
});

describe("updater container", () => {
  it("only Docker installs with a token can update themselves", async () => {
    github();
    process.env.TEMPERANCE_UPDATER_TOKEN = "updater-secret";
    expect((await updates.status()).can_update).toBe(false);
    process.env.TEMPERANCE_INSTALL = "docker";
    expect((await updates.status()).can_update).toBe(true);
  });
  it("asks Watchtower to update with its token", async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    process.env.TEMPERANCE_INSTALL = "docker";
    process.env.TEMPERANCE_UPDATER_TOKEN = "updater-secret";
    await updates.update();
    expect(calls[0].url).toBe("http://updater:8080/v1/update?async=true");
    expect(calls[0].init?.method).toBe("POST");
    expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe(
      "Bearer updater-secret",
    );
  });
  it("explains when the updater is missing or refuses", async () => {
    await expect(updates.update()).rejects.toThrow(/cannot update itself/);
    process.env.TEMPERANCE_INSTALL = "docker";
    process.env.TEMPERANCE_UPDATER_TOKEN = "updater-secret";
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));
    await expect(updates.update()).rejects.toThrow(/COMPOSE_PROFILES/);
    stubFetch(() => new Response(null, { status: 401 }));
    await expect(updates.update()).rejects.toThrow(/answered 401/);
  });
});

describe("api/update", () => {
  const request = (method: "GET" | "POST", token?: string) =>
    handle(
      new Request(ORIGIN + "/api/update", {
        method,
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
      }),
      "api/update",
      new TestRepository(),
    );
  it("requires the administrator", async () => {
    github();
    expect((await request("GET")).status).toBe(401);
    expect((await request("POST")).status).toBe(401);
    expect(calls).toHaveLength(0);
  });
  it("reports status and starts updates", async () => {
    github();
    const status = await (await request("GET", ADMIN)).json();
    expect(status).toMatchObject({ current: "0.5.4", available: true });
    const refused = await request("POST", ADMIN);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/cannot update itself/);
    process.env.TEMPERANCE_INSTALL = "docker";
    process.env.TEMPERANCE_UPDATER_TOKEN = "updater-secret";
    stubFetch(() => new Response(null, { status: 200 }));
    expect(await (await request("POST", ADMIN)).json()).toEqual({
      updating: true,
    });
    expect(calls[0].url).toMatch(/^http:\/\/updater:8080\/v1\/update/);
  });
});
