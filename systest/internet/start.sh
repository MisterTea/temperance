#!/bin/sh
# Sites are "name=address" pairs; each page's body is the site's name.
set -eu
SITES="allowed.test=198.51.100.10 games.test=198.51.100.11"
iface=$(ip -o -4 address show | awk '$4 ~ /^198\.51\.100\./ {print $2; exit}')
records=""
for site in $SITES; do
  name=${site%=*}
  address=${site#*=}
  ip address add "$address/24" dev "$iface"
  mkdir -p "/www/$name"
  echo "$name" > "/www/$name/index.html"
  # A real transfer for observed-network-minute accounting. Tiny probe pages
  # must stay below the gateway's 32 KiB idle-traffic threshold.
  dd if=/dev/zero of="/www/$name/activity.bin" bs=65536 count=2 2>/dev/null
  httpd -f -p "$address:80" -h "/www/$name" &
  records="$records --address=/$name/$address"
done
# shellcheck disable=SC2086
exec dnsmasq --keep-in-foreground --log-facility=- --log-queries --no-resolv --no-hosts \
  --listen-address=198.51.100.53 --bind-interfaces --local=/test/ $records
