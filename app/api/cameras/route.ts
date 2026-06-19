import { NextResponse } from "next/server";
import { loadCameras } from "@/lib/cameras";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await loadCameras();
    return NextResponse.json({
      fetchedAt: data.fetchedAt,
      count: data.count,
      cameras: data.cameras,
    });
  } catch {
    return NextResponse.json(
      { error: "Camera data not found. Run: node scripts/fetch-cameras.mjs" },
      { status: 500 },
    );
  }
}
