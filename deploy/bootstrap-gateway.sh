#!/bin/sh
# Run deliberately on a dedicated Linux VPN gateway after installing dependencies.
set -eu
if [ "$(id -u)" != 0 ]; then echo 'Run as root on the gateway' >&2; exit 1; fi
if [ -f /etc/wireguard/temperance.conf ]; then echo 'Existing gateway config preserved; refusing to overwrite' >&2; exit 1; fi
umask 077
mkdir -p /etc/wireguard /etc/temperance
private_key=$(wg genkey)
printf '[Interface]\nPrivateKey = %s\nAddress = 10.77.0.1/24\nListenPort = 51820\nPostUp = nft -f /etc/temperance/closed.nft\n' "$private_key" > /etc/wireguard/temperance.conf
cat > /etc/temperance/closed.nft <<'RULES'
table inet temperance_boot {
 chain forward { type filter hook forward priority -20; policy accept;
  iifname "temperance" drop
  oifname "temperance" drop
 }
}
RULES
# Agent removes this bootstrap table only after successfully installing expiring leases.
printf 'net.ipv4.ip_forward=1\n' > /etc/sysctl.d/90-temperance.conf
sysctl -p /etc/sysctl.d/90-temperance.conf >/dev/null
printf 'Gateway public key (safe to configure in the policy service):\n'
printf '%s' "$private_key" | wg pubkey
printf '\nCreate /etc/temperance/gateway.env and install temperance-gateway.service before starting the interface.\n'
