#!/usr/bin/env bash
# End-to-end test of the Android app against the real Next.js policy service.
# Starts a fresh SQLite-backed server behind HTTPS (throwaway CA trusted only by
# this debug test build), creates a family member with a client user, then runs
# RealServerTest on the connected emulator/device and checks the server state.
# The app enrolls, browses through the server's embedded WireGuard gateway, is
# blocked once its time runs out, and browses again after a parent approves more.
#   prerequisites: a booted emulator (adb) with internet, `npm run build:gateway && npm run build`
#   in web/, OpenSSL, node
set -euo pipefail
cd "$(dirname "$0")/.."
ANDROID=$(pwd)
WEB=$(cd ../../web && pwd)
WORK=$ANDROID/app/build/e2e
rm -rf "$WORK" && mkdir -p "$WORK/res/raw" "$WORK/res/xml"

HTTPS_PORT=${HTTPS_PORT:-8443}
WEB_PORT=${WEB_PORT:-3107}
WG_PORT=${WG_PORT:-51820}
ORIGIN=https://localhost:$HTTPS_PORT
ADMIN_TOKEN=$(openssl rand -hex 24)
PASSWORD="e2e-$(openssl rand -hex 8)"

# Backdated: the emulator's clock can trail the host's by several seconds. OpenSSL
# before 3.4 cannot backdate; an emulator on the same host (CI) shares its clock.
stamp() { HOURS=$1 node -e 'console.log(new Date(Date.now() + process.env.HOURS * 3600e3).toISOString().replace(/[-:T]|\.\d+/g, ""))'; }
if openssl req -help 2>&1 | grep -q -- -not_before; then
  VALIDITY=(-not_before "$(stamp -1)" -not_after "$(stamp 24)")
else
  VALIDITY=(-days 1)
fi
openssl req -x509 -newkey rsa:2048 -nodes "${VALIDITY[@]}" -subj "/CN=Temperance e2e CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" \
  -keyout "$WORK/ca.key" -out "$WORK/ca.pem" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout "$WORK/server.key" -out "$WORK/server.csr" 2>/dev/null
printf "subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n" > "$WORK/ext.cnf"
openssl x509 -req -in "$WORK/server.csr" -CA "$WORK/ca.pem" -CAkey "$WORK/ca.key" -CAcreateserial "${VALIDITY[@]}" \
  -extfile "$WORK/ext.cnf" -out "$WORK/server.pem" 2>/dev/null
cp "$WORK/ca.pem" "$WORK/res/raw/e2e_ca.pem"
cat > "$WORK/res/xml/e2e_network.xml" <<'EOF'
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="false">
    <domain includeSubdomains="false">localhost</domain>
    <trust-anchors><certificates src="@raw/e2e_ca" /></trust-anchors>
  </domain-config>
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">127.0.0.1</domain>
  </domain-config>
</network-security-config>
EOF
cat > "$WORK/AndroidManifest.xml" <<'EOF'
<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools">
  <application android:networkSecurityConfig="@xml/e2e_network" tools:replace="android:networkSecurityConfig" />
</manifest>
EOF

pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; adb reverse --remove "tcp:$HTTPS_PORT" 2>/dev/null || true; }
trap cleanup EXIT

# The emulator reaches the host's loopback as 10.0.2.2, so the embedded gateway
# listens on 127.0.0.1 and the app tunnels to 10.0.2.2:$WG_PORT.
cp -R "$WEB/.next/static" "$WEB/.next/standalone/.next/"
(cd "$WEB/.next/standalone" && env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production \
  HOSTNAME=127.0.0.1 PORT=$WEB_PORT TEMPERANCE_DATA_DIR="$WORK" \
  TEMPERANCE_ADMIN_TOKEN="$ADMIN_TOKEN" TEMPERANCE_GATEWAY_TOKEN="$(openssl rand -hex 24)" \
  TEMPERANCE_PUBLIC_URL="$ORIGIN" TEMPERANCE_VPN_ENDPOINT="10.0.2.2:$WG_PORT" \
  TEMPERANCE_GATEWAY_LISTEN="127.0.0.1:$WG_PORT" TEMPERANCE_TIMEZONE=UTC \
  node server.js > "$WORK/server.log" 2>&1) &
pids+=($!)
node e2e/https-proxy.mjs "$WORK/server.pem" "$WORK/server.key" "$HTTPS_PORT" "$WEB_PORT" &
pids+=($!)

api() { curl -sS --fail-with-body --cacert "$WORK/ca.pem" -H "Origin: $ORIGIN" -H "Content-Type: application/json" "$@"; }
for _ in $(seq 1 60); do api "$ORIGIN/healthz" >/dev/null 2>&1 && break; sleep 1; done
api -X POST "$ORIGIN/api/profiles" -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"name":"Jordan","limit":90}' >/dev/null
api -X POST "$ORIGIN/api/profiles" -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"name":"Riley","limit":60}' >/dev/null
riley=$(api "$ORIGIN/api/state" -H "Authorization: Bearer $ADMIN_TOKEN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).profiles.find(p=>p.name==="Riley").id))')
api -X POST "$ORIGIN/api/users" -H "Authorization: Bearer $ADMIN_TOKEN" -d "{\"username\":\"riley\",\"password\":\"$PASSWORD\",\"profile_id\":$riley}" >/dev/null

adb reverse "tcp:$HTTPS_PORT" "tcp:$HTTPS_PORT" >/dev/null
./gradlew -q connectedDebugAndroidTest -Pe2eDir="$WORK" \
  -Pandroid.testInstrumentationRunnerArguments.class=org.temperance.app.RealServerTest \
  -Pandroid.testInstrumentationRunnerArguments.server="$ORIGIN" \
  -Pandroid.testInstrumentationRunnerArguments.username=riley \
  -Pandroid.testInstrumentationRunnerArguments.password="$PASSWORD" \
  -Pandroid.testInstrumentationRunnerArguments.admin="$ADMIN_TOKEN"

state=$(api "$ORIGIN/api/state" -H "Authorization: Bearer $ADMIN_TOKEN")
node -e '
const s = JSON.parse(process.argv[1]);
const riley = s.profiles.find(p => p.name === "Riley");
const device = s.devices.find(d => d.profile_id === riley.id && !d.revoked);
if (!device) throw new Error("device was not enrolled into Riley: " + JSON.stringify(s.devices));
if (!s.requests.some(r => r.device_id === device.id && r.minutes === 30 && r.status === "approved")) throw new Error("approved time request missing");
if (!s.rewards.some(r => r.profile_id === riley.id && r.kind === "extra_time" && r.minutes === 30)) throw new Error("reward missing");
if (!s.gateway_seen || !(riley.used >= 1)) throw new Error(`no gateway activity recorded: seen=${s.gateway_seen} used=${riley.used}`);
console.log(`Server state OK: ${device.name} browsed through the gateway, ran out of time and was restored by an approved 30 minute request`);
' "$state"
grep -q "Temperance gateway on udp" "$WORK/server.log" || { echo "embedded gateway did not start" >&2; exit 1; }
