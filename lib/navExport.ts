// Deep links into external navigation apps + shareable-link encoding.
import { sampleWaypoints, type LatLng } from "./geo";

const fmt = (p: LatLng) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;

/**
 * Google Maps directions URL. Google supports intermediate waypoints, so we
 * sample points along our computed route — this makes Google actually follow
 * the camera-avoidance path rather than recomputing its own fastest route.
 * (api=1 supports up to ~9 waypoints.)
 */
export function googleMapsUrl(
  start: LatLng,
  end: LatLng,
  routeGeometry: LatLng[],
): string {
  const waypoints = sampleWaypoints(routeGeometry, 8);
  const params = new URLSearchParams({
    api: "1",
    origin: fmt(start),
    destination: fmt(end),
    travelmode: "driving",
  });
  if (waypoints.length) {
    params.set("waypoints", waypoints.map(fmt).join("|"));
  }
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/**
 * Apple Maps URL. Apple's URL scheme does NOT support intermediate waypoints,
 * so this navigates straight to the destination (won't follow our route).
 */
export function appleMapsUrl(start: LatLng, end: LatLng): string {
  return `https://maps.apple.com/?saddr=${fmt(start)}&daddr=${fmt(end)}&dirflg=d`;
}

/** Waze URL — destination only (no waypoint support). */
export function wazeUrl(end: LatLng): string {
  return `https://waze.com/ul?ll=${fmt(end)}&navigate=yes`;
}

/**
 * Build a GPX 1.1 track of the full route geometry — imports into OsmAnd, Gaia,
 * Garmin, Komoot, etc. as a precise followable path (a good fallback for the
 * apps whose deep links can't take our waypoints).
 */
export function buildGpx(name: string, routeGeometry: LatLng[]): string {
  const pts = routeGeometry
    .map((p) => `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}" />`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="DeFlock Maps" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${name.replace(/[<&>]/g, "")}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

// ---- Shareable links --------------------------------------------------------

export type ShareState = {
  start: LatLng;
  end: LatLng;
  useDirection: boolean;
  level: "balanced" | "max";
};

export function encodeShareParams(s: ShareState): string {
  const params = new URLSearchParams({
    s: fmt(s.start),
    e: fmt(s.end),
    dir: s.useDirection ? "1" : "0",
    lvl: s.level,
  });
  return params.toString();
}

function parsePt(v: string | null): LatLng | null {
  if (!v) return null;
  const [lat, lng] = v.split(",").map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

export function decodeShareParams(search: string): Partial<ShareState> | null {
  const p = new URLSearchParams(search);
  const start = parsePt(p.get("s"));
  const end = parsePt(p.get("e"));
  if (!start || !end) return null;
  return {
    start,
    end,
    useDirection: p.get("dir") !== "0",
    level: p.get("lvl") === "max" ? "max" : "balanced",
  };
}
