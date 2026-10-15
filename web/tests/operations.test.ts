import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestRepository, mutate } from "../src/lib/database";
import { emptyState } from "../src/lib/model";
import { checks, readiness, supportBundle } from "../src/lib/readiness";
import { gatewayHealth } from "../src/lib/gateway-health";
import {
  configuredFeeds,
  feedStatus,
  parseFeed,
  publicAddress,
  refreshFeeds,
} from "../src/lib/feeds";
import {
  deliverNotifications,
  mailConfig,
  notificationStatus,
  testMail,
  retryFailedNotifications,
} from "../src/lib/notifications";
import { maintenanceTick } from "../src/lib/maintenance";
import { handle } from "../src/lib/http";
import { smtpSend } from "../src/lib/notifications";
import { downloadFeed } from "../src/lib/feeds";
import { EventEmitter } from "node:events";

const network = vi.hoisted(() => ({
  lookup: vi.fn(),
  get: vi.fn(),
  send: vi.fn(),
  create: vi.fn(),
  close: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({ lookup: network.lookup }));
vi.mock("node:https", () => ({ get: network.get }));
vi.mock("nodemailer", () => ({ default: { createTransport: network.create } }));

const at = Math.floor(Date.now() / 1000);
const ADMIN = "a".repeat(48);
let repo: TestRepository;
beforeEach(() => {
  repo = new TestRepository();
  vi.stubEnv("TEMPERANCE_ADMIN_TOKEN", ADMIN);
  vi.stubEnv("TEMPERANCE_ADMIN_PASSWORD", "");
  delete process.env.TEMPERANCE_ADMIN_PASSWORD;
  vi.stubEnv("TEMPERANCE_GATEWAY_TOKEN", "g".repeat(48));
  vi.stubEnv("TEMPERANCE_SMTP_HOST", "");
  vi.stubEnv("TEMPERANCE_BACKUP_PASSPHRASE", "");
  vi.stubEnv("TEMPERANCE_FEEDS", "");
  vi.stubEnv("TEMPERANCE_GATEWAY_LISTEN", "");
  vi.stubEnv("TEMPERANCE_DATABASE_URL", "sqlite::memory:");
  vi.stubEnv("TEMPERANCE_DATA_DIR", "");
  vi.stubEnv("TEMPERANCE_TIMEZONE", "UTC");
  vi.stubEnv("TEMPERANCE_VPN_ENDPOINT", "example.net:51820");
  vi.stubEnv("TEMPERANCE_PUBLIC_URL", "http://localhost");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function smtp() {
  vi.stubEnv("TEMPERANCE_SMTP_HOST", "smtp.example.net");
  vi.stubEnv("TEMPERANCE_SMTP_FROM", "temperance@example.net");
  vi.stubEnv("TEMPERANCE_SMTP_TO", "admin@example.net");
}
async function addEvent(id = "event-1") {
  await mutate(repo, (s) =>
    s.events.push({
      id,
      at: at + 1,
      kind: "time_request",
      message: "PRIVATE CHILD AND REQUEST",
      read: false,
    }),
  );
}
describe("readiness and privacy", () => {
  it("creates the first client and sign-in atomically without leaving a profile after a failed sign-in", async () => {
    const create = (password: string, name = "avery") =>
      handle(
        new Request("http://localhost/api/setup/client", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + ADMIN,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ profile: { name, limit: 90 }, password }),
        }),
        "api/setup/client",
        repo,
      );
    expect((await create("short")).status).toBe(400);
    expect((await repo.read()).state.profiles).toHaveLength(0);
    expect((await create("a-valid-password")).status).toBe(200);
    expect((await repo.read()).state.users?.[0].profile_id).toBe(
      (await repo.read()).state.profiles[0].id,
    );
    expect((await create("another-password")).status).toBe(400);
    expect((await repo.read()).state.profiles).toHaveLength(1);
    expect((await repo.read()).state.nextProfileId).toBe(2);
  });
  it("reports missing and stale gateways and invalid timezones", async () => {
    expect((await readiness(repo)).ready).toBe(false);
    await mutate(repo, (s) => {
      s.gateway_seen = at;
    });
    expect((await readiness(repo)).ready).toBe(true);
    expect(
      checks({ ...emptyState(), gateway_seen: at - 91 }).find(
        (c) => c.id === "gateway",
      )?.state,
    ).toBe("error");
    vi.stubEnv("TEMPERANCE_TIMEZONE", "bad zone");
    expect(checks(emptyState()).find((c) => c.id === "timezone")?.state).toBe(
      "error",
    );
    const response = await handle(
      new Request("http://localhost/api/readiness?report=1", {
        headers: { Authorization: "Bearer " + ADMIN },
      }),
      "api/readiness",
      repo,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).checks).toContainEqual(
      expect.objectContaining({ id: "timezone", state: "error" }),
    );
    expect(
      (
        await readiness({
          read: async () => {
            throw new Error("private SQL hostname");
          },
          commit: async () => false,
        })
      ).checks[0].message,
    ).not.toContain("SQL");
  });
  it("checks embedded policy lease and overlapping subnets", () => {
    vi.stubEnv("TEMPERANCE_GATEWAY_LISTEN", "0.0.0.0:51820");
    vi.stubEnv("TEMPERANCE_GATEWAY_LAN_NETWORKS", "10.77.0.8/28");
    gatewayHealth().applied_at = at * 1000 - 16000;
    expect(
      checks(emptyState())
        .filter((c) => c.state === "error")
        .map((c) => c.id),
    ).toContain("policy_lease");
    gatewayHealth().applied_at = Date.now();
    expect(
      checks(emptyState()).find((c) => c.id === "policy_lease")?.state,
    ).toBe("ok");
    expect(checks(emptyState()).find((c) => c.id === "subnet")?.state).toBe(
      "error",
    );
  });
  it("requires admin access to every operational interface", async () => {
    for (const path of [
      "api/readiness",
      "api/support",
      "api/maintenance",
      "api/recovery",
      "api/notifications/test",
      "api/notifications/retry",
    ]) {
      const method = /recovery|test$|retry$/.test(path) ? "POST" : "GET";
      expect(
        (
          await handle(
            new Request("http://localhost/" + path, { method }),
            path,
            repo,
          )
        ).status,
      ).toBe(401);
    }
  });
  it("exports only allowlisted diagnostics and returns readiness status", async () => {
    await mutate(repo, (s) => {
      s.gateway_seen = at;
      s.events.push({
        id: "private",
        at,
        kind: "private",
        message: "SECRET",
        read: false,
      });
      s.network = {
        upnp: false,
        ddns: {
          provider: "dynu",
          hostname: "SECRET",
          username: "SECRET",
          password: "SECRET",
        },
      };
    });
    const report = JSON.stringify(supportBundle((await repo.read()).state));
    expect(report).not.toContain("SECRET");
    expect(report).not.toContain("events");
    for (const path of ["api/readiness", "api/support", "api/maintenance"]) {
      const response = await handle(
        new Request("http://localhost/" + path, {
          headers: { Authorization: "Bearer " + ADMIN },
        }),
        path,
        repo,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
});
describe("persistent email queue", () => {
  it("requeues failed notices explicitly without resending delivered notices", async () => {
    smtp();
    const send = vi.fn().mockRejectedValue(new Error("temporary mail outage"));
    await deliverNotifications(repo, send, at);
    await addEvent();
    for (let i = 0; i < 5; i++)
      await deliverNotifications(repo, send, at + 2 + i * 4000);
    expect(notificationStatus((await repo.read()).state).failed).toBe(1);
    // The generic kind allows safe retry even after the original event is pruned.
    await mutate(repo, (s) => {
      s.events = [];
    });
    expect(await retryFailedNotifications(repo, at + 20000)).toEqual({
      retried: 1,
    });
    expect(await retryFailedNotifications(repo, at + 20000)).toEqual({
      retried: 0,
    });
    send.mockResolvedValue(undefined);
    await deliverNotifications(repo, send, at + 20000);
    expect(notificationStatus((await repo.read()).state)).toMatchObject({
      pending: 0,
      failed: 0,
    });
    expect(await retryFailedNotifications(repo)).toEqual({ retried: 0 });
    expect(JSON.stringify(send.mock.calls)).not.toContain("PRIVATE");
  });
  it("skips unavailable legacy events without starving newer notices", async () => {
    smtp();
    await deliverNotifications(repo, vi.fn(), at);
    await mutate(repo, (s) => {
      s.maintenance!.mail!.deliveries.push({
        id: "pruned-legacy",
        attempts: 0,
        next_at: at,
      });
    });
    await addEvent();
    const send = vi.fn().mockResolvedValue(undefined);
    await deliverNotifications(repo, send, at + 2);
    expect(send).toHaveBeenCalledTimes(1);
    vi.stubEnv("TEMPERANCE_SMTP_HOST", "");
    await expect(retryFailedNotifications(repo)).rejects.toThrow(
      /Configure SMTP/,
    );
  });
  it("requires verified TLS and disables file/URL message access", async () => {
    smtp();
    network.send.mockResolvedValue({
      accepted: ["admin@example.net"],
      rejected: [],
    });
    network.create.mockReturnValue({
      sendMail: network.send,
      close: network.close,
    });
    await smtpSend({
      id: "test-id",
      subject: "Delivery test",
      text: "Generic notice",
    });
    expect(network.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        port: 587,
        requireTLS: true,
        disableFileAccess: true,
        disableUrlAccess: true,
        logger: false,
      }),
    );
    expect(network.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: "<test-id@temperance.local>" }),
    );
    vi.stubEnv("TEMPERANCE_SMTP_PORT", "465");
    await smtpSend({
      id: "test-id-2",
      subject: "Delivery test",
      text: "Generic notice",
    });
    expect(network.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ secure: true, port: 465 }),
    );
    network.send.mockResolvedValue({
      accepted: [],
      rejected: ["admin@example.net"],
    });
    await expect(
      smtpSend({ id: "refused", subject: "Test", text: "Test" }),
    ).rejects.toThrow(/refused/);
    expect(network.close).toHaveBeenCalled();
  });
  it("is off by default and validates configured mailboxes", async () => {
    const send = vi.fn();
    await deliverNotifications(repo, send, at);
    expect(send).not.toHaveBeenCalled();
    expect(notificationStatus(emptyState()).configured).toBe(false);
    smtp();
    vi.stubEnv("TEMPERANCE_SMTP_TO", "invalid\r\nBcc: secret");
    expect(() => mailConfig()).toThrow();
    expect(notificationStatus(emptyState()).configured).toBe(false);
  });
  it("does not replay history and deduplicates across ticks and workers", async () => {
    smtp();
    await addEvent("old");
    const send = vi.fn().mockResolvedValue(undefined);
    await deliverNotifications(repo, send, at);
    expect(send).not.toHaveBeenCalled();
    await addEvent();
    await Promise.all([
      deliverNotifications(repo, send, at + 2),
      deliverNotifications(repo, send, at + 2),
    ]);
    await deliverNotifications(repo, send, at + 200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls)).not.toContain("PRIVATE");
    expect(notificationStatus((await repo.read()).state)).toMatchObject({
      pending: 0,
      failed: 0,
      last_sent_at: at + 2,
    });
  });
  it("backs off, bounds retries and persists a generic failure", async () => {
    smtp();
    const send = vi.fn().mockRejectedValue(new Error("SMTP PASSWORD PRIVATE"));
    await deliverNotifications(repo, send, at);
    await addEvent();
    await deliverNotifications(repo, send, at + 2);
    await deliverNotifications(repo, send, at + 3);
    expect(send).toHaveBeenCalledTimes(1);
    for (let i = 1; i <= 4; i++)
      await deliverNotifications(repo, send, at + 2 + i * 4000);
    expect(send).toHaveBeenCalledTimes(5);
    expect(notificationStatus((await repo.read()).state)).toMatchObject({
      pending: 0,
      failed: 1,
    });
    expect(JSON.stringify((await repo.read()).state)).not.toContain("PASSWORD");
  });
  it("rate limits delivery tests and records both outcomes", async () => {
    smtp();
    await deliverNotifications(repo, vi.fn(), at);
    const send = vi.fn().mockResolvedValue(undefined);
    await testMail(repo, send, at);
    await expect(testMail(repo, send, at + 1)).rejects.toThrow(/last minute/);
    send.mockRejectedValue(new Error("private provider reply"));
    await expect(testMail(repo, send, at + 61)).rejects.toThrow(
      /delivery failed/,
    );
    expect(notificationStatus((await repo.read()).state).error).not.toContain(
      "private",
    );
  });
});
describe("category feed integrity", () => {
  it("pins public DNS answers while validating TLS and refuses redirects/private destinations", async () => {
    network.lookup.mockResolvedValue({ address: "127.0.0.1" });
    await expect(
      downloadFeed("https://feeds.example.net/list"),
    ).rejects.toThrow(/public address/);
    network.lookup.mockResolvedValue({ address: "1.1.1.1" });
    let status = 200;
    network.get.mockImplementation((_options, callback) => {
      const request = new EventEmitter() as EventEmitter & {
        destroy: (error: Error) => void;
      };
      request.destroy = (error) => {
        request.emit("error", error);
        request.emit("close");
      };
      queueMicrotask(() => {
        const response = Object.assign(new EventEmitter(), {
          statusCode: status,
          headers: {},
          resume() {
            request.emit("close");
          },
        });
        callback(response);
        response.emit("data", Buffer.from("ads.example.net"));
        response.emit("end");
        request.emit("close");
      });
      return request;
    });
    expect(await downloadFeed("https://feeds.example.net/list")).toBe(
      "ads.example.net",
    );
    expect(network.get).toHaveBeenLastCalledWith(
      expect.objectContaining({
        hostname: "1.1.1.1",
        servername: "feeds.example.net",
        headers: expect.objectContaining({ Host: "feeds.example.net" }),
      }),
      expect.any(Function),
    );
    status = 302;
    await expect(
      downloadFeed("https://feeds.example.net/list"),
    ).rejects.toThrow(/response refused/);
    await expect(downloadFeed("http://feeds.example.net/list")).rejects.toThrow(
      /HTTPS/,
    );
  });
  const configure = () =>
    vi.stubEnv(
      "TEMPERANCE_FEEDS",
      JSON.stringify([
        {
          category: "ads",
          url: "https://feeds.example.net/ads",
          attribution: "Operator reviewed source",
          license: "MIT",
        },
      ]),
    );
  it("accepts domains and hosts files, rejecting unsupported content and empty responses", () => {
    expect(
      parseFeed(
        "# comment\n0.0.0.0 Ads.example.com\n127.0.0.1 localhost\nads.example.com\nexample.net # note",
      ),
    ).toEqual(["ads.example.com", "example.net"]);
    for (const text of [
      "",
      "<html>error</html>",
      "||example.com^",
      "https://example.com",
    ])
      expect(() => parseFeed(text)).toThrow();
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "100.64.1.1",
      "169.254.169.254",
      "172.16.1.1",
      "192.168.1.1",
      "198.18.0.1",
      "203.0.113.1",
      "224.1.1.1",
      "::1",
    ])
      expect(publicAddress(ip)).toBe(false);
    expect(publicAddress("1.1.1.1")).toBe(true);
  });
  it("validates sources, reports configuration failures and never exposes source URLs", () => {
    configure();
    expect(configuredFeeds()).toHaveLength(1);
    expect(feedStatus(emptyState()).feeds[0].stale).toBe(true);
    expect(JSON.stringify(feedStatus(emptyState()))).not.toContain("https://");
    vi.stubEnv("TEMPERANCE_FEEDS", "invalid");
    expect(feedStatus(emptyState()).error).toMatch(/Invalid/);
  });
  it("refreshes and keeps the last known good list on errors and truncation", async () => {
    configure();
    const download = vi.fn().mockResolvedValue("ads.example.com");
    await refreshFeeds(repo, download, at);
    expect((await repo.read()).state.extra_domains.ads).toEqual([
      "ads.example.com",
    ]);
    await refreshFeeds(repo, download, at + 1);
    expect(download).toHaveBeenCalledTimes(1);
    download.mockRejectedValue(new Error("private URL token"));
    await refreshFeeds(repo, download, at + 3600);
    expect((await repo.read()).state.extra_domains.ads).toEqual([
      "ads.example.com",
    ]);
    expect(JSON.stringify(feedStatus((await repo.read()).state))).not.toContain(
      "private",
    );
    await mutate(repo, (s) => {
      s.extra_domains.ads = Array.from(
        { length: 200 },
        (_, i) => `ad${i}.example.com`,
      );
    });
    download.mockResolvedValue("one.example.com");
    await refreshFeeds(repo, download, at + 7200);
    expect((await repo.read()).state.extra_domains.ads).toHaveLength(200);
  });
});
describe("background health monitoring", () => {
  it("records gateway outage and recovery once per transition", async () => {
    await mutate(repo, (s) => {
      s.gateway_seen = at - 100;
    });
    await maintenanceTick(repo, at);
    await maintenanceTick(repo, at + 1);
    expect((await repo.read()).state.events).toHaveLength(1);
    await mutate(repo, (s) => {
      s.gateway_seen = at + 2;
    });
    await maintenanceTick(repo, at + 2);
    expect((await repo.read()).state.events).toHaveLength(2);
  });
});
