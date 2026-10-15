// Run after `npm ci` in web: node scripts/brand-assets.mjs
// The approved SVG is the source for every platform's brand mark.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const sharp = createRequire(resolve(root, "web/package.json"))("sharp");
const source = await readFile(
  resolve(root, "docs/brand/temperance-mark-v2.svg"),
  "utf8",
);
const path = source.match(/<path fill="[^"]+" d="([^"]+)"/)[1];
const svg = (body, viewBox = "0 0 1254 1254") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>\n`;
const mark = svg(`<path fill="#2B3675" d="${path}"/>`, "166 184 922 922");
const tile = (rounded = false) =>
  svg(
    `<rect width="1254" height="1254"${rounded ? ' rx="260"' : ""} fill="#2B3675"/><path fill="#FFFFFF" d="${path}"/>`,
  );
async function save(name, data) {
  const dest = resolve(root, name);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, data);
}
async function png(name, size, input = tile()) {
  await save(
    name,
    await sharp(Buffer.from(input)).resize(size, size).png().toBuffer(),
  );
}
async function ico(name) {
  const sizes = [16, 32, 48, 64, 128, 256];
  const images = await Promise.all(
    sizes.map((size) =>
      sharp(Buffer.from(tile(true)))
        .resize(size, size)
        .png()
        .toBuffer(),
    ),
  );
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  images.forEach((image, i) => {
    const at = 6 + i * 16;
    header[at] = header[at + 1] = sizes[i] % 256;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(image.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += image.length;
  });
  await save(name, Buffer.concat([header, ...images]));
}

for (const dir of ["web/public", "clients/desktop/public"])
  await save(`${dir}/temperance-mark.svg`, mark);
await save("web/src/app/icon.svg", tile(true));
await ico("web/src/app/favicon.ico");
await png("web/src/app/apple-icon.png", 180);
await save("clients/desktop/public/icon.svg", tile(true));
await save("core/temperance-desktop/icons/icon.svg", tile(true));
for (const [name, size] of [
  ["32x32", 32],
  ["128x128", 128],
  ["128x128@2x", 256],
  ["icon", 1024],
]) {
  await png(`core/temperance-desktop/icons/${name}.png`, size, tile(true));
}
await ico("core/temperance-desktop/icons/icon.ico");

const catalog = "clients/apple/App/Assets.xcassets";
const contents = (images) =>
  JSON.stringify({ images, info: { author: "xcode", version: 1 } }, null, 2) +
  "\n";
await save(
  `${catalog}/Contents.json`,
  JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2) + "\n",
);
const icons = [];
for (const size of [16, 32, 128, 256, 512])
  for (const scale of [1, 2]) {
    const filename = `mac-${size}@${scale}x.png`;
    await png(
      `${catalog}/AppIcon.appiconset/${filename}`,
      size * scale,
      tile(true),
    );
    icons.push({
      idiom: "mac",
      size: `${size}x${size}`,
      scale: `${scale}x`,
      filename,
    });
  }
await png(`${catalog}/AppIcon.appiconset/ios-1024.png`, 1024);
icons.push({
  idiom: "universal",
  platform: "ios",
  size: "1024x1024",
  filename: "ios-1024.png",
});
await save(`${catalog}/AppIcon.appiconset/Contents.json`, contents(icons));
const marks = [];
for (const scale of [1, 2, 3]) {
  const filename = `mark@${scale}x.png`;
  await png(`${catalog}/BrandMark.imageset/${filename}`, 48 * scale, mark);
  marks.push({ idiom: "universal", scale: `${scale}x`, filename });
}
await save(`${catalog}/BrandMark.imageset/Contents.json`, contents(marks));
for (const [name, light, dark] of [
  ["AccentColor", "2B3675", "B7BFEF"],
  ["Paper", "F6F7FC", "171A2B"],
  ["Ink", "242A43", "E8EAF7"],
]) {
  const color = (hex) => ({
    "color-space": "srgb",
    components: {
      red: `0x${hex.slice(0, 2)}`,
      green: `0x${hex.slice(2, 4)}`,
      blue: `0x${hex.slice(4, 6)}`,
      alpha: "1.000",
    },
  });
  await save(
    `${catalog}/${name}.colorset/Contents.json`,
    JSON.stringify(
      {
        colors: [
          { idiom: "universal", color: color(light) },
          {
            idiom: "universal",
            appearances: [{ appearance: "luminosity", value: "dark" }],
            color: color(dark),
          },
        ],
        info: { author: "xcode", version: 1 },
      },
      null,
      2,
    ) + "\n",
  );
}

const res = "clients/android/app/src/main/res";
const vector = (fill, viewport = "1254") =>
  `<?xml version="1.0" encoding="utf-8"?>\n<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="48dp" android:height="48dp" android:viewportWidth="${viewport}" android:viewportHeight="${viewport}"><path android:fillColor="${fill}" android:pathData="${path}"/></vector>\n`;
await save(`${res}/drawable/brand_mark.xml`, vector("@color/brand"));
await save(`${res}/drawable/ic_notification.xml`, vector("#FFFFFF"));
// Adaptive icons reserve extra space for the platform's circular and squircle masks.
await save(
  `${res}/drawable/ic_launcher_foreground.xml`,
  `<?xml version="1.0" encoding="utf-8"?>\n<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="1254" android:viewportHeight="1254"><group android:scaleX="0.7" android:scaleY="0.7" android:translateX="188.1" android:translateY="188.1"><path android:fillColor="#FFFFFF" android:pathData="${path}"/></group></vector>\n`,
);
for (const name of ["ic_launcher", "ic_launcher_round"])
  await save(
    `${res}/mipmap-anydpi-v26/${name}.xml`,
    `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@color/brand"/><foreground android:drawable="@drawable/ic_launcher_foreground"/><monochrome android:drawable="@drawable/ic_launcher_foreground"/></adaptive-icon>\n`,
  );
console.log(
  "Generated web, desktop, Apple, and Android brand assets from the approved SVG.",
);
