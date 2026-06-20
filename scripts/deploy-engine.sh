#!/usr/bin/env bash
# One-shot, idempotent deploy of the Valhalla engine from prebuilt tiles.
# Run on the VM from the repo root:  sudo bash scripts/deploy-engine.sh
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

TILES_URL="https://github.com/nate-bowers/deflockmaps/releases/download/tiles-v1/valhalla_tiles.tar"

echo "==> Stopping any existing engine..."
docker compose down 2>/dev/null || true

echo "==> Resetting tiles directory..."
rm -rf valhalla_tiles
mkdir -p valhalla_tiles
chmod 777 valhalla_tiles

echo "==> Downloading prebuilt tiles (~256 MB)..."
curl -fL --retry 3 -o valhalla_tiles/valhalla_tiles.tar "$TILES_URL"
size=$(stat -c%s valhalla_tiles/valhalla_tiles.tar)
echo "    downloaded $((size / 1024 / 1024)) MB"
if [ "$size" -lt 100000000 ]; then
  echo "FAIL: tile download is too small ($size bytes). Aborting."
  exit 1
fi

echo "==> Starting engine (serves directly from the tar, no build)..."
docker compose up -d

echo "==> Waiting for it to come online..."
for i in $(seq 1 24); do
  if curl -sf http://localhost:8002/status >/dev/null 2>&1; then
    echo ""
    echo "================ SUCCESS — engine is serving on port 8002 ================"
    curl -s http://localhost:8002/status; echo
    exit 0
  fi
  sleep 5
done

echo ""
echo "NOT serving yet after 2 minutes. Recent logs:"
docker logs --tail 20 deflock-valhalla
exit 1
