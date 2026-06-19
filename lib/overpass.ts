// Fetch ALPR camera locations (DeFlock data, mirrored in OpenStreetMap) from the
// Overpass API. Shared by the refresh cron; mirrors scripts/fetch-cameras.mjs.
import type { Camera } from "./geo";

// Default region: SF Bay Area [south, west, north, east].
export const DEFAULT_BBOX: [number, number, number, number] = [
  37.2, -122.55, 38.05, -121.7,
];

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

export type CameraFile = {
  fetchedAt: string;
  bbox: [number, number, number, number];
  count: number;
  cameras: Camera[];
};

function parseDirection(tags: Record<string, string>): number | null {
  const raw = tags.direction ?? tags["camera:direction"];
  if (raw == null) return null;
  const num = Number(raw);
  if (Number.isFinite(num)) return ((num % 360) + 360) % 360;
  const COMPASS: Record<string, number> = {
    N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
    S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
  };
  return COMPASS[String(raw).toUpperCase().trim()] ?? null;
}

export async function fetchCameras(
  bbox: [number, number, number, number] = DEFAULT_BBOX,
): Promise<CameraFile> {
  const [s, w, n, e] = bbox;
  const ql = `
    [out:json][timeout:180];
    (
      node["man_made"="surveillance"]["surveillance:type"="ALPR"](${s},${w},${n},${e});
      node["man_made"="surveillance"]["surveillance:type"="ANPR"](${s},${w},${n},${e});
    );
    out body;`;

  let lastErr: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "deflockmaps/0.1 (camera-avoidance routing)",
        },
        body: "data=" + encodeURIComponent(ql),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        elements?: Array<{
          type: string;
          id: number;
          lat?: number;
          lon?: number;
          tags?: Record<string, string>;
        }>;
      };
      const cameras: Camera[] = (data.elements ?? [])
        .filter((el) => el.type === "node" && el.lat != null && el.lon != null)
        .map((el) => {
          const tags = el.tags ?? {};
          return {
            id: el.id,
            lat: el.lat as number,
            lon: el.lon as number,
            direction: parseDirection(tags),
            manufacturer: tags.manufacturer ?? null,
            operator: tags.operator ?? null,
          };
        });
      return {
        fetchedAt: new Date().toISOString(),
        bbox,
        count: cameras.length,
        cameras,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("All Overpass endpoints failed");
}
