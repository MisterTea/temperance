#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ ! -d Vendor/wireguard-apple ]; then
  mkdir -p Vendor
  git clone https://github.com/WireGuard/wireguard-apple.git Vendor/wireguard-apple
fi
git -C Vendor/wireguard-apple checkout 2fec12a6e1f6e3460b6ee483aa00ad29cddadab1
python3 patch-dependency.py
../../core/build-bindings.sh apple
xcodegen generate
