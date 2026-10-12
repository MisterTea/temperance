#!/usr/bin/env bash
# Builds temperance-core for mobile platforms and generates UniFFI bindings.
#   ./build-bindings.sh apple     -> clients/apple/Core (XCFramework + Swift)
#   ./build-bindings.sh android   -> clients/android/app/src/main/{jniLibs,java}
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)
LIB=temperance_core
PROFILE=${PROFILE:-release}

# Bindings are generated from an unstripped debug build: the release profile
# strips symbols, which removes UniFFI's metadata on Linux.
host_library() {
  cargo build -p temperance-core >&2
  local dir=target/debug
  for ext in dylib so dll; do
    [ -f "$dir/lib$LIB.$ext" ] && { echo "$dir/lib$LIB.$ext"; return; }
  done
  echo "$dir/$LIB.dll"
}

apple() {
  local out=$ROOT/clients/apple/Core
  rm -rf "$out" && mkdir -p "$out/headers"
  for target in aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios aarch64-apple-darwin x86_64-apple-darwin; do
    cargo build -p temperance-core --profile "$PROFILE" --target "$target"
  done
  cargo run -q -p uniffi-bindgen -- generate --library "$(host_library)" --language swift --out-dir "$out/generated"
  cp "$out/generated/${LIB}FFI.h" "$out/headers/"
  cp "$out/generated/${LIB}FFI.modulemap" "$out/headers/module.modulemap"
  mkdir -p "$out/lib"
  lipo -create target/aarch64-apple-ios-sim/$PROFILE/lib$LIB.a target/x86_64-apple-ios/$PROFILE/lib$LIB.a -output "$out/lib/ios-sim.a"
  lipo -create target/aarch64-apple-darwin/$PROFILE/lib$LIB.a target/x86_64-apple-darwin/$PROFILE/lib$LIB.a -output "$out/lib/macos.a"
  xcodebuild -create-xcframework \
    -library target/aarch64-apple-ios/$PROFILE/lib$LIB.a -headers "$out/headers" \
    -library "$out/lib/ios-sim.a" -headers "$out/headers" \
    -library "$out/lib/macos.a" -headers "$out/headers" \
    -output "$out/TemperanceCoreFFI.xcframework"
  mkdir -p "$out/Sources"
  test -s "$out/generated/$LIB.swift" || { echo "Swift bindings were not generated" >&2; exit 1; }
  mv "$out/generated/$LIB.swift" "$out/Sources/TemperanceCore.swift"
  rm -rf "$out/generated" "$out/headers" "$out/lib"
}

android() {
  local app=$ROOT/clients/android/app/src/main
  cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 -t x86 -P 26 -o "$app/jniLibs" build -p temperance-core --profile "$PROFILE"
  cargo run -q -p uniffi-bindgen -- generate --library "$(host_library)" --language kotlin --out-dir "$app/java"
  test -s "$app/java/uniffi/temperance_core/temperance_core.kt" || { echo "Kotlin bindings were not generated" >&2; exit 1; }
}

case "${1:-all}" in
  apple) apple ;;
  android) android ;;
  all) apple; android ;;
  *) echo "usage: $0 [apple|android|all]" >&2; exit 2 ;;
esac
