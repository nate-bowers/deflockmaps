# DeFlock Maps — camera-avoidance routing (local demo)

A web app that pulls ALPR ("Flock") camera locations from DeFlock/OpenStreetMap and
plans driving routes that avoid being captured — offering a spectrum of options
from *fastest (most cameras)* to *camera-free (longest)*, or telling you when no
camera-free route exists.

Runs **100% locally and free** — no paid APIs, no API keys.

## Stack

- **Next.js** (App Router) + **MapLibre GL** — UI and map
- **Overpass API** — one-time fetch of ALPR cameras (cached to `data/cameras.json`)
- **Valhalla** in Docker — local routing engine (unlimited calls, no quota)

## One-time setup

```bash
npm install

# 1. Start the routing engine. First run downloads the California OSM extract
#    (~1 GB) and builds routing tiles — this takes a while. Watch progress with:
#       docker logs -f deflock-valhalla
#    It's ready when the log says the server is listening on 8002.
docker compose up -d

# 2. Fetch camera data (defaults to the SF Bay Area bounding box).
#    Pass a custom bbox as: node scripts/fetch-cameras.mjs S W N E
node scripts/fetch-cameras.mjs
```

## Run

```bash
npm run dev
# open the printed http://localhost:PORT
```

Set a **start** and **destination** by either typing an address / `lat, lng` into
the input boxes (Enter to resolve — addresses are geocoded via OSM Nominatim) or
clicking the map. Route options then appear; click a card to highlight that route
and the cameras it passes — **red** = cameras capturing your direction of travel,
**amber** = cameras facing the other way (shown but not avoided). Use **Reset** to
start over.

### Directional avoidance

The **"Use camera direction"** toggle controls how the `direction` tag is used:

- **On (default):** a camera is only avoided if it faces roughly your direction of
  travel (or has no direction data). Cameras facing the opposite way (the other
  carriageway) are treated as pass-through — shown in amber, not routed around.
- **Off:** every camera near the route is avoided, regardless of facing.

The capture model is a documented assumption (see `classifyCamera` in `lib/geo.ts`):
directionality is genuinely ambiguous in the wild, so "facing your way OR unknown"
is treated conservatively as a capture. A true *graduated* cost (reduced-but-nonzero
for opposite-facing) would need a custom Valhalla costing model — a future step
beyond this hard-exclusion demo.

## How routing works

`lib/planRoutes.ts` implements a **greedy incremental-exclusion sweep**:

1. Route normally → find which cameras capture the route (within `ROUTE_THRESHOLD_M`).
2. Try excluding **one** camera (a small `exclude_polygons` bubble of
   `EXCLUDE_RADIUS_M`) and re-route. If that succeeds, the route has peeled onto a
   quieter parallel/side street to dodge it; if it makes routing impossible, the
   camera is on the only through-road — mark it **un-dodgeable** and skip it.
3. Repeat on the new route, accumulating exclusions, until no more cameras can be
   dodged (or a camera-free route is found).
4. Keep only the **Pareto-efficient** options (none both slower *and* more exposed
   than another), then **thin** them to a short menu: always the two endpoints
   (Fastest + Fewest cameras) plus at most 3 middle options. A middle is dropped
   unless it cuts cameras meaningfully from the previous kept option *and* is
   meaningfully faster than the fewest-cameras route — so you never see a
   "one fewer camera, one more minute" near-duplicate (`thinOptions`).

Excluding cameras **one at a time** (rather than all at once) is what lets the
planner distinguish "dodgeable via a side street" from "on the only road", produce
a real spectrum of options, and stay far under Valhalla's exclude-polygon budget
even on hour-long routes. `EXCLUDE_RADIUS_M` is deliberately larger than
`ROUTE_THRESHOLD_M` so an excluded camera can't be re-counted on the detour, which
keeps the sweep making progress instead of stalling.

### Avoidance strength

Because each excluded camera is a *hard* (infinite-cost) constraint, the only thing
bounding how far the route will detour is the sweep's iteration budget. That budget
is exposed as an avoidance level (`AvoidanceLevel` in `lib/planRoutes.ts`):

- **Balanced** (default) — fast, bounded sweep (~12 detours). Sensible time/camera
  tradeoffs.
- **Maximum avoidance** — pushes the sweep to exhaustion (up to ~200 detours).
  Treats every camera as effectively infinite-cost and accepts arbitrarily large
  detours — a 10× slower route to reach zero (or the fewest possible) cameras.
  Takes a few seconds longer.

## Data notes

- Cameras come from OSM tags `man_made=surveillance` + `surveillance:type=ALPR`.
- Most Bay Area cameras carry a `direction` tag (compass bearing), used for the
  directional avoidance described above.

## Configuration

- Routing region: edit `tile_urls` in `docker-compose.yml`, delete `valhalla_tiles/`,
  and `docker compose up -d` to rebuild.
- Camera area: re-run `scripts/fetch-cameras.mjs` with a bbox.
- Valhalla URL: `VALHALLA_URL` env var (default `http://localhost:8002`).
