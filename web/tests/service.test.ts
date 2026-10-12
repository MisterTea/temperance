import { beforeEach, describe, expect, it, vi } from "vitest";
import { TestRepository, mutate } from "../src/lib/database";
import { handle } from "../src/lib/http";
import * as service from "../src/lib/service";
import {
  accessReason,
  domainReason,
  inWindow,
  localTime,
  profileSchema,
} from "../src/lib/policy";
import { emptyState } from "../src/lib/model";
const PUBLIC = btoa(
  String.fromCharCode(...Array.from({ length: 32 }, (_, n) => n)),
);
const DEVICE = btoa(
  String.fromCharCode(...Array.from({ length: 32 }, (_, n) => n + 1)),
);
const ADMIN = "a".repeat(48),
  GATEWAY = "g".repeat(48);
beforeEach(() => {
  vi.setSystemTime(new Date("2026-10-11T18:00:00Z"));
  process.env.TEMPERANCE_ADMIN_TOKEN = ADMIN;
  process.env.TEMPERANCE_GATEWAY_TOKEN = GATEWAY;
  process.env.TEMPERANCE_VPN_ENDPOINT = "192.0.2.1:51820";
  process.env.TEMPERANCE_VPN_PUBLIC_KEY = PUBLIC;
  process.env.TEMPERANCE_TIMEZONE = "America/Chicago";
  process.env.TEMPERANCE_PUBLIC_URL = "http://127.0.0.1:3000";
});
async function request(
  repo: TestRepository,
  path: string,
  body?: unknown,
  token?: string,
  headers: Record<string, string> = {},
) {
  return handle(
    new Request("http://127.0.0.1:3000/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    path,
    repo,
  );
}
async function enrollFixture(repo: TestRepository) {
  await request(repo, "api/profiles", { name: "Alex", limit: 30 }, ADMIN);
  const { code } = await (
    await request(repo, "api/enrollment", { profile_id: 1 }, ADMIN)
  ).json();
  const result = await (
    await request(repo, "v1/enroll", {
      code,
      name: "Phone",
      public_key: DEVICE,
    })
  ).json();
  return { code, ...result };
}
describe("authoritative policy and enrollment", () => {
  it("keeps private keys local and scopes credentials", async () => {
    const repo = new TestRepository(),
      device = await enrollFixture(repo);
    expect(device.tunnel.allowed_ips).toBe("0.0.0.0/0, ::/0");
    expect(device.private_key).toBeUndefined();
    expect(
      (await request(repo, "api/state", undefined, device.token)).status,
    ).toBe(401);
    expect(
      (await request(repo, "v1/device/state", undefined, device.token)).status,
    ).toBe(200);
    expect(
      (await request(repo, "v1/gateway/state", undefined, ADMIN)).status,
    ).toBe(401);
    const snapshot = await (
      await request(repo, "v1/gateway/state", undefined, GATEWAY)
    ).text();
    expect(snapshot).not.toContain(device.token);
    expect(snapshot).not.toContain("token_hash");
  });
  it("atomically consumes an enrollment code under concurrent requests", async () => {
    const repo = new TestRepository();
    await request(repo, "api/profiles", { name: "Alex" }, ADMIN);
    const { code } = await (
      await request(repo, "api/enrollment", { profile_id: 1 }, ADMIN)
    ).json();
    const results = await Promise.all([
      request(repo, "v1/enroll", { code, name: "A", public_key: PUBLIC }),
      request(repo, "v1/enroll", { code, name: "B", public_key: DEVICE }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await repo.read()).state.devices).toHaveLength(1);
  });
  it("rejects cookie writes from another origin", async () => {
    const repo = new TestRepository();
    const login = await request(
      repo,
      "v1/login",
      { password: ADMIN },
      undefined,
      { Origin: "http://127.0.0.1:3000" },
    );
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(
      (
        await request(repo, "api/profiles", { name: "A" }, undefined, {
          Cookie: cookie,
          Origin: "http://evil.test",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(repo, "api/profiles", { name: "A" }, undefined, {
          Cookie: cookie,
          Origin: "http://127.0.0.1:3000",
        })
      ).status,
    ).toBe(200);
  });
  it("deduplicates simultaneous devices and repeated activity reports", async () => {
    const repo = new TestRepository(),
      device = await enrollFixture(repo);
    for (let i = 0; i < 2; i++)
      expect(
        (
          await request(
            repo,
            "v1/gateway/activity",
            { active_devices: [device.device_id, device.device_id] },
            GATEWAY,
          )
        ).status,
      ).toBe(200);
    const state = await (
      await request(repo, "v1/device/state", undefined, device.token)
    ).json();
    expect(state.policy.used).toBe(1);
  });
  it("supports child requests, approval, cancellation and revocation", async () => {
    const repo = new TestRepository(),
      device = await enrollFixture(repo);
    const pending = await (
      await request(
        repo,
        "v1/device/requests",
        { minutes: 15, message: "Finish homework" },
        device.token,
      )
    ).json();
    expect(pending.status).toBe("pending");
    expect(
      (await request(repo, "v1/device/requests", { minutes: 15 }, device.token))
        .status,
    ).toBe(400);
    const approved = await (
      await request(
        repo,
        "api/requests",
        { id: pending.id, approve: true },
        ADMIN,
      )
    ).json();
    expect(approved.profiles[0].effective_limit).toBe(45);
    await request(
      repo,
      "api/rewards/delete",
      { id: approved.rewards[0].id },
      ADMIN,
    );
    expect(
      (await (await request(repo, "api/state", undefined, ADMIN)).json())
        .profiles[0].effective_limit,
    ).toBe(30);
    await request(repo, "api/devices/delete", { ip: "10.77.0.2" }, ADMIN);
    expect(
      (await request(repo, "v1/device/state", undefined, device.token)).status,
    ).toBe(401);
  });
  it("records history and emits CSV without sharing it with devices", async () => {
    const repo = new TestRepository(),
      device = await enrollFixture(repo);
    await request(
      repo,
      "v1/gateway/activity",
      {
        history: [
          {
            id: "sample-1",
            device_id: device.device_id,
            at: Date.now() / 1000,
            domain: "www.youtube.com",
            blocked: true,
            reason: "video",
            category: "video",
          },
        ],
      },
      GATEWAY,
    );
    const history = await (
      await request(repo, "api/history", undefined, ADMIN)
    ).json();
    expect(history[0].domain).toBe("www.youtube.com");
    expect(
      (await request(repo, "api/history", undefined, device.token)).status,
    ).toBe(401);
    const response = await handle(
      new Request("http://127.0.0.1:3000/api/history?format=csv", {
        headers: { Authorization: "Bearer " + ADMIN },
      }),
      "api/history",
      repo,
    );
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(await response.text()).toContain("www.youtube.com");
  });
  it("round-trips a portable backup and preserves credential scope", async () => {
    const repo = new TestRepository(),
      device = await enrollFixture(repo);
    const backup = await (
      await request(repo, "api/export", undefined, ADMIN)
    ).json();
    const restored = new TestRepository();
    expect(
      (
        await request(
          restored,
          "api/import",
          { confirm: "RESTORE", backup },
          ADMIN,
        )
      ).status,
    ).toBe(200);
    expect(
      (await request(restored, "v1/device/state", undefined, device.token))
        .status,
    ).toBe(200);
  });
});
describe("schedule, filter and reward semantics", () => {
  const at = (text: string) => new Date(text).getTime() / 1000;
  it("anchors overnight schedules to the selected start day", () => {
    const w = { start: "21:00", end: "07:00", days: [0] };
    expect(inWindow(w, at("2026-10-12T02:00:00Z"), "America/Chicago")).toBe(
      true,
    );
    expect(inWindow(w, at("2026-10-12T11:00:00Z"), "America/Chicago")).toBe(
      true,
    );
    expect(inWindow(w, at("2026-10-12T12:00:00Z"), "America/Chicago")).toBe(
      false,
    );
    expect(inWindow(w, at("2026-10-13T02:00:00Z"), "America/Chicago")).toBe(
      false,
    );
  });
  it("applies weekday quotas, rewards and midnight expiry", () => {
    const p = {
      ...profileSchema.parse({
        name: "A",
        limit: 30,
        weekday_limits: { "0": 10 },
      }),
      id: 1,
    };
    const t = at("2026-10-11T18:00:00Z"),
      usage = {
        "2026-10-11": {
          "1": { total: Array.from({ length: 10 }, (_, i) => i) },
        },
      };
    expect(accessReason(p, t, "America/Chicago", usage, [])).toBe(
      "daily limit",
    );
    const r = {
      id: "reward",
      profile_id: 1,
      day: "2026-10-11",
      kind: "extra_time" as const,
      minutes: 15,
    };
    expect(accessReason(p, t, "America/Chicago", usage, [r])).toBe("allowed");
    expect(
      accessReason(p, at("2026-10-12T05:00:00Z"), "America/Chicago", usage, [
        r,
      ]),
    ).toBe("allowed");
  });
  it("allows unmanaged sites through all profile restrictions", () => {
    const p = {
      ...profileSchema.parse({
        name: "A",
        paused: true,
        unmanaged: ["education.test"],
      }),
      id: 1,
    };
    expect(
      domainReason(
        p,
        "a.education.test",
        Date.now() / 1000,
        "UTC",
        {},
        [],
        true,
      ),
    ).toBe("unmanaged");
    expect(
      domainReason(
        p,
        "evil-education.test",
        Date.now() / 1000,
        "UTC",
        {},
        [],
        true,
      ),
    ).toBe("household pause");
  });
  it("restricts focus windows and permits learning categories", () => {
    const p = {
      ...profileSchema.parse({
        name: "A",
        schedules: [
          {
            id: "homework",
            name: "Homework",
            mode: "focus",
            start: "12:00",
            end: "15:00",
            days: [0],
            allowed_categories: ["education"],
          },
        ],
      }),
      id: 1,
    };
    expect(
      domainReason(
        p,
        "www.khanacademy.org",
        Date.now() / 1000,
        "America/Chicago",
        {},
        [],
      ),
    ).toBe("allowed");
    expect(
      domainReason(
        p,
        "www.youtube.com",
        Date.now() / 1000,
        "America/Chicago",
        {},
        [],
      ),
    ).toBe("focus time");
  });
  it("None disables filtering/time accounting without removing pause", () => {
    const p = {
      ...profileSchema.parse({
        name: "A",
        filter_level: "none",
        deny: ["youtube.com"],
      }),
      id: 1,
    };
    expect(
      domainReason(p, "youtube.com", Date.now() / 1000, "UTC", {}, []),
    ).toBe("allowed");
    expect(
      accessReason({ ...p, paused: true }, Date.now() / 1000, "UTC", {}, []),
    ).toBe("paused");
  });
});
describe("VPN endpoint", () => {
  it("accepts IPv4 and dynamic-DNS hostnames, rejects anything else", () => {
    expect(service.vpnEndpoint("192.0.2.1:51820")).toBe("192.0.2.1:51820");
    expect(service.vpnEndpoint("Home.Example.net:51820")).toBe(
      "home.example.net:51820",
    );
    for (const bad of [
      "",
      "home.example.net",
      "home.example.net:0",
      "home.example.net:70000",
      "999.1.1.1:51820",
      "1.2.3:51820",
      "-home.example.net:51820",
      "home..example.net:51820",
      "home.example.net:51820\nPostUp=x",
    ])
      expect(() => service.vpnEndpoint(bad), bad).toThrow(/host:port/);
  });
});
describe("remote access settings", () => {
  const dynu = {
    hostname: "myhome.ddnsfree.com",
    username: "family",
    password: "ip-update-secret",
  };
  it("defaults to UPnP on and never shows the Dynu password", () => {
    const state = emptyState();
    expect(service.snapshot(state).network).toEqual({ upnp: true, ddns: null });
    expect(service.snapshot(state).vpn_endpoint).toBe("192.0.2.1:51820");
    service.settings(state, { network: { upnp: true, ddns: dynu } });
    const shown = service.snapshot(state);
    expect(shown.network.ddns).toEqual({
      provider: "dynu",
      hostname: "myhome.ddnsfree.com",
      username: "family",
      has_password: true,
    });
    expect(JSON.stringify(shown)).not.toContain("ip-update-secret");
    expect(service.gatewayState(state).network.ddns?.password).toBe(
      "ip-update-secret",
    );
    expect(state.events.at(-1)?.message).toBe("Remote access settings updated");
  });
  it("keeps the saved password when the field is left blank", () => {
    const state = emptyState();
    expect(() =>
      service.settings(state, {
        network: { upnp: true, ddns: { ...dynu, password: "" } },
      }),
    ).toThrow(/IP update password/);
    service.settings(state, { network: { upnp: true, ddns: dynu } });
    service.settings(state, {
      network: { upnp: false, ddns: { ...dynu, username: "other" } },
    });
    expect(state.network).toEqual({
      upnp: false,
      ddns: { provider: "dynu", ...dynu, username: "other" },
    });
    service.settings(state, { network: { upnp: true, ddns: null } });
    expect(state.network).toEqual({ upnp: true });
  });
  it("rejects hostnames that are not full DNS names", () => {
    for (const hostname of ["myhome", "192.0.2.1", "bad host.example", ""])
      expect(
        () =>
          service.settings(emptyState(), {
            network: { upnp: true, ddns: { ...dynu, hostname } },
          }),
        hostname,
      ).toThrow();
  });
  it("reports a missing endpoint as null", () => {
    process.env.TEMPERANCE_VPN_ENDPOINT = "";
    expect(service.snapshot(emptyState()).vpn_endpoint).toBeNull();
  });
  it("turns reachability problems and recoveries into events", () => {
    const state = emptyState();
    const status = (s: string, message: string) => ({
      state: s,
      ip: null,
      message,
      at: 1,
    });
    const report = (upnp: unknown, ddns: unknown = null) =>
      service.account(state, { network: { upnp, ddns } });
    report(status("ok", "Mapped."));
    expect(state.events).toHaveLength(0);
    report(status("error", "No UPnP router answered."));
    report(status("error", "No UPnP router answered."));
    report(
      status("ok", "Mapped."),
      status("warning", "Dynu is having problems; retrying."),
    );
    expect(state.events.map((e) => e.message)).toEqual([
      "Port forwarding: No UPnP router answered.",
      "Port forwarding works again",
      "Dynamic DNS: Dynu is having problems; retrying.",
    ]);
    expect(state.network_status?.ddns?.state).toBe("warning");
    expect(() =>
      service.account(state, {
        network: { upnp: status("broken", "x"), ddns: null },
      }),
    ).toThrow();
  });
  it("survives a backup and restore", async () => {
    const repo = new TestRepository();
    await request(
      repo,
      "api/settings",
      { network: { upnp: false, ddns: dynu } },
      ADMIN,
    );
    const backup = await (
      await request(repo, "api/export", undefined, ADMIN)
    ).json();
    const restored = new TestRepository();
    await request(
      restored,
      "api/import",
      { confirm: "RESTORE", backup },
      ADMIN,
    );
    expect((await restored.read()).state.network).toEqual({
      upnp: false,
      ddns: { provider: "dynu", ...dynu },
    });
  });
});
