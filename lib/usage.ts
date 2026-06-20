// Persistent monthly usage counter for the paid geocoder (Mapbox), backed by
// Vercel Blob so the count survives cold starts and is shared across all
// serverless instances. This is what enforces the hard monthly cap that keeps
// you off Mapbox's paid overage.
import { list, put } from "@vercel/blob";

const PATH = "mapbox-usage.json";

type Usage = { month: string; count: number };

function monthKey(): string {
  return new Date().toISOString().slice(0, 7); // "YYYY-MM"
}

export function blobConfigured(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

async function read(): Promise<Usage> {
  try {
    const { blobs } = await list({ prefix: PATH, limit: 1 });
    if (blobs[0]) {
      const res = await fetch(blobs[0].url, { cache: "no-store" });
      if (res.ok) return (await res.json()) as Usage;
    }
  } catch {
    /* fall through to a fresh counter */
  }
  return { month: monthKey(), count: 0 };
}

async function write(u: Usage): Promise<void> {
  await put(PATH, JSON.stringify(u), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
}

/**
 * Atomically-ish check the monthly cap and record one use. Resets on a new
 * month. Returns whether the call is allowed and the current count.
 * (Read-modify-write can race slightly under high concurrency; the cap is set
 * below the provider's free tier to absorb that.)
 */
export async function checkAndRecord(
  cap: number,
): Promise<{ allowed: boolean; count: number }> {
  const month = monthKey();
  let u = await read();
  if (u.month !== month) u = { month, count: 0 };
  if (u.count >= cap) return { allowed: false, count: u.count };
  u.count += 1;
  await write(u);
  return { allowed: true, count: u.count };
}
