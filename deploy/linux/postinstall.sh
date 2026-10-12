#!/bin/sh
# .deb/.rpm post-install: create settings with fresh secrets once, then (re)start.
set -e
env_file=/etc/temperance/temperance.env
if [ ! -f "$env_file" ]; then
  install -d -m 700 /etc/temperance
  secret() { head -c "$1" /dev/urandom | base64 | tr -d '/+=\n'; }
  (umask 077 && sed -e "s|^TEMPERANCE_ADMIN_PASSWORD=.*|TEMPERANCE_ADMIN_PASSWORD=$(secret 18)|" \
    -e "s|^TEMPERANCE_GATEWAY_TOKEN=.*|TEMPERANCE_GATEWAY_TOKEN=$(secret 36)|" \
    /usr/share/temperance/temperance.env.example | grep -v '^TEMPERANCE_DATA_DIR=' > "$env_file")
  echo "Temperance: set TEMPERANCE_PUBLIC_URL and TEMPERANCE_VPN_ENDPOINT in $env_file, then"
  echo "  sudo systemctl restart temperance   (admin password is in that file)"
fi
if [ -d /run/systemd/system ]; then
  systemctl daemon-reload
  systemctl enable temperance >/dev/null 2>&1
  systemctl restart temperance
fi
