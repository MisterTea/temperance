import fs from "node:fs";
import { isIPv4 } from "node:net";
import path from "node:path";
import { randomToken } from "./auth";
import { dataDir, mutate, repository, type Repository } from "./database";
import { account, gatewaySeen, gatewayState, vpnEndpoint } from "./service";
import { accessPoint } from "./home-lan";
import type { State } from "./model";
import { gatewayHealth } from "./gateway-health";

// The embedded WireGuard gateway (Rust, Node-API). State, config and activity are JSON strings.
export interface GatewayHandle {
  publicKey(): string;
  applyState(state: string): void;
  drainActivity(): string;
  stop(): void;
}
export interface GatewayAddon {
  GatewayHandle: { start(config: string): GatewayHandle };
  generatePrivateKey(): string;
  publicKey(privateKey: string): string;
}
type Env = Record<string, string | undefined>;

export function loadAddon(
  id = process.env.TEMPERANCE_GATEWAY_ADDON_PACKAGE ??
    "@temperance/gateway-addon",
): GatewayAddon {
  // Node's own require, resolved from the server entry (standalone server.js):
  // bundlers neither inline the native binary nor shim this lookup.
  const { createRequire } = process.getBuiltinModule("node:module");
  return createRequire(process.argv[1] ?? process.cwd() + "/")(id);
}

/** Devices pin the gateway's public key, so the private key must survive restarts. */
export function gatewayKey(env: Env, addon: GatewayAddon) {
  if (env.TEMPERANCE_GATEWAY_PRIVATE_KEY)
    return env.TEMPERANCE_GATEWAY_PRIVATE_KEY.trim();
  const file = path.join(dataDir(env), "gateway.key");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const key = addon.generatePrivateKey();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, key + "\n", { mode: 0o600, flag: "wx" });
  return key;
}

function hostname(value: string) {
  try {
    return new URL(value.includes("://") ? value : "udp://" + value).hostname;
  } catch {
    return "";
  }
}

export function gatewayConfig(env: Env, privateKey: string) {
  const router = env.TEMPERANCE_GATEWAY_ROUTER?.trim()
    ? env.TEMPERANCE_GATEWAY_ROUTER.split(",").map((s) => s.trim())
    : undefined;
  if (router && router.length !== 3)
    throw new Error(
      "TEMPERANCE_GATEWAY_ROUTER is lan_interface,lan_address,uplink",
    );
  // The dashboard host must resolve and stay reachable while a device is blocked.
  const management = [env.TEMPERANCE_PUBLIC_URL, env.TEMPERANCE_VPN_ENDPOINT]
    .map((v) => (v ? hostname(v) : ""))
    .filter((h) => h && !isIPv4(h) && h !== "localhost");
  const host = env.HOSTNAME;
  const web = `${host && isIPv4(host) && host !== "0.0.0.0" ? host : "127.0.0.1"}:${env.PORT || 3000}`;
  let publicPort: number | null = null;
  try {
    publicPort = Number(
      vpnEndpoint(env.TEMPERANCE_VPN_ENDPOINT ?? "").split(":")[1],
    );
  } catch {
    // Without an endpoint the router maps the listen port.
  }
  const ap = accessPoint(env.TEMPERANCE_GATEWAY_AP);
  const dnsSetting = env.TEMPERANCE_GATEWAY_HOME_DNS?.trim();
  const homeDns =
    dnsSetting === "off"
      ? null
      : dnsSetting || (ap ? `${ap.address}:53` : null);
  const lan = (env.TEMPERANCE_GATEWAY_LAN_NETWORKS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ap) {
    const cidr = `${ap.address}/${ap.prefix}`;
    if (!lan.includes(cidr)) lan.push(cidr);
  }
  return {
    listen: env.TEMPERANCE_GATEWAY_LISTEN,
    private_key: privateKey,
    dns_upstream: env.TEMPERANCE_GATEWAY_DNS_UPSTREAM || "1.1.1.1:53",
    management_domains: [...new Set(management)],
    web,
    home_dns: homeDns,
    lan_networks: lan,
    router: router
      ? {
          lan_interface: router[0],
          lan_address: router[1],
          uplink: router[2],
        }
      : null,
    public_port: publicPort,
    // Children's devices setting up, and parent phones, reach the dashboard over the WireGuard port.
    remote: env.TEMPERANCE_FORWARD_SECRET
      ? {
          key_file: path.join(dataDir(env), "parent.key"),
          secret: env.TEMPERANCE_FORWARD_SECRET,
          target: `http://${web}`,
          parents: env.TEMPERANCE_REMOTE_PARENTS !== "off",
        }
      : null,
    ap: ap ? { ...ap, dns: dnsSetting !== "off" } : null,
    destinations_file: path.join(dataDir(env), "destinations.json"),
  };
}

// Every save rewrites the whole household document, which wears out SD cards.
const SAVE_INTERVAL_MS = 60_000;

/** Activity drained from the gateway but not yet saved. */
export interface PendingActivity {
  batches: unknown[];
  savedAt: number;
}

function accountPending(state: State, pending: PendingActivity) {
  pending.batches = pending.batches.filter((batch) => {
    // A rejected batch must never keep the policy from refreshing.
    try {
      account(state, batch);
      return true;
    } catch (error) {
      console.error("Gateway activity rejected", error);
      return false;
    }
  });
}

/** Report usage since the last sync, then hand the gateway a fresh policy. */
export async function syncGateway(
  handle: GatewayHandle,
  repo: Repository,
  pending: PendingActivity = { batches: [], savedAt: 0 },
  saveIntervalMs = SAVE_INTERVAL_MS,
) {
  const batch = JSON.parse(handle.drainActivity());
  let { state } = await repo.read();
  const urgent =
    !!batch.network ||
    (!!batch.remote && batch.remote.pin !== state.remote_pin);
  if (urgent || batch.activity?.length || batch.history?.length)
    pending.batches.push(batch);
  if (urgent || Date.now() - pending.savedAt >= saveIntervalMs) {
    state = await mutate(repo, (s) => {
      accountPending(s, pending);
      gatewaySeen(s);
      return s;
    });
    pending.batches = [];
    pending.savedAt = Date.now();
  } else {
    // Budgets must count unsaved minutes, so policy comes from a copy that includes them.
    accountPending(state, pending);
  }
  handle.applyState(JSON.stringify(gatewayState(state)));
  const health = gatewayHealth();
  health.applied_at = Date.now();
  health.syncs++;
}

export async function startGateway({
  env = process.env as Env,
  addon = loadAddon(),
  repo = repository(),
  intervalMs = 5000,
}: {
  env?: Env;
  addon?: GatewayAddon;
  repo?: Repository;
  intervalMs?: number;
} = {}) {
  const key = gatewayKey(env, addon);
  const publicKey = addon.publicKey(key);
  if (
    env.TEMPERANCE_VPN_PUBLIC_KEY &&
    env.TEMPERANCE_VPN_PUBLIC_KEY !== publicKey
  )
    throw new Error(
      "TEMPERANCE_VPN_PUBLIC_KEY does not match the embedded gateway's key; unset it",
    );
  // provisioning() hands this key to devices.
  env.TEMPERANCE_VPN_PUBLIC_KEY = publicKey;
  // The dashboard trusts parent requests carrying this; it never leaves the process.
  env.TEMPERANCE_FORWARD_SECRET ||= randomToken();
  fs.mkdirSync(dataDir(env), { recursive: true, mode: 0o700 });
  const handle = addon.GatewayHandle.start(
    JSON.stringify(gatewayConfig(env, key)),
  );
  const pending: PendingActivity = { batches: [], savedAt: 0 };
  let running: Promise<void> | undefined;
  const tick = () =>
    (running ??= syncGateway(handle, repo, pending)
      .catch(() => {
        gatewayHealth().sync_failures++;
        console.error(
          "Gateway policy sync failed; check database and gateway readiness.",
        );
      })
      .finally(() => (running = undefined)));
  await tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  const stop = () => {
    clearInterval(timer);
    process.off("exit", stop);
    handle.stop();
  };
  // Router mode leaves fail-closed firewall rules behind on exit.
  process.once("exit", stop);
  return { publicKey, tick, stop };
}
