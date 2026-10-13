// A fresh Temperance server with its embedded WireGuard gateway, plus the admin
// calls storyboards make. The client under test signs in with the dashboard's
// setup code and reaches home only through the gateway's UDP port.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";

const freePort = () =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.on("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * origin: "local" (the dashboard on http://127.0.0.1:<port>) or "tunnel" (also
 * on a Cloudflare quick tunnel, where a driver can mount its own harness).
 * endpointHost: how the client reaches this machine's UDP gateway.
 */
export async function startServer({ web, work, origin, endpointHost, log = () => {} }) {
  const standalone = join(web, ".next/standalone");
  if (!existsSync(join(standalone, "server.js")))
    throw new Error("Build the web app first: cd web && npm run build:gateway && npm run build");
  cpSync(join(web, ".next/static"), join(standalone, ".next/static"), { recursive: true });
  const port = await freePort();
  const wgPort = await freePort();
  const admin = `storyboard-${randomBytes(12).toString("hex")}`;
  const gatewayToken = randomBytes(24).toString("hex");
  const children = [];
  // Also when starting fails part way: a leftover cloudflared keeps running.
  process.on("exit", () => children.forEach((c) => c.kill()));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => process.exit(130));
  let output = "";
  const track = (p, name) => {
    children.push(p);
    p.stdout?.on("data", (d) => (output += d));
    p.stderr?.on("data", (d) => (output += d));
    p.on("exit", (code) => code && log(`${name} exited with ${code}`));
    return p;
  };

  let publicUrl;
  if (origin === "local") publicUrl = `http://127.0.0.1:${port}`;
  let tunnel;
  // A driver can serve its own requests under /__storyboard/ on the server's
  // public host, which a child's VPN lets through even while it's paused.
  const mounts = {};
  if (origin === "tunnel") {
    const front = http.createServer((req, res) => {
      const mount = Object.keys(mounts).find((m) => req.url.startsWith(m));
      if (mount) return mounts[mount](req, res);
      const upstream = http.request({ host: "127.0.0.1", port, path: req.url, method: req.method, headers: req.headers }, (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      });
      upstream.on("error", () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    });
    const frontPort = await freePort();
    await new Promise((ok) => front.listen(frontPort, "127.0.0.1", ok));
    children.push({ kill: () => front.close() });
    tunnel = track(spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${frontPort}`]), "cloudflared");
    for (let i = 0; i < 120 && !publicUrl; i++) {
      publicUrl = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(output)?.[0];
      await sleep(500);
    }
    if (!publicUrl) throw new Error(`cloudflared gave no URL:\n${output}`);
  }

  const server = track(
    spawn(process.execPath, ["server.js"], {
      cwd: standalone,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: "production",
        HOSTNAME: "127.0.0.1",
        PORT: String(port),
        TEMPERANCE_DATA_DIR: work,
        TEMPERANCE_DATABASE_URL: `sqlite:${join(work, "temperance.sqlite")}`,
        TEMPERANCE_ADMIN_PASSWORD: admin,
        TEMPERANCE_GATEWAY_TOKEN: gatewayToken,
        TEMPERANCE_PUBLIC_URL: publicUrl,
        TEMPERANCE_HOUSEHOLD_NAME: "The Parkers",
        TEMPERANCE_VPN_ENDPOINT: `${endpointHost}:${wgPort}`,
        TEMPERANCE_GATEWAY_LISTEN: `127.0.0.1:${wgPort}`,
        TEMPERANCE_TIMEZONE: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    }),
    "server",
  );

  const base = `http://127.0.0.1:${port}`;
  async function call(path, body, token = admin, method = body ? "POST" : "GET") {
    const res = await fetch(base + path, {
      method,
      headers: {
        origin: publicUrl,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  }

  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {}
    if (server.exitCode !== null || i > 120) throw new Error(`Server did not start:\n${output}`);
    await sleep(500);
  }
  if (tunnel) {
    // Asking the system resolver before the name is published caches "no such host" for minutes.
    const host = new URL(publicUrl).hostname;
    for (let i = 0; i < 60; i++) {
      const dig = spawnSync("dig", ["+short", host, "@1.1.1.1"], { encoding: "utf8" });
      if (dig.error || /^\d/m.test(dig.stdout)) break;
      await sleep(1000);
    }
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${publicUrl}/healthz`)).ok) break;
      } catch {}
      if (i > 120) throw new Error(`${publicUrl} is not reachable`);
      await sleep(1000);
    }
  }
  for (let i = 0; !/Temperance gateway on udp/.test(output); i++) {
    if (i > 60) throw new Error(`The embedded gateway did not start:\n${output}`);
    await sleep(500);
  }
  await call("/api/setup/complete", {});
  // The setup code appears once the gateway has reported the key devices pin.
  let home;
  for (let i = 0; !(home = (await call("/api/state")).device_setup); i++) {
    if (i > 60) throw new Error(`The gateway never reported its key:\n${output}`);
    await sleep(500);
  }
  log(`server ${base}, devices use the gateway at ${endpointHost}:${wgPort}`);

  return {
    home,
    publicUrl,
    gatewayToken,
    mount: (prefix, handler) => (mounts[prefix] = handler),
    call,
    output: () => output,
    state: () => call("/api/state"),
    async stop() {
      for (const c of children.reverse()) c.kill();
      await sleep(300);
    },
  };
}
