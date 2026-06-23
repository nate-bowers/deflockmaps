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

## Hosting Valhalla for free: Oracle Cloud Always Free (AMD Micro)

Use an **Oracle Cloud Always Free VM.Standard.E2.1.Micro** (AMD, 1 vCPU / 1 GB RAM).
The Ampere (ARM) shapes have more RAM but are frequently "out of capacity"; the AMD
Micro is essentially always available. 1 GB can't build the whole-California graph,
so `docker-compose.yml` is configured to use a small **Bay Area extract** (~175 MB,
hosted as a release asset) plus a swap file for headroom.

1. Create an Oracle Cloud account (free; card is for identity only — Always Free
   doesn't charge).
2. **Compute → Instances → Create instance:** shape **VM.Standard.E2.1.Micro**
   (Always-Free-eligible), image **Ubuntu 22.04**. Under Networking, create a new
   VCN + **public** subnet and auto-assign a public IP. **Download the SSH private
   key** (only chance). Create.
3. **Open port 8002:** instance → subnet → Default Security List → Add Ingress Rule
   → Source `0.0.0.0/0`, TCP, port `8002`.
4. SSH in (`ssh -i <key> ubuntu@<PUBLIC_IP>`) and run:
   ```bash
   # 2 GB swap so the build never OOMs on 1 GB RAM
   sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
   sudo mkswap /swapfile && sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

   sudo apt update && sudo apt install -y docker.io docker-compose-plugin git netfilter-persistent
   sudo systemctl enable --now docker
   sudo iptables -I INPUT 6 -p tcp --dport 8002 -j ACCEPT && sudo netfilter-persistent save

   git clone https://github.com/nate-bowers/deflockmaps.git && cd deflockmaps
   sudo docker compose up -d        # builds the Bay Area graph (~10–20 min on the Micro)
   ```
   Watch it with `sudo docker logs -f deflock-valhalla`; ready when it stops building.
5. Verify: `curl http://localhost:8002/status`, then open
   `http://<PUBLIC_IP>:8002/status` in a browser.
6. Set **`VALHALLA_URL=http://<PUBLIC_IP>:8002`** on your Vercel project. (Plain HTTP
   is fine — the app calls Valhalla server-side, so there's no mixed-content issue.)

## Faster engine (free): upgrade to Ampere A1 when capacity opens

The E2.1.Micro has ~1/8 of a CPU core, so each routing call takes ~2–4 s and the
`max` camera-peel stalls on long routes (it runs out of the 60 s request budget
before it can dodge everything — benchmarked: the *same* call is ~0.2 s on a real
CPU). The fix is Oracle's **other** Always-Free tier, **Ampere A1** (ARM, up to
4 OCPU / 24 GB, also $0). On it, long routes peel to their true floor (e.g.
Tiburon→Atherton ~6 cameras) in well under the budget.

A1 capacity is usually "Out of host capacity," so grab it with the watcher:

```bash
brew install oci-cli && oci setup config        # one-time
cp scripts/ampere.env.example scripts/ampere.env
bash scripts/ampere-watch.sh --discover         # lists the OCIDs to paste in
# fill in scripts/ampere.env, then:
caffeinate -is bash scripts/ampere-watch.sh      # retries until it lands, then pings you
```

When it lands: SSH in, install Docker, run `scripts/deploy-engine.sh` (the tile
image is multi-arch, so it runs on ARM unchanged), open port 8002, then repoint
`VALHALLA_URL` at the new IP and redeploy. Nothing in the app code changes — the
camera-avoidance quality improvement comes entirely from the faster CPU.

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

## Camera-avoidance graph planner (optional, recommended)

`/api/route` uses the bundled **greedy** planner by default (Valhalla
`exclude_polygons`) — it works everywhere but plateaus on dense routes (it can't
reach the camera-free floor) and fires dozens of engine calls per request. The
**graph planner service** (`server/planner.mts`) instead compiles a Flock-penalized
road graph once and routes **single-pass** (`time + λ·cameras`), reaching the
fewest-cameras / camera-free floor in ~0.2 s.

It holds the graph in memory (~0.5 GB Bay Area; multiple GB for the US), so it
**cannot run in a Vercel function** — run it on the always-on engine box (the
Oracle A1; the 1 GB Micro can't hold it alongside Valhalla). On the box:

```bash
node scripts/fetch-road-graph.mjs              # pull drivable roads (Bay Area default) → road-ways.json
npm install
ROAD_GRAPH_WAYS=road-ways.json npm run planner # serves /plan and /health on :8090 (set PLANNER_PORT to change)
```

Then set **`PLANNER_URL=http://<box-ip>:8090`** on Vercel and redeploy. `/api/route`
uses it when reachable and **falls back to the greedy planner** if it's unset,
unreachable, or errors — so routing never breaks. The graph bakes camera
positions at startup, so re-run `fetch-road-graph.mjs` (or just restart the
service) after the daily camera refresh. Whole-US needs a US road-ways pull and
matching RAM (the 2 OCPU / 12 GB A1 is sized for it).
