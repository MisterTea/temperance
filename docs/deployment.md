# Deploy the policy service and VPN gateway

Use a dedicated Linux host with a reachable public IPv4 address/UDP port and an HTTPS hostname for the policy service. The service and gateway may share a host; the policy service can also run remotely. This repository supplies source and deployment recipes; it does not provision a public server automatically.

1. Install Python 3.11+, `wireguard-tools`, `nftables`, `iproute2`, and `procps`. Clone this repository to `/opt/temperance`. Create `/opt/temperance/.venv` and install the project there.
2. Run `sudo deploy/bootstrap-gateway.sh` on that dedicated host. It creates a private server key, interface config, default-deny bootstrap rules, and IPv4 forwarding configuration. Record the printed **public** key. Keep the private key in `/etc/wireguard/temperance.conf` private. The script refuses to overwrite an existing tunnel.
3. Copy `deploy/.env.example` to `deploy/.env`, generate two different random tokens, and set the HTTPS origin, gateway public key, numeric public IPv4 endpoint (`IP:51820`), and timezone. Restrict the file to mode 600. Tokens must each contain at least 32 characters.
4. Start the service: `docker compose --env-file deploy/.env -f deploy/compose.yml up -d --build`. The container binds only local port 8788. Configure Caddy on the host using `deploy/Caddyfile`, with `TEMPERANCE_POLICY_HOST` set to the HTTPS hostname. Caddy terminates TLS and forwards to localhost:8788. Open TCP 443 and UDP 51820 to the public network. Never publish port 8788 directly.
5. Create `/etc/temperance/gateway.env` (mode 600) containing `TEMPERANCE_GATEWAY_TOKEN`, `TEMPERANCE_PUBLIC_URL`, and `TEMPERANCE_UPLINK` (e.g. `eth0`). Match the gateway token to the service. Install `deploy/temperance-gateway.service` in `/etc/systemd/system/`, run `systemctl daemon-reload`, then `systemctl enable --now temperance-gateway`. The required `wg-quick@temperance` unit starts automatically; enable it at boot as well. If another firewall manages forwarding, explicitly permit the WireGuard/uplink flow while retaining Temperance's earlier drop rules.
6. Sign into the HTTPS dashboard with the admin token, create a family profile, and create an enrollment code. Enroll a test device and install/start its VPN. Test pause, resume, bedtime, filtering, and budget behavior before enrolling other devices.

The gateway agent requires root, `CAP_NET_ADMIN`, and `CAP_NET_BIND_SERVICE`. Its systemd unit narrows the capability set and filesystem access. It binds DNS only on `10.77.0.1:53`. It can produce a reviewable configuration without modifying networking:

```sh
TEMPERANCE_GATEWAY_TOKEN='your-token' python3 -m temperance.gateway \
  --service https://policy.example.com --uplink eth0 --dry-run
```

Do not use the bootstrap script on your development workstation. Do not use the VPN subnet `10.77.0.0/24` anywhere else in the deployment. The numeric public endpoint avoids tunnel startup depending on DNS; the HTTPS hostname must resolve before enrollment. If paused clients must refresh status, serve the policy API on the gateway's HTTPS endpoint; input HTTPS is exempt from forwarding limits, while remote service traffic through the uplink is governed by the pause. Control-plane polling from the gateway host remains independent of child VPN forwarding.

Back up the policy SQLite database using SQLite's online backup API (or stop the service before copying). Retain the server private key separately. Losing the database requires re-enrollment; losing the server key requires new provisioning on clients. Rotate compromised administrator/gateway tokens in their environment files and restart both processes. Revoke individual devices through the dashboard's Remove action.

## Local-only API smoke test

The service supports HTTP exclusively on loopback for development. Native clients intentionally require HTTPS. Do not weaken their trust checks for testing; use a trusted development TLS endpoint instead.

```sh
export TEMPERANCE_ADMIN_TOKEN="$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')"
export TEMPERANCE_GATEWAY_TOKEN="$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')"
python3 -m temperance.control --vpn-endpoint 192.0.2.1:51820 \
  --vpn-public-key 'your-generated-WireGuard-public-key'
```

Visit http://127.0.0.1:8788. No real VPN interface is installed by this command. The VPN agent is a separate deliberately privileged process.
