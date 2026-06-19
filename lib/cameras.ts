// Loads the camera dataset. In production it reads the refreshable copy at
// CAMERAS_URL (kept up to date by the refresh cron → Vercel Blob); locally (or
// if that fetch fails) it falls back to the bundled snapshot in data/.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Camera } from "./geo";

type CameraFile = {
  fetchedAt: string;
  bbox: [number, number, number, number];
  count: number;
  cameras: Camera[];
};

let cache: CameraFile | null = null;
let cacheExp = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 min

async function loadBundled(): Promise<CameraFile> {
  const file = path.join(process.cwd(), "data", "cameras.json");
  return JSON.parse(await readFile(file, "utf8")) as CameraFile;
}

export async function loadCameras(): Promise<CameraFile> {
  if (cache && Date.now() < cacheExp) return cache;

  const url = process.env.CAMERAS_URL;
  if (url) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      cache = (await res.json()) as CameraFile;
      cacheExp = Date.now() + CACHE_TTL;
      return cache;
    } catch {
      // fall through to the bundled snapshot
    }
  }

  cache = await loadBundled();
  cacheExp = Date.now() + CACHE_TTL;
  return cache;
}

/** Cameras within a lat/lng bbox expanded by `padDeg` degrees. */
export function camerasInBox(
  cameras: Camera[],
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
  padDeg = 0.05,
): Camera[] {
  const minLat = Math.min(a.lat, b.lat) - padDeg;
  const maxLat = Math.max(a.lat, b.lat) + padDeg;
  const minLng = Math.min(a.lng, b.lng) - padDeg;
  const maxLng = Math.max(a.lng, b.lng) + padDeg;
  return cameras.filter(
    (c) =>
      c.lat >= minLat &&
      c.lat <= maxLat &&
      c.lon >= minLng &&
      c.lon <= maxLng,
  );
}
