import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { fetchCameras } from "@/lib/overpass";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Scheduled refresh of the camera dataset (see vercel.json crons). Re-fetches
// ALPR cameras from Overpass and writes them to Vercel Blob at a stable path, so
// loadCameras() (via CAMERAS_URL) serves fresh data. Crowd-sourced ALPR data
// changes constantly, so a daily refresh keeps coverage current.
//
// Setup (one-time): create a Blob store, then set env vars on the project:
//   BLOB_READ_WRITE_TOKEN  (added automatically when you connect the Blob store)
//   CRON_SECRET            (any random string — Vercel sends it as a Bearer token)
//   CAMERAS_URL            (the public Blob URL printed below on first run)
export async function GET(req: Request) {
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: "Blob store not configured (BLOB_READ_WRITE_TOKEN missing)." },
      { status: 500 },
    );
  }

  try {
    const data = await fetchCameras();
    const blob = await put("cameras.json", JSON.stringify(data), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return NextResponse.json({
      ok: true,
      count: data.count,
      fetchedAt: data.fetchedAt,
      // Set this as CAMERAS_URL in the project env (first run only).
      url: blob.url,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Refresh failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}
