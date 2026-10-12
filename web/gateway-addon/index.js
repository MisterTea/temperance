"use strict";
// Prebuilt binaries are named temperance-gateway.<platform>-<arch>.node
// (linux-x64, linux-arm64, darwin-arm64, darwin-x64, win32-x64).
const path = require("node:path");

const name = `temperance-gateway.${process.platform}-${process.arch}.node`;
const file = process.env.TEMPERANCE_GATEWAY_ADDON || path.join(__dirname, name);
try {
  module.exports = require(file);
} catch (error) {
  throw new Error(
    `The Temperance gateway add-on is not available for ${process.platform}-${process.arch} (${file}). ` +
      "Build it with `npm run build:gateway` in web/ or install a release that includes it.",
    { cause: error },
  );
}
