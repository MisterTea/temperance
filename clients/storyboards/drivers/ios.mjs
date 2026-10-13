// Drives the iOS app in the simulator through the TemperanceIOSStoryboard UI
// test (clients/apple/Storyboard), which takes commands from this harness over
// HTTP, and records the simulator screen with simctl.
import { execFile, spawn } from "node:child_process";
import { rename } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apple = resolve(import.meta.dirname, "../../apple");
const BUNDLE = "org.temperance.ios";
const DEVICE = "Temperance Storyboard";
const simctl = async (...args) => (await run("xcrun", ["simctl", ...args], { maxBuffer: 1 << 24 })).stdout;

export default function driver({ log, here }) {
  let udid, scale, test, recorder, recording, httpServer, ca;
  const queue = [];
  let waiting = null;
  let settle = false;
  let id = 0;
  const pending = new Map();

  // The UI test long-polls /next, sending the previous command's result.
  function serve() {
    httpServer = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const result = body ? JSON.parse(body) : {};
        if (result.id !== undefined) pending.get(result.id)?.(result);
        const give = (cmd) => res.end(JSON.stringify(cmd));
        if (queue.length) give(queue.shift());
        else waiting = give;
      });
    });
    return new Promise((ok) => httpServer.listen(0, "127.0.0.1", () => ok(httpServer.address().port)));
  }
  function send(op, args = {}) {
    const cmd = { id: ++id, op, ...args };
    return new Promise((ok, fail) => {
      pending.set(cmd.id, (r) => (r.error ? fail(new Error(r.error)) : ok(r)));
      if (waiting) {
        const w = waiting;
        waiting = null;
        w(cmd);
      } else queue.push(cmd);
    });
  }
  const locator = (t) => ({
    ...t,
    ...(t.regex ? { regex: t.regex.source, flags: t.regex.flags } : {}),
  });
  const px = (r) => ({ x: r.x * scale, y: r.y * scale, width: r.width * scale, height: r.height * scale });

  // The status bar and the app follow the simulator's launchd TZ once SpringBoard restarts.
  async function clock(zone) {
    if (!zone && !process.env.TZ) return;
    await simctl("spawn", udid, "launchctl", ...(zone ? ["setenv", "TZ", zone] : ["unsetenv", "TZ"]));
    await simctl("spawn", udid, "launchctl", "kickstart", "-k", "user/foreground/com.apple.SpringBoard").catch(() => {});
    await sleep(4000);
  }

  async function launch() {
    await send("launch", { arguments: ["-SimulatedVPN", "YES"] });
    await sleep(1200);
  }

  return {
    platform: "ios",
    noun: "iPhone",
    // The "A little later" chip goes low, clear of the large title and headline.
    frame: { chip: "bottom" },
    origin: "local",
    httpsPort: 8444,
    endpointHost: "127.0.0.1",

    async setup({ server, work }) {
      ca = server.ca;
      const devices = JSON.parse(await simctl("list", "devices", "available", "-j")).devices;
      udid = Object.values(devices).flat().find((d) => d.name === DEVICE)?.udid;
      if (!udid) {
        const runtime = JSON.parse(await simctl("list", "runtimes", "-j")).runtimes.filter((r) => r.platform === "iOS" && r.isAvailable).at(-1);
        udid = (await simctl("create", DEVICE, "com.apple.CoreSimulator.SimDeviceType.iPhone-17", runtime.identifier)).trim();
      }
      await simctl("boot", udid).catch(() => {});
      await simctl("bootstatus", udid, "-b");
      await clock(process.env.TZ);
      await simctl("ui", udid, "appearance", "light").catch(() => {});
      await simctl("status_bar", udid, "override", "--batteryState", "charged", "--batteryLevel", "100", "--wifiBars", "3", "--cellularBars", "4").catch(() => {});
      await simctl("keychain", udid, "add-root-cert", ca);
      const derived = join(here, "out", ".ios-build");
      log("building the app and its storyboard UI test");
      await run("xcodegen", ["generate"], { cwd: apple });
      await run(
        "xcodebuild",
        ["build-for-testing", "-project", "Temperance.xcodeproj", "-scheme", "TemperanceIOSStoryboard", "-destination", `id=${udid}`, "-derivedDataPath", derived, "-quiet"],
        { cwd: apple, maxBuffer: 1 << 26 },
      );
      const port = await serve();
      test = spawn(
        "xcodebuild",
        ["test-without-building", "-project", "Temperance.xcodeproj", "-scheme", "TemperanceIOSStoryboard", "-destination", `id=${udid}`, "-derivedDataPath", derived,
          "-only-testing:TemperanceIOSStoryboard/StoryboardDriver/testDrive"],
        { cwd: apple, env: { ...process.env, TEST_RUNNER_STORYBOARD_DRIVER: `http://127.0.0.1:${port}` }, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      test.stdout.on("data", (d) => (output += d));
      test.stderr.on("data", (d) => (output += d));
      test.on("exit", (code) => {
        for (const [, done] of pending) done({ error: `The UI test stopped (${code}):\n${output.slice(-3000)}` });
      });
      await launch();
      const { width } = await send("screen");
      const shot = join(work, "screen.png");
      await simctl("io", udid, "screenshot", shot);
      const { stdout } = await run("sips", ["-g", "pixelWidth", shot]);
      scale = Number(/pixelWidth: (\d+)/.exec(stdout)[1]) / width;
    },

    async reset() {
      await send("terminate");
      // The app's own defaults live in its container, not the simulator's shared domain.
      const data = (await simctl("get_app_container", udid, BUNDLE, "data")).trim();
      await simctl("spawn", udid, "defaults", "delete", join(data, "Library/Preferences", `${BUNDLE}.plist`)).catch(() => {});
      await simctl("keychain", udid, "reset");
      await simctl("keychain", udid, "add-root-cert", ca);
      await launch();
    },

    launch,

    // A refresh's wait is cut up to when the change is found, but the
    // recording gets the new frame up to a second later: hold until it has.
    async refresh() {
      settle = true;
    },

    async find(t, timeout = 15000) {
      const { rect } = await send("find", { ...locator(t), timeout: timeout / 1000 });
      if (settle) {
        settle = false;
        await sleep(1000);
      }
      return px(rect);
    },

    async tapAt(rect, t) {
      await send("tap", locator(t));
    },

    // Secrets (the pairing link) are long: paste them rather than type them.
    async type(rect, text, { target, secret }) {
      await send("type", { ...locator(target), text, paste: !!secret, multiline: /pairing link/.test(target.field ?? "") });
    },

    // The simulator has no Network Extension; -SimulatedVPN stands in for it.
    async system() {
      return null;
    },

    async startRecording(file) {
      recorder = spawn("xcrun", ["simctl", "io", udid, "recordVideo", "--codec=h264", "--force", file], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      await new Promise((ok, fail) => {
        const look = (d) => {
          output += d;
          if (/Recording started/.test(output)) ok();
        };
        recorder.stdout.on("data", look);
        recorder.stderr.on("data", look);
        recorder.on("exit", (code) => fail(new Error(`recordVideo exited (${code}): ${output}`)));
      });
      await sleep(500);
      recording = { started: Date.now() };
      return recording.started;
    },

    async stopRecording() {
      const done = new Promise((ok) => recorder.on("exit", ok));
      recorder.kill("SIGINT");
      await done;
      recorder = null;
      recording.length = (Date.now() - recording.started) / 1000;
    },

    // simctl only writes a frame when the screen changes, so the file ends at
    // the last change: hold that frame until recording actually stopped.
    async fetch(raw) {
      const padded = raw.replace(/\.mp4$/, ".padded.mp4");
      const length = recording.length + 1;
      await run("ffmpeg", ["-v", "error", "-y", "-i", raw, "-vf", `tpad=stop_mode=clone:stop_duration=${length},fps=30`, "-t", length.toFixed(2),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", padded]);
      await rename(padded, raw);
    },

    async teardown() {
      if (recorder) await this.stopRecording();
      if (test && test.exitCode === null) {
        send("done").catch(() => {});
        await sleep(1500);
        test.kill();
      }
      httpServer?.close();
      if (process.env.TZ) await clock(undefined).catch(() => {});
    },
  };
}
