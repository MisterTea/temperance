#!/usr/bin/env bash
# Run both independent suites and retain each result, even if the other fails.
set -uo pipefail
cd "$(dirname "$0")/.."
REPORT=app/build/acceptance
mkdir -p "$REPORT"
ui_status=0
./gradlew connectedDebugAndroidTest || ui_status=$?
cp -R app/build/reports/androidTests "$REPORT/ui-reports" 2>/dev/null || true
cp -R app/build/outputs/androidTest-results "$REPORT/ui-results" 2>/dev/null || true
adb pull /data/local/tmp/temperance-shots "$REPORT/screenshots" >/dev/null 2>&1 || true
server_status=0
TEMPERANCE_DISPOSABLE_TEST=1 e2e/real-server.sh || server_status=$?
printf 'UI suite exit status: %s; real-server suite exit status: %s\n' "$ui_status" "$server_status"
[ "$ui_status" -eq 0 ] && [ "$server_status" -eq 0 ]
