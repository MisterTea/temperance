#!/bin/sh
# Runs the system tests: builds the images, starts the isolated environment, and exits
# with the client's status. Extra arguments go to the test binary (e.g. a test name).
# TEMPERANCE_SYSTEST_SERVER_IMAGE=ghcr.io/... tests a published image instead of the source.
set -eu
cd "$(dirname "$0")"
compose() { docker compose -f compose.yml "$@"; }

if ! grep -qw wireguard /proc/modules 2>/dev/null; then
  modprobe wireguard 2>/dev/null || sudo -n modprobe wireguard 2>/dev/null \
    || echo "warning: could not load the wireguard kernel module; the client needs it" >&2
fi

compose down --volumes --remove-orphans >/dev/null 2>&1 || true
if [ -n "${TEMPERANCE_SYSTEST_SERVER_IMAGE:-}" ]; then
  docker image inspect "$TEMPERANCE_SYSTEST_SERVER_IMAGE" >/dev/null 2>&1 \
    || docker pull "$TEMPERANCE_SYSTEST_SERVER_IMAGE"
  compose build client internet
else
  compose build
fi

status=0
compose run --rm client "$@" || status=$?
if [ "$status" -ne 0 ]; then
  compose logs --no-color server caddy internet | tail -n 200 >&2
fi
compose down --volumes --remove-orphans >/dev/null 2>&1 || true
exit "$status"
