# Client storyboards

Each `NN-*.json` file is a short story about the client apps, told from a
family's point of view. `run.mjs` plays a story on a real app against a fresh
local server (the real web app with its embedded gateway) and records it as an
MP4 with captions:

```sh
node clients/storyboards/run.mjs --platform android      # all stories
node clients/storyboards/run.mjs --platform ios 03 04    # just these two
```

Videos land in `out/<platform>/`. Stories run in order on one server and one
device, so naming `04` still plays 01–03 first (unrecorded) to set up the
state. `"fresh": true` reinstalls the app; the server keeps its state. `--keep` keeps the work directory (raw recording, timeline, server log)
even when the run succeeds; it's always kept when a run fails.

The stories take place in an afternoon and evening. Run outside 13:00–18:00
and the runner plays them in a time zone where it's afternoon, and the
Android and iOS drivers move the device's clock there for the run; set `TZ`
yourself to choose another.

The step format is documented at the top of `run.mjs`. `targets.json` maps
each control a story points at to how it's found on each platform; `null`
skips that step on a platform.

## Platforms

| Platform | Device | Driven by | Gateway reached at |
| --- | --- | --- | --- |
| `android` | running emulator (`adb`) | uiautomator + `adb input`, recorded with `scrcpy` | `10.0.2.2` (the host) |
| `ios` | "Temperance Storyboard" simulator | an XCUITest that long-polls the runner (`clients/apple/Storyboard`) | `127.0.0.1` |
| `macos` | this Mac | `cua-driver` accessibility actions, recorded with ffmpeg | `127.0.0.1` |
| `windows` | the UTM "Windows 11" VM | `windows/agent.ps1` (UI Automation), recorded with ffmpeg in the VM | `10.0.2.2`; its harness is on a Cloudflare quick tunnel |

Every client signs in with the dashboard's setup code (`{{server}}`) and reaches
home only through the gateway's UDP port, as a real device does.

Notes:

- Android needs `cargo` on `PATH` (the app build compiles the core) and an
  emulator already running.
- The iOS and macOS apps run with `-SimulatedVPN YES` (debug builds only),
  because the simulator and unsigned builds can't install a Network Extension.
- macOS needs the screen unlocked when the run starts (the driver keeps the
  display awake with `caffeinate` so it doesn't lock part way), and
  Accessibility and Screen Recording granted to CuaDriver.
- Windows needs SSH to the VM on port 2222 and the app installed; the agent
  runs as an elevated scheduled task in the signed-in desktop session.
