import { beforeEach, describe, expect, it, vi } from "vitest";
import { TestRepository } from "../src/lib/database";
import { handle } from "../src/lib/http";
import { isHomeAddress } from "../src/lib/service";

const ADMIN = "a".repeat(48),
  GATEWAY = "g".repeat(48);
const DEVICE = btoa(
  String.fromCharCode(...Array.from({ length: 32 }, (_, n) => n + 1)),
);
beforeEach(() => {
  vi.setSystemTime(new Date("2026-10-11T18:00:00Z"));
  process.env.TEMPERANCE_ADMIN_TOKEN = ADMIN;
  process.env.TEMPERANCE_GATEWAY_TOKEN = GATEWAY;
  process.env.TEMPERANCE_VPN_ENDPOINT = "192.0.2.1:51820";
  process.env.TEMPERANCE_VPN_PUBLIC_KEY = btoa(
    String.fromCharCode(...Array.from({ length: 32 }, (_, n) => n)),
  );
  process.env.TEMPERANCE_TIMEZONE = "America/Chicago";
  process.env.TEMPERANCE_PUBLIC_URL = "http://127.0.0.1:3000";
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
const TV = { name: "Living room TV", ip: "192.168.1.50", profile_id: 1 };

describe("home-network devices", () => {
  it("accepts only private LAN addresses outside the VPN pool", () => {
    for (const ip of ["192.168.1.50", "10.0.0.8", "172.16.4.2", "172.31.0.9"])
      expect(isHomeAddress(ip)).toBe(true);
    for (const ip of [
      "10.77.0.5",
      "8.8.8.8",
      "172.32.0.1",
      "192.168.1.0",
      "192.168.1.255",
      "192.168.1",
      "192.168.1.256",
      "a.b.c.d",
    ])
      expect(isHomeAddress(ip)).toBe(false);
  });

  it("adds, lists, and hands home devices to the gateway separately from VPN peers", async () => {
    const repo = new TestRepository();
    await call(repo, "api/profiles", { name: "Alex" });
    const { code } = (await call(repo, "api/enrollment", { profile_id: 1 }))
      .body;
    await call(
      repo,
      "v1/enroll",
      { code, name: "Phone", public_key: DEVICE },
      "",
    );
    const added = await call(repo, "api/devices/home", TV);
    expect(added.status).toBe(200);
    const tv = added.body.devices.find(
      (d: { kind: string }) => d.kind === "home",
    );
    expect(tv).toMatchObject({ ...TV, managed: true, paused: false });
    expect(added.body.devices[0].kind).toBe("vpn");
    expect(added.body.events.at(-1).message).toBe(
      "Living room TV added on the home network",
    );

    const gateway = (await call(repo, "v1/gateway/state", undefined, GATEWAY))
      .body;
    expect(gateway.peers.map((p: { ip: string }) => p.ip)).toEqual([
      "10.77.0.2",
    ]);
    expect(gateway.lan_devices).toEqual([
      {
        id: tv.id,
        ip: "192.168.1.50",
        profile_id: 1,
        paused: false,
        managed: true,
      },
    ]);

    await call(repo, "api/devices", { ...tv, paused: true });
    expect(
      (await call(repo, "v1/gateway/state", undefined, GATEWAY)).body
        .lan_devices[0].paused,
    ).toBe(true);

    // Gateway-reported usage and history are attributed to the home device's profile.
    await call(
      repo,
      "v1/gateway/activity",
      {
        activity: [{ device_id: tv.id, buckets: ["total"] }],
        history: [
          {
            id: "h1",
            device_id: tv.id,
            at: Date.now() / 1000,
            domain: "example.com",
            blocked: false,
            reason: "allowed",
          },
        ],
      },
      GATEWAY,
    );
    const state = (await call(repo, "api/state")).body;
    expect(state.profiles[0].used).toBe(1);
    expect(state.recent[0].device_id).toBe(tv.id);
    expect(
      state.devices.find((d: { id: string }) => d.id === tv.id).last_seen,
    ).toBe(Date.now() / 1000);
  });

  it("rejects invalid, duplicate and unlocatable home devices; re-adds after removal", async () => {
    const repo = new TestRepository();
    await call(repo, "api/profiles", { name: "Alex" });
    expect(
      (await call(repo, "api/devices/home", { ...TV, ip: "8.8.8.8" })).status,
    ).toBe(400);
    expect(
      (await call(repo, "api/devices/home", { ...TV, profile_id: 9 })).body
        .error,
    ).toBe("Profile does not exist");
    await call(repo, "api/devices/home", TV);
    expect((await call(repo, "api/devices/home", TV)).body.error).toBe(
      "A device already uses that address",
    );
    expect(
      (await call(repo, "api/devices/locate", { ip: TV.ip })).body.error,
    ).toBe("Home devices cannot share a location");
    await call(repo, "api/devices/delete", { ip: TV.ip });
    const readded = await call(repo, "api/devices/home", {
      ...TV,
      name: "New TV",
    });
    expect(readded.body.devices.map((d: { name: string }) => d.name)).toEqual([
      "New TV",
    ]);
    expect((await repo.read()).state.devices).toHaveLength(1);
  });

  it("survives backup and restore alongside VPN devices", async () => {
    const repo = new TestRepository();
    await call(repo, "api/profiles", { name: "Alex" });
    await call(repo, "api/devices/home", TV);
    await call(repo, "api/devices/home", {
      ...TV,
      name: "Console",
      ip: "192.168.1.51",
    });
    const backup = (await call(repo, "api/export")).body;
    const restored = await call(repo, "api/import", {
      confirm: "RESTORE",
      backup,
    });
    expect(restored.body.error).toBeUndefined();
    expect(restored.body.devices).toHaveLength(2);
    const forged = structuredClone(backup);
    forged.state.devices[0].public_key = DEVICE;
    expect(
      (await call(repo, "api/import", { confirm: "RESTORE", backup: forged }))
        .status,
    ).toBe(400);
    const outside = structuredClone(backup);
    outside.state.devices[0].ip = "8.8.8.8";
    expect(
      (await call(repo, "api/import", { confirm: "RESTORE", backup: outside }))
        .status,
    ).toBe(400);
  });
});
