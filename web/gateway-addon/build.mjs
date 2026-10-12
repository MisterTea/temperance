// Build the Rust gateway as a Node-API add-on next to index.js.
// usage: node build.mjs [--release] [--target <rust-triple>] [--name <platform-arch>]
import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const core = path.join(here, "..", "..", "core");
const args = process.argv.slice(2);
const option = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const release = args.includes("--release");
const target = option("--target");
const name = option("--name") ?? `${process.platform}-${process.arch}`;

const cargo = ["build", "-p", "temperance-gateway", "--features", "node", "--lib"];
if (release) cargo.push("--release");
if (target) cargo.push("--target", target);
execFileSync("cargo", cargo, { cwd: core, stdio: "inherit" });

const os = target
  ? target.includes("windows")
    ? "win32"
    : target.includes("apple")
      ? "darwin"
      : "linux"
  : process.platform;
const library = {
  win32: "temperance_gateway.dll",
  darwin: "libtemperance_gateway.dylib",
  linux: "libtemperance_gateway.so",
}[os];
const built = path.join(core, "target", ...(target ? [target] : []), release ? "release" : "debug", library);
const out = path.join(here, `temperance-gateway.${name}.node`);
copyFileSync(built, out);
console.log(`Built ${path.relative(process.cwd(), out)}`);
