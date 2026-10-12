import { beforeEach, describe, expect, it, vi } from "vitest";
import { TestRepository } from "../src/lib/database";
import { handle } from "../src/lib/http";

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
  token?: string,
) {
  const response = await handle(
    new Request("http://127.0.0.1:3000/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    path,
    repo,
  );
  return { status: response.status, body: await response.json() };
}
async function enrolled(repo: TestRepository) {
  await call(repo, "api/profiles", { name: "Alex" }, ADMIN);
  const { code } = (
    await call(repo, "api/enrollment", { profile_id: 1 }, ADMIN)
  ).body;
  return (
    await call(repo, "v1/enroll", { code, name: "Phone", public_key: DEVICE })
  ).body as { token: string; tunnel: { address: string } };
}

describe("on-demand location", () => {
  it("shares one location only after a parent asks", async () => {
    const repo = new TestRepository(),
      device = await enrolled(repo);
    const point = { latitude: 41.88, longitude: -87.63, accuracy: 25 };
    expect(
      (await call(repo, "v1/device/location", point, device.token)).body.error,
    ).toBe("No location request is pending");
    expect(
      (await call(repo, "v1/device/state", undefined, device.token)).body
        .location_requested,
    ).toBe(false);

    const asked = await call(
      repo,
      "api/devices/locate",
      { ip: "10.77.0.2" },
      ADMIN,
    );
    expect(asked.body.devices[0].location_requested).toBeGreaterThan(0);
    expect(asked.body.events.at(-1).message).toBe(
      "Location requested from Phone",
    );
    expect(
      (await call(repo, "v1/device/state", undefined, device.token)).body
        .location_requested,
    ).toBe(true);

    expect(
      (await call(repo, "v1/device/location", point, device.token)).body,
    ).toEqual({ ok: true });
    const state = (await call(repo, "api/state", undefined, ADMIN)).body;
    expect(state.devices[0].location).toEqual({
      ...point,
      at: Date.now() / 1000,
    });
    expect(state.devices[0].location_requested).toBeUndefined();
    expect(state.events.at(-1).message).toBe("Phone shared its location");
    // A single answer per request.
    expect(
      (await call(repo, "v1/device/location", point, device.token)).status,
    ).toBe(400);
  });

  it("records refusals, expires stale requests, and validates input", async () => {
    const repo = new TestRepository(),
      device = await enrolled(repo);
    await call(repo, "api/devices/locate", { ip: "10.77.0.2" }, ADMIN);
    expect(
      (
        await call(
          repo,
          "v1/device/location",
          { latitude: 91, longitude: 0, accuracy: 1 },
          device.token,
        )
      ).status,
    ).toBe(400);
    await call(
      repo,
      "v1/device/location",
      { unavailable: "location permission not granted" },
      device.token,
    );
    const state = (await call(repo, "api/state", undefined, ADMIN)).body;
    expect(state.events.at(-1).message).toBe(
      "Phone could not share its location: location permission not granted",
    );
    expect(state.devices[0].location).toBeUndefined();

    await call(repo, "api/devices/locate", { ip: "10.77.0.2" }, ADMIN);
    vi.setSystemTime(new Date("2026-10-11T19:00:01Z"));
    expect(
      (await call(repo, "v1/device/state", undefined, device.token)).body
        .location_requested,
    ).toBe(false);
    expect(
      (await call(repo, "api/devices/locate", { ip: "10.77.0.99" }, ADMIN)).body
        .error,
    ).toBe("Device does not exist");
    expect(
      (
        await call(
          repo,
          "v1/device/location",
          { unavailable: "x" },
          "not-a-device",
        )
      ).status,
    ).toBe(401);
  });

  it("survives backup and restore", async () => {
    const repo = new TestRepository();
    await enrolled(repo);
    await call(repo, "api/devices/locate", { ip: "10.77.0.2" }, ADMIN);
    const backup = (await call(repo, "api/export", undefined, ADMIN)).body;
    const restored = await call(
      repo,
      "api/import",
      { confirm: "RESTORE", backup },
      ADMIN,
    );
    expect(restored.body.devices[0].location_requested).toBeGreaterThan(0);
  });
});

describe("device diagnostics", () => {
  it("stores the latest issues and notifies parents of new problems once", async () => {
    const repo = new TestRepository(),
      device = await enrolled(repo);
    const portal = {
      code: "captive_portal",
      severity: "warning",
      message: "This Wi-Fi needs a sign-in page",
      action: "Choose “Sign in to Wi-Fi”.",
    };
    const alerts = {
      code: "notifications_off",
      severity: "info",
      message: "Alerts are turned off",
    };
    expect(
      (
        await call(
          repo,
          "v1/device/diagnostics",
          { issues: [portal, alerts] },
          device.token,
        )
      ).body,
    ).toEqual({ ok: true });
    let state = (await call(repo, "api/state", undefined, ADMIN)).body;
    expect(state.devices[0].diagnostics).toEqual({
      at: Date.now() / 1000,
      issues: [portal, { ...alerts, action: "" }],
    });
    expect(
      state.events.filter((e: { kind: string }) => e.kind === "device_health")
        .length,
    ).toBe(1);
    expect(state.events.at(-1).message).toBe(
      "Phone: This Wi-Fi needs a sign-in page",
    );
    await call(
      repo,
      "v1/device/diagnostics",
      { issues: [portal] },
      device.token,
    );
    await call(repo, "v1/device/diagnostics", { issues: [] }, device.token);
    state = (await call(repo, "api/state", undefined, ADMIN)).body;
    expect(state.devices[0].diagnostics.issues).toEqual([]);
    expect(
      state.events.filter((e: { kind: string }) => e.kind === "device_health")
        .length,
    ).toBe(1);

    for (const bad of [
      { issues: [{ ...portal, code: "Bad Code" }] },
      { issues: Array(11).fill(portal) },
      { issues: [{ ...portal, severity: "fatal" }] },
    ])
      expect(
        (await call(repo, "v1/device/diagnostics", bad, device.token)).status,
      ).toBe(400);
    expect(
      (await call(repo, "v1/device/diagnostics", { issues: [] }, "nope"))
        .status,
    ).toBe(401);

    await call(
      repo,
      "v1/device/diagnostics",
      { issues: [portal] },
      device.token,
    );
    const backup = (await call(repo, "api/export", undefined, ADMIN)).body;
    const restored = await call(
      repo,
      "api/import",
      { confirm: "RESTORE", backup },
      ADMIN,
    );
    expect(restored.body.devices[0].diagnostics.issues[0].code).toBe(
      "captive_portal",
    );
  });
});

describe("gateway heartbeat", () => {
  it("records gateway contact at most once a minute and notes reconnection", async () => {
    const repo = new TestRepository();
    const before = (await call(repo, "api/state", undefined, ADMIN)).body;
    expect(before.gateway_seen).toBeUndefined();
    await call(repo, "v1/gateway/state", undefined, GATEWAY);
    const first = (await repo.read()).revision;
    expect((await repo.read()).state.gateway_seen).toBe(Date.now() / 1000);
    await call(repo, "v1/gateway/state", undefined, GATEWAY);
    expect((await repo.read()).revision).toBe(first);

    vi.setSystemTime(new Date("2026-10-11T18:10:00Z"));
    await call(repo, "v1/gateway/state", undefined, GATEWAY);
    const state = (await call(repo, "api/state", undefined, ADMIN)).body;
    expect(state.gateway_seen).toBe(Date.now() / 1000);
    expect(state.events.at(-1).message).toBe("VPN gateway reconnected");
  });
});
