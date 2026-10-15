// Turns a raw screen recording and its storyboard timeline into the final MP4:
// a title card, the recording framed on a branded 1920x1080 canvas with the
// waits cut out, captions beside (phones) or below (desktops), and a ring on
// each control as it's used. Overlays are rendered by Chromium, so they match
// the web storyboards.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const W = 1920;
const H = 1080;
const TITLE = 3.6;
const TAIL = 1.2;
const NAMES = { android: "Android", ios: "iPhone", macos: "Mac", windows: "Windows" };

const web = resolve(import.meta.dirname, "../../../web");
const require = createRequire(join(web, "package.json"));
const playwright = await import(pathToFileURL(require.resolve("@playwright/test")).href);
const chromium = playwright.chromium ?? playwright.default.chromium;

function probe(file) {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]).toString();
  const [width, height] = out.trim().split(",").map(Number);
  return { width, height };
}

const even = (n) => Math.round(n / 2) * 2;

function layout(src, frame = {}) {
  // The part of the recording that shows the app (e.g. without a window shadow).
  const crop = frame.crop ?? { x: 0, y: 0, width: src.width, height: src.height };
  if (crop.height > crop.width * 0.9) {
    const h = 960;
    const w = even(Math.min((crop.width * h) / crop.height, 900));
    const hh = even((crop.height * w) / crop.width);
    return { crop, portrait: true, bezel: !frame.window, box: { x: even(560 - w / 2), y: even(540 - hh / 2), width: w, height: hh }, radius: frame.radius ?? (frame.window ? 12 : 34) };
  }
  const s = Math.min(1760 / crop.width, 800 / crop.height);
  const w = even(crop.width * s);
  const h = even(crop.height * s);
  return { crop, portrait: false, bezel: false, box: { x: even((W - w) / 2), y: even(30 + (800 - h) / 2), width: w, height: h }, radius: 14 };
}

const brandMark = readFileSync(resolve(web, "public/temperance-mark.svg"), "utf8").replaceAll("#2B3675", "#FFFFFF");

const STYLE = `
  *{box-sizing:border-box;margin:0}
  html,body{width:${W}px;height:${H}px;background:transparent;font-family:-apple-system,"SF Pro Display","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
  .bg{position:absolute;inset:0;background:radial-gradient(1200px 800px at 15% 10%,#5364a8 0%,transparent 60%),linear-gradient(135deg,#1b214b,#2B3675)}
  .title{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;color:#fff;text-align:center}
  .title small{font-size:24px;letter-spacing:.28em;text-transform:uppercase;opacity:.65}
  .title b{font-size:76px;letter-spacing:-.02em;font-weight:700;max-width:80%}
  .title span{font-size:36px;opacity:.85;max-width:62%;line-height:1.35}
  .side{position:absolute;left:1040px;width:780px;top:0;bottom:0;display:flex;align-items:center}
  .side p{color:#fff;font-size:44px;line-height:1.32;font-weight:600;letter-spacing:-.01em;text-shadow:0 2px 12px rgba(0,0,0,.25)}
  .below{position:absolute;left:120px;right:120px;top:850px;bottom:20px;display:flex;align-items:center;justify-content:center}
  .below p{background:rgba(23,27,52,.72);color:#fff;font-size:38px;line-height:1.3;font-weight:600;padding:20px 34px;border-radius:20px;text-align:center;max-width:1500px}
  .brand svg{width:34px;height:34px;vertical-align:middle;margin-right:8px}
  .brand{position:absolute;left:1040px;top:64px;color:#fff;opacity:.7;font-size:26px;letter-spacing:.04em}
  .ring{position:absolute;border:5px solid #ffc400;border-radius:16px;box-shadow:0 0 0 9px rgba(255,196,0,.28),0 0 24px rgba(255,196,0,.5)}
  .chip{position:absolute;transform:translateX(-50%);background:rgba(23,27,52,.82);color:#fff;font-size:28px;font-weight:600;padding:10px 24px;border-radius:999px}
`;

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function compose({ raw, mp4, timeline, end, title, subtitle, platform, frame }) {
  const src = probe(raw);
  const L = layout(src, frame);
  const scale = L.box.width / L.crop.width;
  const tmp = mkdtempSync(join(tmpdir(), "storyboard-compose-"));

  // Waits cut from the recording, and recording time -> video time.
  const cuts = timeline
    .filter((e) => e.kind === "cut" && e.to - e.from > 0.3)
    .map(({ from, to, quiet }) => ({ from, to, quiet }))
    .sort((a, b) => a.from - b.from);
  const keep = [];
  let at = 0;
  for (const c of cuts) {
    if (c.from > at) keep.push([at, c.from]);
    at = Math.max(at, c.to);
  }
  keep.push([at, end]);
  const map = (t) => {
    let shift = 0;
    for (const c of cuts) {
      if (t >= c.to) shift += c.to - c.from;
      else if (t > c.from) return c.from - shift + TITLE;
    }
    return t - shift + TITLE;
  };
  const total = keep.reduce((s, [a, b]) => s + b - a, 0) + TITLE + TAIL;

  // Overlays as full-canvas PNGs, each with the time it's on screen.
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const overlays = [];
  let n = 0;
  async function png(body, from, until, fade = 0.25) {
    const file = join(tmp, `o${n++}.png`);
    await page.setContent(`<style>${STYLE}</style>${body}`);
    await page.screenshot({ path: file, omitBackground: true });
    if (from !== undefined) overlays.push({ file, from, until, fade });
    return file;
  }
  const b = L.box;
  const frameFile = join(tmp, "frame.png");
  await page.setContent(`<style>${STYLE}</style><canvas id=c width=${W} height=${H}></canvas>`);
  await page.evaluate(
    ({ b, r, phone }) => {
      const c = document.getElementById("c").getContext("2d");
      const g = c.createLinearGradient(0, 0, 1920, 1080);
      g.addColorStop(0, "#1b214b");
      g.addColorStop(1, "#2B3675");
      c.fillStyle = g;
      c.fillRect(0, 0, 1920, 1080);
      const glow = c.createRadialGradient(290, 110, 0, 290, 110, 1100);
      glow.addColorStop(0, "rgba(83,100,168,.85)");
      glow.addColorStop(1, "rgba(83,100,168,0)");
      c.fillStyle = glow;
      c.fillRect(0, 0, 1920, 1080);
      const bezel = phone ? 14 : 0;
      c.shadowColor = "rgba(0,0,0,.45)";
      c.shadowBlur = 50;
      c.shadowOffsetY = 18;
      c.fillStyle = phone ? "#111423" : "rgba(0,0,0,.35)";
      c.beginPath();
      c.roundRect(b.x - bezel, b.y - bezel, b.width + 2 * bezel, b.height + 2 * bezel, r + bezel);
      c.fill();
      c.shadowColor = "transparent";
      c.globalCompositeOperation = "destination-out";
      c.fillStyle = "#000";
      c.beginPath();
      c.roundRect(b.x, b.y, b.width, b.height, r);
      c.fill();
    },
    { b, r: L.radius, phone: L.bezel },
  );
  await page.screenshot({ path: frameFile, omitBackground: true });
  const brand = L.portrait ? `<div class=brand>${brandMark} temperance · ${NAMES[platform]}</div>` : "";
  if (brand) overlays.push({ file: await png(brand), from: TITLE, until: total, fade: 0.3 });
  overlays.push({
    file: await png(`<div class=bg></div><div class=title><small>Temperance · ${NAMES[platform]}</small><b>${esc(title)}</b><span>${esc(subtitle ?? "")}</span></div>`),
    from: 0,
    until: TITLE,
    fade: 0.5,
    noFadeIn: true,
  });
  const captions = timeline.filter((e) => e.kind === "caption");
  for (const [i, c] of captions.entries()) {
    const from = map(c.at);
    const until = i + 1 < captions.length ? map(captions[i + 1].at) : total - 0.4;
    const body = L.portrait ? `<div class=side><p>${esc(c.text)}</p></div>` : `<div class=below><p>${esc(c.text)}</p></div>`;
    await png(body, from, until, 0.2);
  }
  for (const r of timeline.filter((e) => e.kind === "ring")) {
    const x = b.x + (r.rect.x - L.crop.x) * scale;
    const y = b.y + (r.rect.y - L.crop.y) * scale;
    const w = r.rect.width * scale;
    const h = r.rect.height * scale;
    await png(
      `<div class=ring style="left:${x - 8}px;top:${y - 8}px;width:${w + 16}px;height:${h + 16}px"></div>`,
      map(r.at),
      Math.max(map(r.until), map(r.at) + 0.6),
      0.15,
    );
  }
  for (const c of cuts.filter((c) => !c.quiet)) {
    const from = map(c.to);
    // Below a phone's status bar and camera cutout, or above its home indicator.
    const top = frame?.chip === "bottom" ? b.y + b.height - 110 : b.y + (L.bezel ? 110 : 24);
    await png(`<div class=chip style="left:${b.x + b.width / 2}px;top:${top}px">A little later</div>`, from, from + 1.8, 0.25);
  }
  await browser.close();

  // One ffmpeg pass: cut, scale, frame, then every overlay in time.
  const inputs = ["-i", raw, "-loop", "1", "-framerate", "30", "-t", total.toFixed(2), "-i", frameFile];
  for (const o of overlays) inputs.push("-loop", "1", "-framerate", "30", "-t", total.toFixed(2), "-i", o.file);
  const f = [];
  const c = L.crop;
  f.push(`[0:v]crop=${c.width}:${c.height}:${c.x}:${c.y},fps=30,split=${keep.length}${keep.map((_, i) => `[k${i}]`).join("")}`);
  keep.forEach(([a, bEnd], i) => f.push(`[k${i}]trim=start=${a.toFixed(3)}:end=${bEnd.toFixed(3)},setpts=PTS-STARTPTS[s${i}]`));
  f.push(`${keep.map((_, i) => `[s${i}]`).join("")}concat=n=${keep.length}:v=1:a=0,scale=${b.width}:${b.height}:flags=lanczos,setsar=1,tpad=start_duration=${TITLE}:start_mode=clone:stop_duration=${TAIL + 1}:stop_mode=clone[v]`);
  f.push(`color=c=black:s=${W}x${H}:r=30:d=${total.toFixed(2)}[bg]`);
  f.push(`[bg][v]overlay=${b.x}:${b.y}:shortest=1[l0]`);
  f.push(`[l0][1:v]overlay=0:0[l1]`);
  let last = "l1";
  overlays.forEach((o, i) => {
    const s = Math.max(0, o.from);
    const e = Math.min(total, o.until);
    const fades = [
      o.noFadeIn ? null : `fade=t=in:st=${s.toFixed(3)}:d=${o.fade}:alpha=1`,
      e < total - 0.05 ? `fade=t=out:st=${Math.max(s, e - o.fade).toFixed(3)}:d=${o.fade}:alpha=1` : null,
    ].filter(Boolean);
    f.push(`[${i + 2}:v]format=rgba${fades.map((x) => "," + x).join("")}[o${i}]`);
    f.push(`[${last}][o${i}]overlay=0:0:enable='between(t,${s.toFixed(3)},${e.toFixed(3)})'[m${i}]`);
    last = `m${i}`;
  });
  execFileSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", ...inputs, "-filter_complex", f.join(";"), "-map", `[${last}]`, "-t", total.toFixed(2),
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4],
    { stdio: "inherit" },
  );
  rmSync(tmp, { recursive: true, force: true });
}
