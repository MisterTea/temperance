#!/bin/bash
# Run only on a disposable macOS signing runner; never imports keys into a user's login keychain.
set -euo pipefail
for name in APPLE_CERTIFICATES_BASE64 APPLE_CERTIFICATES_PASSWORD APPLE_TEAM_ID APPLE_API_KEY_BASE64 APPLE_API_KEY_ID APPLE_API_ISSUER TEMPERANCE_APPLE_VERSION TEMPERANCE_BUILD_NUMBER; do
  [ -n "${!name:-}" ] || { echo "Missing $name" >&2; exit 1; }
done
: "${RUNNER_TEMP:?Use a disposable signing runner}"
temporary=$(mktemp -d "$RUNNER_TEMP/temperance-signing.XXXXXX")
keychain="$temporary/signing.keychain-db"
umask 077
password=$(openssl rand -hex 32)
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$temporary"
}
trap cleanup EXIT
printf '%s' "$APPLE_CERTIFICATES_BASE64" | base64 --decode > "$temporary/certificates.p12"
printf '%s' "$APPLE_API_KEY_BASE64" | base64 --decode > "$temporary/AuthKey.p8"
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
security import "$temporary/certificates.p12" -k "$keychain" -P "$APPLE_CERTIFICATES_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple:,codesign: -k "$password" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain"
auth=(-allowProvisioningUpdates -authenticationKeyPath "$temporary/AuthKey.p8" -authenticationKeyID "$APPLE_API_KEY_ID" -authenticationKeyIssuerID "$APPLE_API_ISSUER")
common=(-project clients/apple/Temperance.xcodeproj -configuration Release "DEVELOPMENT_TEAM=$APPLE_TEAM_ID" "MARKETING_VERSION=$TEMPERANCE_APPLE_VERSION" "CURRENT_PROJECT_VERSION=$TEMPERANCE_BUILD_NUMBER")
mkdir -p build
xcodebuild "${common[@]}" -scheme TemperanceIOS -destination 'generic/platform=iOS' -archivePath build/TemperanceIOS.xcarchive "${auth[@]}" archive
xcodebuild "${common[@]}" -scheme TemperanceMac -destination 'generic/platform=macOS' -archivePath build/TemperanceMac.xcarchive 'CODE_SIGN_IDENTITY=Developer ID Application' ENABLE_HARDENED_RUNTIME=YES "${auth[@]}" archive
python3 - "$temporary" "$APPLE_TEAM_ID" <<'PY'
import plistlib, pathlib, sys
for name, method in [('ios', 'app-store-connect'), ('mac', 'developer-id')]:
    with (pathlib.Path(sys.argv[1]) / (name + '.plist')).open('wb') as f:
        plistlib.dump({'method': method, 'teamID': sys.argv[2], 'signingStyle': 'automatic', 'destination': 'export'}, f)
PY
for platform in ios mac; do
  if [ "$platform" = ios ]; then archive=TemperanceIOS; else archive=TemperanceMac; fi
  xcodebuild -exportArchive -archivePath "build/$archive.xcarchive" -exportPath "build/signed-$platform" -exportOptionsPlist "$temporary/$platform.plist" "${auth[@]}"
done
apps=(build/signed-mac/*.app)
[ "${#apps[@]}" -eq 1 ] && [ -d "${apps[0]}" ] || { echo "Expected one exported macOS app" >&2; exit 1; }
app=${apps[0]}
codesign --verify --deep --strict "$app"
ditto -c -k --keepParent "$app" build/Temperance-macOS.zip
xcrun notarytool submit build/Temperance-macOS.zip --key "$temporary/AuthKey.p8" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple "$app"
spctl --assess --type execute "$app"
ditto -c -k --keepParent "$app" build/Temperance-macOS.zip
shasum -a 256 build/Temperance-macOS.zip build/signed-ios/*.ipa > build/apple-SHA256SUMS
