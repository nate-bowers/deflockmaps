// Camera-avoidance planner over a pre-compiled, camera-penalized road graph.
//
// Drives lib/roadGraph: snap the endpoints, then sweep the penalty weight λ from
// 0 (fastest) upward — each λ is ONE single-pass shortest path — to trace the
// fastest→fewest-cameras spectrum. Every routed geometry is re-measured with the
// production camera detector so the reported counts are truthful, then run through
// the same Pareto/thin/label menu builder the greedy planner uses. Output is a
// drop-in PlanResult.
import { camerasOnRoute, type Camera, type LatLng } from "./geo";
import { nearestNode, routeOnGraph, type RoadGraph } from "./roadGraph";
import {
  ROUTE_THRESHOLD_M,
  partitionHits,
  paretoFilter,
  thinOptions,
  labelOptions,
  type AvoidanceLevel,
  type PlanResult,
  type RouteOption,
} from "./planRoutes";

// Penalty ladders (seconds of detour the planner will accept per camera dodged).
// "balanced" keeps detours sensible; "max" pushes to the camera-free floor even
// when that costs a large detour. Each rung is one Dijkstra (~200 ms Bay Area).
const LADDERS: Record<AvoidanceLevel, number[]> = {
  balanced: [0, 40, 120, 400],
  max: [0, 25, 60, 150, 400, 1200, 100000],
};

export function planRoutesOnGraph(
  g: RoadGraph,
  cameras: Camera[],
  start: LatLng,
  end: LatLng,
  useDirection = true,
  level: AvoidanceLevel = "balanced",
): PlanResult {
  const src = nearestNode(g, start);
  const dst = nearestNode(g, end);
  const ladder = LADDERS[level] ?? LADDERS.balanced;

  const raw: RouteOption[] = [];
  for (const lambda of ladder) {
    const r = routeOnGraph(g, src, dst, lambda, useDirection);
    if (!r) continue;
    // Re-measure on the actual geometry — never trust the baked penalty as the
    // reported count. FOV on, to match the cone model the penalty was baked with.
    const hits = camerasOnRoute(r.geometry, cameras, ROUTE_THRESHOLD_M, { fov: true });
    const { avoided, facingAway } = partitionHits(hits, useDirection);
    raw.push({
      id: `g-${raw.length}`,
      label: "",
      geometry: r.geometry,
      timeSec: r.timeSec,
      distanceMi: r.distanceMi,
      cameraCount: avoided.length,
      cameraIds: avoided.map((c) => c.id),
      facingAwayCount: facingAway.length,
      facingAwayIds: facingAway.map((c) => c.id),
    });
  }

  const cameraFreeExists = raw.some((o) => o.cameraCount === 0);
  const note = cameraFreeExists
    ? null
    : "No fully camera-free route exists between these points — the options below are the lowest-exposure routes available.";

  const options = thinOptions(paretoFilter(raw));
  labelOptions(options, cameraFreeExists);
  return { options, cameraFreeExists, note, useDirection, level };
}
