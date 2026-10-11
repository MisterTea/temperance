#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ "$(id -u)" != 0 ]; then echo 'Run with sudo; this installs WireGuard and Temperance.' >&2; exit 1; fi
if command -v apt-get >/dev/null; then apt-get update && apt-get install -y wireguard-tools iproute2 openresolv
elif command -v dnf >/dev/null; then dnf install -y wireguard-tools iproute openresolv
else echo 'Install wireguard-tools, iproute2 and resolvconf for your distribution first.' >&2; exit 1; fi
arch=$(uname -m)
case "$arch" in x86_64) arch=amd64;; aarch64|arm64) arch=arm64;; *) echo 'Unsupported architecture' >&2; exit 1;; esac
install -m 755 "../../build/temperance-linux-$arch" /usr/local/bin/temperance-desktop
install -d -m 700 /var/lib/temperance-client
cat > /etc/systemd/system/temperance-vpn.service <<'UNIT'
[Unit]
Description=Temperance family VPN
After=network-online.target
Wants=network-online.target
ConditionPathExists=/var/lib/temperance-client/temperance.conf
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/wg-quick up /var/lib/temperance-client/temperance.conf
ExecStop=/usr/bin/wg-quick down /var/lib/temperance-client/temperance.conf
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
printf 'Run sudo temperance-desktop --data /var/lib/temperance-client and open the printed localhost URL.\nAfter enrollment and connection, enable boot persistence: sudo systemctl enable temperance-vpn\n'
