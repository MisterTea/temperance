#!/bin/sh
set -eu
# App, tunnel extension and test targets share the same Go output. Serialize
# their make invocations so parallel Xcode targets cannot patch one Go runtime
# or replace the same library simultaneously.
python3 - "$SRCROOT" "$ARCHS" "$PLATFORM_NAME" "$SDKROOT" "$CONFIGURATION_BUILD_DIR" "$PROJECT_TEMP_DIR" <<'PYTHON'
import fcntl
import pathlib
import subprocess
import sys
source, architectures, platform, sdk, output, temporary = sys.argv[1:]
lock = pathlib.Path(temporary) / ("WireGuard-" + platform + ".lock")
lock.parent.mkdir(parents=True, exist_ok=True)
with lock.open("a") as handle:
    fcntl.flock(handle, fcntl.LOCK_EX)
    result = subprocess.run([
        "make", "-C", str(pathlib.Path(source) / "Vendor/wireguard-apple/Sources/WireGuardKitGo"),
        "ARCHS=" + architectures, "PLATFORM_NAME=" + platform, "SDKROOT=" + sdk,
        "CONFIGURATION_BUILD_DIR=" + output,
        "CONFIGURATION_TEMP_DIR=" + str(pathlib.Path(temporary) / ("WireGuard-" + platform)),
    ])
    sys.exit(result.returncode)
PYTHON
