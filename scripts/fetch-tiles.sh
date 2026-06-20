#!/usr/bin/env bash
# Download the prebuilt Bay Area Valhalla tiles into ./valhalla_tiles/ so a
# low-power host can serve routes without doing the slow tile build.
# Run from the repo root: bash scripts/fetch-tiles.sh
set -euo pipefail

URL="https://github.com/nate-bowers/deflockmaps/releases/download/tiles-v1/valhalla_tiles.tar"

mkdir -p valhalla_tiles
chmod 777 valhalla_tiles

echo "Downloading prebuilt tiles..."
curl -fL -o valhalla_tiles/valhalla_tiles.tar "$URL"

size=$(stat -c%s valhalla_tiles/valhalla_tiles.tar 2>/dev/null || stat -f%z valhalla_tiles/valhalla_tiles.tar)
echo "Downloaded $(( size / 1024 / 1024 )) MB."
if [ "$size" -lt 100000000 ]; then
  echo "ERROR: file is too small — the download failed. Try again."
  exit 1
fi
echo "OK: valhalla_tiles/valhalla_tiles.tar is in place."
