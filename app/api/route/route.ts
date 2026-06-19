import { NextResponse } from "next/server";
import { camerasInBox, loadCameras } from "@/lib/cameras";
import { planRoutes } from "@/lib/planRoutes";
import { NoRouteError } from "@/lib/valhalla";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

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
