// Thin client for the local Valhalla routing engine (docker-compose service).
import { decodePolyline, type LatLng } from "./geo";

const VALHALLA_URL = process.env.VALHALLA_URL ?? "http://localhost:8002";

export type RouteResult = {
  geometry: LatLng[];
  /** travel time in seconds */
  timeSec: number;
  /** distance in miles */
  distanceMi: number;
};

export class NoRouteError extends Error {
  constructor(message = "No route found") {
    super(message);
    this.name = "NoRouteError";
  }
}

/** A single engine call took too long and was aborted (engine slow/overloaded). */
export class EngineTimeoutError extends Error {
  constructor(message = "Routing engine timed out") {
    super(message);
    this.name = "EngineTimeoutError";
  }
}

/**
 * Request a driving route from Valhalla, optionally hard-avoiding a set of
 * polygons (used to exclude camera locations).
 */
export async function valhallaRoute(
  start: LatLng,
  end: LatLng,
  excludePolygons: [number, number][][] = [],
  timeoutMs = 20000,
): Promise<RouteResult> {
  const body = {
    locations: [
      { lat: start.lat, lon: start.lng },
      { lat: end.lat, lon: end.lng },
    ],
    costing: "auto",
    directions_options: { units: "miles" },
    ...(excludePolygons.length ? { exclude_polygons: excludePolygons } : {}),
  };

  // Hard per-call timeout so one slow/hung engine call can't run past the
  // serverless function's wall-clock limit (which would kill the whole request
  // and return a non-JSON error page to the client).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs));
  let res: Response;
  try {
    res = await fetch(`${VALHALLA_URL}/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new EngineTimeoutError();
    }
    throw new Error(
      `Could not reach Valhalla at ${VALHALLA_URL}. Is the container up and finished building? (${(err as Error).message})`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Valhalla returns 400 with an error code when no path exists.
    const text = await res.text();
    if (res.status === 400 && /no path|no route|exact|unreachable/i.test(text)) {
      throw new NoRouteError();
    }
    throw new Error(`Valhalla error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const trip = data.trip;
  if (!trip || trip.status !== 0 || !trip.legs?.length) {
    throw new NoRouteError(trip?.status_message ?? "No route found");
  }

  // Concatenate leg geometries (single leg for a 2-point request).
  const geometry: LatLng[] = [];
  for (const leg of trip.legs) {
    geometry.push(...decodePolyline(leg.shape, 6));
  }

  return {
    geometry,
    timeSec: trip.summary.time,
    distanceMi: trip.summary.length,
  };
}
