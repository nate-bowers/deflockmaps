import { NextResponse } from "next/server";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// Geocoding for the address autocomplete. Default provider is **Photon**
// (komoot) — free, no key, and purpose-built for type-ahead (fast, good prefix
// matching) which beats Nominatim for autocomplete. If MAPBOX_TOKEN is set we use
// Mapbox instead, which has far better US street-address coverage (free tier is
// 100k req/mo). Results are cached and rate-limited either way.
const PHOTON = "https://photon.komoot.io/api/";
const MAPBOX = "https://api.mapbox.com/geocoding/v5/mapbox.places/";
// Bias toward the SF Bay Area.
const BIAS_LAT = 37.8;
const BIAS_LON = -122.27;

type Result = { lat: number; lng: number; label: string };

type CacheEntry = { body: unknown; exp: number };
const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function dedupeJoin(parts: (string | undefined)[]): string {
  const clean = parts.filter((p): p is string => !!p);
  return clean.filter((v, i) => v !== clean[i - 1]).join(", ");
}

async function viaPhoton(q: string): Promise<Result[]> {
  const url =
    `${PHOTON}?q=${encodeURIComponent(q)}&limit=6&lang=en` +
    `&lat=${BIAS_LAT}&lon=${BIAS_LON}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "deflockmaps/0.1 (camera-avoidance routing)" },
  });
  if (!res.ok) throw new Error(`Photon HTTP ${res.status}`);
  const data = (await res.json()) as {
    features?: Array<{
      geometry: { coordinates: [number, number] };
      properties: Record<string, string>;
    }>;
  };
  return (data.features ?? [])
    .filter((f) => f.geometry?.coordinates)
    .map((f) => {
      const p = f.properties;
      const street = [p.housenumber, p.street].filter(Boolean).join(" ");
      const label = dedupeJoin([
        street || p.name,
        p.city || p.town || p.village || p.district,
        p.state,
      ]);
      const [lng, lat] = f.geometry.coordinates;
      return { lat, lng, label: label || p.name || q };
    });
}

async function viaMapbox(q: string, token: string): Promise<Result[]> {
  const url =
    `${MAPBOX}${encodeURIComponent(q)}.json?access_token=${token}` +
    `&autocomplete=true&limit=6&country=us&proximity=${BIAS_LON},${BIAS_LAT}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mapbox HTTP ${res.status}`);
  const data = (await res.json()) as {
    features?: Array<{ center: [number, number]; place_name: string }>;
  };
  return (data.features ?? [])
    .filter((f) => f.center)
    .map((f) => ({ lat: f.center[1], lng: f.center[0], label: f.place_name }));
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim();
  if (!q) {
    return NextResponse.json({ error: "Missing ?q" }, { status: 400 });
  }

  const cached = cache.get(q.toLowerCase());
  if (cached && cached.exp > Date.now()) {
    return NextResponse.json(cached.body);
  }

  const rl = rateLimit(`geocode:${clientIp(req)}`, 40, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests — slow down a moment." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  let results: Result[];
  try {
    const token = process.env.MAPBOX_TOKEN;
    results = token ? await viaMapbox(q, token) : await viaPhoton(q);
  } catch (err) {
    return NextResponse.json(
      { error: `Geocoding failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  if (results.length === 0) {
    return NextResponse.json({ error: `No match for "${q}"` }, { status: 404 });
  }

  const body = { results };
  cache.set(q.toLowerCase(), { body, exp: Date.now() + CACHE_TTL });
  return NextResponse.json(body);
}
