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

## Hosting Valhalla for free: Oracle Cloud Always Free

Use an **Oracle Cloud Always Free Ampere (ARM) VM**. It's a real always-on cloud
server (no home machine needed), free *forever*, with enough RAM (up to 24 GB / 4
cores in the free tier) to run the California graph comfortably 24/7.

1. Create an Oracle Cloud account (free; a card is required for identity only —
   Always Free resources don't charge).
2. **Compute → Instances → Create instance.** Choose shape
   **VM.Standard.A1.Flex** (Ampere/ARM), give it ~2 OCPU / 12 GB RAM (within the
   Always Free allowance), image **Ubuntu 22.04**. Save the SSH key.
   *(If you hit a capacity error, try a different Availability Domain or region.)*
3. **Networking → open port 8002:** add an ingress rule to the VCN's default
   security list for TCP 8002 from `0.0.0.0/0` (or lock it to Vercel later).
4. SSH in and install Docker + bring up Valhalla:
   ```bash
   sudo apt update && sudo apt install -y docker.io docker-compose-plugin
   git clone https://github.com/nate-bowers/deflockmaps.git && cd deflockmaps
   sudo docker compose up -d        # first run downloads the CA extract + builds tiles
   ```
   Also open the OS firewall: `sudo iptables -I INPUT -p tcp --dport 8002 -j ACCEPT`.
5. The engine is now at `http://<VM_PUBLIC_IP>:8002`. (Optional but recommended:
   put **Caddy** in front for automatic HTTPS so the URL is `https://…`.)
6. Set **`VALHALLA_URL`** to that URL on your Vercel project.

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
