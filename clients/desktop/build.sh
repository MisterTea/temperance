#!/bin/sh
set -eu
cd "$(dirname "$0")"
mkdir -p ../../build
for os in linux windows; do
  for arch in amd64 arm64; do
    suffix=''; [ "$os" != windows ] || suffix='.exe'
    GOOS="$os" GOARCH="$arch" go build -trimpath -o "../../build/temperance-$os-$arch$suffix" .
  done
done
