#!/usr/bin/env node
// Fetch the drivable road network for a region from Overpass and cache it as the
// road-graph source the camera-avoidance planner service compiles at startup.
//
//   node scripts/fetch-road-graph.mjs                 # default Bay Area bbox
//   node scripts/fetch-road-graph.mjs S W N E         # custom bbox
//   ROAD_GRAPH_WAYS=/path/out.json node scripts/fetch-road-graph.mjs
//
// Output is large (Bay Area ≈ 280 MB) and gitignored — it lives on the box that
// runs the planner service, regenerated alongside the camera refresh.
import { writeFile } from "node:fs/promises";

// Default region: SF Bay Area [south, west, north, east] (matches DEFAULT_BBOX).
const [s, w, n, e] = process.argv.slice(2).map(Number).length === 4
  ? process.argv.slice(2).map(Number)
  : [37.2, -122.55, 38.05, -121.7];
const OUT = process.env.ROAD_GRAPH_WAYS ?? "road-ways.json";

const DRIVABLE =
  "motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|service";
const ql = `[out:json][timeout:300];
way["highway"~"^(${DRIVABLE})$"]["access"!~"^(no|private)$"](${s},${w},${n},${e});
out geom;`;

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

console.log(`Fetching drivable roads for bbox [${s}, ${w}, ${n}, ${e}] ...`);
let text = null;
for (const url of ENDPOINTS) {
  try {
    const t0 = Date.now();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "deflockmaps/0.1 (camera-avoidance routing)" },
      body: "data=" + encodeURIComponent(ql),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
    console.log(`  ${(text.length / 1e6).toFixed(1)} MB from ${url} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    break;
  } catch (err) {
    console.log(`  ${url} failed: ${err.message}`);
  }
}
if (!text) { console.error("All Overpass endpoints failed."); process.exit(1); }

const data = JSON.parse(text);
const ways = (data.elements ?? []).filter((el) => el.type === "way" && el.geometry && el.nodes);
console.log(`  ${ways.length} drivable ways`);
await writeFile(OUT, JSON.stringify(ways));
console.log(`Wrote ${OUT}`);
