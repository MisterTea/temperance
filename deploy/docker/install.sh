#!/bin/sh
# Installs Temperance with Docker Compose into ~/temperance (or $TEMPERANCE_DIR):
#   sh -c "$(curl -fsSL https://raw.githubusercontent.com/MisterTea/temperance/main/deploy/docker/install.sh)"
# Without a terminal, set TEMPERANCE_HOSTNAME and optionally TEMPERANCE_HTTPS
# (caddy, cloudflared or none), CLOUDFLARE_TUNNEL_TOKEN, TEMPERANCE_TIMEZONE and
# TEMPERANCE_UPDATES (yes or no: let the dashboard install updates).
# Rerun it to upgrade; an existing .env is kept.
set -eu

raw=https://raw.githubusercontent.com/MisterTea/temperance/main/deploy/docker
dir=${TEMPERANCE_DIR:-$HOME/temperance}
here=$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)

fail() { echo "error: $*" >&2; exit 1; }
ask() {
  # ask <variable> <question> <default>
  eval "value=\${$1:-}"
  if [ -z "$value" ] && [ -n "$tty" ]; then
    printf '%s [%s]: ' "$2" "$3" > /dev/tty
    read -r value < /dev/tty || true
  fi
  eval "$1=\${value:-\$3}"
}
secret() { head -c "$1" /dev/urandom | base64 | tr -d '\n/+='; }

command -v docker > /dev/null || fail "Docker is not installed (https://docs.docker.com/engine/install/)"
docker compose version > /dev/null 2>&1 || fail "the Docker Compose plugin is missing (docker compose version failed)"
docker info > /dev/null 2>&1 || fail "cannot talk to Docker; start it, or add yourself to the docker group"
tty=; if (: < /dev/tty) 2> /dev/null; then tty=1; fi

mkdir -p "$dir"
cd "$dir"
# Stage configuration until validation, recovery and image pulls have succeeded.
# A failed upgrade must leave the operator's active Compose file intact.
trap 'rm -f compose.yml.next' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -n "$here" ] && [ -f "$here/compose.yml" ] && [ "$here" != "$dir" ]; then
  cp "$here/compose.yml" compose.yml.next
else
  curl -fsSL "$raw/compose.yml" -o compose.yml.next
fi

if [ ! -f .env ]; then
  zone=$(readlink /etc/localtime 2> /dev/null | sed -n 's|.*zoneinfo/||p')
  if [ -z "${TEMPERANCE_HOSTNAME:-}" ] && [ -n "$tty" ]; then
    echo "No hostname yet? Create a free one at https://www.dynu.com/ (e.g. myhome.ddnsfree.com)," > /dev/tty
    echo "then enter its Dynu login under Settings > Remote access in the dashboard to keep it current." > /dev/tty
  fi
  ask TEMPERANCE_HOSTNAME "Public DNS name for this home (dynamic DNS works)" ""
  [ -n "$TEMPERANCE_HOSTNAME" ] || fail "a public hostname is required, e.g. myhome.ddnsfree.com"
  ask TEMPERANCE_TIMEZONE "Family timezone" "${zone:-UTC}"
  # Devices and parent phones only use the UDP port; HTTPS is for browsers away from home.
  ask TEMPERANCE_HTTPS "HTTPS for browsers away from home: none, caddy (Let's Encrypt, forward TCP 80/443) or cloudflared (Cloudflare Tunnel)" none
  public=https://$TEMPERANCE_HOSTNAME
  case $TEMPERANCE_HTTPS in
    caddy) profiles=caddy ;;
    cloudflared) profiles=cloudflared; ask CLOUDFLARE_TUNNEL_TOKEN "Cloudflare tunnel token" "" ;;
    none) profiles=; public=http://localhost:8788 ;;
    *) fail "TEMPERANCE_HTTPS must be caddy, cloudflared or none" ;;
  esac
  ask TEMPERANCE_UPDATES "Install updates from the dashboard (runs a Watchtower container with Docker access): yes or no" yes
  updater_token=
  case $TEMPERANCE_UPDATES in
    yes) profiles=${profiles:+$profiles,}updater; updater_token=$(secret 36) ;;
    no) ;;
    *) fail "TEMPERANCE_UPDATES must be yes or no" ;;
  esac
  password=$(secret 18)
  umask 077
  cat > .env << EOF
TEMPERANCE_ADMIN_PASSWORD=$password
TEMPERANCE_GATEWAY_TOKEN=$(secret 36)
TEMPERANCE_PUBLIC_URL=$public
TEMPERANCE_VPN_ENDPOINT=$TEMPERANCE_HOSTNAME:${TEMPERANCE_WIREGUARD_PORT:-51820}
TEMPERANCE_TIMEZONE=$TEMPERANCE_TIMEZONE

# Extra services: caddy or cloudflared for HTTPS (or neither if you run your own),
# and updater to install new versions from the dashboard.
COMPOSE_PROFILES=$profiles
CLOUDFLARE_TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN:-}

# Shared by Temperance and the updater container. Updates run only when
# requested through the dashboard, after a successful encrypted recovery snapshot.
TEMPERANCE_UPDATER_TOKEN=$updater_token
TEMPERANCE_AUTO_UPDATE=false
TEMPERANCE_UPDATE_CHANNEL=${TEMPERANCE_UPDATE_CHANNEL:-stable}
TEMPERANCE_IMAGE=${TEMPERANCE_IMAGE:-mistertea/temperance:latest}
# Recovery runs daily and before dashboard updates. Copy archives and this
# passphrase to separate safe storage; keeping them only here is not recovery.
TEMPERANCE_BACKUP_PASSPHRASE=$(secret 36)

# Temperance uses this machine's network. It asks the router to forward UDP
# ${TEMPERANCE_WIREGUARD_PORT:-51820} with UPnP; without UPnP, forward it to this machine by hand.
# The dashboard is plain HTTP on TEMPERANCE_DASHBOARD_ADDRESS:TEMPERANCE_DASHBOARD_PORT.
TEMPERANCE_DASHBOARD_ADDRESS=127.0.0.1
TEMPERANCE_DASHBOARD_PORT=8788
TEMPERANCE_WIREGUARD_PORT=${TEMPERANCE_WIREGUARD_PORT:-51820}
# Loopback port of the updater container's API.
TEMPERANCE_UPDATER_PORT=8790

# Leave empty for SQLite in the temperance-data volume, or use postgres://user:pass@host:5432/temperance
TEMPERANCE_DATABASE_URL=
EOF
  echo "Wrote $dir/.env with a new admin password: $password"
elif ! grep -q '^TEMPERANCE_UPDATER_TOKEN=.' .env; then
  # Installs from before the updater existed: offer it once, keeping everything else.
  ask TEMPERANCE_UPDATES "Install updates from the dashboard from now on (runs a Watchtower container with Docker access): yes or no" no
  if [ "$TEMPERANCE_UPDATES" = yes ]; then
    profiles=$(sed -n 's/^COMPOSE_PROFILES=//p' .env | tail -1)
    umask 077
    sed -i.bak -e '/^TEMPERANCE_UPDATER_TOKEN=/d' -e '/^COMPOSE_PROFILES=/d' .env && rm -f .env.bak
    printf '\nCOMPOSE_PROFILES=%s\nTEMPERANCE_UPDATER_TOKEN=%s\nTEMPERANCE_AUTO_UPDATE=false\n' \
      "${profiles:+$profiles,}updater" "$(secret 36)" >> .env
    echo "Turned on dashboard updates in $dir/.env"
  fi
fi
# Installs from before host networking published the dashboard as address:port.
published=$(sed -n 's/^TEMPERANCE_DASHBOARD_PORT=//p' .env | tail -1)
case $published in
  *:*)
    umask 077
    sed -i.bak '/^TEMPERANCE_DASHBOARD_PORT=/d' .env && rm -f .env.bak
    printf 'TEMPERANCE_DASHBOARD_ADDRESS=%s\nTEMPERANCE_DASHBOARD_PORT=%s\n' "${published%:*}" "${published##*:}" >> .env
    echo "Split TEMPERANCE_DASHBOARD_PORT=$published into an address and a port in $dir/.env"
    ;;
esac
bridged=; if [ -f compose.yml ] && ! grep -q 'network_mode: host' compose.yml; then bridged=1; fi

if [ -f compose.yml ] && [ -n "$(docker compose ps -q --status running temperance)" ]; then
  echo "Creating an encrypted recovery snapshot before replacing this server."
  docker compose exec -T temperance node scripts/recovery.cjs backup || fail "Recovery failed. Follow docs/beta-operations.md before upgrading an older installation."
fi
docker compose -f compose.yml.next config --quiet
docker compose -f compose.yml.next pull --quiet || fail "Could not pull the requested images; existing containers and Compose configuration were not replaced."
if [ -f compose.yml ]; then
  cp -p compose.yml compose.yml.previous
fi
mv compose.yml.next compose.yml
if ! docker compose up -d --remove-orphans; then
  if [ -f compose.yml.previous ]; then cp -p compose.yml.previous compose.yml; fi
  fail "Server replacement failed. The previous Compose file was restored; follow the recovery guide before restarting."
fi

printf 'Waiting for Temperance to start'
for _ in $(seq 60); do
  state=$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q temperance)" 2> /dev/null || true)
  [ "$state" = healthy ] && break
  printf .; sleep 2
done
echo
[ "$state" = healthy ] || { docker compose logs --tail 30 temperance; fail "Temperance did not become healthy"; }

setting() { sed -n "s/^$1=//p" .env | tail -1; }
address=$(setting TEMPERANCE_DASHBOARD_ADDRESS); address=${address:-127.0.0.1}
port=$(setting TEMPERANCE_DASHBOARD_PORT); port=${port:-8788}
if [ "$address" = 0.0.0.0 ]; then dashboard=127.0.0.1:$port; else dashboard=$address:$port; fi
if command -v curl > /dev/null && ! curl -fsS -m 5 -o /dev/null "http://$dashboard/healthz" 2> /dev/null; then
  echo "warning: the dashboard is not answering on http://$dashboard from this machine." >&2
  echo "  Docker Desktop: turn on Settings > Resources > Network > Enable host networking, then rerun this installer." >&2
fi
if [ -n "$bridged" ]; then
  case ",$(setting COMPOSE_PROFILES)," in
    *,cloudflared,*) echo "Action needed: in the Cloudflare dashboard, route the tunnel's hostname to http://localhost:$port (it was http://temperance:3000)." ;;
  esac
fi
cat << EOF
Temperance is running from $dir.
  Dashboard:  $(setting TEMPERANCE_PUBLIC_URL) (and http://$dashboard on this machine)
  Password:   TEMPERANCE_ADMIN_PASSWORD in $dir/.env
  Recovery:   save the passphrase from .env separately; copy encrypted archives off this server
  Router:     Temperance asks the router to forward UDP port $(setting TEMPERANCE_WIREGUARD_PORT) with UPnP; see Settings > Remote access.
              Without UPnP, forward it to this machine by hand$( [ "$(setting COMPOSE_PROFILES)" = caddy ] && echo ", plus TCP 80 and 443 for Caddy")
              (how-to for TP-Link, eero and Netgear: https://github.com/MisterTea/temperance/blob/main/docs/routers.md)
  Upgrade:    $(case ",$(setting COMPOSE_PROFILES)," in *,updater,*) echo "Settings > Software updates in the dashboard, or rerun this installer" ;; *) echo "rerun this installer, or: cd $dir && docker compose pull && docker compose up -d" ;; esac)
EOF
