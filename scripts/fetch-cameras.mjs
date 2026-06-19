#!/usr/bin/env node
/**
 * Fetch ALPR camera locations (DeFlock data, mirrored in OpenStreetMap) from the
 * Overpass API and cache them to data/cameras.json.
 *
 * DeFlock contributes cameras to OSM as:
 *   man_made = surveillance
 *   surveillance:type = ALPR
 *   manufacturer = Flock Safety   (for Flock specifically)
 *   direction = <compass degrees> (often present; ALPRs are directional)
 *
 * Usage:
 *   node scripts/fetch-cameras.mjs                 # default bbox (see below)
 *   node scripts/fetch-cameras.mjs S W N E         # custom bbox (lat/lon)
 *
 * Run this on a schedule (cron) for a real deployment — for the demo, run it
 * once and the result is cached.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// Default demo bbox: San Francisco Bay Area. Override via CLI args (S W N E).
// Querying the whole state is possible but slow on the public Overpass servers.
const DEFAULT_BBOX = [37.2, -122.55, 38.05, -121.7]; // [south, west, north, east]

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const OUT_PATH = new URL("../data/cameras.json", import.meta.url).pathname;

function parseBbox(argv) {
  const args = argv.slice(2).map(Number);
  if (args.length === 4 && args.every((n) => Number.isFinite(n))) return args;
  return DEFAULT_BBOX;
}

/** Normalize a `direction` tag (degrees, or compass like "N"/"NE") to 0-360, or null. */
function parseDirection(tags) {
  const raw = tags.direction ?? tags["camera:direction"];
  if (raw == null) return null;
  const num = Number(raw);
  if (Number.isFinite(num)) return ((num % 360) + 360) % 360;
  const COMPASS = {
    N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
    S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
  };
  return COMPASS[String(raw).toUpperCase().trim()] ?? null;
}

async function queryOverpass(bbox) {
  const [s, w, n, e] = bbox;
  const ql = `
    [out:json][timeout:180];
    (
      node["man_made"="surveillance"]["surveillance:type"="ALPR"](${s},${w},${n},${e});
      node["man_made"="surveillance"]["surveillance:type"="ANPR"](${s},${w},${n},${e});
    );
    out body;`;

  let lastErr;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      console.log(`Querying ${endpoint} for bbox [${bbox.join(", ")}] ...`);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          // Overpass requires a descriptive User-Agent or it returns 406.
          "User-Agent": "deflockmaps-demo/0.1 (camera-avoidance routing demo)",
        },
        body: "data=" + encodeURIComponent(ql),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      console.warn(`  failed: ${err.message}`);
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("All Overpass endpoints failed");
}

async function main() {
  const bbox = parseBbox(process.argv);
  const data = await queryOverpass(bbox);

  const cameras = (data.elements ?? [])
    .filter((el) => el.type === "node" && el.lat != null && el.lon != null)
    .map((el) => {
      const tags = el.tags ?? {};
      return {
        id: el.id,
        lat: el.lat,
        lon: el.lon,
        direction: parseDirection(tags), // 0-360 (compass bearing camera faces) or null
        manufacturer: tags.manufacturer ?? null,
        operator: tags.operator ?? null,
        tags,
      };
    });

  await mkdir(dirname(OUT_PATH), { recursive: true });
  const payload = {
    fetchedAt: new Date().toISOString(),
    bbox,
    count: cameras.length,
    cameras,
  };
  await writeFile(OUT_PATH, JSON.stringify(payload, null, 2));

  const withDir = cameras.filter((c) => c.direction != null).length;
  console.log(`\nSaved ${cameras.length} cameras to data/cameras.json`);
  console.log(`  ${withDir} have a direction tag (${cameras.length - withDir} unknown)`);
}

main().catch((err) => {
  console.error("Failed to fetch cameras:", err);
  process.exit(1);
});
