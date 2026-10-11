#!/bin/sh
set -eu
# Match the SDK/architectures of the current Xcode target.
make -C "$SRCROOT/Vendor/wireguard-apple/Sources/WireGuardKitGo" \
  ARCHS="$ARCHS" PLATFORM_NAME="$PLATFORM_NAME" SDKROOT="$SDKROOT" \
  CONFIGURATION_BUILD_DIR="$CONFIGURATION_BUILD_DIR" \
  CONFIGURATION_TEMP_DIR="$PROJECT_TEMP_DIR/WireGuard-$PLATFORM_NAME"
