import type { NextConfig } from "next";
const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["pg"],
  // pg loads its Workers socket adapter conditionally, so tracing misses it.
  outputFileTracingIncludes: { "/*": ["./node_modules/pg-cloudflare/**"] },
};
export default config;
