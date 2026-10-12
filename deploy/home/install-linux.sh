#!/bin/sh
# Install Temperance as a systemd service on the home server, either from an unpacked
# release tarball (`sudo ./install.sh`, Node.js included) or from a checkout
# (`sudo deploy/home/install-linux.sh`, needs Node.js 24+ and Rust or a prebuilt add-on).
# Data: /var/lib/temperance. Settings and secrets: /etc/temperance/temperance.env.
set -eu
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)" >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
env_file=/etc/temperance/temperance.env

if [ -f "$here/app/server.js" ]; then
  rm -rf /opt/temperance/app /opt/temperance/node
  mkdir -p /opt/temperance
  cp -R "$here/app" "$here/node" /opt/temperance/
  example=$here/temperance.env.example
  unit=$here/temperance.service
else
  repo=$(cd "$here/../.." && pwd)
  node=$(command -v node) || { echo "Install Node.js 24 or newer first, or use a release tarball" >&2; exit 1; }
  [ "$("$node" -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "Node.js 24 or newer is required" >&2; exit 1; }
  "$repo/deploy/home/stage.sh" /opt/temperance/app
  mkdir -p /opt/temperance/node/bin
  ln -sf "$node" /opt/temperance/node/bin/node
  example=$repo/deploy/.env.example
  unit=$here/temperance.service
fi

install -d -m 700 /etc/temperance
if [ ! -f "$env_file" ]; then
  secret() { head -c "$1" /dev/urandom | base64 | tr -d '/+=\n'; }
  (umask 077 && sed -e "s|^TEMPERANCE_ADMIN_PASSWORD=.*|TEMPERANCE_ADMIN_PASSWORD=$(secret 18)|" \
    -e "s|^TEMPERANCE_GATEWAY_TOKEN=.*|TEMPERANCE_GATEWAY_TOKEN=$(secret 36)|" \
    "$example" | grep -v '^TEMPERANCE_DATA_DIR=' > "$env_file")
  echo "Created $env_file with a generated admin password. Set TEMPERANCE_PUBLIC_URL and TEMPERANCE_VPN_ENDPOINT, then:"
  echo "  sudo systemctl restart temperance"
fi
install -m 644 "$unit" /etc/systemd/system/temperance.service
systemctl daemon-reload
systemctl enable temperance >/dev/null 2>&1
systemctl restart temperance
echo "Temperance is running: http://127.0.0.1:3000 (admin password in $env_file)."
echo "Forward UDP 51820 on your router to this machine, and see docs/deployment.md for HTTPS."
