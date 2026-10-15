import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryFor, TestRepository } from "../src/lib/database";
import { handle } from "../src/lib/http";
import * as updates from "../src/lib/updates";
import * as maintenance from "../src/lib/maintenance";

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
  "TEMPERANCE_UPDATE_CHANNEL",
  "TEMPERANCE_IMAGE",
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
  vi.restoreAllMocks();
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
  it("orders beta releases before stable and compares beta numbers numerically", () => {
    expect(updates.newer("0.6.0-beta.10", "0.6.0-beta.2")).toBe(true);
    expect(updates.newer("0.6.0", "0.6.0-beta.10")).toBe(true);
    expect(updates.newer("0.6.0-beta.10", "0.6.0")).toBe(false);
  });
  it("never calls a development build outdated", () => {
    expect(updates.newer("0.6.0", "dev")).toBe(false);
    expect(updates.newer("0.6.0", "0.0.0~dev.abc1234")).toBe(false);
    expect(updates.newer("0.6.0", "0.5.4-3-gabc1234")).toBe(false);
  });
});

describe("release check", () => {
  it("selects beta releases without offering them to stable users", async () => {
    process.env.TEMPERANCE_UPDATE_CHANNEL = "beta";
    process.env.TEMPERANCE_INSTALL = "docker";
    process.env.TEMPERANCE_UPDATER_TOKEN = "secret";
    process.env.TEMPERANCE_IMAGE = "ghcr.io/mistertea/temperance:beta";
    stubFetch(() =>
      Response.json([
        { ...RELEASE, tag_name: "v0.6.0-beta.2", prerelease: true },
        { ...RELEASE, tag_name: "v0.6.0-beta.10", prerelease: true },
        { ...RELEASE, tag_name: "v9.0.0", draft: true },
      ]),
    );
    expect(await updates.status()).toMatchObject({
      channel: "beta",
      can_update: true,
      latest: { version: "0.6.0-beta.10" },
    });
    expect(calls[0].url).toContain("per_page=30");
    process.env.TEMPERANCE_UPDATE_CHANNEL = "stable";
    stubFetch(() =>
      Response.json({
        ...RELEASE,
        tag_name: "v0.6.0-beta.10",
        prerelease: true,
      }),
    );
    expect(await updates.status()).toMatchObject({
      channel: "stable",
      can_update: false,
      available: false,
    });
  });
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
  it.each([
    "mistertea/temperance",
    "docker.io/mistertea/temperance",
    "ghcr.io/mistertea/temperance",
  ])("accepts matching channel images from %s", async (registry) => {
    github();
    process.env.TEMPERANCE_INSTALL = "docker";
    process.env.TEMPERANCE_UPDATER_TOKEN = "updater-secret";
    process.env.TEMPERANCE_IMAGE = registry + ":latest";
    expect((await updates.status()).can_update).toBe(true);
    process.env.TEMPERANCE_IMAGE = registry + ":beta";
    expect((await updates.status()).can_update).toBe(false);
    process.env.TEMPERANCE_UPDATE_CHANNEL = "beta";
    stubFetch(() => Response.json([]));
    expect((await updates.status()).can_update).toBe(true);
  });
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
  it("refuses to auto-update pinned or mismatched images", async () => {
    process.env.TEMPERANCE_INSTALL = "docker";
    process.env.TEMPERANCE_UPDATER_TOKEN = "updater-secret";
    process.env.TEMPERANCE_IMAGE = "ghcr.io/mistertea/temperance:0.5.4";
    await expect(updates.update()).rejects.toThrow(/pinned/);
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
    const backup = vi
      .spyOn(maintenance, "backupNow")
      .mockResolvedValue("encrypted-recovery.json");
    expect(await (await request("POST", ADMIN)).json()).toEqual({
      updating: true,
    });
    expect(calls[0].url).toMatch(/^http:\/\/updater:8080\/v1\/update/);
    expect(backup).toHaveBeenCalledTimes(1);
  });
  it("never invokes the updater if the recovery snapshot fails", async () => {
    github();
    process.env.TEMPERANCE_INSTALL = "docker";
    process.env.TEMPERANCE_UPDATER_TOKEN = "updater-secret";
    vi.spyOn(maintenance, "backupNow").mockRejectedValue(
      new Error("Recovery backup failed"),
    );
    expect((await request("POST", ADMIN)).status).toBe(409);
    expect(
      calls.every((c) => c.url.startsWith("https://api.github.com/")),
    ).toBe(true);
  });
});

describe("persistent update lifecycle", () => {
  beforeEach(() => {
    github();
    process.env.TEMPERANCE_INSTALL = "docker";
    process.env.TEMPERANCE_UPDATER_TOKEN = "updater-secret";
  });
  it("reserves one update across concurrent requests and reconciles success after replacement", async () => {
    const repo = new TestRepository();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const prepare = vi.fn(async () => {
      await gate;
    });
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const first = updates.requestUpdate(repo, prepare, dispatch);
    await vi.waitFor(async () =>
      expect((await repo.read()).state.maintenance?.update?.status).toBe(
        "preparing",
      ),
    );
    await expect(
      updates.requestUpdate(repo, prepare, dispatch),
    ).rejects.toThrow(/already in progress/);
    release();
    await first;
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await updates.updateAttempt(repo))?.status).toBe("dispatched");
    process.env.TEMPERANCE_BUILD_VERSION = "0.6.0";
    expect(await updates.updateAttempt(repo)).toMatchObject({
      status: "succeeded",
      target: "0.6.0",
      from: "0.5.4",
    });
  });
  it("retains the active attempt and final outcome after reopening SQLite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "temperance-update-"));
    const url = `sqlite:${join(directory, "state.sqlite3")}`;
    let repo = repositoryFor(url);
    try {
      await updates.requestUpdate(
        repo,
        async () => undefined,
        async () => undefined,
      );
      await repo.close();
      repo = repositoryFor(url);
      expect(await updates.updateAttempt(repo)).toMatchObject({
        status: "dispatched",
        target: "0.6.0",
      });
      await expect(
        updates.requestUpdate(
          repo,
          async () => undefined,
          async () => undefined,
        ),
      ).rejects.toThrow(/already in progress/);
      process.env.TEMPERANCE_BUILD_VERSION = "0.6.0";
      expect((await updates.updateAttempt(repo))?.status).toBe("succeeded");
      await repo.close();
      repo = repositoryFor(url);
      expect((await updates.updateAttempt(repo))?.status).toBe("succeeded");
    } finally {
      await repo.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("persists a generic failure without dispatching when backup fails", async () => {
    const repo = new TestRepository(),
      dispatch = vi.fn();
    await expect(
      updates.requestUpdate(
        repo,
        async () => {
          throw new Error("private path in backup error");
        },
        dispatch,
      ),
    ).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    const attempt = await updates.updateAttempt(repo);
    expect(attempt?.status).toBe("failed");
    expect(JSON.stringify(attempt)).not.toContain("private path");
    await updates.requestUpdate(repo, async () => undefined, dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("times out interrupted requests and detects an unexpected replacement version", async () => {
    const repo = new TestRepository();
    await updates.requestUpdate(
      repo,
      async () => undefined,
      async () => undefined,
    );
    const request = (await repo.read()).state.maintenance!.update!;
    expect(
      (await updates.updateAttempt(repo, request.deadline_at))?.status,
    ).toBe("failed");
    await updates.requestUpdate(
      repo,
      async () => undefined,
      async () => undefined,
    );
    process.env.TEMPERANCE_BUILD_VERSION = "0.5.3";
    expect(await updates.updateAttempt(repo)).toMatchObject({
      status: "failed",
      message: expect.stringContaining("different version"),
    });
  });
  it("does not dispatch an up-to-date or failed release check", async () => {
    const repo = new TestRepository(),
      prepare = vi.fn(),
      dispatch = vi.fn();
    process.env.TEMPERANCE_BUILD_VERSION = "0.6.0";
    await expect(
      updates.requestUpdate(repo, prepare, dispatch),
    ).rejects.toThrow(/release check/);
    expect(prepare).not.toHaveBeenCalled();
    process.env.TEMPERANCE_BUILD_VERSION = "0.5.4";
    stubFetch(() => new Response(null, { status: 503 }));
    await updates.status(true);
    await expect(
      updates.requestUpdate(repo, prepare, dispatch),
    ).rejects.toThrow(/release check/);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
