import { beforeEach, describe, expect, it, vi } from "vitest";
import { TestRepository } from "../src/lib/database";
import { handle } from "../src/lib/http";
import { dailyLimit, domainReason, profileSchema } from "../src/lib/policy";

const ADMIN = "a".repeat(48),
  GATEWAY = "g".repeat(48);
const key = (seed: number) =>
  btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, n) => n + seed)));
beforeEach(() => {
  vi.setSystemTime(new Date("2026-10-11T18:00:00Z"));
  Object.assign(process.env, {
    TEMPERANCE_ADMIN_TOKEN: ADMIN,
    TEMPERANCE_GATEWAY_TOKEN: GATEWAY,
    TEMPERANCE_VPN_ENDPOINT: "192.0.2.1:51820",
    TEMPERANCE_VPN_PUBLIC_KEY: key(0),
    TEMPERANCE_TIMEZONE: "America/Chicago",
    TEMPERANCE_PUBLIC_URL: "http://127.0.0.1:3000",
  });
});
async function call(
  repo: TestRepository,
  path: string,
  body?: unknown,
  token = ADMIN,
) {
  const response = await handle(
    new Request("http://127.0.0.1:3000/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    path,
    repo,
  );
  return { status: response.status, body: await response.json() };
}
const GAMES = {
  id: "games",
  name: "Games",
  domains: ["Roblox.com", "minecraft.net", "fortnite.com"],
  minutes: 30,
};

describe("shared app limits", () => {
  it("validates groups", () => {
    const base = { name: "A" };
    expect(
      profileSchema.parse({ ...base, app_limits: [GAMES] }).app_limits[0]
        .domains[0],
    ).toBe("roblox.com");
    for (const bad of [
      [{ ...GAMES, minutes: 0 }],
      [{ ...GAMES, domains: [] }],
      [{ ...GAMES, id: "Not valid!" }],
      [GAMES, { ...GAMES, name: "Again" }],
    ])
      expect(
        profileSchema.safeParse({ ...base, app_limits: bad }).success,
      ).toBe(false);
  });

  it("is one budget for every app in the group, extendable by a reward", async () => {
    const repo = new TestRepository();
    await call(repo, "api/profiles", { name: "Kid", app_limits: [GAMES] });
    const { code } = (await call(repo, "api/enrollment", { profile_id: 1 }))
      .body;
    const phone = (
      await call(repo, "v1/enroll", { code, name: "Phone", public_key: key(1) })
    ).body;
    const minute = Math.floor(Date.now() / 60000);
    // 20 minutes of Roblox and 10 of Minecraft use up the shared 30.
    const activity = Array.from({ length: 30 }, (_, n) => ({
      device_id: phone.device_id,
      minute: minute - n,
      buckets: [
        "total",
        n < 20 ? "site:roblox.com" : "site:minecraft.net",
        "group:games",
      ],
    }));
    expect(
      (await call(repo, "v1/gateway/activity", { activity }, GATEWAY)).body,
    ).toEqual({ ok: true });

    const state = (await call(repo, "api/state")).body;
    expect(state.profiles[0].bucket_usage["group:games"]).toBe(30);
    const gateway = (await call(repo, "v1/gateway/state", undefined, GATEWAY))
      .body;
    expect(gateway.profiles[0].app_limits[0].id).toBe("games");

    const { state: stored } = await repo.read();
    const p = stored.profiles[0];
    const at = Date.now() / 1000;
    const reason = (host: string) =>
      domainReason(
        p,
        host,
        at,
        "America/Chicago",
        stored.usage,
        stored.rewards,
      );
    expect(reason("www.fortnite.com")).toBe("limit group:games");
    expect(reason("roblox.com")).toBe("limit group:games");
    expect(reason("khanacademy.org")).toBe("allowed");

    const rewarded = await call(repo, "api/rewards", {
      profile_id: 1,
      kind: "extra_time",
      minutes: 15,
      scope: "group:games",
    });
    expect(rewarded.status).toBe(200);
    const after = (await repo.read()).state;
    expect(
      dailyLimit(
        after.profiles[0],
        at,
        "America/Chicago",
        after.rewards,
        "group:games",
      ),
    ).toBe(45);
    expect(
      domainReason(
        after.profiles[0],
        "fortnite.com",
        at,
        "America/Chicago",
        after.usage,
        after.rewards,
      ),
    ).toBe("allowed");
    expect(
      (
        await call(repo, "api/rewards", {
          profile_id: 1,
          kind: "extra_time",
          minutes: 5,
          scope: "group:Bad Scope",
        })
      ).status,
    ).toBe(400);
  });

  it("treats profiles saved before app groups existed as having none", () => {
    const legacy = profileSchema.parse({ name: "Old" });
    delete (legacy as Partial<typeof legacy>).app_limits;
    const p = { ...legacy, id: 1 };
    expect(dailyLimit(p, 0, "UTC", [], "group:games")).toBe(0);
    expect(domainReason(p, "roblox.com", 0, "UTC", {}, [])).toBe("allowed");
  });
});
