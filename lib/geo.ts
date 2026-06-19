// Geometry helpers for camera-avoidance routing.

export type LatLng = { lat: number; lng: number };

const EARTH_RADIUS_M = 6_371_000;

/** Decode a Valhalla-encoded polyline (precision 6) into [lat, lng] points. */
export function decodePolyline(encoded: string, precision = 6): LatLng[] {
  const factor = Math.pow(10, precision);
  let index = 0;
  let lat = 0;
  let lng = 0;
  const coords: LatLng[] = [];

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push({ lat: lat / factor, lng: lng / factor });
  }
  return coords;
}

/**
 * Sample `n` interior points evenly spaced by distance along a route polyline.
 * Used to seed external nav apps (Google Maps) with waypoints so they follow our
 * camera-avoidance path instead of their own fastest route.
 */
export function sampleWaypoints(route: LatLng[], n: number): LatLng[] {
  if (route.length <= 2 || n <= 0) return [];
  const cum = [0];
  for (let i = 1; i < route.length; i++) {
    cum.push(cum[i - 1] + haversine(route[i - 1], route[i]));
  }
  const total = cum[cum.length - 1];
  if (total === 0) return [];

  const points: LatLng[] = [];
  for (let k = 1; k <= n; k++) {
    const target = (total * k) / (n + 1);
    let i = 1;
    while (i < cum.length - 1 && cum[i] < target) i++;
    const segLen = cum[i] - cum[i - 1] || 1;
    const t = (target - cum[i - 1]) / segLen;
    const a = route[i - 1];
    const b = route[i];
    points.push({
      lat: a.lat + (b.lat - a.lat) * t,
      lng: a.lng + (b.lng - a.lng) * t,
    });
  }
  return points;
}

/** Great-circle distance in meters between two points. */
export function haversine(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function toRad(d: number): number {
  return (d * Math.PI) / 180;
}

/**
 * Shortest distance (meters) from point `p` to the segment a–b.
 * Uses a local equirectangular projection — accurate at the scale of a few
 * hundred meters, which is all we need for "is this camera on the road".
 */
export function pointToSegmentMeters(p: LatLng, a: LatLng, b: LatLng): number {
  const latRef = toRad((a.lat + b.lat) / 2);
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos(latRef);

  const px = p.lng * mPerDegLng;
  const py = p.lat * mPerDegLat;
  const ax = a.lng * mPerDegLng;
  const ay = a.lat * mPerDegLat;
  const bx = b.lng * mPerDegLng;
  const by = b.lat * mPerDegLat;

  const dx = bx - ax;
  const dy = by - ay;
  const segLenSq = dx * dx + dy * dy;
  if (segLenSq === 0) return Math.hypot(px - ax, py - ay);

  let t = ((px - ax) * dx + (py - ay) * dy) / segLenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

export type Camera = {
  id: number;
  lat: number;
  lon: number;
  direction: number | null;
  manufacturer: string | null;
  operator: string | null;
};

/** Compass bearing (0-360, degrees) from point a to point b. */
export function bearing(a: LatLng, b: LatLng): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** Smallest absolute angle (0-180) between two compass bearings. */
export function angularDiff(a: number, b: number): number {
  let d = Math.abs(((a - b) % 360) + 360) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/**
 * Classify a camera relative to the direction of travel past it.
 *
 * Model (documented assumption — directionality is genuinely ambiguous in the
 * wild): the camera's `direction` tag is the compass bearing it faces, and it
 * captures vehicles traveling in roughly that same direction (i.e. it monitors
 * the lane flowing the way it points). So:
 *   - "captures": you travel within TOLERANCE of the way the camera faces, OR
 *                 you pass roughly perpendicular (conservative — counted).
 *   - "opposite": you travel within TOLERANCE of the *opposite* of the camera
 *                 facing — likely the other carriageway, not captured.
 *   - "unknown":  no direction tag — treated as capturing (conservative).
 */
export type CameraClass = "captures" | "opposite" | "unknown";

const DIRECTION_TOLERANCE = 50; // degrees

export function classifyCamera(
  camera: Camera,
  travelBearing: number,
): CameraClass {
  if (camera.direction == null) return "unknown";
  const delta = angularDiff(travelBearing, camera.direction);
  if (delta >= 180 - DIRECTION_TOLERANCE) return "opposite";
  return "captures";
}

export type CameraHit = {
  camera: Camera;
  /** bearing of travel along the nearest route segment, 0-360 */
  travelBearing: number;
  classification: CameraClass;
};

/**
 * Return the cameras within `thresholdM` meters of a route polyline, each
 * annotated with the direction of travel past it and a capture classification.
 * The route is an ordered list of points (start → end).
 */
export function camerasOnRoute(
  route: LatLng[],
  cameras: Camera[],
  thresholdM = 30,
): CameraHit[] {
  if (route.length < 2) return [];
  const hits: CameraHit[] = [];
  for (const cam of cameras) {
    const p = { lat: cam.lat, lng: cam.lon };
    let minDist = Infinity;
    let bestSeg = 0;
    for (let i = 0; i + 1 < route.length; i++) {
      const d = pointToSegmentMeters(p, route[i], route[i + 1]);
      if (d < minDist) {
        minDist = d;
        bestSeg = i;
      }
    }
    if (minDist <= thresholdM) {
      const travelBearing = bearing(route[bestSeg], route[bestSeg + 1]);
      hits.push({
        camera: cam,
        travelBearing,
        classification: classifyCamera(cam, travelBearing),
      });
    }
  }
  return hits;
}

/**
 * Build a small polygon (ring of [lng, lat]) approximating a circle of
 * `radiusM` meters around a camera — used as a Valhalla `exclude_polygons`
 * entry to hard-avoid that camera.
 */
export function circlePolygon(
  lat: number,
  lon: number,
  radiusM = 25,
  sides = 8,
): [number, number][] {
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos(toRad(lat));
  const ring: [number, number][] = [];
  for (let i = 0; i < sides; i++) {
    const theta = (2 * Math.PI * i) / sides;
    const dLat = (radiusM * Math.sin(theta)) / mPerDegLat;
    const dLng = (radiusM * Math.cos(theta)) / mPerDegLng;
    ring.push([lon + dLng, lat + dLat]);
  }
  ring.push(ring[0]); // close the ring
  return ring;
}
