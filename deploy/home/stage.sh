#!/bin/sh
# Build the web app with the embedded gateway and copy the standalone server to $1.
# The gateway add-on comes from web/gateway-addon/*.node (CI artifact), or is built with Rust.
set -eu
dest=$1
repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo/web"
npm ci --no-audit --no-fund
name="temperance-gateway.$(node -p 'process.platform + "-" + process.arch').node"
if [ ! -f "gateway-addon/$name" ]; then
  command -v cargo >/dev/null || { echo "Put the prebuilt gateway-addon/$name in web/, or install Rust" >&2; exit 1; }
  npm run build:gateway
fi
npm run build
mkdir -p "$dest"
rm -rf "$dest/.next" "$dest/node_modules"
cp -R .next/standalone/. "$dest/"
cp -R .next/static "$dest/.next/static"
[ -d public ] && cp -R public "$dest/public"
echo "Staged the Temperance server in $dest"
