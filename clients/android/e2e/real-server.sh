#!/usr/bin/env bash
# End-to-end test of the Android app against the real Next.js policy service.
# Starts a fresh SQLite-backed server with its embedded WireGuard gateway, creates
# a family member with a client user, then runs RealServerTest on the connected
# emulator/device with the dashboard's setup code and checks the server state.
# The app signs in over the gateway's UDP port, browses through the tunnel, is
# blocked once its time runs out, and browses again after a parent approves more.
#   prerequisites: a booted emulator (adb) with internet, `npm run build:gateway && npm run build`
#   in web/, OpenSSL, node
set -euo pipefail
cd "$(dirname "$0")/.."
ANDROID=$(pwd)
WEB=$(cd ../../web && pwd)
WORK=$ANDROID/app/build/e2e
rm -rf "$WORK" && mkdir -p "$WORK"

WEB_PORT=${WEB_PORT:-3107}
WG_PORT=${WG_PORT:-51820}
ORIGIN=http://127.0.0.1:$WEB_PORT
ADMIN_TOKEN=$(openssl rand -hex 24)
PASSWORD="e2e-$(openssl rand -hex 8)"

pids=()
fixture_address=
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  adb reverse --remove "tcp:$WEB_PORT" 2>/dev/null || true
  if [ -n "$fixture_address" ]; then sudo -n ip address del "$fixture_address/32" dev lo 2>/dev/null || true; fi
}
trap cleanup EXIT

# The disposable Linux runner serves a fixed-size page at a documentation-only
# address, exercising WireGuard policy without third-party download services.
# Never change a developer's host routes unless this explicit test flag is set.
if [ "${TEMPERANCE_DISPOSABLE_TEST:-}" = 1 ]; then
  [ "$(uname -s)" = Linux ] || { echo "Disposable fixture requires Linux" >&2; exit 1; }
  address=198.51.100.10
  if ip -4 address show dev lo | grep -q " $address/"; then echo "Fixture address already exists; refusing to change it" >&2; exit 1; fi
  sudo -n ip address add "$address/32" dev lo
  fixture_address=$address
  SITE_PORT=${SITE_PORT:-3109}
  node -e 'require("node:http").createServer((req,res)=>{res.writeHead(200,{"Content-Type":"application/octet-stream","Content-Length":131072});res.end(Buffer.alloc(131072))}).listen(Number(process.argv[2]),process.argv[1])' "$address" "$SITE_PORT" > "$WORK/site.log" 2>&1 &
  pids+=($!)
  SITE_URL=http://$address:$SITE_PORT/
else
  SITE_URL=${TEMPERANCE_TEST_SITE_URL:?Set a reachable test URL returning at least 64 KiB, or run with TEMPERANCE_DISPOSABLE_TEST=1 on a disposable Linux runner}
fi

# The emulator reaches the host's loopback as 10.0.2.2, so the embedded gateway
# listens on 127.0.0.1 and the setup code sends the app to 10.0.2.2:$WG_PORT.
# Only the test's admin calls use the dashboard, through adb reverse.
cp -R "$WEB/.next/static" "$WEB/.next/standalone/.next/"
(cd "$WEB/.next/standalone" && env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production \
  HOSTNAME=127.0.0.1 PORT=$WEB_PORT TEMPERANCE_DATA_DIR="$WORK" \
  TEMPERANCE_ADMIN_TOKEN="$ADMIN_TOKEN" TEMPERANCE_GATEWAY_TOKEN="$(openssl rand -hex 24)" \
  TEMPERANCE_PUBLIC_URL="$ORIGIN" TEMPERANCE_VPN_ENDPOINT="10.0.2.2:$WG_PORT" \
  TEMPERANCE_GATEWAY_LISTEN="127.0.0.1:$WG_PORT" TEMPERANCE_TIMEZONE=UTC \
  node server.js > "$WORK/server.log" 2>&1) &
pids+=($!)

api() { curl -sS --fail-with-body -H "Origin: $ORIGIN" -H "Content-Type: application/json" "$@"; }
for _ in $(seq 1 60); do api "$ORIGIN/healthz" >/dev/null 2>&1 && break; sleep 1; done
api -X POST "$ORIGIN/api/profiles" -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"name":"Jordan","limit":90}' >/dev/null
api -X POST "$ORIGIN/api/profiles" -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"name":"Riley","limit":60}' >/dev/null
riley=$(api "$ORIGIN/api/state" -H "Authorization: Bearer $ADMIN_TOKEN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).profiles.find(p=>p.name==="Riley").id))')
api -X POST "$ORIGIN/api/users" -H "Authorization: Bearer $ADMIN_TOKEN" -d "{\"username\":\"riley\",\"password\":\"$PASSWORD\",\"profile_id\":$riley}" >/dev/null
# The setup code appears once the gateway has reported the key it pins.
home=""
for _ in $(seq 1 30); do
  home=$(api "$ORIGIN/api/state" -H "Authorization: Bearer $ADMIN_TOKEN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).device_setup||""))')
  [ -n "$home" ] && break; sleep 1
done
[ -n "$home" ] || { echo "the gateway never reported its key; no setup code" >&2; exit 1; }

adb reverse "tcp:$WEB_PORT" "tcp:$WEB_PORT" >/dev/null
./gradlew -q connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=org.temperance.app.RealServerTest \
  -Pandroid.testInstrumentationRunnerArguments.home="$home" \
  -Pandroid.testInstrumentationRunnerArguments.server="$ORIGIN" \
  -Pandroid.testInstrumentationRunnerArguments.profile_id="$riley" \
  -Pandroid.testInstrumentationRunnerArguments.site="$SITE_URL" \
  -Pandroid.testInstrumentationRunnerArguments.username=riley \
  -Pandroid.testInstrumentationRunnerArguments.password="$PASSWORD" \
  -Pandroid.testInstrumentationRunnerArguments.admin="$ADMIN_TOKEN"

state=$(api "$ORIGIN/api/state" -H "Authorization: Bearer $ADMIN_TOKEN")
node -e '
const s = JSON.parse(process.argv[1]);
const riley = s.profiles.find(p => p.id === Number(process.argv[2]));
const device = s.devices.find(d => d.profile_id === riley.id && !d.revoked);
if (!device) throw new Error("device was not enrolled into Riley: " + JSON.stringify(s.devices));
if (!s.requests.some(r => r.device_id === device.id && r.minutes === 30 && r.status === "approved")) throw new Error("approved time request missing");
if (!s.rewards.some(r => r.profile_id === riley.id && r.kind === "extra_time" && r.minutes === 30)) throw new Error("reward missing");
if (!s.gateway_seen || !(riley.used >= 1)) throw new Error(`no gateway activity recorded: seen=${s.gateway_seen} used=${riley.used}`);
console.log(`Server state OK: ${device.name} browsed through the gateway, ran out of time and was restored by an approved 30 minute request`);
' "$state" "$riley"
grep -q "Temperance gateway on udp" "$WORK/server.log" || { echo "embedded gateway did not start" >&2; exit 1; }
