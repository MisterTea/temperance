import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const verifier = resolve("../scripts/verify-candidates.mjs");
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "temperance-artifacts-"));
  for (const name of ["docs", "artifacts", "dist"])
    mkdirSync(join(directory, name));
  writeFileSync(
    join(directory, "docs/release-evidence.json"),
    JSON.stringify({
      version: "v0.7.0-beta.1",
      source_digest: "qualified-source",
    }),
  );
  for (const [platform, name] of [
    ["android", "app-release.apk"],
    ["apple", "Temperance.zip"],
    ["windows", "Temperance.exe"],
  ]) {
    const bytes = Buffer.from(platform + " signed candidate fixture");
    writeFileSync(join(directory, "artifacts", name), bytes);
    writeFileSync(
      join(directory, "artifacts", `${platform}-candidate.json`),
      JSON.stringify({
        schema: 1,
        platform,
        version: "v0.7.0-beta.1",
        source_digest: "qualified-source",
        artifacts: [
          {
            file: name,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
      }),
    );
  }
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const verify = () =>
  execFileSync(process.execPath, [verifier, "artifacts", "dist"], {
    cwd: directory,
    stdio: "pipe",
  });
it("copies only source-bound artifacts after validating every platform", () => {
  expect(verify().toString()).toContain("Verified 3");
  expect(
    readFileSync(join(directory, "dist/Temperance.zip"), "utf8"),
  ).toContain("apple");
  expect(readdirSync(join(directory, "dist"))).toHaveLength(6);
});
it("rejects tampered artifacts before copying any files", () => {
  writeFileSync(join(directory, "artifacts/Temperance.exe"), "tampered");
  expect(verify).toThrow();
  expect(readdirSync(join(directory, "dist"))).toEqual([]);
});
it("rejects stale manifests and incomplete candidate sets", () => {
  const file = join(directory, "artifacts/apple-candidate.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(
    file,
    JSON.stringify({ ...manifest, source_digest: "old-source" }),
  );
  expect(verify).toThrow();
  rmSync(file);
  expect(verify).toThrow();
  expect(readdirSync(join(directory, "dist"))).toEqual([]);
});
