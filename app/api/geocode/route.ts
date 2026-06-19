import { NextResponse } from "next/server";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// Free geocoding via OpenStreetMap Nominatim. Proxied server-side so we can set
// a proper User-Agent (required), bias results to the Bay Area, cache, and rate
// limit. Nominatim's usage policy caps this at ~1 req/sec — caching keeps us well
// under it. For higher traffic, self-host Nominatim or use a keyed provider.
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
// Bias toward the SF Bay Area: viewbox = west,north,east,south
const BAY_VIEWBOX = "-122.6,38.1,-121.6,37.1";

// Simple in-memory cache (autocomplete repeats the same prefixes a lot).
type CacheEntry = { body: unknown; exp: number };
const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim();
  if (!q) {
    return NextResponse.json({ error: "Missing ?q" }, { status: 400 });
  }

  const cached = cache.get(q.toLowerCase());
  if (cached && cached.exp > Date.now()) {
    return NextResponse.json(cached.body);
  }

  const rl = rateLimit(`geocode:${clientIp(req)}`, 30, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests — slow down a moment." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  const url =
    `${NOMINATIM}?format=json&limit=5&addressdetails=0` +
    `&viewbox=${BAY_VIEWBOX}&q=${encodeURIComponent(q)}`;

  let data: unknown;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "deflockmaps-demo/0.1 (camera-avoidance routing demo)",
        "Accept-Language": "en",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    return NextResponse.json(
      { error: `Geocoding failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  const arr = (Array.isArray(data) ? data : []) as Array<{
    lat: string;
    lon: string;
    display_name: string;
  }>;
  const results = arr
    .filter((r) => r.lat != null && r.lon != null)
    .map((r) => ({
      lat: Number(r.lat),
      lng: Number(r.lon),
      label: r.display_name,
    }));

  if (results.length === 0) {
    return NextResponse.json({ error: `No match for "${q}"` }, { status: 404 });
  }

  const body = { results };
  cache.set(q.toLowerCase(), { body, exp: Date.now() + CACHE_TTL });
  return NextResponse.json(body);
}
