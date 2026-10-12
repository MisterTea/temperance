#!/bin/sh
# Installs Temperance with Docker Compose into ~/temperance (or $TEMPERANCE_DIR):
#   sh -c "$(curl -fsSL https://raw.githubusercontent.com/MisterTea/temperance/main/deploy/docker/install.sh)"
# Without a terminal, set TEMPERANCE_HOSTNAME and optionally TEMPERANCE_HTTPS
# (caddy, cloudflared or none), CLOUDFLARE_TUNNEL_TOKEN and TEMPERANCE_TIMEZONE.
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
if [ -n "$here" ] && [ -f "$here/compose.yml" ] && [ "$here" != "$dir" ]; then
  cp "$here/compose.yml" compose.yml
else
  curl -fsSL "$raw/compose.yml" -o compose.yml.new && mv compose.yml.new compose.yml
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
  ask TEMPERANCE_HTTPS "HTTPS: caddy (Let's Encrypt, forward TCP 80/443), cloudflared (Cloudflare Tunnel), or none" caddy
  case $TEMPERANCE_HTTPS in
    caddy) profiles=caddy ;;
    cloudflared) profiles=cloudflared; ask CLOUDFLARE_TUNNEL_TOKEN "Cloudflare tunnel token" "" ;;
    none) profiles= ;;
    *) fail "TEMPERANCE_HTTPS must be caddy, cloudflared or none" ;;
  esac
  password=$(secret 18)
  umask 077
  cat > .env << EOF
TEMPERANCE_ADMIN_PASSWORD=$password
TEMPERANCE_GATEWAY_TOKEN=$(secret 36)
TEMPERANCE_PUBLIC_URL=https://$TEMPERANCE_HOSTNAME
TEMPERANCE_VPN_ENDPOINT=$TEMPERANCE_HOSTNAME:${TEMPERANCE_WIREGUARD_PORT:-51820}
TEMPERANCE_TIMEZONE=$TEMPERANCE_TIMEZONE

# HTTPS front end to start with Temperance: caddy, cloudflared, or empty if you run your own.
COMPOSE_PROFILES=$profiles
CLOUDFLARE_TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN:-}

# Host side of the published ports. Forward UDP $TEMPERANCE_HOSTNAME:${TEMPERANCE_WIREGUARD_PORT:-51820} on your router to this machine.
TEMPERANCE_DASHBOARD_PORT=127.0.0.1:8788
TEMPERANCE_WIREGUARD_PORT=${TEMPERANCE_WIREGUARD_PORT:-51820}

# Leave empty for SQLite in the temperance-data volume, or use postgres://user:pass@host:5432/temperance
TEMPERANCE_DATABASE_URL=
EOF
  echo "Wrote $dir/.env with a new admin password: $password"
fi

docker compose pull --quiet || echo "warning: could not pull images; using local copies" >&2
docker compose up -d --remove-orphans

printf 'Waiting for Temperance to start'
for _ in $(seq 60); do
  state=$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q temperance)" 2> /dev/null || true)
  [ "$state" = healthy ] && break
  printf .; sleep 2
done
echo
[ "$state" = healthy ] || { docker compose logs --tail 30 temperance; fail "Temperance did not become healthy"; }

setting() { sed -n "s/^$1=//p" .env | tail -1; }
cat << EOF
Temperance is running from $dir.
  Dashboard:  $(setting TEMPERANCE_PUBLIC_URL) (and http://$(setting TEMPERANCE_DASHBOARD_PORT) on this machine)
  Password:   TEMPERANCE_ADMIN_PASSWORD in $dir/.env
  Router:     forward UDP port $(setting TEMPERANCE_WIREGUARD_PORT) to this machine$( [ "$(setting COMPOSE_PROFILES)" = caddy ] && echo ", plus TCP 80 and 443 for Caddy")
              (how-to for TP-Link, eero and Netgear: https://github.com/MisterTea/temperance/blob/main/docs/routers.md)
  Upgrade:    rerun this installer, or: cd $dir && docker compose pull && docker compose up -d
EOF
