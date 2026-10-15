import { execFileSync } from "node:child_process";
import type { NextConfig } from "next";
// Release builds pass TEMPERANCE_VERSION; checkouts describe themselves from git tags.
function version() {
  if (process.env.TEMPERANCE_VERSION) return process.env.TEMPERANCE_VERSION;
  try {
    return execFileSync("git", ["describe", "--tags", "--match", "v*"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim()
      .replace(/^v/, "");
  } catch {
    return "dev";
  }
}
const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  env: { TEMPERANCE_BUILD_VERSION: version() },
  serverExternalPackages: ["pg", "@temperance/gateway-addon"],
  // No next/image, so release packages leave out Next's optional sharp dependency.
  images: { unoptimized: true },
  // pg loads its Workers socket adapter conditionally and the gateway add-on
  // picks its binary by platform at runtime, so tracing misses both.
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/pg-cloudflare/**",
      "./node_modules/@temperance/gateway-addon/*.{js,node}",
      "./scripts/recovery.cjs",
    ],
  },
};
export default config;
