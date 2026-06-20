// The camera-avoidance route planner.
//
// Strategy ("iterative exclusion"): start with the plain fastest route, find
// which cameras capture it, then hard-exclude all of them and re-route. Each
// pass forces a detour around the previously-hit cameras, producing a longer
// route that hits fewer (and the camera-free route at the end, if one exists).
// We then keep only the Pareto-efficient options — no route that is both slower
// AND hits more cameras than another — which is exactly the menu we show:
//   fastest / most-exposed  →  slowest / camera-free (or "impossible").
//
// Directionality: when `useDirection` is on, a camera that faces the *opposite*
// of your travel direction is treated as not capturing you (the other
// carriageway) — it is shown but not routed around. Cameras facing your way, or
// with no direction data, are avoided. See classifyCamera() in geo.ts.
import {
  camerasOnRoute,
  circlePolygon,
  type Camera,
  type CameraHit,
  type LatLng,
} from "./geo";
import { NoRouteError, valhallaRoute, type RouteResult } from "./valhalla";

export type RouteOption = {
  id: string;
  label: string;
  geometry: LatLng[];
  timeSec: number;
  distanceMi: number;
  /** cameras that capture this route's travel direction (the ones we avoid) */
  cameraCount: number;
  cameraIds: number[];
  /** cameras passed that face the other way — shown, not avoided */
  facingAwayCount: number;
  facingAwayIds: number[];
};

export type AvoidanceLevel = "balanced" | "max";

export type PlanResult = {
  options: RouteOption[];
  cameraFreeExists: boolean;
  note: string | null;
  useDirection: boolean;
  level: AvoidanceLevel;
};

// Detection threshold MUST stay well below the exclusion radius: once a camera
// is excluded the reroute is forced ~EXCLUDE_RADIUS_M away, so a smaller
// detection threshold guarantees that excluded camera is not re-counted as a
// hit (which would stall the sweep via the `added` check). The gap between them
// is what lets the planner keep peeling the route onto quieter parallel/side
// streets pass after pass instead of giving up after one detour.
const ROUTE_THRESHOLD_M = 22; // how close to the line counts as "captured"
const EXCLUDE_RADIUS_M = 40; // hard-avoid bubble per camera (reliably blocks the road)

/** Split route hits into the cameras we avoid vs. the ones facing away. */
function partitionHits(hits: CameraHit[], useDirection: boolean) {
  if (!useDirection) {
    return { avoided: hits.map((h) => h.camera), facingAway: [] as Camera[] };
  }
  const avoided: Camera[] = [];
  const facingAway: Camera[] = [];
  for (const h of hits) {
    if (h.classification === "opposite") facingAway.push(h.camera);
    else avoided.push(h.camera); // "captures" or "unknown"
  }
  return { avoided, facingAway };
}

// Iteration budgets per avoidance level. "balanced" stays fast and bounded;
// "max" treats every camera as effectively infinite-cost and keeps dodging until
// it physically can't — accepting arbitrarily large detours (a 10× slower,
// zero-camera route) to do it. `excluded` stays well under Valhalla's 10k-point
// exclude-polygon budget in both modes.
const LIMITS: Record<
  AvoidanceLevel,
  { passes: number; calls: number; excluded: number; budgetMs: number }
> = {
  // budgetMs is a hard wall-clock cap: the sweep returns the best routes found
  // so far when it's hit, so the UI stays responsive even if the remote engine
  // is slow. balanced feels snappy; max trades time for thoroughness.
  balanced: { passes: 10, calls: 60, excluded: 60, budgetMs: 8000 },
  // Max prioritizes correctness over speed — generous budget so it fully dodges.
  max: { passes: 80, calls: 400, excluded: 160, budgetMs: 45000 },
};

// Per pass, try this many camera exclusions concurrently. Each Valhalla call to a
// remote engine costs a full network round-trip, so parallelizing the trials
// (instead of one-at-a-time) is what keeps routing fast — wall-clock is bounded
// by the number of passes, not the total number of calls.
const TRIALS_PER_PASS = 6;

export async function planRoutes(
  start: LatLng,
  end: LatLng,
  cameras: Camera[],
  useDirection = true,
  level: AvoidanceLevel = "balanced",
): Promise<PlanResult> {
  const limits = LIMITS[level] ?? LIMITS.balanced;
  // Excluding every captured camera at once tends to block a chokepoint (a
  // camera on the only through-road) and make routing impossible — so instead
  // we exclude cameras GREEDILY, one at a time. When excluding one breaks
  // routing it's marked un-dodgeable and skipped, and we keep peeling the route
  // off the arterial onto quieter side streets to dodge the cameras that CAN be
  // avoided. Each accepted exclusion is recorded as a candidate option.
  const excluded = new Map<number, Camera>();
  const undodgeable = new Set<number>();
  const raw: RouteOption[] = [];
  let calls = 0;

  const polysFor = (extra?: Camera) =>
    [...excluded.values(), ...(extra ? [extra] : [])].map((c) =>
      circlePolygon(c.lat, c.lon, EXCLUDE_RADIUS_M),
    );

  const measure = (route: {
    geometry: LatLng[];
    timeSec: number;
    distanceMi: number;
  }) => {
    const hits = camerasOnRoute(route.geometry, cameras, ROUTE_THRESHOLD_M);
    const { avoided, facingAway } = partitionHits(hits, useDirection);
    return { avoided, facingAway };
  };

  const record = (route: {
    geometry: LatLng[];
    timeSec: number;
    distanceMi: number;
  }) => {
    const { avoided, facingAway } = measure(route);
    raw.push({
      id: `opt-${raw.length}`,
      label: "",
      geometry: route.geometry,
      timeSec: route.timeSec,
      distanceMi: route.distanceMi,
      cameraCount: avoided.length,
      cameraIds: avoided.map((c) => c.id),
      facingAwayCount: facingAway.length,
      facingAwayIds: facingAway.map((c) => c.id),
    });
    return avoided;
  };

  const deadline = Date.now() + limits.budgetMs;

  // Baseline fastest route (no avoidance).
  let current = await valhallaRoute(start, end, []);
  calls++;
  let captured = record(current); // cameras capturing this route

  // Greedily dodge cameras. Each pass tries excluding several captured cameras
  // IN PARALLEL, marks the un-dodgeable ones (those on the only through-road),
  // and commits the exclusion that yields the route with the fewest cameras.
  type Trial =
    | { cam: Camera; route: RouteResult }
    | { cam: Camera; undodgeable: true }
    | { cam: Camera; failed: true };

  while (
    raw.length <= limits.passes &&
    calls < limits.calls &&
    excluded.size < limits.excluded &&
    Date.now() < deadline
  ) {
    const remaining = captured.filter(
      (c) => !excluded.has(c.id) && !undodgeable.has(c.id),
    );
    if (remaining.length === 0) break; // nothing left we can try to dodge
    const candidates = remaining.slice(0, TRIALS_PER_PASS);
    calls += candidates.length;

    const trials: Trial[] = await Promise.all(
      candidates.map(async (cam): Promise<Trial> => {
        try {
          return { cam, route: await valhallaRoute(start, end, polysFor(cam)) };
        } catch (err) {
          if (err instanceof NoRouteError) return { cam, undodgeable: true };
          return { cam, failed: true }; // e.g. exclude-polygon limit / engine error
        }
      }),
    );

    const limitHit = trials.some((t) => "failed" in t);
    for (const t of trials) if ("undodgeable" in t) undodgeable.add(t.cam.id);

    // Commit the successful exclusion that leaves the fewest captured cameras.
    let best: { cam: Camera; route: RouteResult; avoided: Camera[] } | null = null;
    for (const t of trials) {
      if (!("route" in t)) continue;
      const avoided = measure(t.route).avoided;
      if (!best || avoided.length < best.avoided.length) {
        best = { cam: t.cam, route: t.route, avoided };
      }
    }

    if (best) {
      excluded.set(best.cam.id, best.cam);
      current = best.route;
      captured = best.avoided;
      record(current);
    }

    if (limitHit) break;
    // No dodge found and we tried every remaining candidate → done.
    if (!best && candidates.length === remaining.length) break;
  }

  const cameraFreeExists = raw.some((o) => o.cameraCount === 0);
  const note = cameraFreeExists
    ? null
    : "No fully camera-free route exists between these points — the options below are the lowest-exposure routes available.";

  const options = thinOptions(paretoFilter(raw));
  labelOptions(options, cameraFreeExists);
  return { options, cameraFreeExists, note, useDirection, level };
}

/**
 * Trim the Pareto frontier to a short, meaningful menu: always keep the two
 * endpoints (fastest and fewest-cameras) and at most 3 middle options, dropping
 * marginal ones (e.g. "one fewer camera, one more minute"). A middle option is
 * only kept if it cuts cameras by a meaningful step from the previous kept
 * option AND from the fewest-cameras endpoint.
 */
function thinOptions(frontier: RouteOption[]): RouteOption[] {
  if (frontier.length <= 2) return frontier;

  const fastest = frontier[0];
  const fewest = frontier[frontier.length - 1];
  const middles = frontier.slice(1, -1);

  const span = fastest.cameraCount - fewest.cameraCount;
  const minCamStep = Math.max(2, Math.ceil(span / 4));
  const MIN_TIME_GAP = 240; // sec — a middle within ~4 min of the fewest-cameras
  //                            route adds nothing: just take that route instead.

  const kept: RouteOption[] = [];
  let prevCams = fastest.cameraCount;
  for (const m of middles) {
    if (
      prevCams - m.cameraCount >= minCamStep && // meaningful camera cut vs. prev
      fewest.timeSec - m.timeSec >= MIN_TIME_GAP // meaningfully faster than fewest
    ) {
      kept.push(m);
      prevCams = m.cameraCount;
    }
  }

  // Hard cap at 3 middles, evenly spaced across the survivors.
  const trimmed =
    kept.length <= 3
      ? kept
      : [0, 1, 2].map(
          (k) => kept[Math.round((k * (kept.length - 1)) / 2)],
        );

  return [fastest, ...trimmed, fewest];
}

/**
 * Keep only Pareto-efficient routes: sorted fastest→slowest, a route survives
 * only if it captures strictly fewer cameras than every faster route kept so
 * far. Also dedupes near-identical routes.
 */
function paretoFilter(routes: RouteOption[]): RouteOption[] {
  const seen = new Set<string>();
  const unique = routes.filter((r) => {
    const key = `${Math.round(r.timeSec / 15)}:${r.cameraCount}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by time asc, breaking ties by FEWER cameras first so that when two
  // routes take ~the same time, the more-exposed one is treated as dominated
  // and dropped by the strictly-decreasing-cameras rule below.
  unique.sort(
    (a, b) => a.timeSec - b.timeSec || a.cameraCount - b.cameraCount,
  );
  const kept: RouteOption[] = [];
  let bestCameras = Infinity;
  for (const r of unique) {
    if (r.cameraCount < bestCameras) {
      kept.push(r);
      bestCameras = r.cameraCount;
    }
  }
  return kept;
}

function labelOptions(options: RouteOption[], cameraFreeExists: boolean): void {
  const last = options.length - 1;
  options.forEach((opt, i) => {
    if (i === 0) {
      opt.label = "Fastest";
    } else if (opt.cameraCount === 0) {
      opt.label = "Camera-free";
    } else if (i === last) {
      // The lowest-exposure route we could find (most cameras dodged).
      opt.label = "Fewest cameras";
    } else {
      opt.label = "Lower exposure";
    }
  });
  void cameraFreeExists;
}
