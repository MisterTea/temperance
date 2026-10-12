import type { NextConfig } from "next";
const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["pg", "@temperance/gateway-addon"],
  // No next/image, so release packages leave out Next's optional sharp dependency.
  images: { unoptimized: true },
  // pg loads its Workers socket adapter conditionally and the gateway add-on
  // picks its binary by platform at runtime, so tracing misses both.
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/pg-cloudflare/**",
      "./node_modules/@temperance/gateway-addon/*.{js,node}",
    ],
  },
};
export default config;
