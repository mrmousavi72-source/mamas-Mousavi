#!/usr/bin/env bash
# Builds bedo-release.tar.gz: the app, its node_modules, a Node.js runtime
# and the pmtiles tool, so the server needs no npm or GitHub access.
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-v22.23.4}"
PMTILES_VERSION="${PMTILES_VERSION:-1.31.2}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
STAGE="$WORK/bedo"
mkdir -p "$STAGE/runtime"

cd "$ROOT"
git archive HEAD | tar -x -C "$STAGE"
(cd "$STAGE" && npm ci --omit=dev --no-audit --no-fund)

NODE_TAR="node-$NODE_VERSION-linux-x64.tar.xz"
curl -fsSL -o "$STAGE/runtime/$NODE_TAR" "https://nodejs.org/dist/$NODE_VERSION/$NODE_TAR"
curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" | grep " $NODE_TAR\$" |
  (cd "$STAGE/runtime" && sha256sum -c -)

curl -fsSL "https://github.com/protomaps/go-pmtiles/releases/download/v$PMTILES_VERSION/go-pmtiles_${PMTILES_VERSION}_Linux_x86_64.tar.gz" |
  tar -xz -C "$STAGE/runtime" pmtiles

tar -czf "$ROOT/bedo-release.tar.gz" -C "$WORK" bedo
rm -rf "$WORK"
ls -lh "$ROOT/bedo-release.tar.gz"
