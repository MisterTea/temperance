#!/bin/sh
# Runs as root before Temperance starts, and again with "stop" when it stops.
# TEMPERANCE_GATEWAY_AP=interface;address/prefix;ssid;passphrase
# turns that Wi-Fi interface into an access point. Devices use a fixed address
# from the dashboard. Unless TEMPERANCE_GATEWAY_HOME_DNS=off, Temperance answers
# DNS on that address.
set -eu
pidfile=/run/temperance/hostapd.pid
conf=/run/temperance/hostapd.conf

stop_ap() {
  if [ -f "$pidfile" ]; then
    kill "$(cat "$pidfile")" 2>/dev/null || true
    rm -f "$pidfile"
  fi
}

if [ "${1:-}" = stop ]; then
  stop_ap
  exit 0
fi

spec=${TEMPERANCE_GATEWAY_AP:-}
[ -n "$spec" ] || exit 0
iface=$(printf '%s' "$spec" | cut -d';' -f1)
cidr=$(printf '%s' "$spec" | cut -d';' -f2)
ssid=$(printf '%s' "$spec" | cut -d';' -f3)
pass=$(printf '%s' "$spec" | cut -d';' -f4-)
case "$iface" in
  *[!A-Za-z0-9_.-]*) echo "TEMPERANCE_GATEWAY_AP has an invalid interface name" >&2; exit 1 ;;
esac
[ -n "$ssid" ] && [ "${#pass}" -ge 8 ] || {
  echo "TEMPERANCE_GATEWAY_AP is interface;address/prefix;ssid;passphrase" >&2
  exit 1
}
command -v hostapd >/dev/null 2>&1 || command -v /usr/sbin/hostapd >/dev/null || {
  echo "Install hostapd to use TEMPERANCE_GATEWAY_AP" >&2
  exit 1
}
hostapd=$(command -v hostapd || echo /usr/sbin/hostapd)

sysctl -w net.ipv4.ip_forward=1 >/dev/null
if command -v nmcli >/dev/null 2>&1; then
  mkdir -p /etc/NetworkManager/conf.d
  printf '[keyfile]\nunmanaged-devices=interface-name:%s\n' "$iface" \
    > /etc/NetworkManager/conf.d/temperance-ap.conf
  nmcli device set "$iface" managed no >/dev/null 2>&1 || true
fi
rfkill unblock wifi >/dev/null 2>&1 || true

mkdir -p /run/temperance
chmod 700 /run/temperance
umask 077
# 80 MHz at channel 36. Channel 165 is 20 MHz only, and 149–161 is the block
# home routers usually occupy.
cat > "$conf" <<EOF
interface=$iface
driver=nl80211
ssid=$ssid
country_code=US
ieee80211d=1
hw_mode=a
channel=36
ieee80211n=1
ieee80211ac=1
ht_capab=[HT40+][SHORT-GI-20][SHORT-GI-40]
vht_capab=[SHORT-GI-80]
vht_oper_chwidth=1
vht_oper_centr_freq_seg0_idx=42
wmm_enabled=1
wpa=2
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
wpa_passphrase=$pass
EOF
stop_ap
ip link set "$iface" down >/dev/null 2>&1 || true
ip addr flush dev "$iface" >/dev/null 2>&1 || true
ip addr replace "$cidr" dev "$iface"
# hostapd brings the interface up. Changing the link after that drops AP mode.
"$hostapd" -B -P "$pidfile" "$conf"
