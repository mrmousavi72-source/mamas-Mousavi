#!/usr/bin/env bash
# Extracts Iran from the latest Protomaps daily OpenStreetMap build into
# data/iran.pmtiles. Only the tiles inside the bounding box are downloaded
# (HTTP range requests), not the whole planet.
#
# Requires the pmtiles CLI: https://github.com/protomaps/go-pmtiles/releases
# Usage: scripts/build-iran-map.sh [max-zoom]   (default 15)
set -euo pipefail

MAX_ZOOM="${1:-15}"
PMTILES="${PMTILES:-pmtiles}"
OUT="${OUT:-$(dirname "$0")/../data/iran.pmtiles}"
# Iran with a small margin: west, south, east, north.
BBOX="43.9,24.8,63.4,39.9"

for days_ago in $(seq 0 10); do
  day=$(date -u -d "-${days_ago} day" +%Y%m%d)
  url="https://build.protomaps.com/${day}.pmtiles"
  if curl -sfI "$url" >/dev/null; then
    echo "Using build ${day}"
    mkdir -p "$(dirname "$OUT")"
    "$PMTILES" extract "$url" "$OUT.tmp" --bbox="$BBOX" --maxzoom="$MAX_ZOOM"
    mv "$OUT.tmp" "$OUT"
    "$PMTILES" show "$OUT"
    exit 0
  fi
done

echo "No Protomaps build found in the last 10 days (is build.protomaps.com reachable?)" >&2
exit 1
