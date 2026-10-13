// Drives the installed Tauri app in the UTM "Windows 11" VM through
// windows/agent.ps1, which runs elevated in the VM's desktop session and
// long-polls this harness on the server's public host (the child's VPN lets
// that host through even while blocked). Recordings are made in the VM with
// ffmpeg and pulled out through the UTM guest agent, which needs no network.
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VM = process.env.STORYBOARD_VM ?? "Windows 11";
const UTMCTL = "/Applications/UTM.app/Contents/MacOS/utmctl";
const SSH = ["-o", "ConnectTimeout=10", "-p", "2222", "jjg@127.0.0.1"];
const TASK = "TemperanceStoryboard";
const REMOTE = "C:\\t\\storyboard.mp4";

export default function driver({ log }) {
  const queue = [];
  let waiting = null;
  let id = 0;
  const pending = new Map();
  // The app window, cropped out of the desktop; once another window joins it, the
  // desktop without the taskbar.
  let window = null;
  let desktop = null;
  let hello;
  const ready = new Promise((ok) => (hello = ok));

  function handler(req, res) {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const result = body ? JSON.parse(body) : {};
      if (result.hello) hello();
      if (result.id !== undefined) pending.get(result.id)?.(result);
      const give = (cmd) => {
        clearTimeout(timer);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(cmd));
      };
      // Quick tunnels drop requests that are idle for 100 s.
      const timer = setTimeout(() => {
        if (waiting === give) waiting = null;
        give({ op: "noop" });
      }, 50000);
      if (queue.length) give(queue.shift());
      else waiting = give;
    });
  }
  function send(op, args = {}) {
    const cmd = { id: ++id, op, ...args };
    if (args.window) window = desktop;
    return new Promise((ok, fail) => {
      pending.set(cmd.id, (r) => (r.error ? fail(new Error(r.error)) : ok(r)));
      if (waiting) {
        const w = waiting;
        waiting = null;
        w(cmd);
      } else queue.push(cmd);
    });
  }
  const locator = (t) => ({ ...t, ...(t.regex ? { regex: t.regex.source, flags: t.regex.flags } : {}) });
  const guest = (...cmd) => run(UTMCTL, ["exec", VM, "--cmd", ...cmd]);

  return {
    platform: "windows",
    noun: "PC",
    origin: "tunnel",
    endpointHost: "10.0.2.2",
    get frame() {
      return window ? { window: true, crop: window } : undefined;
    },

    async setup({ server }) {
      server.mount("/__storyboard/", handler);
      const base = `${server.publicUrl}/__storyboard`;
      await run("ssh", [...SSH, "if not exist C:\\t mkdir C:\\t"]);
      await run("scp", ["-q", "-P", "2222", resolve(import.meta.dirname, "../windows/agent.ps1"), "jjg@127.0.0.1:C:/t/agent.ps1"]);
      const register = [
        // Agents left by an interrupted run would keep the new one from starting.
        `Stop-ScheduledTask -TaskName '${TASK}' -ErrorAction SilentlyContinue`,
        `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*agent.ps1 -Base*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
        `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\\t\\agent.ps1 -Base ${base}'`,
        `$principal = New-ScheduledTaskPrincipal -UserId 'jjg' -LogonType Interactive -RunLevel Highest`,
        `Register-ScheduledTask -TaskName '${TASK}' -Action $action -Principal $principal -Force | Out-Null`,
        `Start-ScheduledTask -TaskName '${TASK}'`,
      ].join("; ");
      await run("ssh", [...SSH, `powershell -NoProfile -Command "${register.replace(/"/g, '\\"')}"`]);
      log(`waiting for the agent in ${VM}`);
      await Promise.race([ready, sleep(90000).then(() => Promise.reject(new Error("The VM agent did not check in")))]);
      log(`agent screen: ${JSON.stringify(await send("screen", { width: 1280, height: 800 }))}`);
    },

    reset: () => send("reset", {}),
    launch: () => send("launch", {}),

    async find(t, timeout = 15000) {
      return (await send("find", { ...locator(t), timeout: timeout / 1000 })).rect;
    },
    async tapAt(rect, t) {
      await send("tap", locator(t));
    },
    async type(rect, text, { target, secret }) {
      await send("type", { ...locator(target), text, secret: !!secret });
    },
    close: (window) => send("close", { window }),
    // An installed, elevated app sets up WireGuard without asking again.
    async system() {
      return null;
    },

    async startRecording() {
      const started = await send("record", { file: REMOTE });
      window = started.window ?? null;
      desktop = started.desktop ?? null;
      return Date.now() - (started.recording ?? 1000);
    },
    async stopRecording() {
      await send("stop", { file: REMOTE });
    },
    async fetch(file) {
      const out = createWriteStream(file);
      const pull = spawn(UTMCTL, ["file", "pull", VM, REMOTE], { stdio: ["ignore", "pipe", "inherit"] });
      pull.stdout.pipe(out);
      await new Promise((ok, fail) => pull.on("exit", (code) => (code ? fail(new Error(`utmctl file pull exited ${code}`)) : ok())));
      await new Promise((ok) => out.close(ok));
    },

    async teardown() {
      send("done").catch(() => {});
      await sleep(1500);
      await guest("schtasks", "/Delete", "/TN", TASK, "/F").catch((e) => log(e.message));
      // A tunnel to this run's (now stopped) gateway would cut the VM off, SSH included.
      await guest("C:\\Program Files\\WireGuard\\wireguard.exe", "/uninstalltunnelservice", "temperance").catch((e) => log(e.message));
    },
  };
}
