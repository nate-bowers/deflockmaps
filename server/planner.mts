// Standalone camera-avoidance planner service.
//
// Holds the compiled, Flock-penalized road graph in memory and answers route
// requests with a single-pass λ-sweep — the work that can't run in a Vercel
// serverless function (the graph is ~110 MB for the Bay Area, multiple GB for the
// US). Meant to run next to the routing data on the always-on box (Oracle A1).
// The Vercel app calls it via PLANNER_URL and falls back to the bundled greedy
// planner if it is unreachable. See DEPLOY.md.
//
// Run:  ROAD_GRAPH_WAYS=road-ways.json npx tsx server/planner.mts
import http from "node:http";
import { readFile } from "node:fs/promises";
import { buildRoadGraph, bakeCameraPenalty, type OsmWay } from "../lib/roadGraph";
import { planRoutesOnGraph } from "../lib/graphPlanner";
import { loadCameras } from "../lib/cameras";
import type { AvoidanceLevel } from "../lib/planRoutes";

const WAYS_PATH = process.env.ROAD_GRAPH_WAYS ?? "road-ways.json";
const PORT = Number(process.env.PLANNER_PORT ?? 8090);

function isPt(v: unknown): v is { lat: number; lng: number } {
  return !!v && typeof v === "object" && typeof (v as { lat?: unknown }).lat === "number" && typeof (v as { lng?: unknown }).lng === "number";
}

console.log(`[planner] loading road graph from ${WAYS_PATH} ...`);
const t0 = Date.now();
const ways = JSON.parse(await readFile(WAYS_PATH, "utf8")) as OsmWay[];
const { cameras, count } = await loadCameras();
const graph = buildRoadGraph(ways);
bakeCameraPenalty(graph, cameras);
console.log(`[planner] ready: N=${graph.N} E=${graph.E} cameras=${count} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

const server = http.createServer(async (req, res) => {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/health") return json(200, { ok: true, nodes: graph.N, edges: graph.E, cameras: count });
  if (req.method !== "POST" || req.url !== "/plan") return json(404, { error: "not found" });

  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return json(400, { error: "invalid JSON" }); }
  const { start, end, useDirection, level } = (body ?? {}) as { start?: unknown; end?: unknown; useDirection?: unknown; level?: unknown };
  if (!isPt(start) || !isPt(end)) return json(400, { error: "body must be { start:{lat,lng}, end:{lat,lng} }" });

  try {
    const result = planRoutesOnGraph(
      graph, cameras, start, end,
      useDirection !== false,
      (level === "max" ? "max" : "balanced") as AvoidanceLevel,
    );
    json(200, result);
  } catch (err) {
    json(500, { error: (err as Error).message });
  }
});
server.listen(PORT, () => console.log(`[planner] listening on :${PORT}`));
