import { NextResponse } from "next/server";
import { camerasInBox, loadCameras } from "@/lib/cameras";
import { planRoutes } from "@/lib/planRoutes";
import { NoRouteError } from "@/lib/valhalla";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
// Max avoidance peels cameras one-by-one over many engine round-trips and can
// run up to ~55s (see LIMITS.max.budgetMs). Give the function headroom so it
// isn't killed mid-sweep. 60s is the Hobby-plan ceiling.
export const maxDuration = 60;
// Run this function next to the Valhalla engine (Oracle us-sanjose-1). A single
// route fires dozens of sequential engine calls, so co-locating in San Jose
// (sfo1) cuts the per-call round-trip that would otherwise be cross-country.
// If the engine ever moves regions, update this to match.
export const preferredRegion = "sfo1";

type Pt = { lat: number; lng: number };

function isPt(v: unknown): v is Pt {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as Pt).lat === "number" &&
    typeof (v as Pt).lng === "number"
  );
}

export async function POST(req: Request) {
  // Routing fans out to many engine calls — keep a tight per-IP limit.
  const rl = rateLimit(`route:${clientIp(req)}`, 20, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests — slow down a moment." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { start, end, useDirection, level } = (body ?? {}) as {
    start?: unknown;
    end?: unknown;
    useDirection?: unknown;
    level?: unknown;
  };
  if (!isPt(start) || !isPt(end)) {
    return NextResponse.json(
      { error: "Body must be { start: {lat,lng}, end: {lat,lng} }" },
      { status: 400 },
    );
  }

  // Prefer the on-box graph planner (single-pass λ-sweep over a camera-penalized
  // road graph) when configured. It holds the graph in memory, so it can't run in
  // this serverless function — it lives on the always-on engine box (see
  // server/planner.mts, DEPLOY.md). If it's unset/unreachable/errors, fall through
  // to the bundled greedy planner so routing always works.
  const plannerUrl = process.env.PLANNER_URL;
  if (plannerUrl) {
    try {
      const r = await fetch(`${plannerUrl}/plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ start, end, useDirection, level }),
        signal: AbortSignal.timeout(25_000),
      });
      if (r.ok) return NextResponse.json(await r.json());
      // non-OK response → fall through to the greedy fallback below
    } catch {
      // unreachable / timeout → fall through to the greedy fallback below
    }
  }

  let cameras;
  try {
    const data = await loadCameras();
    cameras = camerasInBox(data.cameras, start, end);
  } catch {
    return NextResponse.json(
      { error: "Camera data not found. Run: node scripts/fetch-cameras.mjs" },
      { status: 500 },
    );
  }

  try {
    const result = await planRoutes(
      start,
      end,
      cameras,
      useDirection !== false, // default on
      level === "max" ? "max" : "balanced",
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof NoRouteError) {
      return NextResponse.json(
        { error: "No route exists between these points (within California)." },
        { status: 422 },
      );
    }
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 502 },
    );
  }
}
