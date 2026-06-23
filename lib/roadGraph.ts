// A directed road graph with a baked-in per-edge camera penalty, plus a
// single-pass shortest-path that trades travel time against camera exposure.
//
// This is the core of the camera-avoidance planner: instead of repeatedly asking
// the routing engine to exclude cameras (slow, gets stuck in local optima), we
// compile the camera cost INTO the graph ONCE and then route in a single pass —
// cost(edge) = time + λ·cameras. Sweeping λ from 0 (fastest) upward yields the
// whole fastest→fewest-cameras spectrum, each a clean Dijkstra. See
// lib/graphPlanner.ts for the planner that drives it.
import {
  bearing,
  classifyCamera,
  haversine,
  pointToSegmentMeters,
  segInCone,
  FOV_RANGE_M,
  type Camera,
  type LatLng,
} from "./geo";

/** One drivable OSM way: node ids + their coordinates + tags (Overpass `out geom`). */
export type OsmWay = {
  nodes: number[];
  geometry: { lat: number; lon: number }[];
  tags?: Record<string, string>;
};

/** A compiled directed road graph (CSR adjacency, typed arrays). */
export type RoadGraph = {
  N: number;
  E: number;
  nLat: Float64Array;
  nLng: Float64Array;
  /** CSR: edges of node u are adj[off[u] .. off[u+1]) */
  off: Int32Array;
  adj: Int32Array;
  eFrom: Int32Array;
  eTo: Int32Array;
  /** free-flow travel time of each directed edge, seconds */
  eTime: Float64Array;
  /** baked penalty: # cameras capturing travel along this edge (direction-aware) */
  ePen: Float64Array;
  /** baked penalty: # cameras within range regardless of facing (toggle off) */
  ePenAll: Float64Array;
};

// Default free-flow speeds (km/h) by OSM highway class when maxspeed is absent.
const KPH: Record<string, number> = {
  motorway: 105, trunk: 90, primary: 65, secondary: 55, tertiary: 45,
  unclassified: 40, residential: 30, living_street: 15, service: 20,
  motorway_link: 60, trunk_link: 50, primary_link: 40, secondary_link: 35, tertiary_link: 30,
};

function speedMs(tags: Record<string, string> = {}): number {
  const ms = tags.maxspeed;
  if (ms) {
    const m = ms.match(/(\d+)\s*(mph)?/);
    if (m) { const v = Number(m[1]); return ((m[2] ? v * 1.60934 : v) * 1000) / 3600; }
  }
  return ((KPH[tags.highway ?? ""] ?? 40) * 1000) / 3600;
}

/** Build a directed graph from drivable OSM ways (oneway-aware). */
export function buildRoadGraph(ways: OsmWay[]): RoadGraph {
  const idx = new Map<number, number>();
  const nLatA: number[] = [], nLngA: number[] = [];
  const nodeIdx = (osm: number, lat: number, lon: number) => {
    let i = idx.get(osm);
    if (i === undefined) { i = nLatA.length; idx.set(osm, i); nLatA.push(lat); nLngA.push(lon); }
    return i;
  };
  const eFromA: number[] = [], eToA: number[] = [], eTimeA: number[] = [];
  for (const w of ways) {
    const ow = w.tags?.oneway;
    const fwdOnly = ow === "yes" || ow === "true" || ow === "1" || w.tags?.junction === "roundabout";
    const revOnly = ow === "-1";
    const sp = speedMs(w.tags);
    for (let k = 0; k + 1 < w.nodes.length; k++) {
      const g0 = w.geometry[k], g1 = w.geometry[k + 1];
      if (!g0 || !g1) continue;
      const u = nodeIdx(w.nodes[k], g0.lat, g0.lon);
      const v = nodeIdx(w.nodes[k + 1], g1.lat, g1.lon);
      const t = haversine({ lat: g0.lat, lng: g0.lon }, { lat: g1.lat, lng: g1.lon }) / sp;
      if (!revOnly) { eFromA.push(u); eToA.push(v); eTimeA.push(t); }
      if (!fwdOnly) { eFromA.push(v); eToA.push(u); eTimeA.push(t); }
    }
  }
  const N = nLatA.length, E = eToA.length;
  const eFrom = Int32Array.from(eFromA), eTo = Int32Array.from(eToA);
  const eTime = Float64Array.from(eTimeA);
  const nLat = Float64Array.from(nLatA), nLng = Float64Array.from(nLngA);

  // CSR adjacency.
  const off = new Int32Array(N + 1);
  for (let e = 0; e < E; e++) off[eFrom[e] + 1]++;
  for (let i = 0; i < N; i++) off[i + 1] += off[i];
  const adj = new Int32Array(E);
  const cur = off.slice(0, N);
  for (let e = 0; e < E; e++) adj[cur[eFrom[e]]++] = e;

  return {
    N, E, nLat, nLng, off, adj, eFrom, eTo, eTime,
    ePen: new Float64Array(E), ePenAll: new Float64Array(E),
  };
}

/**
 * Bake the camera penalty into each directed edge: ePen[e] = number of cameras
 * that capture travel along that edge (within `thresholdM`, facing this way or
 * unknown — the opposite carriageway is not penalized). Directional and per-edge,
 * so the southbound lane past a northbound-facing camera stays free.
 */
export function bakeCameraPenalty(g: RoadGraph, cameras: Camera[], thresholdM = 30): void {
  const CELL = 0.0025; // ~250 m
  const grid = new Map<string, number[]>();
  for (let ci = 0; ci < cameras.length; ci++) {
    const c = cameras[ci];
    const k = `${Math.floor(c.lat / CELL)}:${Math.floor(c.lon / CELL)}`;
    const b = grid.get(k); if (b) b.push(ci); else grid.set(k, [ci]);
  }
  const padLat = FOV_RANGE_M / 111_320;
  for (let e = 0; e < g.E; e++) {
    const a = { lat: g.nLat[g.eFrom[e]], lng: g.nLng[g.eFrom[e]] };
    const b = { lat: g.nLat[g.eTo[e]], lng: g.nLng[g.eTo[e]] };
    const tb = bearing(a, b);
    const padLng = FOV_RANGE_M / (111_320 * Math.max(0.01, Math.cos((a.lat * Math.PI) / 180)));
    const clo = Math.floor((Math.min(a.lat, b.lat) - padLat) / CELL) - 1;
    const chi = Math.floor((Math.max(a.lat, b.lat) + padLat) / CELL) + 1;
    const glo = Math.floor((Math.min(a.lng, b.lng) - padLng) / CELL) - 1;
    const ghi = Math.floor((Math.max(a.lng, b.lng) + padLng) / CELL) + 1;
    let cap = 0, all = 0;
    for (let cl = clo; cl <= chi; cl++) for (let cg = glo; cg <= ghi; cg++) {
      const bucket = grid.get(`${cl}:${cg}`);
      if (!bucket) continue;
      for (const ci of bucket) {
        const cam = cameras[ci];
        // Captured if within the proximity floor OR inside the camera's view cone
        // (down its sightline / onto a cross-street) — catches cars in view that a
        // plain radius misses.
        const d = pointToSegmentMeters({ lat: cam.lat, lng: cam.lon }, a, b);
        if (d > FOV_RANGE_M) continue;
        const captured =
          d <= thresholdM ||
          (cam.direction != null &&
            segInCone(cam.lat, cam.lon, cam.direction, a, b));
        if (!captured) continue;
        all++;
        if (classifyCamera(cam, tb) !== "opposite") cap++;
      }
    }
    g.ePen[e] = cap;
    g.ePenAll[e] = all;
  }
}

/** Nearest graph node to a point (brute force; one-off per request endpoint). */
export function nearestNode(g: RoadGraph, p: LatLng): number {
  let best = -1, bd = Infinity;
  for (let i = 0; i < g.N; i++) {
    const d = haversine(p, { lat: g.nLat[i], lng: g.nLng[i] });
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// Binary min-heap keyed by cost (parallel arrays, lazy-delete via dist check).
class MinHeap {
  private c: number[] = [];
  private v: number[] = [];
  get size() { return this.c.length; }
  push(cost: number, node: number) {
    this.c.push(cost); this.v.push(node);
    let i = this.c.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (this.c[p] <= this.c[i]) break; this.swap(i, p); i = p; }
  }
  pop(): [number, number] {
    const c = this.c[0], v = this.v[0], n = this.c.length - 1;
    this.c[0] = this.c[n]; this.v[0] = this.v[n]; this.c.pop(); this.v.pop();
    let i = 0; const L = this.c.length;
    while (true) {
      let s = i; const l = 2 * i + 1, r = l + 1;
      if (l < L && this.c[l] < this.c[s]) s = l;
      if (r < L && this.c[r] < this.c[s]) s = r;
      if (s === i) break; this.swap(i, s); i = s;
    }
    return [c, v];
  }
  private swap(a: number, b: number) {
    const tc = this.c[a]; this.c[a] = this.c[b]; this.c[b] = tc;
    const tv = this.v[a]; this.v[a] = this.v[b]; this.v[b] = tv;
  }
}

export type GraphRoute = { geometry: LatLng[]; timeSec: number; distanceMi: number };

/**
 * Single-pass shortest path minimizing time + λ·cameras from src to dst.
 * λ = 0 is fastest; large λ is fewest cameras (camera-free if one exists).
 */
export function routeOnGraph(
  g: RoadGraph,
  src: number,
  dst: number,
  lambda: number,
  useDirection = true,
): GraphRoute | null {
  const pen = useDirection ? g.ePen : g.ePenAll;
  const dist = new Float64Array(g.N).fill(Infinity);
  const prev = new Int32Array(g.N).fill(-1);
  dist[src] = 0;
  const h = new MinHeap();
  h.push(0, src);
  while (h.size) {
    const [d, u] = h.pop();
    if (d > dist[u]) continue;
    if (u === dst) break;
    for (let p = g.off[u]; p < g.off[u + 1]; p++) {
      const e = g.adj[p], v = g.eTo[e];
      const nd = d + g.eTime[e] + lambda * pen[e];
      if (nd < dist[v]) { dist[v] = nd; prev[v] = e; h.push(nd, v); }
    }
  }
  if (dist[dst] === Infinity) return null;

  const geometry: LatLng[] = [];
  let timeSec = 0, meters = 0;
  let u = dst;
  while (u !== src) {
    const e = prev[u];
    if (e < 0) break;
    geometry.push({ lat: g.nLat[u], lng: g.nLng[u] });
    timeSec += g.eTime[e];
    meters += haversine({ lat: g.nLat[g.eFrom[e]], lng: g.nLng[g.eFrom[e]] }, { lat: g.nLat[u], lng: g.nLng[u] });
    u = g.eFrom[e];
  }
  geometry.push({ lat: g.nLat[src], lng: g.nLng[src] });
  geometry.reverse();
  return { geometry, timeSec, distanceMi: meters / 1609.34 };
}
