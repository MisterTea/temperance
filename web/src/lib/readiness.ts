import { backend, databaseUrl, type Repository } from "./database";
import type { State } from "./model";
import { inNetwork } from "./home-lan";
import { gatewayHealth } from "./gateway-health";

export type Check = {
  id: string;
  state: "ok" | "warning" | "error";
  message: string;
};

/** Deliberately allowlisted: no names, addresses, URLs, messages or credentials. */
export function checks(
  state: State,
  env = process.env,
  at = Date.now() / 1000,
): Check[] {
  const result: Check[] = [
    { id: "database", state: "ok", message: "Database is readable." },
  ];
  try {
    new Intl.DateTimeFormat("en", {
      timeZone: env.TEMPERANCE_TIMEZONE || "UTC",
    });
    result.push({
      id: "timezone",
      state: "ok",
      message: "Household timezone is valid.",
    });
  } catch {
    result.push({
      id: "timezone",
      state: "error",
      message: "Set a valid household timezone.",
    });
  }
  const age = state.gateway_seen
    ? Math.max(0, at - state.gateway_seen)
    : Infinity;
  result.push({
    id: "gateway",
    state: age < 90 ? "ok" : "error",
    message:
      age < 90
        ? "Gateway heartbeat is current."
        : "Gateway has not checked in within 90 seconds.",
  });
  if (env.TEMPERANCE_GATEWAY_LISTEN) {
    const applied = gatewayHealth().applied_at;
    const live = !!applied && at * 1000 - applied < 15000;
    result.push({
      id: "policy_lease",
      state: live ? "ok" : "error",
      message: live
        ? "Embedded gateway received a policy within its lease."
        : "Embedded gateway policy lease is stale or has not started.",
    });
  }
  result.push({
    id: "storage",
    state:
      env.TEMPERANCE_DATA_DIR || backend(databaseUrl(env)) === "postgres"
        ? "ok"
        : "warning",
    message: env.TEMPERANCE_DATA_DIR
      ? "Data directory is configured; verify it is on persistent storage."
      : "Verify the database and gateway keys survive replacement of this server.",
  });
  result.push({
    id: "endpoint",
    state: env.TEMPERANCE_VPN_ENDPOINT ? "ok" : "error",
    message: env.TEMPERANCE_VPN_ENDPOINT
      ? "VPN endpoint is configured."
      : "Configure the public VPN endpoint.",
  });
  // Local checks cannot establish whether UDP reaches this machine from the internet.
  result.push({
    id: "reachability",
    state: "warning",
    message:
      "Test a device over mobile data. Local checks cannot prove inbound UDP reachability or rule out CGNAT.",
  });
  const networks = (env.TEMPERANCE_GATEWAY_LAN_NETWORKS || "").split(",");
  const conflict = networks.some((cidr) => {
    const [ip, prefix] = cidr.trim().split("/");
    return (
      ip &&
      prefix &&
      (inNetwork("10.77.0.1", ip, Number(prefix)) ||
        inNetwork(ip, "10.77.0.1", 24))
    );
  });
  result.push({
    id: "subnet",
    state: conflict ? "error" : "warning",
    message: conflict
      ? "Configured LAN overlaps the VPN subnet 10.77.0.0/24."
      : "Configured LAN has no detected overlap; also verify the host and remote networks do not use 10.77.0.0/24.",
  });
  return result;
}

export async function readiness(repo: Repository) {
  try {
    const { state } = await repo.read();
    const items = checks(state);
    if (process.env.TEMPERANCE_DATA_DIR) {
      try {
        const { access, statfs } = await import("node:fs/promises");
        await access(process.env.TEMPERANCE_DATA_DIR, 2);
        const disk = await statfs(process.env.TEMPERANCE_DATA_DIR);
        if (disk.bavail * disk.bsize < 1024 * 1024)
          throw new Error("Storage full");
      } catch {
        items.push({
          id: "storage_access",
          state: "error",
          message:
            "Data directory is unavailable, unwritable or has less than 1 MiB free.",
        });
      }
    }
    const { networkInterfaces } = await import("node:os");
    const overlap = Object.values(networkInterfaces())
      .flat()
      .some(
        (nic) =>
          nic?.family === "IPv4" &&
          nic.cidr &&
          (inNetwork(
            "10.77.0.1",
            nic.address,
            Number(nic.cidr.split("/")[1]),
          ) ||
            inNetwork(nic.address, "10.77.0.1", 24)),
      );
    if (overlap)
      items.push({
        id: "host_subnet",
        state: "error",
        message: "A host network overlaps the VPN subnet 10.77.0.0/24.",
      });
    return { ready: !items.some((c) => c.state === "error"), checks: items };
  } catch {
    return {
      ready: false,
      checks: [
        {
          id: "database",
          state: "error",
          message: "Database is unavailable.",
        } as Check,
      ],
    };
  }
}

export function supportBundle(state: State) {
  return {
    format: "temperance-support",
    schema: 1,
    generated_at: new Date().toISOString(),
    version: process.env.TEMPERANCE_BUILD_VERSION || "dev",
    runtime: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      uptime_seconds: Math.floor(process.uptime()),
    },
    metrics: {
      gateway_syncs: gatewayHealth().syncs,
      gateway_sync_failures: gatewayHealth().sync_failures,
      rss_bytes: process.memoryUsage().rss,
      heap_bytes: process.memoryUsage().heapUsed,
    },
    database: backend(databaseUrl()),
    checks: checks(state),
    counts: {
      profiles: state.profiles.length,
      active_devices: state.devices.filter((d) => !d.revoked).length,
      revoked_devices: state.devices.filter((d) => d.revoked).length,
      pending_requests: state.requests.filter((r) => r.status === "pending")
        .length,
    },
    device_issues: Object.fromEntries(
      ["error", "warning", "info"].map((severity) => [
        severity,
        state.devices
          .filter((d) => !d.revoked)
          .flatMap((d) => d.diagnostics?.issues || [])
          .filter((i) => i.severity === severity).length,
      ]),
    ),
    maintenance: {
      email_configured: !!process.env.TEMPERANCE_SMTP_HOST,
      email_failed: !!state.maintenance?.mail?.last_error,
      backup_at: state.maintenance?.backup_at ?? null,
      backup_failed: !!state.maintenance?.backup_error,
      update_status: state.maintenance?.update?.status ?? "none",
      feeds_configured: !!process.env.TEMPERANCE_FEEDS,
      feeds_failed: Object.values(state.maintenance?.feeds || {}).filter(
        (f) => f.error,
      ).length,
    },
  };
}
