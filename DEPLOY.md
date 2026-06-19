# Deploying DeFlock Maps (and keeping it ~free)

## What goes where

| Piece | Host | Free? |
|---|---|---|
| Next.js frontend + API routes (`/api/route`, `/api/geocode`) | **Vercel Hobby** | ✅ free |
| Camera-refresh cron (`/api/cron/refresh-cameras`) | **Vercel Cron** | ✅ free (Hobby allows daily crons) |
| Camera dataset (`cameras.json`) | **Vercel Blob** | ✅ free tier |
| Geocoding | OSM **Nominatim** (proxied, cached, rate-limited) | ✅ free at low traffic |
| **Routing engine (Valhalla)** | **NOT Vercel** — see below | ⚠️ the one catch |

**Why Valhalla can't run on Vercel:** it needs a long-lived process with ~1 GB RAM
and the regional routing tiles (hundreds of MB) on disk. Serverless functions are
short-lived, memory-capped, and have no persistent mounted graph. So the engine
must live on a small always-on host that Vercel calls over HTTP.

## Hosting Valhalla for free (pick one)

1. **Oracle Cloud Always Free** *(best truly-free, always-on)* — the Always Free
   ARM (Ampere) VM gives up to 24 GB RAM / 4 cores, free forever. Plenty for the
   California graph 24/7. Run the same `docker compose up -d` from this repo on it,
   open port 8002 (ideally behind HTTPS via a reverse proxy / Caddy).

2. **Cloudflare Tunnel from a machine you already run** *(zero cost, simplest)* —
   keep `docker compose up -d` running on your Mac or a Raspberry Pi and expose it:
   `cloudflared tunnel --url http://localhost:8002`. You get a public HTTPS URL with
   no server to manage. Caveat: that machine must stay on.

3. **Fly.io with scale-to-zero** *(cheap, not free)* — auto-stops when idle, boots on
   request (~10–30 s cold start to load the CA graph). Roughly $0–3/mo at low traffic.

Set the resulting URL as `VALHALLA_URL` on the Vercel project.

## Step-by-step

1. **Push to GitHub**, import the repo on Vercel.
2. **Host Valhalla** (one of the above) → set `VALHALLA_URL`.
3. **Create a Vercel Blob store** (Storage tab). This auto-adds `BLOB_READ_WRITE_TOKEN`.
4. **Set `CRON_SECRET`** to any random string (protects the cron endpoint).
5. **Seed the camera data:** deploy, then hit `/api/cron/refresh-cameras` once with
   `Authorization: Bearer <CRON_SECRET>`. It returns the Blob `url` — set that as
   **`CAMERAS_URL`** and redeploy. After this the daily cron keeps it fresh.
   (Until `CAMERAS_URL` is set, the app serves the bundled `data/cameras.json`.)

## Cost summary

Everything except the routing engine is free on Vercel's Hobby tier. The routing
engine is free too via Oracle Always Free or a Cloudflare Tunnel from a machine you
already keep on — so a low-traffic launch can genuinely cost **$0/mo**.

## Hardening notes (for real traffic)

- Rate limiting (`lib/rateLimit.ts`) is in-memory / per-instance. For a hard global
  limit, back it with **Upstash Redis** (free tier).
- The geocode cache is in-memory. Same Upstash upgrade applies, or self-host Nominatim.
- Expand coverage by editing `DEFAULT_BBOX` in `lib/overpass.ts` (and the camera
  fetch) and rebuilding the Valhalla graph for a larger region in `docker-compose.yml`.
