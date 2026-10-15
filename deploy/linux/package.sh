#!/bin/sh
# Builds dist/temperance-<version>-linux-<arch>.tar.gz (Node.js runtime included) and,
# when nfpm is installed, matching .deb and .rpm packages.
#   deploy/linux/package.sh <x64|arm64> <version> <libtemperance_gateway.so>
# Run `npm run build` in web/ first; its standalone output is the same for every
# architecture. Build the add-on against glibc 2.28, the floor of Node.js 24's own
# Linux binaries, e.g. `cargo zigbuild --target aarch64-unknown-linux-gnu.2.28`.
set -eu
arch=$1 version=$2 addon=$3
case "$arch" in x64) deb=amd64 ;; arm64) deb=arm64 ;; *) echo "arch must be x64 or arm64" >&2; exit 1 ;; esac
repo=$(cd "$(dirname "$0")/../.." && pwd)
web=$repo/web
dist=$repo/dist
name=temperance-$version-linux-$arch
root=$dist/$name
[ -f "$web/.next/standalone/server.js" ] || { echo "Run npm run build in web/ first" >&2; exit 1; }
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

node_version=${NODE_VERSION:-$(curl -fsSL https://nodejs.org/dist/index.json |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).find(r=>r.version.startsWith("v24.")).version))')}
cache=$dist/cache && mkdir -p "$cache"
node_tar=node-$node_version-linux-$arch.tar.xz
if [ ! -f "$cache/$node_tar" ]; then
  curl -fsSL "https://nodejs.org/dist/$node_version/$node_tar" -o "$cache/$node_tar.part"
  curl -fsSL "https://nodejs.org/dist/$node_version/SHASUMS256.txt" -o "$cache/SHASUMS256-$node_version.txt"
  expected=$(grep " $node_tar\$" "$cache/SHASUMS256-$node_version.txt" | cut -d' ' -f1)
  [ "$(sha256 "$cache/$node_tar.part" | cut -d' ' -f1)" = "$expected" ] || { echo "Node.js checksum mismatch" >&2; exit 1; }
  mv "$cache/$node_tar.part" "$cache/$node_tar"
fi

rm -rf "$root" && mkdir -p "$root/node/bin"
tar -xJf "$cache/$node_tar" -C "$cache" "node-$node_version-linux-$arch/bin/node" "node-$node_version-linux-$arch/LICENSE"
mv "$cache/node-$node_version-linux-$arch/bin/node" "$root/node/bin/node"
mv "$cache/node-$node_version-linux-$arch/LICENSE" "$root/node/LICENSE"
rm -rf "$cache/node-$node_version-linux-$arch"

cp -R "$web/.next/standalone" "$root/app"
mkdir -p "$root/app/scripts"
cp "$web/scripts/recovery.cjs" "$root/app/scripts/recovery.cjs"
cp "$web/scripts/acceptance.mjs" "$root/app/scripts/acceptance.mjs"
# sharp (Next's image optimizer, unused) is the only other native code in the bundle.
rm -rf "$root/app/.env"* "$root/app/node_modules/@temperance/gateway-addon/"*.node \
  "$root/app/node_modules/sharp" "$root/app/node_modules/@img"
cp -R "$web/.next/static" "$root/app/.next/static"
[ -d "$web/public" ] && cp -R "$web/public" "$root/app/public"
cp "$addon" "$root/app/node_modules/@temperance/gateway-addon/temperance-gateway.linux-$arch.node"
cp "$repo/deploy/home/install-linux.sh" "$root/install.sh"
cp "$repo/deploy/home/temperance.service" "$root/temperance.service"
cp "$repo/deploy/home/ap-prepare.sh" "$root/ap-prepare.sh"
chmod 755 "$root/ap-prepare.sh"
cp "$repo/deploy/.env.example" "$root/temperance.env.example"
cp "$repo/LICENSE" "$root/LICENSE"
printf 'Temperance %s for Linux %s (Node.js %s, glibc 2.28 or newer).\nInstall: sudo ./install.sh, then see https://github.com/MisterTea/temperance/blob/main/docs/deployment.md\n' \
  "$version" "$arch" "$node_version" > "$root/README.txt"
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$dist/$name.tar.gz" -C "$dist" "$name"
echo "$dist/$name.tar.gz"

if command -v nfpm >/dev/null; then
  sed -e "s|@ROOT@|$root|g" -e "s|@VERSION@|$version|g" -e "s|@ARCH@|$deb|g" \
    "$repo/deploy/linux/nfpm.yaml" > "$dist/nfpm-$arch.yaml"
  for packager in deb rpm; do
    (cd "$repo" && nfpm package -f "$dist/nfpm-$arch.yaml" -p "$packager" -t "$dist/")
  done
fi
