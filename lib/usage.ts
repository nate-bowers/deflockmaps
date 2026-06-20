// Persistent monthly usage counter for the paid geocoder (Mapbox). It enforces
// the hard monthly cap that keeps you off Mapbox's paid overage.
//
// Two backends:
//   1. Upstash Redis (preferred) — atomic INCR, so the cap is EXACT even under a
//      traffic spike or a bot flood. This is the bulletproof option.
//   2. Vercel Blob (fallback) — read-modify-write, persistent but can race
//      slightly under heavy concurrency, so the cap is approximate.
import { list, put } from "@vercel/blob";
import { Redis } from "@upstash/redis";

const PATH = "mapbox-usage.json";

function monthKey(): string {
  return new Date().toISOString().slice(0, 7); // "YYYY-MM"
}

function redis(): Redis | null {
  // Vercel's Upstash integration may expose either naming convention.
  const url =
    process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (url && token) return new Redis({ url, token });
  return null;
}

/** True if some persistent counter is available (so the cap can be enforced). */
export function usageConfigured(): boolean {
  return !!redis() || !!process.env.BLOB_READ_WRITE_TOKEN;
}

// ---- Blob fallback ----------------------------------------------------------
type Usage = { month: string; count: number };

async function blobRead(): Promise<Usage> {
  try {
    const { blobs } = await list({ prefix: PATH, limit: 1 });
    if (blobs[0]) {
      const res = await fetch(blobs[0].url, { cache: "no-store" });
      if (res.ok) return (await res.json()) as Usage;
    }
  } catch {
    /* fresh counter */
  }
  return { month: monthKey(), count: 0 };
}

async function blobWrite(u: Usage): Promise<void> {
  await put(PATH, JSON.stringify(u), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
}

/**
 * Check the monthly cap and record one use; resets on a new month. Atomic when
 * Upstash is configured. Returns whether the call is allowed and the count.
 */
export async function checkAndRecord(
  cap: number,
): Promise<{ allowed: boolean; count: number }> {
  const r = redis();
  if (r) {
    // Atomic: each request gets a unique count, so at most `cap` are allowed.
    const key = `mapbox:${monthKey()}`;
    const count = await r.incr(key);
    if (count === 1) await r.expire(key, 60 * 60 * 24 * 40); // auto-clean old months
    return { allowed: count <= cap, count };
  }

  const month = monthKey();
  let u = await blobRead();
  if (u.month !== month) u = { month, count: 0 };
  if (u.count >= cap) return { allowed: false, count: u.count };
  u.count += 1;
  await blobWrite(u);
  return { allowed: true, count: u.count };
}
