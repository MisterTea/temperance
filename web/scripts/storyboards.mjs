#!/usr/bin/env node
// Plays the storyboards in web/storyboards against a fresh Temperance server
// and records each one as an MP4 in web/storyboards/out.
//
//   npm run build && npm run storyboards [-- 03 04] [--headed] [--out dir]
//
// Storyboards run in file order and share one server, so later ones build on
// the family set up by earlier ones. Naming storyboards records only those;
// the others still run, quickly and unrecorded, to set up the state.
//
// A storyboard is { title, subtitle, start = "/", signedIn = true, steps }. The
// title card plays over the start page. Each step has one action key:
//   title, say                    full-screen card / caption ("hold" in ms)
//   goto, reload, wait            navigation and pauses
//   show, click, fill, check,     act on a target, pointing at it first
//   uncheck, select, press        (fill: "value"; select: "option" label or
//                                  "optionValue"; press: "key")
//   deviceSignIn                  { as, username, password, name } signs in a
//                                 simulated Temperance app on a phone
//   device                        { as, path, body } calls a device API
//   gateway                       body for /v1/gateway/activity
//   browse                        { as, minutes, buckets, sites } simulates
//                                 browsing reported by the gateway
//   admin                         { path, body } calls a dashboard API
//   parentPair                    { as, name } pairs a simulated parent phone
//                                 the way the gateway does after a QR scan
//   parentView                    alias: reloads the page as that parent
//                                 phone sees it through the gateway (null:
//                                 back to the signed-in admin)
// Targets: { role, name } | { label } | { text } | { css } | { section } plus
// optional exact, within, hasText, has and nth. Strings like "/^Teen/" are
// regular expressions. Strings in step data may use {{admin}}, {{now}},
// {{now-60}} and {{device:alias}}.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { shiftClock } from "../e2e/clock.mjs";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const boards = join(web, "storyboards");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
const out = resolve(option("--out") ?? join(boards, "out"));
const headed = flag("--headed");
const only = args.filter((a) => !a.startsWith("--"));
const now = process.env.STORYBOARD_NOW ?? "2026-06-10T16:30:00-05:00";
const offset = Date.parse(now) - Date.now();
const size = { width: 1280, height: 720 };
const ADMIN = "storyboard-admin-".padEnd(48, "a");
const GATEWAY = "storyboard-gateway-".padEnd(48, "g");

if (!existsSync(join(web, ".next/standalone/server.js"))) {
  console.error("Build the app first: npm run build");
  process.exit(1);
}
if (spawnSync("ffmpeg", ["-version"]).status !== 0) {
  console.error("ffmpeg is required to make MP4s");
  process.exit(1);
}

const files = readdirSync(boards)
  .filter((f) => f.endsWith(".json"))
  .sort();
const selected = (file) =>
  !only.length || only.some((o) => file.startsWith(o) || file === `${o}.json`);
if (!files.some(selected)) {
  console.error(`No storyboards match ${only.join(", ")}`);
  process.exit(1);
}

const freePort = () =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.on("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

const work = mkdtempSync(join(tmpdir(), "temperance-storyboards-"));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["scripts/start.cjs"], {
  cwd: web,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    NODE_OPTIONS: "--import=./e2e/clock.mjs",
    E2E_CLOCK_OFFSET_MS: String(offset),
    TEMPERANCE_DATABASE_URL: `sqlite:${join(work, "temperance.sqlite")}`,
    TEMPERANCE_DATA_DIR: work,
    TEMPERANCE_ADMIN_PASSWORD: ADMIN,
    TEMPERANCE_GATEWAY_TOKEN: GATEWAY,
    TEMPERANCE_PUBLIC_URL: base,
    TEMPERANCE_VPN_ENDPOINT: "jordanshouse.ddnsfree.com:51820",
    TEMPERANCE_VPN_PUBLIC_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    TEMPERANCE_TIMEZONE: "America/Chicago",
  },
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

let browser, heartbeat;
const cleanup = async () => {
  clearInterval(heartbeat);
  await browser?.close().catch(() => {});
  server.kill();
  rmSync(work, { recursive: true, force: true });
};
process.on("SIGINT", () => cleanup().then(() => process.exit(130)));

async function call(path, body, token, method = body ? "POST" : "GET") {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) break;
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server did not start:\n${log}`);
}

const devices = {};
const parents = {};
const clock = () => Math.floor((Date.now() + offset) / 1000);

function fill(value) {
  if (Array.isArray(value)) return value.map(fill);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, fill(v)]),
    );
  if (typeof value !== "string") return value;
  const one = (expr) => {
    if (expr === "admin") return ADMIN;
    const time = /^now(?:([+-])(\d+))?$/.exec(expr);
    if (time)
      return clock() + (time[1] === "-" ? -1 : 1) * Number(time[2] ?? 0);
    const dev = /^device:(.+)$/.exec(expr);
    if (dev) {
      if (!devices[dev[1]]) throw new Error(`Unknown device ${dev[1]}`);
      return devices[dev[1]].id;
    }
    throw new Error(`Unknown template {{${expr}}}`);
  };
  const whole = /^\{\{([^}]+)\}\}$/.exec(value);
  if (whole) return one(whole[1]);
  return value.replace(/\{\{([^}]+)\}\}/g, (_, e) => String(one(e)));
}

const pattern = (s) => {
  const m = typeof s === "string" && /^\/(.+)\/([a-z]*)$/.exec(s);
  return m ? new RegExp(m[1], m[2]) : s;
};

function locate(scope, t) {
  if (typeof t === "string") t = { text: t };
  if (t.within) scope = locate(scope, t.within);
  const exact = t.exact;
  let loc;
  if (t.role) loc = scope.getByRole(t.role, { name: pattern(t.name), exact });
  else if (t.label) loc = scope.getByLabel(pattern(t.label), { exact });
  else if (t.text) loc = scope.getByText(pattern(t.text), { exact });
  else if (t.section)
    loc = scope.locator("section", {
      has: scope.getByRole("heading", { name: pattern(t.section), exact }),
    });
  else if (t.css) loc = scope.locator(t.css);
  else throw new Error(`Bad target ${JSON.stringify(t)}`);
  if (t.hasText) loc = loc.filter({ hasText: pattern(t.hasText) });
  if (t.has) loc = loc.filter({ has: locate(scope, t.has) });
  return loc.nth(t.nth ?? 0);
}

// Captions, title cards and the pointer live in one overlay that ignores
// pointer events, so Playwright's clicks still reach the page beneath it. The
// overlay is a popover so it can be raised above modal dialogs, which
// otherwise cover everything in the top layer.
function paint(view) {
  let root = document.getElementById("sb-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "sb-root";
    root.popover = "manual";
    root.innerHTML = `<style>
      #sb-root{position:fixed;inset:0;width:auto;height:auto;margin:0;padding:0;border:0;background:transparent;overflow:visible;color:inherit;z-index:2147483647;pointer-events:none;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
      #sb-caption{position:absolute;left:50%;bottom:28px;transform:translateX(-50%);max-width:78%;padding:14px 22px;border-radius:14px;background:rgba(23,27,52,.88);color:#fff;font-size:22px;line-height:1.35;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.25);transition:opacity .3s}
      #sb-caption.top{top:28px;bottom:auto}
      #sb-title{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:linear-gradient(135deg,#1b214b,#2B3675);color:#fff;text-align:center;transition:opacity .5s}
      #sb-title b{font-size:52px;letter-spacing:-.02em}
      #sb-title span{font-size:26px;opacity:.85;max-width:70%}
      #sb-title small{font-size:18px;opacity:.6;text-transform:uppercase;letter-spacing:.2em}
      #sb-pointer{position:absolute;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;background:rgba(255,196,0,.55);border:2px solid #fff;box-shadow:0 0 0 2px rgba(0,0,0,.35);transition:left .45s ease,top .45s ease,opacity .3s}
      #sb-ring{position:absolute;border:3px solid #ffc400;border-radius:10px;box-shadow:0 0 0 6px rgba(255,196,0,.25)}
      </style><div id="sb-ring"></div><div id="sb-pointer"></div><div id="sb-caption"></div><div id="sb-title"><small></small><b></b><span></span></div>`;
    document.documentElement.append(root);
  }
  if (
    document.querySelector("dialog[open]") ||
    !root.matches(":popover-open")
  ) {
    if (root.matches(":popover-open")) root.hidePopover();
    root.showPopover();
  }
  const caption = root.querySelector("#sb-caption");
  if (caption.textContent !== (view.caption ?? "")) {
    caption.textContent = view.caption ?? "";
    caption.classList.remove("top");
  }
  caption.style.opacity = view.caption ? "1" : "0";
  // A caption stays where it is until it changes, unless it would cover the
  // element being shown (or the last one shown, which a new caption usually
  // talks about); then it moves to the other edge of the screen.
  const target = view.ring ?? view.focus;
  if (view.caption && target) {
    const covers = () => {
      const c = caption.getBoundingClientRect();
      const r = target;
      return (
        c.top < r.y + r.height + 12 &&
        c.bottom > r.y - 12 &&
        c.left < r.x + r.width + 12 &&
        c.right > r.x - 12
      );
    };
    if (covers()) {
      caption.classList.toggle("top");
      if (covers()) caption.classList.toggle("top");
    }
  }
  const title = root.querySelector("#sb-title");
  title.style.opacity = view.title ? "1" : "0";
  if (view.title) {
    title.querySelector("small").textContent = "Temperance";
    title.querySelector("b").textContent = view.title;
    title.querySelector("span").textContent = view.subtitle ?? "";
  }
  const pointer = root.querySelector("#sb-pointer");
  pointer.style.opacity = view.pointer ? "1" : "0";
  if (view.pointer) {
    pointer.style.left = `${view.pointer.x}px`;
    pointer.style.top = `${view.pointer.y}px`;
  }
  const ring = root.querySelector("#sb-ring");
  // Chromium can leave a faded-out ring on screen after the page beneath
  // re-renders, so the ring is removed from layout instead.
  ring.style.display = view.ring ? "block" : "none";
  if (view.ring)
    Object.assign(ring.style, {
      left: `${view.ring.x - 6}px`,
      top: `${view.ring.y - 6}px`,
      width: `${view.ring.width + 12}px`,
      height: `${view.ring.height + 12}px`,
    });
}

async function play(file, page, record) {
  const board = JSON.parse(readFileSync(join(boards, file), "utf8"));
  const view = { pointer: { x: size.width / 2, y: size.height / 2 } };
  const pause = (ms) => (record ? page.waitForTimeout(ms) : Promise.resolve());
  const draw = () => page.evaluate(paint, view).catch(() => {});
  const settle = async () => {
    await page.waitForLoadState("networkidle").catch(() => {});
    await draw();
    await pause(500);
  };
  const point = async (loc, hold = 700) => {
    await loc.waitFor({ state: "visible", timeout: 15000 });
    if (!record) return;
    await loc.evaluate((el) =>
      el.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
    await pause(500);
    const box = await loc.boundingBox();
    if (box) {
      view.pointer = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      view.ring = view.focus = box;
    }
    await draw();
    await pause(hold);
  };
  const done = async () => {
    view.ring = null;
    await draw();
    await settle();
  };

  const actions = {
    async title(text, step) {
      Object.assign(view, {
        title: text,
        subtitle: step.subtitle,
        caption: "",
      });
      await draw();
      await pause(step.hold ?? 3200);
      view.title = null;
      await draw();
      await pause(500);
    },
    async say(text, step) {
      view.caption = fill(text);
      await draw();
      await pause(step.hold ?? Math.max(2200, view.caption.length * 55));
    },
    async goto(path) {
      view.focus = null;
      await page.goto(base + path);
      await settle();
    },
    async reload() {
      view.focus = null;
      await page.reload();
      await settle();
    },
    wait: (ms) => pause(ms),
    async show(target, step) {
      await point(locate(page, target), step.hold ?? 1600);
      await done();
    },
    async click(target) {
      const loc = locate(page, target);
      await point(loc);
      await loc.click();
      await done();
    },
    async fill(target, step) {
      const loc = locate(page, target);
      const value = String(fill(step.value));
      await point(loc, 400);
      const type = await loc.getAttribute("type");
      if (!record || ["time", "date", "select"].includes(type))
        await loc.fill(value);
      else {
        await loc.fill("");
        await loc.pressSequentially(value, { delay: 45 });
      }
      await done();
    },
    async check(target) {
      const loc = locate(page, target);
      await point(loc);
      await loc.check();
      await done();
    },
    async uncheck(target) {
      const loc = locate(page, target);
      await point(loc);
      await loc.uncheck();
      await done();
    },
    async select(target, step) {
      const loc = locate(page, target);
      await point(loc);
      await loc.selectOption(
        step.optionValue !== undefined
          ? { value: step.optionValue }
          : { label: step.option },
      );
      await done();
    },
    async press(target, step) {
      const loc = locate(page, target);
      await point(loc);
      await loc.press(step.key);
      await done();
    },
    async deviceSignIn(spec) {
      const { as, ...login } = fill(spec);
      const public_key = randomBytes(32).toString("base64");
      const res = await call("/v1/device/login", { ...login, public_key }, "");
      devices[as] = { id: res.device_id, token: res.token };
    },
    async device(spec) {
      const { as, path, body } = fill(spec);
      await call(path, body, devices[as].token);
    },
    async gateway(body) {
      await call("/v1/gateway/activity", fill(body), GATEWAY);
    },
    async browse(spec) {
      const { as, minutes = 0, buckets = ["total"], sites = [] } = fill(spec);
      const id = devices[as].id;
      const minute = Math.floor(clock() / 60);
      await call(
        "/v1/gateway/activity",
        {
          active_devices: [id],
          activity: Array.from({ length: minutes }, (_, i) => ({
            device_id: id,
            minute: minute - minutes + i,
            buckets,
          })),
          history: sites.map((s, i) => ({
            id: `storyboard-${id}-${minute}-${i}`,
            device_id: id,
            at: clock() - (sites.length - i) * 97,
            blocked: false,
            reason: s.blocked ? "blocked" : "allowed",
            ...s,
          })),
        },
        GATEWAY,
      );
    },
    async admin(spec) {
      const { path, body } = fill(spec);
      await call(path, body, ADMIN);
    },
    async parentPair(spec) {
      const { as, name } = fill(spec);
      const { link } = await call("/api/parents/pairing", {}, ADMIN);
      const { code } = JSON.parse(
        Buffer.from(link.split("#")[1], "base64url").toString(),
      );
      const key = randomBytes(32).toString("base64url");
      const res = await call(
        "/v1/gateway/parents/pair",
        { code, name, key },
        GATEWAY,
      );
      parents[as] = res.id;
    },
    // The standalone gateway forwards parent requests with its own token.
    async parentView(as) {
      if (as && !parents[as]) throw new Error(`Unknown parent ${as}`);
      await page.setExtraHTTPHeaders(
        as
          ? {
              "x-temperance-forwarded": GATEWAY,
              "x-temperance-parent": parents[as],
            }
          : {},
      );
      view.focus = null;
      await page.reload();
      await settle();
    },
  };

  const run = async (i) => {
    const step = board.steps[i];
    const kind = Object.keys(step).find((k) => k in actions);
    if (!kind) throw new Error(`${file} step ${i + 1}: no known action`);
    try {
      await actions[kind](step[kind], step);
    } catch (error) {
      throw new Error(`${file} step ${i + 1} (${kind}): ${error.message}`, {
        cause: error,
      });
    }
  };
  console.log(`${record ? "Recording" : "Preparing"} ${file}`);
  // Off-screen setup (a phone or the gateway reporting in) happens before the
  // start page loads so the first frame already shows its effect.
  const offscreen = [
    "deviceSignIn",
    "device",
    "gateway",
    "browse",
    "admin",
    "parentPair",
  ];
  let i = 0;
  for (; i < board.steps.length; i++) {
    if (!offscreen.some((k) => k in board.steps[i])) break;
    await run(i);
  }
  await page.goto(base + (board.start ?? "/"));
  await page.waitForLoadState("networkidle").catch(() => {});
  Object.assign(view, { title: board.title, subtitle: board.subtitle });
  await draw();
  titleShown = Date.now();
  await actions.title(board.title, { subtitle: board.subtitle });
  for (; i < board.steps.length; i++) await run(i);
  view.caption = "";
  view.pointer = null;
  await draw();
  await pause(800);
  return board;
}

// Set when a storyboard's title card first covers the page; the recording is
// trimmed to start there so the page never flashes up before the title.
let titleShown;

function toMp4(webm, mp4, skip) {
  const res = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-i",
      webm,
      "-ss",
      skip.toFixed(2),
      "-vf",
      "fps=30,format=yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-movflags",
      "+faststart",
      mp4,
    ],
    { stdio: "inherit" },
  );
  if (res.status !== 0) throw new Error(`ffmpeg failed for ${mp4}`);
}

let failed = false;
try {
  await waitForServer();
  // The gateway checks in on its own schedule; keep it looking online.
  const beat = () =>
    call("/v1/gateway/state", undefined, GATEWAY).catch(() => {});
  await beat();
  heartbeat = setInterval(beat, 30000);
  mkdirSync(out, { recursive: true });
  browser = await chromium.launch({ headless: !headed });
  let session;
  for (const file of files) {
    const record = selected(file);
    const board = JSON.parse(readFileSync(join(boards, file), "utf8"));
    const context = await browser.newContext({
      viewport: size,
      deviceScaleFactor: 1,
      storageState: board.signedIn === false ? undefined : session,
      ...(record ? { recordVideo: { dir: work, size } } : {}),
    });
    await context.addInitScript(shiftClock, offset);
    const page = await context.newPage();
    const opened = Date.now();
    titleShown = undefined;
    page.on("dialog", (d) => d.accept());
    try {
      await play(file, page, record);
      session = await context.storageState();
    } finally {
      const video = page.video();
      await context.close();
      if (record && video) {
        const mp4 = join(out, file.replace(/\.json$/, ".mp4"));
        const skip = titleShown ? (titleShown - opened) / 1000 + 0.2 : 0;
        toMp4(await video.path(), mp4, skip);
        console.log(`  wrote ${mp4}`);
      }
    }
  }
} catch (error) {
  failed = true;
  console.error(error.message);
} finally {
  await cleanup();
}
process.exit(failed ? 1 : 0);
