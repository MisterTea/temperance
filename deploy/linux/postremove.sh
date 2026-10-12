#!/bin/sh
# Settings (/etc/temperance) and data (/var/lib/temperance) are kept for reinstalls.
if [ -d /run/systemd/system ]; then systemctl daemon-reload || true; fi
exit 0
