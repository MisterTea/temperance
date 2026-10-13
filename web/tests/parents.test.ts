import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/lib/http";
import { mutate, TestRepository } from "../src/lib/database";
import { gatewayState } from "../src/lib/service";

const ADMIN = "simple-admin-password",
  GATEWAY = "g".repeat(48),
  FORWARD = "f".repeat(64),
  KEY = "k".repeat(43);
beforeEach(() => {
  process.env.TEMPERANCE_ADMIN_PASSWORD = ADMIN;
  process.env.TEMPERANCE_GATEWAY_TOKEN = GATEWAY;
  process.env.TEMPERANCE_FORWARD_SECRET = FORWARD;
  process.env.TEMPERANCE_HOUSEHOLD_NAME = "The Parkers";
  process.env.TEMPERANCE_PUBLIC_URL = "http://127.0.0.1:3000";
  process.env.TEMPERANCE_VPN_ENDPOINT = "home.example.net:51820";
});
async function call(
  repo: TestRepository,
  path: string,
  data?: unknown,
  headers: Record<string, string> = {},
) {
  return handle(
    new Request("http://127.0.0.1:3000/" + path, {
      method: data === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    }),
    path,
    repo,
  );
}
const ORIGIN = { Origin: "http://127.0.0.1:3000" };
const admin = async (repo: TestRepository) => {
  const login = await call(repo, "v1/login", { password: ADMIN }, ORIGIN);
  return { Cookie: login.headers.get("set-cookie")!, ...ORIGIN };
};
const decode = (link: string) =>
  JSON.parse(
    Buffer.from(link.replace("temperance://pair#", ""), "base64url").toString(),
  );
const asGateway = { "x-temperance-forwarded": FORWARD };
const asParent = (id: string, secret = FORWARD) => ({
  "x-temperance-forwarded": secret,
  "x-temperance-parent": id,
});
async function reportPin(repo: TestRepository, pin = "PIN") {
  const response = await call(
    repo,
    "v1/gateway/activity",
    { active_devices: [], activity: [], history: [], remote: { pin } },
    { Authorization: "Bearer " + GATEWAY },
  );
  expect(response.status).toBe(200);
}
async function paired(repo: TestRepository) {
  const headers = await admin(repo);
  await reportPin(repo);
  const { link } = await (
    await call(repo, "api/parents/pairing", {}, headers)
  ).json();
  const { code } = decode(link);
  const reply = await call(
    repo,
    "v1/gateway/parents/pair",
    { code, name: "Jordan's iPhone", key: KEY },
    asGateway,
  );
  expect(reply.status).toBe(200);
  const { id } = await reply.json();
  return { headers, id: id as string, code: code as string };
}

describe("parent phones", () => {
  it("waits for the gateway's pin, then links the endpoint, pin and household", async () => {
    const repo = new TestRepository();
    const headers = await admin(repo);
    const early = await call(repo, "api/parents/pairing", {}, headers);
    expect(early.status).toBe(400);
    expect((await early.json()).error).toMatch(/hasn’t checked in/);
    await reportPin(repo, "PIN-1");
    const response = await call(repo, "api/parents/pairing", {}, headers);
    const { link, expires_in } = await response.json();
    expect(expires_in).toBe(600);
    expect(decode(link)).toMatchObject({
      v: 1,
      host: "home.example.net",
      port: 51820,
      pin: "PIN-1",
      household: "The Parkers",
      code: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const state = await (
      await call(repo, "api/state", undefined, headers)
    ).json();
    expect(state.parent_access).toEqual({
      available: true,
      host: "home.example.net",
    });
  });

  it("prefers the Dynu hostname, which follows the home's changing address", async () => {
    const repo = new TestRepository();
    const headers = await admin(repo);
    await reportPin(repo);
    await mutate(repo, (state) => {
      state.network = {
        upnp: true,
        ddns: {
          provider: "dynu",
          hostname: "parkers.ddnsfree.com",
          username: "u",
          password: "p",
        },
      };
    });
    const { link } = await (
      await call(repo, "api/parents/pairing", {}, headers)
    ).json();
    expect(decode(link)).toMatchObject({
      host: "parkers.ddnsfree.com",
      port: 51820,
    });
  });

  it("pairs once per code, and only when the gateway asks", async () => {
    const repo = new TestRepository();
    const { id, code } = await paired(repo);
    expect(id).toMatch(/^par_/);
    const again = await call(
      repo,
      "v1/gateway/parents/pair",
      { code, name: "Another", key: "x".repeat(43) },
      asGateway,
    );
    expect(again.status).toBe(400);
    expect((await again.json()).error).toMatch(/expired or was already used/);
    const forged = await call(
      repo,
      "v1/gateway/parents/pair",
      { code, name: "Mallory", key: "m".repeat(43) },
      { "x-temperance-forwarded": "wrong" },
    );
    expect(forged.status).toBe(401);
    const { state } = await repo.read();
    expect(gatewayState(state).parents).toEqual([{ id, key: KEY }]);
    expect(state.events.at(-1)?.message).toMatch(
      /Jordan's iPhone can now open the dashboard/,
    );
  });

  it("accepts the standalone gateway's token as the forwarding secret", async () => {
    const repo = new TestRepository();
    const { id } = await paired(repo);
    const me = await call(repo, "api/me", undefined, asParent(id, GATEWAY));
    expect(await me.json()).toEqual({
      role: "parent",
      id,
      name: "Jordan's iPhone",
    });
  });

  it("treats forwarded requests as the paired parent, without a cookie or Origin", async () => {
    const repo = new TestRepository();
    const { id } = await paired(repo);
    const created = await call(
      repo,
      "api/profiles",
      { name: "Riley" },
      asParent(id),
    );
    expect(created.status).toBe(200);
    const { state } = await repo.read();
    expect(state.profiles.map((p) => p.name)).toContain("Riley");
    expect(state.parents?.[0].last_seen).toBeGreaterThan(0);
    expect(
      (await (await call(repo, "api/state", undefined, asParent(id))).json())
        .parents,
    ).toEqual([expect.objectContaining({ id, name: "Jordan's iPhone" })]);
  });

  it("rejects forwarded headers without the secret, even with an admin cookie", async () => {
    const repo = new TestRepository();
    const { headers, id } = await paired(repo);
    for (const extra of [
      asParent(id, "not-the-secret"),
      asParent("par_unknown"),
      { "x-temperance-parent": id, "x-temperance-forwarded": "" },
    ])
      expect(
        (await call(repo, "api/state", undefined, { ...headers, ...extra }))
          .status,
      ).toBe(401);
    expect((await call(repo, "api/state", undefined, headers)).status).toBe(
      200,
    );
  });

  it("removes a phone at once, but not the phone doing the removing", async () => {
    const repo = new TestRepository();
    const { headers, id } = await paired(repo);
    const self = await call(repo, "api/parents/revoke", { id }, asParent(id));
    expect(self.status).toBe(400);
    const removed = await call(repo, "api/parents/revoke", { id }, headers);
    expect((await removed.json()).parents).toEqual([]);
    expect(
      (await call(repo, "api/state", undefined, asParent(id))).status,
    ).toBe(401);
    const { state } = await repo.read();
    expect(gatewayState(state).parents).toEqual([]);
    expect(
      (await call(repo, "api/parents/revoke", { id }, headers)).status,
    ).toBe(400);
  });

  it("keeps paired phones in backups", async () => {
    const repo = new TestRepository();
    const { headers, id } = await paired(repo);
    const backup = await (
      await call(repo, "api/export", undefined, headers)
    ).json();
    const fresh = new TestRepository();
    const restore = await call(
      fresh,
      "api/import",
      { confirm: "RESTORE", backup },
      await admin(fresh),
    );
    expect(restore.status).toBe(200);
    const { state } = await fresh.read();
    expect(state.parents?.map((p) => p.id)).toEqual([id]);
  });
});

describe("admin sign-in", () => {
  it("pauses after ten wrong passwords from one address", async () => {
    const repo = new TestRepository();
    const from = (ip: string) => ({ "x-forwarded-for": ip, ...ORIGIN });
    for (let n = 0; n < 10; n++)
      expect(
        (
          await call(
            repo,
            "v1/login",
            { password: "wrong-password" },
            from("198.51.100.7"),
          )
        ).status,
      ).toBe(401);
    const blocked = await call(
      repo,
      "v1/login",
      { password: ADMIN },
      from("198.51.100.7"),
    );
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error).toMatch(/Wait 15 minutes/);
    expect(
      (await call(repo, "v1/login", { password: ADMIN }, from("198.51.100.8")))
        .status,
    ).toBe(200);
  });
});
