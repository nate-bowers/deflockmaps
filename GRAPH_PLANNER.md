# Graph planner — activation handoff

> **For a fresh Claude Code session.** This explains the camera-avoidance **graph
> planner** that's already in the codebase but **dormant in production**, and
> exactly how to turn it on when the always-on engine box (Oracle Ampere A1) is
> available. Read `AGENTS.md` first (Next.js 16 has breaking changes; build with
> `--webpack`, not Turbopack).

## Current state (what's true today)

- The graph planner is **built, merged, and deployed** (PR #1) but **OFF in prod**:
  the env var **`PLANNER_URL` is unset**, so `app/api/route` falls back to the
  older **greedy** planner (Valhalla `exclude_polygons`). The live app behaves
  exactly as it did before — activating the graph planner is purely setting
  `PLANNER_URL` once a box can run the service.
- Why it's a separate service: it holds a camera-penalized road graph **in memory**
  (~0.5 GB Bay Area, multiple GB for the US). That can't live in a Vercel function,
  so it runs as a long-lived process on the engine box. The **1 GB Oracle Micro
  can't hold it** alongside Valhalla — it needs the **A1** (or any box with RAM).

## What it does (one paragraph)

Compile Flock-camera penalties **into the road graph once**, then route
**single-pass** with `cost = time + λ·cameras`. Sweeping λ from 0 (fastest) upward
yields the whole fastest→fewest-cameras spectrum, each a clean Dijkstra. It reaches
the **camera-free floor** the greedy sweep couldn't (Tiburon→Atherton: **0 cameras**
vs the greedy's stall at 12) and routes ~100× faster (no per-request engine-call
storm). Reported camera counts are re-measured on the real geometry, so they're
truthful.

## Key files

| File | Role |
|---|---|
| `lib/roadGraph.ts` | Build directed graph from OSM ways; `bakeCameraPenalty` (directional, per-edge; `ePen` direction-aware + `ePenAll` for the toggle); `routeOnGraph` single-pass Dijkstra |
| `lib/graphPlanner.ts` | `planRoutesOnGraph`: λ-sweep → re-measure with `camerasOnRoute` → existing `paretoFilter`/`thinOptions`/`labelOptions` → `PlanResult` |
| `server/planner.mts` | Standalone Node service: `POST /plan`, `GET /health`. Holds the graph in memory |
| `scripts/fetch-road-graph.mjs` | Pull the drivable network for a bbox from Overpass → `road-ways.json` (gitignored) |
| `app/api/route/route.ts` | Calls `PLANNER_URL` when set; **falls back to the greedy planner** if unset/unreachable/error |
| env | `PLANNER_URL` (the service URL), `ROAD_GRAPH_WAYS` (path to the ways file) |

## ACTIVATE — when the A1 (or any RAM box) is up

The Vercel function calls the planner **server-side**, so plain HTTP to the box is
fine (no browser mixed-content) — same pattern as `VALHALLA_URL`.

On the box (Ubuntu, alongside Valhalla):

```bash
# 1. Node 20+ and the repo
sudo apt install -y nodejs npm git    # or nodesource for Node 20+
git clone https://github.com/nate-bowers/deflockmaps.git && cd deflockmaps
npm install

# 2. Build the road-graph source (Bay Area default; pass "S W N E" for another region)
node scripts/fetch-road-graph.mjs            # writes ./road-ways.json (~280 MB Bay Area)

# 3. Run the service (keep it up with systemd / pm2 / nohup). Big graphs need heap:
ROAD_GRAPH_WAYS=road-ways.json NODE_OPTIONS=--max-old-space-size=8192 npm run planner
#   → "[planner] listening on :8090"   (set PLANNER_PORT to change)

# 4. Open port 8090 to the internet (Oracle security list + iptables), like 8002 for Valhalla.
```

Then on Vercel:

```
PLANNER_URL = http://<box-ip>:8090
```

…and redeploy (push to `main` or trigger a redeploy). That's it — the live app now
uses the graph planner, with the greedy planner still there as automatic fallback.

## Verify it's working

```bash
curl http://<box-ip>:8090/health
#   → {"ok":true,"nodes":...,"edges":...,"cameras":...}
```

Then on the live site, route **Tiburon→Atherton** (start `37.8736,-122.4564`,
end `37.4613,-122.1977`) in "max avoidance": you should see a **Camera-free (0)**
option plus a mid option around **12 cameras for a tiny detour**. If you instead
see it stall around 12 with no camera-free option, `PLANNER_URL` is unset/wrong and
it's falling back to greedy — check the env var and `curl /health`.

Other test route: **Sunset SF** (`37.7558,-122.4449` → `37.7785,-122.4136`) →
camera-free at ~3.9 mi.

## Local full-app test (no box needed)

```bash
# terminal 1
ROAD_GRAPH_WAYS=road-ways.json NODE_OPTIONS=--max-old-space-size=8192 npm run planner
# terminal 2 — put PLANNER_URL=http://localhost:8090 in .env.local, then:
npm run dev
# hit the local site / POST /api/route
```

## Daily refresh

The graph **bakes camera positions at startup**, so after the daily camera refresh
(`/api/cron/refresh-cameras` → Blob), **restart the planner service** to pick up new
cameras. Roads rarely change, so you only need to re-run `fetch-road-graph.mjs`
occasionally (or when expanding the region). A `/reload` endpoint would avoid the
restart — not built yet.

## Gotchas

- **RAM**: Bay Area graph ~0.5 GB; US multiple GB. The 1 GB Micro can't host it — use
  the A1 (12 GB) or a box with enough RAM. For large graphs raise
  `NODE_OPTIONS=--max-old-space-size`.
- **The graph planner does NOT use Valhalla.** Only the greedy fallback does. Both
  need the camera dataset (`lib/cameras.ts`).
- **ETAs are graph-estimated** (simple speed model), so times are approximate
  (ranking is fine). Accurate ETAs would require realizing the chosen path through
  Valhalla — a follow-up.
- Build the Next app with `--webpack` (see `AGENTS.md`).

## Field-of-view cone — DONE

The planner models each directional camera's **view cone** (apex at the camera,
axis = its `direction`, range `FOV_RANGE_M`=75 m, half-angle 25°) and penalizes
**any edge the cone touches** — catching cars in view on cross-streets / down the
sightline that a plain radius misses. `segInCone` in `lib/geo.ts`; baked in
`bakeCameraPenalty` (`lib/roadGraph.ts`); the graph planner re-measures with
`camerasOnRoute(..., { fov: true })`. **Scoped to the graph-planner path only** —
the greedy planner and map still use the plain radius (FOV defaults off), because
the greedy avoids via point-bubbles that can't dodge a camera seeing you down a
cross-street. Cone params are the tuning dial (wider = more avoidance, more
detours). To re-tune, edit `FOV_RANGE_M` / `FOV_HALF_ANGLE_DEG` in `lib/geo.ts`.

## Follow-up enhancements (not done yet)

1. **Valhalla-realized ETAs / legality** — realize each menu route through Valhalla
   (waypoints) for accurate time and to respect turn restrictions, then re-measure.
3. **Whole-US** — `node scripts/fetch-road-graph.mjs <US bbox>` + matching RAM; also
   build US Valhalla tiles (for the greedy fallback) per DEPLOY.md.

## References

- `DEPLOY.md` → "Camera-avoidance graph planner" section.
- Engine/host context: the A1 is an Oracle Always-Free capacity lottery; a watcher
  (`scripts/ampere-watch.sh`) runs in the user's terminal until one lands.
