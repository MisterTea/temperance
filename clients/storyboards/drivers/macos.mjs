// Drives the macOS SwiftUI app through cua-driver (accessibility actions;
// XCUITest on macOS needs an admin to enable Automation Mode) and records the
// screen with ffmpeg, cropped to the app window.
import { execFile, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apple = resolve(import.meta.dirname, "../../apple");
const BUNDLE = "org.temperance.mac";
// An ended session's label can't be reused.
const SESSION = `temperance-storyboard-${process.pid}`;

async function cua(tool, args = {}) {
  const { stdout } = await run("cua-driver", ["call", tool, JSON.stringify({ ...args, session: SESSION })], { maxBuffer: 1 << 26 }).catch((e) => {
    throw new Error(`${tool}: ${(e.stdout + e.stderr).replace(/\s+/g, " ").slice(0, 600)}`);
  });
  // The CLI leaves raw newlines inside strings.
  const result = JSON.parse(stdout.replace(/[\u0000-\u001f]/g, " "));
  if (result.isError || result.error) throw new Error(`${tool}: ${JSON.stringify(result).slice(0, 500)}`);
  return result;
}

function matches(e, t) {
  const label = e.label ?? "";
  const value = typeof e.value === "string" ? e.value : "";
  if (t.field) return /AXTextField|AXTextArea|AXComboBox/.test(e.role) && (label === t.field || e.placeholder === t.field);
  if (t.regex) return t.regex.test(label) || t.regex.test(value);
  return label === t.text || value === t.text;
}

export default function driver({ log, here }) {
  let app, ocr, pid, windowId, bounds, scale, screenIndex, recorder;

  async function windowOf() {
    for (let i = 0; i < 40; i++) {
      const { windows } = await cua("list_windows", { pid });
      const w = windows.find((w) => w.layer === 0 && w.is_on_screen);
      if (w) return w;
      await sleep(250);
    }
    throw new Error("The Temperance window did not appear");
  }

  async function place() {
    const screen = await cua("get_screen_size");
    scale = screen.scale ?? screen.scale_factor ?? 2;
    // Small enough to read in the video and clear of the Dock.
    const height = Math.min(660, screen.height - 160);
    const width = 540;
    bounds = { x: Math.round((screen.width - width) / 2), y: 60, width, height };
    const w = await windowOf();
    windowId = w.window_id;
    await cua("set_window_frame", { pid, window_id: windowId, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }).catch((e) => log(e.message));
    await cua("bring_to_front", { pid }).catch((e) => log(e.message));
    // The rings show what's used; the agent cursor would cover fields as they're typed in.
    await cua("set_agent_cursor_enabled", { enabled: false }).catch((e) => log(e.message));
    bounds = (await windowOf()).bounds;
  }

  async function launch() {
    const running = (await run("pgrep", ["-f", `${app}/Contents/MacOS/TemperanceMac`]).catch(() => ({ stdout: "" }))).stdout.trim();
    if (!running) {
      // Light, like the other platforms' recordings, whatever the Mac's own appearance.
      await run("open", ["-n", app, "--args", "-SimulatedVPN", "YES", "-NSRequiresAquaSystemAppearance", "YES"]);
      await sleep(2500);
    }
    pid = Number((await run("pgrep", ["-f", `${app}/Contents/MacOS/TemperanceMac`])).stdout.trim().split("\n")[0]);
    await place();
    await sleep(800);
  }

  async function snapshot() {
    const state = await cua("get_window_state", { pid, window_id: windowId, include_screenshot: false });
    return { state, elements: state.elements.filter((e) => e.depth > 0 && !/Menu/.test(e.role) && e.frame) };
  }

  const plain = (s) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').toLowerCase();
  const says = (s, t) => (t.regex ? t.regex.test(s) : plain(s).includes(plain(t.text)));

  /** Static text (only in the tree's markdown, without a frame), located by OCR. */
  async function readText(t) {
    const png = join(here, "out", ".mac-build", "window.png");
    const shot = await cua("get_window_state", { pid, window_id: windowId, include_accessibility_tree: false, max_image_dimension: 0, screenshot_out_file: png });
    const { stdout } = await run(ocr, [png]);
    const line = JSON.parse(stdout).find((l) => says(l.text, t));
    if (!line) return null;
    const k = 1 / (shot.screenshot_scale ?? scale);
    const wb = shot.window_bounds ?? bounds;
    return { x: (wb.x + line.x * k) * scale, y: (wb.y + line.y * k) * scale, width: line.w * k * scale, height: line.h * k * scale };
  }

  /** Pastes into a field, as a parent pastes a long link; typed, it would take many seconds. */
  async function paste(rect, text) {
    const pbcopy = (s) => new Promise((ok, fail) => spawn("pbcopy").on("error", fail).on("exit", ok).stdin.end(s));
    // SwiftUI ignores AXValue writes, so it's a real ⌘V; the clipboard's text is put back after.
    const saved = (await run("pbpaste").catch(() => ({ stdout: "" }))).stdout;
    await pbcopy(text);
    try {
      await cua("hotkey", { pid, element_token: rect.token, keys: ["cmd", "a"] });
      await cua("hotkey", { pid, element_token: rect.token, keys: ["cmd", "v"] });
      await sleep(300);
    } finally {
      await pbcopy(saved);
    }
  }

  /** Wheels the window's content toward a control outside it (the dashboard scrolls); false once it's in view. */
  async function scrollToward(f) {
    // Below the title bar and the dashboard's Done bar.
    const top = bounds.y + 96;
    const bottom = bounds.y + bounds.height - 24;
    if (f.y >= top && f.y + f.h <= bottom) return false;
    const distance = f.y < top ? top - f.y : f.y + f.h - bottom;
    // The wheel needs a fresh capture to place its window-local point.
    const shot = await cua("get_window_state", { pid, window_id: windowId, include_accessibility_tree: false, max_image_dimension: 0 });
    const k = shot.screenshot_scale ?? scale;
    await cua("scroll", {
      pid, window_id: windowId, x: Math.round((bounds.width / 2) * k), y: Math.round((bounds.height / 2) * k),
      direction: f.y < top ? "up" : "down", amount: Math.max(1, Math.min(8, Math.round(distance / 40))),
    });
    await sleep(350);
    return true;
  }

  async function find(t, timeout = 15000) {
    const end = Date.now() + timeout;
    let scrolls = 0;
    let settled = true;
    let lastY = null;
    for (;;) {
      const { state, elements } = await snapshot();
      const hit = elements.find((e) => matches(e, t) && e.frame.w > 0 && e.frame.h > 0);
      // A control that doesn't move with the wheel (the Done bar's own button) is where it stays.
      const moved = hit && hit.frame.y !== lastY;
      if (hit) lastY = hit.frame.y;
      if (hit && moved && scrolls < 25 && (await scrollToward(hit.frame))) {
        scrolls++;
        settled = false;
        continue;
      }
      // Wheel scrolling eases out; locate the control again once it stops.
      if (hit && !settled) {
        settled = true;
        await sleep(500);
        continue;
      }
      if (hit) {
        const f = hit.frame;
        return { x: f.x * scale, y: f.y * scale, width: f.w * scale, height: f.h * scale, token: hit.element_token };
      }
      if (!t.field && (state.tree_markdown ?? "").split("\n").some((l) => /AXStaticText/.test(l) && says(l, t))) {
        const rect = await readText(t);
        if (rect) return rect;
      }
      if (Date.now() > end) throw new Error(`Not on screen: ${JSON.stringify(t, (k, v) => (v instanceof RegExp ? String(v) : v))}`);
      await sleep(600);
    }
  }

  return {
    platform: "macos",
    noun: "Mac",
    origin: "tunnel",
    endpointHost: "127.0.0.1",
    get frame() {
      return { window: true, crop: { x: Math.round(bounds.x * scale), y: Math.round(bounds.y * scale), width: Math.round(bounds.width * scale), height: Math.round(bounds.height * scale) } };
    },

    async setup() {
      // A locked screen can't be recorded or driven, and it locks a while after the display sleeps.
      spawn("caffeinate", ["-d", "-w", String(process.pid)], { stdio: "ignore", detached: true }).unref();
      const derived = join(here, "out", ".mac-build");
      app = join(derived, "Build/Products/Debug/TemperanceMac.app");
      log("building the Mac app");
      mkdirSync(derived, { recursive: true });
      ocr = join(derived, "ocr");
      await run("swiftc", ["-O", "-o", ocr, resolve(import.meta.dirname, "macos-ocr.swift")]);
      await run("xcodegen", ["generate"], { cwd: apple });
      await run(
        "xcodebuild",
        ["build", "-project", "Temperance.xcodeproj", "-scheme", "TemperanceMac", "-configuration", "Debug", "-derivedDataPath", derived, "CODE_SIGNING_ALLOWED=NO", "-quiet"],
        { cwd: apple, maxBuffer: 1 << 26 },
      ).catch((e) => {
        if (!/exit code 0 but produced no further output/.test(e.stdout + e.stderr)) throw e;
      });
      if (!/granted/.test((await run("cua-driver", ["permissions", "status"]).catch(() => ({ stdout: "" }))).stdout)) {
        await run("open", ["-n", "-g", "-a", "CuaDriver", "--args", "serve"]);
        await sleep(3000);
      }
      const devices = await run("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]).catch((e) => e);
      screenIndex = /\[(\d+)\] Capture screen 0/.exec(devices.stderr)?.[1];
      if (screenIndex === undefined) throw new Error("No screen to capture");
    },

    async reset() {
      await run("pkill", ["-f", `${app}/Contents/MacOS/TemperanceMac`]).catch(() => {});
      await sleep(800);
      await run("defaults", ["delete", BUNDLE]).catch(() => {});
      for (const account of ["device", "parent"])
        await run("security", ["delete-generic-password", "-s", "org.temperance.identity", "-a", account]).catch(() => {});
      await launch();
    },

    launch,
    find,

    async tapAt(rect) {
      await cua("click", { pid, window_id: windowId, element_token: rect.token });
    },

    async type(rect, text, { secret } = {}) {
      if (secret) return paste(rect, text);
      // Text fields have no AXPress; typing at the token focuses the field.
      await cua("type_text", { pid, element_token: rect.token, text, delay_ms: 35 });
    },

    // Unsigned builds can't install the Network Extension; -SimulatedVPN stands in for it.
    async system() {
      return null;
    },

    async startRecording(file) {
      await cua("bring_to_front", { pid }).catch(() => {});
      // Park the pointer beside the window, outside the recorded crop; only moved, never clicked.
      const park = { x: (bounds.x + bounds.width + 120) * scale, y: (bounds.y + 200) * scale };
      await cua("move_cursor", { scope: "desktop", ...park }).catch((e) => log(e.message));
      recorder = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "avfoundation", "-capture_cursor", "1", "-framerate", "30", "-i", `${screenIndex}:none`,
        "-c:v", "h264_videotoolbox", "-b:v", "16M", "-pix_fmt", "yuv420p", file], { stdio: ["pipe", "ignore", "pipe"] });
      await sleep(1500);
      if (recorder.exitCode !== null) throw new Error("ffmpeg could not capture the screen");
      return Date.now() - 1000;
    },

    async stopRecording() {
      const done = new Promise((ok) => recorder.on("exit", ok));
      recorder.stdin.end("q");
      await done;
      recorder = null;
    },

    async teardown() {
      if (recorder) await this.stopRecording();
      await run("pkill", ["-f", `${app}/Contents/MacOS/TemperanceMac`]).catch(() => {});
    },
  };
}
