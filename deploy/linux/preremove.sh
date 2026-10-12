#!/bin/sh
# Stop only on removal (deb: "remove", rpm: 0 packages left), not on upgrade.
case "$1" in
  remove | 0)
    if [ -d /run/systemd/system ]; then systemctl disable --now temperance >/dev/null 2>&1 || true; fi
    ;;
esac
exit 0
