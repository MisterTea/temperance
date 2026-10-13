// Drives the debug Android app on a booted emulator through adb and
// uiautomator, and records it with scrcpy.
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sdk = process.env.ANDROID_HOME ?? join(homedir(), "Library/Android/sdk");
const ADB = join(sdk, "platform-tools/adb");
const PKG = "org.temperance.app";
const android = resolve(import.meta.dirname, "../../android");

const adb = async (...args) => (await run(ADB, args, { maxBuffer: 1 << 24 })).stdout;
const shell = (cmd) => adb("shell", cmd);
const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

const decode = (s) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#10;/g, "\n").replace(/&amp;/g, "&");

function nodes(xml) {
  const out = [];
  for (const m of xml.matchAll(/<node ([^>]*?)\/?>/g)) {
    const attr = {};
    for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attr[a[1]] = decode(a[2]);
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr.bounds ?? "");
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    out.push({ ...attr, rect: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } });
  }
  return out;
}

function matches(node, t) {
  const label = [node.text, node["content-desc"]].filter(Boolean);
  if (t.id) return node["resource-id"]?.endsWith(`:id/${t.id}`);
  if (t.regex) return label.some((l) => t.regex.test(l));
  // Material buttons show their text in capitals.
  return label.some((l) => l === t.text || l.toUpperCase() === t.text.toUpperCase());
}

export default function driver({ log }) {
  let recorder;
  let screen;
  let zone;

  async function dump() {
    for (let i = 0; i < 5; i++) {
      try {
        // uiautomator sometimes never returns on a busy host; a stuck one blocks the next.
        await run(ADB, ["shell", "uiautomator dump /sdcard/sb.xml >/dev/null"], { timeout: 15000 });
        return nodes(await shell("cat /sdcard/sb.xml"));
      } catch (e) {
        if (e.killed) {
          log("uiautomator dump timed out; retrying");
          await shell("pkill -f uiautomator").catch(() => {});
        }
        await sleep(300);
      }
    }
    return [];
  }
  const keyboardShown = async () => /mInputShown=true/.test(await shell("dumpsys input_method"));

  async function find(t, timeout = 15000) {
    const end = Date.now() + timeout;
    let scrolls = 0;
    for (;;) {
      const all = await dump();
      const hit = all.find((n) => matches(n, t) && n.rect.width > 0 && n.rect.height > 0);
      const visible = hit && hit.rect.y + hit.rect.height <= screen.height - 40;
      if (visible) return hit.rect;
      // Swiping would close the notification shade.
      if (!t.shade && (hit || (all.length && Date.now() > end - timeout / 2 && scrolls < 3))) {
        // Under the keyboard or below the fold.
        if (await keyboardShown()) await shell("input keyevent 111");
        else {
          await shell(`input swipe ${screen.width / 2} ${screen.height * 0.7} ${screen.width / 2} ${screen.height * 0.35} 400`);
          scrolls++;
        }
        await sleep(600);
        continue;
      }
      if (Date.now() > end) throw new Error(`Not on screen: ${JSON.stringify(t, (k, v) => (v instanceof RegExp ? String(v) : v))}`);
      await sleep(700);
    }
  }

  return {
    platform: "android",
    noun: "phone",
    // The emulator's status bar has no rounded-corner padding; a rounder frame clips the clock.
    // The "A little later" chip goes low, clear of the headlines most rings point at.
    frame: { radius: 22, chip: "bottom" },
    // adb can't set the clipboard, so pasted text is typed and the typing cut from the video.
    typesSecrets: true,
    origin: "local",
    endpointHost: "10.0.2.2",

    async setup() {
      await adb("wait-for-device");
      for (let i = 0; (await shell("getprop sys.boot_completed")).trim() !== "1"; i++) {
        if (i > 120) throw new Error("The emulator did not finish booting");
        await sleep(1000);
      }
      if (process.env.TZ) {
        zone = (await shell("getprop persist.sys.timezone")).trim();
        await shell(`cmd alarm set-timezone ${quote(process.env.TZ)}`);
      }
      const [, w, h] = /(\d+)x(\d+)/.exec(await shell("wm size"));
      screen = { width: Number(w), height: Number(h) };
      log("building and installing the debug app");
      await run(join(android, "gradlew"), ["-q", ":app:installDebug"], {
        cwd: android,
        maxBuffer: 1 << 26,
        env: {
          ANDROID_HOME: sdk,
          JAVA_HOME: "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
          ...process.env,
          PATH: `${dirname(ADB)}:${process.env.PATH}`,
        },
      });
      await shell("settings put system show_touches 1");
      await shell("cmd notification set_dnd off").catch(() => {});
    },

    async reset() {
      await shell(`am force-stop ${PKG}`);
      await shell(`pm clear ${PKG}`);
      await shell(`appops set ${PKG} ACTIVATE_VPN default`).catch(() => {});
      await shell(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`).catch(() => {});
      await shell("cmd notification cancel_all 2>/dev/null; service call notification 1 >/dev/null").catch(() => {});
      await this.launch();
    },

    async launch() {
      await shell("input keyevent KEYCODE_WAKEUP");
      await shell("wm dismiss-keyguard").catch(() => {});
      await shell(`am start -W -n ${PKG}/.MainActivity`);
      await sleep(1500);
    },

    find: (t, timeout) => find(t, timeout),

    /** Brings a target that lives somewhere else on screen into view; returns how to put it back. */
    async reveal(t) {
      if (t.shade) {
        await shell("cmd statusbar expand-notifications");
        await sleep(900);
        return async () => {
          await shell("cmd statusbar collapse");
          await sleep(1000);
        };
      }
      if (t.menu) {
        const more = await find({ text: "More options" }, 5000);
        await this.tapAt(more);
        await sleep(600);
        return async () => {
          await shell("input keyevent KEYCODE_BACK");
          await sleep(400);
        };
      }
      return null;
    },

    async tapAt(rect) {
      await shell(`input tap ${Math.round(rect.x + rect.width / 2)} ${Math.round(rect.y + rect.height / 2)}`);
    },

    async type(rect, text, { secret } = {}) {
      await this.tapAt(rect);
      await sleep(400);
      // Chunks, so the typing reads on video. A busy emulator drops keys from
      // long chunks, so a visible field that came out wrong is typed again, slower.
      for (const step of secret ? [24, 8] : [4]) {
        await shell("input keycombination 113 29 && input keyevent 67");
        for (let i = 0; i < text.length; i += step) {
          await shell(`input text ${quote(text.slice(i, i + step).replace(/ /g, "%s"))}`);
        }
        await sleep(300);
        if (!secret) break;
        const field = (await dump()).find((n) => n.focused === "true" && n.password !== "true");
        if (!field || field.text === text) break;
        log(`the field reads ${field.text.length} of ${text.length} characters; typing it again`);
      }
      if (await keyboardShown()) await shell("input keyevent 111");
    },

    async system(name) {
      if (name !== "allow-vpn") throw new Error(`Unknown system step ${name}`);
      return find({ text: "OK" }, 15000);
    },

    async startRecording(file) {
      recorder = spawn("scrcpy", ["--no-window", "--no-audio", "--no-control", "--max-fps=30", `--record=${file}`], {
        env: { ...process.env, ADB },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      const ready = new Promise((ok, fail) => {
        const look = (d) => {
          output += d;
          if (/Recording started|Device: /.test(output)) ok();
        };
        recorder.stdout.on("data", look);
        recorder.stderr.on("data", look);
        recorder.on("exit", (code) => fail(new Error(`scrcpy exited (${code}): ${output}`)));
      });
      await ready;
      await sleep(1200);
      return Date.now();
    },

    async stopRecording() {
      const done = new Promise((ok) => recorder.on("exit", ok));
      recorder.kill("SIGINT");
      await done;
      recorder = null;
    },

    async teardown() {
      if (recorder) await this.stopRecording();
      await adb("reverse", "--remove-all").catch(() => {});
      if (zone) await shell(`cmd alarm set-timezone ${quote(zone)}`).catch(() => {});
    },
  };
}
