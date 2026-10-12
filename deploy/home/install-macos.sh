#!/bin/sh
# Install Temperance as a launchd agent for the signed-in user (enable automatic login
# on a dedicated home Mac). Run from a checkout, without sudo:
#   deploy/home/install-macos.sh
# Data, settings and secrets: ~/Library/Application Support/Temperance.
set -eu
[ "$(id -u)" != 0 ] || { echo "Run as your user, not root" >&2; exit 1; }
repo=$(cd "$(dirname "$0")/../.." && pwd)
data="$HOME/Library/Application Support/Temperance"
env_file="$data/temperance.env"
plist="$HOME/Library/LaunchAgents/org.temperance.server.plist"

node=$(command -v node) || { echo "Install Node.js 24 or newer first (brew install node)" >&2; exit 1; }
[ "$("$node" -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "Node.js 24 or newer is required" >&2; exit 1; }

mkdir -p "$data" && chmod 700 "$data"
"$repo/deploy/home/stage.sh" "$data/app"
if [ ! -f "$env_file" ]; then
  umask 077
  sed -e "s|^TEMPERANCE_ADMIN_PASSWORD=.*|TEMPERANCE_ADMIN_PASSWORD=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')|" \
      -e "s|^TEMPERANCE_GATEWAY_TOKEN=.*|TEMPERANCE_GATEWAY_TOKEN=$(head -c 36 /dev/urandom | base64 | tr -d '/+=')|" \
      "$repo/deploy/.env.example" | grep -v '^TEMPERANCE_DATA_DIR=' > "$env_file"
  echo "Created $env_file with a generated admin password. Set TEMPERANCE_PUBLIC_URL and TEMPERANCE_VPN_ENDPOINT."
fi
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|@NODE@|$node|g" -e "s|@HOME@|$HOME|g" "$repo/deploy/home/org.temperance.server.plist" > "$plist"
launchctl bootout "gui/$(id -u)/org.temperance.server" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "Temperance is running: http://127.0.0.1:3000 (admin password in $env_file)."
echo "Allow incoming connections for node if macOS asks, forward UDP 51820 on your router, and see docs/deployment.md for HTTPS."
