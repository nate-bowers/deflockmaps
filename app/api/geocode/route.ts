import { NextResponse } from "next/server";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import { usageConfigured, checkAndRecord } from "@/lib/usage";

export const dynamic = "force-dynamic";

// Hard monthly cap on paid (Mapbox) geocoding so we never hit paid overage.
// Set comfortably below Mapbox's 100k/mo free tier as a safety margin.
const MAPBOX_MONTHLY_CAP = 90_000;

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
  const seen = new Set<string>();
  return (data.features ?? [])
    .filter((f) => f.center)
    .map((f) => ({ lat: f.center[1], lng: f.center[0], label: f.place_name }))
    .filter((r) => {
      if (seen.has(r.label)) return false;
      seen.add(r.label);
      return true;
    });
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

  // Use Mapbox only when a token AND a Blob store are present — the Blob counter
  // enforces the monthly cap, so paid geocoding can never run uncapped. Once the
  // cap is hit, fall back to the free Photon geocoder and flag it loudly.
  const token = process.env.MAPBOX_TOKEN;
  let results: Result[];
  let capped = false;
  try {
    if (token && usageConfigured()) {
      const { allowed } = await checkAndRecord(MAPBOX_MONTHLY_CAP);
      if (allowed) {
        try {
          results = await viaMapbox(q, token);
        } catch {
          results = await viaPhoton(q); // Mapbox hiccup → free fallback
        }
      } else {
        capped = true;
        results = await viaPhoton(q);
      }
    } else {
      results = await viaPhoton(q);
    }
  } catch (err) {
    return NextResponse.json(
      { error: `Geocoding failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  if (results.length === 0 && !capped) {
    return NextResponse.json({ error: `No match for "${q}"` }, { status: 404 });
  }

  const cappedMsg = capped
    ? "Monthly address-search limit reached — basic search active until next month."
    : undefined;
  const body = { results, capped, message: cappedMsg };
  // Don't cache the capped state (it should clear when the month rolls over).
  if (!capped) cache.set(q.toLowerCase(), { body, exp: Date.now() + CACHE_TTL });
  return NextResponse.json(body);
}
