import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestRepository } from "../src/lib/database";
import {
  gatewayConfig,
  startGateway,
  type GatewayAddon,
} from "../src/lib/gateway";
import { handle } from "../src/lib/http";

const ADMIN = "a".repeat(48);
const DEVICE = btoa(
  String.fromCharCode(...Array.from({ length: 32 }, (_, n) => n + 1)),
);

/** A valid-looking WireGuard key derived from `key`, like the real add-on would. */
const derive = (key: string) => btoa(key.padEnd(32, "#").slice(0, 32));

function fakeAddon() {
  const applied: Record<string, unknown>[] = [];
  const configs: Record<string, unknown>[] = [];
  let pending: unknown = { active_devices: [], activity: [], history: [] };
  const stopped = vi.fn();
  const addon: GatewayAddon = {
    generatePrivateKey: () => "private-key",
    publicKey: derive,
    GatewayHandle: {
      start(config) {
        configs.push(JSON.parse(config));
        return {
          publicKey: () => "unused",
          applyState: (state) => void applied.push(JSON.parse(state)),
          drainActivity() {
            const out = pending;
            pending = { active_devices: [], activity: [], history: [] };
            return JSON.stringify(out);
          },
          stop: stopped,
        };
      },
    },
  };
  return {
    addon,
    applied,
    configs,
    stopped,
    report: (value: unknown) => void (pending = value),
  };
}

async function request(repo: TestRepository, route: string, body?: unknown) {
  return handle(
    new Request("http://127.0.0.1:3000/" + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + ADMIN,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    route,
    repo,
  );
}

let dir: string;
let env: Record<string, string | undefined>;
beforeEach(() => {
  vi.setSystemTime(new Date("2026-10-11T18:00:00Z"));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "temperance-gateway-"));
  process.env.TEMPERANCE_ADMIN_TOKEN = ADMIN;
  process.env.TEMPERANCE_GATEWAY_TOKEN = "g".repeat(48);
  process.env.TEMPERANCE_TIMEZONE = "UTC";
  process.env.TEMPERANCE_VPN_ENDPOINT = "home.example.net:51820";
  env = {
    TEMPERANCE_DATA_DIR: dir,
    TEMPERANCE_GATEWAY_LISTEN: "0.0.0.0:51820",
    TEMPERANCE_PUBLIC_URL: "https://home.example.net",
    TEMPERANCE_VPN_ENDPOINT: "home.example.net:51820",
    PORT: "3000",
  };
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function enrolled(repo: TestRepository, publicKey: string) {
  process.env.TEMPERANCE_VPN_PUBLIC_KEY = publicKey;
  await request(repo, "api/profiles", { name: "Riley", limit: 30 });
  const { code } = await (
    await request(repo, "api/enrollment", { profile_id: 1 })
  ).json();
  const device = await (
    await request(repo, "v1/enroll", {
      code,
      name: "Phone",
      public_key: DEVICE,
    })
  ).json();
  return device as { device_id?: string; id?: string };
}

describe("embedded gateway loop", () => {
  it("persists its key, publishes the public key and applies policy", async () => {
    const fake = fakeAddon();
    const repo = new TestRepository();
    const gateway = await startGateway({
      env,
      addon: fake.addon,
      repo,
      intervalMs: 60_000,
    });
    const keyFile = path.join(dir, "gateway.key");
    expect(fs.readFileSync(keyFile, "utf8").trim()).toBe("private-key");
    if (process.platform !== "win32")
      expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(gateway.publicKey).toBe(derive("private-key"));
    expect(env.TEMPERANCE_VPN_PUBLIC_KEY).toBe(derive("private-key"));
    expect(fake.configs[0]).toMatchObject({
      listen: "0.0.0.0:51820",
      private_key: "private-key",
      management_domains: ["home.example.net"],
      web: "127.0.0.1:3000",
    });
    expect(fake.applied[0]).toMatchObject({ policy_schema: 2, peers: [] });
    expect((await repo.read()).state.gateway_seen).toBeGreaterThan(0);
    gateway.stop();
    expect(fake.stopped).toHaveBeenCalled();
  });

  it("accounts reported activity and hands enrolled peers to the gateway", async () => {
    const fake = fakeAddon();
    const repo = new TestRepository();
    await enrolled(repo, derive("private-key"));
    const gateway = await startGateway({ env, addon: fake.addon, repo });
    const peer = (
      fake.applied[0].peers as { id: string; public_key: string }[]
    )[0];
    expect(peer.public_key).toBe(DEVICE);
    const minute = Math.floor(Date.now() / 60_000);
    fake.report({
      active_devices: [],
      activity: [
        { device_id: peer.id, minute, buckets: ["total", "category:video"] },
      ],
      history: [],
    });
    await gateway.tick();
    const { state } = await repo.read();
    const usage = Object.values(state.usage)[0][1];
    expect(usage.total).toEqual([minute]);
    expect(usage["category:video"]).toEqual([minute]);
    const profile = (fake.applied.at(-1)!.profiles as { used: number }[])[0];
    expect(profile.used).toBe(1);
    gateway.stop();
  });

  it("still refreshes policy when a batch is rejected", async () => {
    const fake = fakeAddon();
    const repo = new TestRepository();
    await enrolled(repo, derive("private-key"));
    const gateway = await startGateway({ env, addon: fake.addon, repo });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.report({
      activity: [{ device_id: "x", minute: 1, buckets: ["Not A Bucket"] }],
      history: [],
    });
    const before = fake.applied.length;
    await gateway.tick();
    expect(fake.applied.length).toBe(before + 1);
    errors.mockRestore();
    gateway.stop();
  });

  it("refuses a configured public key that does not match its private key", async () => {
    await expect(
      startGateway({
        env: { ...env, TEMPERANCE_VPN_PUBLIC_KEY: "someone-else" },
        addon: fakeAddon().addon,
        repo: new TestRepository(),
      }),
    ).rejects.toThrow(/does not match/);
  });

  it("prefers an explicit private key and reuses a saved one", async () => {
    const fake = fakeAddon();
    const explicit = await startGateway({
      env: { ...env, TEMPERANCE_GATEWAY_PRIVATE_KEY: " given \n" },
      addon: fake.addon,
      repo: new TestRepository(),
    });
    expect(explicit.publicKey).toBe(derive("given"));
    explicit.stop();
    fs.writeFileSync(path.join(dir, "gateway.key"), "saved\n");
    const saved = await startGateway({
      env: { ...env },
      addon: fake.addon,
      repo: new TestRepository(),
    });
    expect(saved.publicKey).toBe(derive("saved"));
    saved.stop();
  });
});

describe("gateway configuration", () => {
  it("maps environment to the add-on config", () => {
    const config = gatewayConfig(
      {
        TEMPERANCE_GATEWAY_LISTEN: "0.0.0.0:51820",
        TEMPERANCE_GATEWAY_DNS_UPSTREAM: "9.9.9.9:53",
        TEMPERANCE_GATEWAY_HOME_DNS: "0.0.0.0:53",
        TEMPERANCE_GATEWAY_LAN_NETWORKS: "192.168.1.0/24, 10.0.0.0/24",
        TEMPERANCE_GATEWAY_ROUTER: "eth0, 192.168.1.2, eth1",
        TEMPERANCE_PUBLIC_URL: "http://127.0.0.1:3000",
        TEMPERANCE_VPN_ENDPOINT: "203.0.113.10:51820",
        HOSTNAME: "192.168.1.2",
        PORT: "8080",
      },
      "k",
    );
    expect(config).toEqual({
      listen: "0.0.0.0:51820",
      private_key: "k",
      dns_upstream: "9.9.9.9:53",
      management_domains: [],
      web: "192.168.1.2:8080",
      home_dns: "0.0.0.0:53",
      lan_networks: ["192.168.1.0/24", "10.0.0.0/24"],
      router: {
        lan_interface: "eth0",
        lan_address: "192.168.1.2",
        uplink: "eth1",
      },
      public_port: 51820,
    });
    expect(() =>
      gatewayConfig({ TEMPERANCE_GATEWAY_ROUTER: "eth0" }, "k"),
    ).toThrow(/lan_interface/);
  });

  it("maps the router port from the advertised endpoint", () => {
    const port = (endpoint?: string) =>
      gatewayConfig({ TEMPERANCE_VPN_ENDPOINT: endpoint }, "k").public_port;
    expect(port("home.example.net:51821")).toBe(51821);
    expect(port(undefined)).toBeNull();
    expect(port("not an endpoint")).toBeNull();
  });
});

describe("network reachability", () => {
  const upnp = {
    state: "ok",
    ip: "203.0.113.7",
    message: "The router forwards UDP 51820 to 192.168.1.20:51820.",
    at: 1,
  };

  it("hands UPnP and Dynu settings to the gateway and records its status", async () => {
    const fake = fakeAddon();
    const repo = new TestRepository();
    const gateway = await startGateway({ env, addon: fake.addon, repo });
    expect(fake.applied[0].network).toEqual({ upnp: true, ddns: null });
    await request(repo, "api/settings", {
      network: {
        upnp: false,
        ddns: {
          hostname: "MyHome.ddnsfree.com",
          username: "family",
          password: "ip-update-secret",
        },
      },
    });
    fake.report({ activity: [], history: [], network: { upnp, ddns: null } });
    await gateway.tick();
    expect(fake.applied.at(-1)!.network).toEqual({
      upnp: false,
      ddns: {
        provider: "dynu",
        hostname: "myhome.ddnsfree.com",
        username: "family",
        password: "ip-update-secret",
      },
    });
    const { state } = await repo.read();
    expect(state.network_status).toMatchObject({ upnp, ddns: null });
    gateway.stop();
  });

  it("accepts status from a remote gateway", async () => {
    const repo = new TestRepository();
    const response = await handle(
      new Request("http://127.0.0.1:3000/v1/gateway/activity", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + "g".repeat(48),
        },
        body: JSON.stringify({
          network: { upnp: { ...upnp, state: "error" }, ddns: null },
        }),
      }),
      "v1/gateway/activity",
      repo,
    );
    expect(response.status).toBe(200);
    const { state } = await repo.read();
    expect(state.network_status?.upnp?.state).toBe("error");
    expect(state.events.at(-1)?.message).toBe(
      "Port forwarding: " + upnp.message,
    );
  });
});

describe("instrumentation", () => {
  it("only starts the gateway in Node with a listen address", async () => {
    const start = vi.fn(async () => ({ publicKey: "pk", stop: vi.fn() }));
    vi.doMock("../src/lib/gateway", () => ({ startGateway: start }));
    const { register } = await import("../src/instrumentation");
    const saved = { ...process.env };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.env.NEXT_RUNTIME = "edge";
      process.env.TEMPERANCE_GATEWAY_LISTEN = "0.0.0.0:51820";
      await register();
      expect(start).not.toHaveBeenCalled();
      process.env.NEXT_RUNTIME = "nodejs";
      delete process.env.TEMPERANCE_GATEWAY_LISTEN;
      await register();
      expect(start).not.toHaveBeenCalled();
      process.env.TEMPERANCE_GATEWAY_LISTEN = "0.0.0.0:51820";
      await register();
      expect(start).toHaveBeenCalledOnce();
    } finally {
      process.env = saved;
      log.mockRestore();
      vi.doUnmock("../src/lib/gateway");
    }
  });
});
