#!/usr/bin/env node
// Plays the client storyboards on a real Temperance app against a fresh
// server and records each one as an MP4 in clients/storyboards/out/<platform>.
//
//   node clients/storyboards/run.mjs --platform android|ios|macos|windows [01 03] [--out dir]
//
// Storyboards run in file order on one server and one device, so later ones
// build on earlier ones (a "fresh" storyboard starts from a clean install).
// Naming storyboards records only those; earlier ones still run, unrecorded,
// to set up the state.
//
// A storyboard is { title, subtitle, fresh, steps }; title and subtitle may be
// per-platform like "say". Each step has one action:
//   say          caption; a string, or { default, android, ios, macos, windows }
//   show         point at a target and hold ("hold" in ms)
//   tap          point at a target, then tap it
//   type         { type: target, text, secret } types into a field; a secret
//                (password, pairing link) is pasted, never shown being typed
//   system       an OS prompt the app triggers ("allow-vpn")
//   refresh      the app picks up a server change on its own schedule; the
//                wait until the next "show" finds its target is cut from the video
//   wait         pause (ms)
// and server-side actions, which happen off screen:
//   profile      { name, ...fields } creates or updates a profile
//   user         { username, profile } a client account ({{password}})
//   used         minutes of today's time the enrolled device has used
//   approve      answers the pending request for that many minutes
//   reward       { kind, minutes | bedtime } for the enrolled device's profile
//   pairingLink  issues a parent pairing link as {{link}}
//   childRequest { name, profile, minutes, message } another child device asks for time
//
// Targets are ids from targets.json (the control on each platform; null skips
// the step there), literal text, or "/regex/flags". Strings may use {{device}},
// {{server}} (the dashboard's setup code), {{password}}, {{link}} and {{clock+N}} (HH:MM, N minutes after
// the run started, in five-minute steps).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compose } from "./lib/compose.mjs";
import { startServer } from "./lib/server.mjs";

// The stories fill an afternoon and evening, with time used since midnight
// and bedtimes before the next one. At any other time of day, rerun in a zone
// where it's afternoon; the drivers move the device's clock there too.
if (!process.env.TZ) {
  const hour = new Date().getHours();
  if (hour < 13 || hour >= 18) {
    // A named place, since the dashboard shows the household's time zone.
    const hourIn = (timeZone) => Number(new Intl.DateTimeFormat("en", { timeZone, hour: "numeric", hourCycle: "h23" }).format());
    const familiar = "Pacific/Honolulu America/Anchorage America/Los_Angeles America/Denver America/Chicago America/New_York America/Sao_Paulo Atlantic/Azores Europe/London Europe/Paris Europe/Athens Europe/Moscow Asia/Dubai Asia/Karachi Asia/Dhaka Asia/Bangkok Asia/Singapore Asia/Tokyo Australia/Brisbane Pacific/Noumea Pacific/Auckland";
    const zones = [...familiar.split(" "), ...Intl.supportedValuesOf("timeZone").filter((z) => !z.startsWith("Etc/"))];
    const TZ = zones.find((z) => hourIn(z) === 16) ?? zones.find((z) => hourIn(z) >= 13 && hourIn(z) <= 18);
    console.log(`Playing the stories in ${TZ}, where it's afternoon.`);
    const child = spawnSync(process.execPath, process.argv.slice(1), { stdio: "inherit", env: { ...process.env, TZ } });
    process.exit(child.status ?? 1);
  }
}

const here = import.meta.dirname;
const web = resolve(here, "../../web");
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
const platform = option("--platform");
if (!["android", "ios", "macos", "windows"].includes(platform)) {
  console.error("Choose --platform android, ios, macos or windows");
  process.exit(1);
}
const out = resolve(option("--out") ?? join(here, "out", platform));
const keep = args.includes("--keep");
const only = args.filter((a) => !a.startsWith("--"));
const files = readdirSync(here).filter((f) => /^\d\d-.*\.json$/.test(f)).sort();
const selected = (f) => !only.length || only.some((o) => f.startsWith(o));
if (!files.some(selected)) {
  console.error(`No storyboards match ${only.join(", ")}`);
  process.exit(1);
}
const targets = JSON.parse(readFileSync(join(here, "targets.json"), "utf8"));
const log = (...m) => console.log(`[${platform}]`, ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const driver = (await import(`./drivers/${platform}.mjs`)).default({ log, here });
mkdirSync(join(here, "out"), { recursive: true });
const work = mkdtempSync(join(join(here, "out"), `.work-${platform}-`));
const vars = { device: driver.noun, password: `riley-${randomBytes(6).toString("hex")}` };
const started = new Date(Math.ceil(Date.now() / 300e3) * 300e3);
let server;

function fill(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
    const clock = /^clock\+(\d+)$/.exec(expr);
    if (clock) {
      const t = new Date(started.getTime() + Number(clock[1]) * 60e3);
      return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    }
    if (!(expr in vars)) throw new Error(`Unknown template {{${expr}}}`);
    return vars[expr];
  });
}
const fillAll = (v) =>
  Array.isArray(v) ? v.map(fillAll) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillAll(x)])) : fill(v);
const pattern = (s) => {
  const m = /^\/(.+)\/([a-z]*)$/.exec(s);
  return m ? new RegExp(m[1], m[2]) : null;
};
/** A platform locator, or null when the step doesn't apply on this platform. */
function target(spec) {
  let t = spec;
  if (typeof spec === "string" && spec in targets) {
    t = targets[spec][platform];
    if (t === undefined) throw new Error(`${spec} has no ${platform} entry in targets.json`);
    if (t === null) return null;
  }
  if (typeof t === "string") t = pattern(fill(t)) ? { regex: pattern(fill(t)) } : { text: fill(t) };
  else t = { ...t, ...(t.regex ? { regex: pattern(t.regex) } : {}), ...(t.text ? { text: fill(t.text) } : {}) };
  return t;
}
const caption = (say) => fill(typeof say === "string" ? say : (say[platform] ?? say.default));

// Server-side state the storyboards refer to.
async function profileByName(name) {
  const p = (await server.state()).profiles.find((p) => p.name === name);
  if (!p) throw new Error(`No profile ${name}`);
  return p;
}
async function enrolled() {
  const s = await server.state();
  const riley = s.profiles.find((p) => p.name === "Riley");
  const device = s.devices.filter((d) => d.profile_id === riley?.id && d.kind !== "home" && !/tablet/.test(d.name)).at(-1);
  if (!device) throw new Error("No enrolled device for Riley");
  return { device, profile: riley };
}
let backfill = 0;
const serverSteps = {
  async profile(spec) {
    const existing = (await server.state()).profiles.find((p) => p.name === spec.name);
    await server.call("/api/profiles", { ...existing, ...spec });
  },
  async user({ username, profile }) {
    const p = await profileByName(profile);
    await server.call("/api/users", { username, password: vars.password, profile_id: p.id });
  },
  async used(minutes) {
    const { device, profile } = await enrolled();
    const need = minutes - profile.used;
    if (need <= 0) return;
    // Minutes from early this morning, which the live gateway never reports.
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const first = Math.floor(midnight.getTime() / 60e3) + 30 + backfill;
    backfill += need;
    await server.call(
      "/v1/gateway/activity",
      { activity: Array.from({ length: need }, (_, i) => ({ device_id: device.id, minute: first + i })) },
      server.gatewayToken,
    );
  },
  async approve(minutes) {
    const s = await server.state();
    const r = s.requests.findLast((r) => r.status === "pending" && r.minutes === minutes);
    if (!r) throw new Error(`No pending request for ${minutes} minutes`);
    await server.call("/api/requests", { id: r.id, approve: true });
  },
  async reward(spec) {
    const { profile } = await enrolled();
    await server.call("/api/rewards", { profile_id: profile.id, ...spec });
  },
  async pairingLink() {
    vars.link = (await server.call("/api/parents/pairing", {})).link;
  },
  async childRequest({ name, minutes, message }) {
    const login = await server.call(
      "/v1/device/login",
      { username: "riley", password: vars.password, name, public_key: randomBytes(32).toString("base64") },
      "",
    );
    await server.call("/v1/device/requests", { minutes, message }, login.token);
  },
};

async function play(file, record) {
  const board = JSON.parse(readFileSync(join(here, file), "utf8"));
  log(`${record ? "recording" : "preparing"} ${file}`);
  if (board.fresh) await driver.reset();
  else await driver.launch();
  // Filled as they run: earlier steps can set templates such as {{link}}.
  const steps = board.steps;
  let i = 0;
  // Server setup before the first on-screen step happens before recording.
  for (; i < steps.length; i++) {
    const step = fillAll(steps[i]);
    const kind = Object.keys(step).find((k) => k in serverSteps);
    if (!kind) break;
    await serverSteps[kind](step[kind], step);
  }
  const timeline = [];
  let t0 = 0;
  const now = () => (Date.now() - t0) / 1000;
  // Unrecorded runs still give the app a moment between steps.
  const pause = (ms) => sleep(record ? ms : Math.min(ms, 500));
  let cutFrom = null;
  const raw = join(work, file.replace(/\.json$/, ".mp4"));
  if (record) t0 = await driver.startRecording(raw);

  const point = async (t, hold, opts = {}) => {
    const restore = driver.reveal ? await driver.reveal(t) : null;
    const rect = await driver.find(t, cutFrom !== null || opts.long ? 75000 : 20000);
    if (cutFrom !== null) {
      timeline.push({ kind: "cut", from: cutFrom, to: Math.max(cutFrom, now() - 0.5) });
      cutFrom = null;
    }
    if (record) timeline.push({ kind: "ring", at: now(), until: now() + hold / 1000, rect });
    await pause(hold);
    return { rect, restore };
  };
  const actions = {
    async say(text, step) {
      const words = caption(text);
      if (record) timeline.push({ kind: "caption", at: now(), text: words });
      await pause(step.hold ?? Math.max(2400, words.length * 60));
    },
    async show(spec, step) {
      const t = target(spec);
      if (!t) return;
      const { restore } = await point(t, step.hold ?? 1800);
      await restore?.();
    },
    async tap(spec) {
      const t = target(spec);
      if (!t) return;
      if (t.close) return driver.close(t.close);
      const { rect } = await point(t, 800);
      await driver.tapAt(rect, t);
      await sleep(900);
    },
    async type(spec, step) {
      const t = target(spec);
      if (!t) return;
      const { rect } = await point(t, 500);
      const from = now();
      await driver.type(rect, step.text, { secret: step.secret, target: t });
      // A secret is pasted; where the driver can only type it, the typing is cut.
      if (record && step.secret && driver.typesSecrets) timeline.push({ kind: "cut", from: from + 0.4, to: now() - 0.2, quiet: true });
      await pause(400);
    },
    async system(name) {
      const rect = await driver.system(name);
      if (!rect) return;
      if (record) timeline.push({ kind: "ring", at: now(), until: now() + 0.9, rect });
      await pause(900);
      await driver.tapAt(rect);
      await sleep(1200);
    },
    async refresh() {
      cutFrom = now();
      if (driver.refresh) await driver.refresh();
    },
    wait: (ms) => pause(ms),
  };

  for (; i < steps.length; i++) {
    const step = fillAll(steps[i]);
    const kind = Object.keys(step).find((k) => k in actions || k in serverSteps);
    if (!kind) throw new Error(`${file} step ${i + 1}: no known action`);
    try {
      if (kind in serverSteps) await serverSteps[kind](step[kind], step);
      else await actions[kind](step[kind], step);
    } catch (error) {
      if (record) await driver.stopRecording().catch(() => {});
      throw new Error(`${file} step ${i + 1} (${kind}): ${error.message}`, { cause: error });
    }
  }
  if (!record) return;
  await pause(1500);
  const end = now();
  await driver.stopRecording();
  if (driver.fetch) await driver.fetch(raw);
  mkdirSync(out, { recursive: true });
  const mp4 = join(out, file.replace(/\.json$/, ".mp4"));
  writeFileSync(join(work, file.replace(/\.json$/, ".timeline.json")), JSON.stringify({ end, timeline }, null, 1));
  await compose({
    raw,
    mp4,
    timeline,
    end,
    title: caption(board.title),
    subtitle: board.subtitle && caption(board.subtitle),
    platform,
    frame: driver.frame,
  });
  log(`wrote ${mp4}`);
}

let failed = false;
try {
  server = await startServer({ web, work, origin: driver.origin, endpointHost: driver.endpointHost, log });
  vars.server = server.home;
  await driver.setup({ server, work });
  const last = files.findLastIndex(selected);
  for (const file of files.slice(0, last + 1)) await play(file, selected(file));
} catch (error) {
  failed = true;
  console.error(error.stack ?? error.message);
  if (server) writeFileSync(join(work, "server.log"), server.output());
  console.error(`Work files kept in ${work}`);
} finally {
  await driver.teardown().catch((e) => console.error(e.message));
  await server?.stop();
  if (!failed && !keep) rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
