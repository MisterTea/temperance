#!/bin/sh
# Builds the Rust desktop client (core/temperance-desktop) into ../../build.
# Cross targets use cargo-zigbuild when it is installed; CI builds natively.
set -eu
cd "$(dirname "$0")/../../core"
mkdir -p ../build
build() { # rust-target os arch
  if [ "$1" = "$(rustc -vV | sed -n 's/^host: //p')" ]; then cargo build --release -p temperance-desktop --target "$1"
  else cargo zigbuild --release -p temperance-desktop --target "$1"; fi
  suffix=''; [ "$2" != windows ] || suffix='.exe'
  cp "target/$1/release/temperance$suffix" "../build/temperance-$2-$3$suffix"
}
for spec in ${TARGETS:-x86_64-unknown-linux-gnu:linux:amd64 aarch64-unknown-linux-gnu:linux:arm64 x86_64-pc-windows-gnu:windows:amd64}; do
  IFS=:; set -- $spec; unset IFS
  build "$1" "$2" "$3"
done
