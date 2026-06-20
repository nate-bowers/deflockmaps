"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { parseCoordinates } from "@/lib/parseLocation";
import {
  googleMapsUrl,
  buildGpx,
  encodeShareParams,
  decodeShareParams,
} from "@/lib/navExport";

type Pt = { lat: number; lng: number };

type Camera = { id: number; lat: number; lon: number };

type RouteOption = {
  id: string;
  label: string;
  geometry: Pt[];
  timeSec: number;
  distanceMi: number;
  cameraCount: number;
  cameraIds: number[];
  facingAwayCount: number;
  facingAwayIds: number[];
};

type PlanResult = {
  options: RouteOption[];
  cameraFreeExists: boolean;
  note: string | null;
  useDirection: boolean;
};

type BasemapKey = "simple" | "city" | "satellite";

const BASEMAPS: Record<BasemapKey, string[]> = {
  simple: [
    "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    "https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
  ],
  city: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
  satellite: [
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  ],
};
// We swap tiles in place (setTiles), which doesn't update attribution — so the
// source credits all three providers we use.
const BASEMAP_ATTRIBUTION =
  "© OpenStreetMap contributors · © CARTO · Imagery © Esri, Maxar";

function makeStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {
      basemap: {
        type: "raster",
        tiles: BASEMAPS.city,
        tileSize: 256,
        maxzoom: 19,
        attribution: BASEMAP_ATTRIBUTION,
      },
    },
    layers: [
      // Gray backdrop so the map never flashes black while raster tiles load.
      { id: "bg", type: "background", paint: { "background-color": "#e5e7eb" } },
      { id: "basemap", type: "raster", source: "basemap" },
    ],
  };
}

// SF Bay Area.
const INITIAL_CENTER: [number, number] = [-122.33, 37.83];
const INITIAL_ZOOM = 11;

const ROUTE_COLORS = ["#38bdf8", "#22d3ee", "#a78bfa", "#34d399", "#fbbf24"];

function fmtTime(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default function MapView() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const startMarker = useRef<maplibregl.Marker | null>(null);
  const endMarker = useRef<maplibregl.Marker | null>(null);
  const camerasFC = useRef<GeoJSON.FeatureCollection | null>(null);

  // Refs mirror state so the map click handler (bound once) sees fresh values.
  const startRef = useRef<Pt | null>(null);
  const endRef = useRef<Pt | null>(null);

  const [start, setStart] = useState<Pt | null>(null);
  const [end, setEnd] = useState<Pt | null>(null);
  const [startText, setStartText] = useState("");
  const [endText, setEndText] = useState("");

  const [useDirection, setUseDirection] = useState(true);
  const [level, setLevel] = useState<"balanced" | "max">("balanced");
  const [basemap, setBasemap] = useState<BasemapKey>("city");
  const [result, setResult] = useState<PlanResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cameraCount, setCameraCount] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  function setStartPt(p: Pt | null) {
    startRef.current = p;
    setStart(p);
  }
  function setEndPt(p: Pt | null) {
    endRef.current = p;
    setEnd(p);
  }

  // Init map once.
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: makeStyle(),
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      attributionControl: false,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      "bottom-left",
    );

    const setupLayers = async () => {
      const empty: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features: [],
      };

      map.addSource("cameras", { type: "geojson", data: empty });
      map.addLayer({
        id: "cameras",
        type: "circle",
        source: "cameras",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2, 15, 5],
          "circle-color": "#3f3f46",
          "circle-opacity": 0.7,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 0.6,
          "circle-stroke-opacity": 0.5,
        },
      });
      // Cameras facing the other way on the selected route (shown, not avoided).
      map.addLayer({
        id: "cameras-away",
        type: "circle",
        source: "cameras",
        filter: ["in", ["get", "id"], ["literal", []]],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 3, 15, 7],
          "circle-color": "#f59e0b",
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 1.5,
        },
      });
      // Cameras that capture the selected route (red).
      map.addLayer({
        id: "cameras-hit",
        type: "circle",
        source: "cameras",
        filter: ["in", ["get", "id"], ["literal", []]],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4, 15, 8],
          "circle-color": "#ef4444",
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 1.5,
        },
      });

      map.addSource("routes", { type: "geojson", data: empty });
      // Casing under the line for contrast on any basemap.
      map.addLayer({
        id: "routes-casing",
        type: "line",
        source: "routes",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#0b1220",
          "line-width": ["case", ["get", "selected"], 8, 5],
          "line-opacity": ["case", ["get", "selected"], 0.5, 0.2],
        },
      });
      map.addLayer({
        id: "routes",
        type: "line",
        source: "routes",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["case", ["get", "selected"], 5, 3],
          "line-opacity": ["case", ["get", "selected"], 1, 0.4],
        },
      });

      try {
        const res = await fetch("/api/cameras");
        const json = await res.json();
        if (json.cameras) {
          setCameraCount(json.count);
          const fc: GeoJSON.FeatureCollection = {
            type: "FeatureCollection",
            features: json.cameras.map((c: Camera) => ({
              type: "Feature",
              geometry: { type: "Point", coordinates: [c.lon, c.lat] },
              properties: { id: c.id },
            })),
          };
          camerasFC.current = fc;
          (map.getSource("cameras") as maplibregl.GeoJSONSource).setData(fc);
        }
      } catch {
        /* best-effort */
      }
    };

    // Run setup as soon as the style spec is parsed (the base layer exists).
    let didSetup = false;
    const trySetup = () => {
      if (didSetup || !map.getLayer("basemap")) return;
      didSetup = true;
      void setupLayers();
    };
    map.on("styledata", trySetup);
    trySetup();

    // Click: 1st sets start, 2nd sets end, 3rd resets to a new start.
    map.on("click", (e) => {
      const pt = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      const label = `${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}`;
      if (!startRef.current || (startRef.current && endRef.current)) {
        setStartPt(pt);
        setStartText(label);
        setEndPt(null);
        setEndText("");
      } else {
        setEndPt(pt);
        setEndText(label);
      }
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Swap the basemap by removing and re-adding the raster source (clears the old
  // tile cache so the new imagery actually renders). Guarded so it never runs
  // before the style is loaded; deferred to the next idle if not ready yet.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const swap = () => {
      if (!map.isStyleLoaded()) return false;
      if (map.getLayer("basemap")) map.removeLayer("basemap");
      if (map.getSource("basemap")) map.removeSource("basemap");
      map.addSource("basemap", {
        type: "raster",
        tiles: BASEMAPS[basemap],
        tileSize: 256,
        maxzoom: 19,
        attribution: BASEMAP_ATTRIBUTION,
      });
      // Keep the basemap below the camera/route overlays.
      const beforeId = map.getLayer("cameras") ? "cameras" : undefined;
      map.addLayer({ id: "basemap", type: "raster", source: "basemap" }, beforeId);
      return true;
    };
    if (swap()) return;
    const onIdle = () => {
      if (swap()) map.off("idle", onIdle);
    };
    map.on("idle", onIdle);
    return () => {
      map.off("idle", onIdle);
    };
  }, [basemap]);

  // Load a shared route from the URL (?s=&e=&dir=&lvl=) once on mount.
  useEffect(() => {
    const shared = decodeShareParams(window.location.search);
    if (!shared?.start || !shared?.end) return;
    setStartPt(shared.start);
    setEndPt(shared.end);
    setStartText(`${shared.start.lat.toFixed(5)}, ${shared.start.lng.toFixed(5)}`);
    setEndText(`${shared.end.lat.toFixed(5)}, ${shared.end.lng.toFixed(5)}`);
    if (typeof shared.useDirection === "boolean") setUseDirection(shared.useDirection);
    if (shared.level) setLevel(shared.level);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Markers + camera framing.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    startMarker.current?.remove();
    endMarker.current?.remove();
    if (start) {
      startMarker.current = new maplibregl.Marker({ color: "#34d399" })
        .setLngLat([start.lng, start.lat])
        .addTo(map);
    }
    if (end) {
      endMarker.current = new maplibregl.Marker({ color: "#f43f5e" })
        .setLngLat([end.lng, end.lat])
        .addTo(map);
    }
    if (start && end) {
      map.fitBounds(
        [
          [Math.min(start.lng, end.lng), Math.min(start.lat, end.lat)],
          [Math.max(start.lng, end.lng), Math.max(start.lat, end.lat)],
        ],
        { padding: { top: 80, bottom: 80, left: 380, right: 80 }, maxZoom: 14 },
      );
    } else if (start) {
      map.easeTo({ center: [start.lng, start.lat] });
    }
  }, [start, end]);

  // Request routes when both points are set (or options change).
  useEffect(() => {
    if (!start || !end) {
      setResult(null);
      setSelectedId(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setResult(null);
      try {
        const res = await fetch("/api/route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ start, end, useDirection, level }),
        });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error ?? "Routing failed");
          return;
        }
        setResult(json);
        setSelectedId(json.options?.[0]?.id ?? null);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [start, end, useDirection, level]);

  // Draw routes + highlight hit / facing-away cameras.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource("routes")) return;

    const options = result?.options ?? [];
    const features: GeoJSON.Feature[] = options.map((opt, i) => ({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: opt.geometry.map((p) => [p.lng, p.lat]),
      },
      properties: {
        id: opt.id,
        color: ROUTE_COLORS[i % ROUTE_COLORS.length],
        selected: opt.id === selectedId,
      },
    }));
    (map.getSource("routes") as maplibregl.GeoJSONSource).setData({
      type: "FeatureCollection",
      features,
    });

    const selected = options.find((o) => o.id === selectedId);
    if (map.getLayer("cameras-hit")) {
      map.setFilter("cameras-hit", [
        "in",
        ["get", "id"],
        ["literal", selected?.cameraIds ?? []],
      ]);
    }
    if (map.getLayer("cameras-away")) {
      map.setFilter("cameras-away", [
        "in",
        ["get", "id"],
        ["literal", selected?.facingAwayIds ?? []],
      ]);
    }
  }, [result, selectedId]);

  function reset() {
    setStartPt(null);
    setEndPt(null);
    setStartText("");
    setEndText("");
    setResult(null);
    setSelectedId(null);
    setError(null);
  }

  function downloadGpx() {
    if (!selected) return;
    const gpx = buildGpx("DeFlock avoidance route", selected.geometry);
    const blob = new Blob([gpx], { type: "application/gpx+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "deflock-route.gpx";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copyShareLink() {
    if (!start || !end) return;
    const qs = encodeShareParams({ start, end, useDirection, level });
    const url = `${window.location.origin}${window.location.pathname}?${qs}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard may be unavailable */
    }
  }

  const options = result?.options ?? [];
  const selected = options.find((o) => o.id === selectedId);

  return (
    <div className="relative h-screen w-screen bg-zinc-200">
      {/* h-full (not absolute inset-0): maplibre-gl.css forces position:relative on
          its container, which would override `absolute` and collapse the height. */}
      <div ref={mapContainer} className="h-full w-full" />

      {/* Basemap switcher */}
      <div className="absolute bottom-4 right-4 z-10 flex gap-0.5 rounded-lg bg-zinc-900/85 p-1 text-xs font-medium text-zinc-400 ring-1 ring-white/10 backdrop-blur">
        {(["simple", "city", "satellite"] as const).map((b) => (
          <button
            key={b}
            type="button"
            onClick={() => setBasemap(b)}
            className={`rounded-md px-2.5 py-1 capitalize transition ${
              basemap === b
                ? "bg-sky-500 text-white"
                : "hover:bg-white/5 hover:text-zinc-200"
            }`}
          >
            {b}
          </button>
        ))}
      </div>

      {/* Control panel */}
      <div className="absolute left-3 top-3 z-10 flex max-h-[calc(100vh-1.5rem)] w-[340px] max-w-[92vw] flex-col overflow-y-auto rounded-2xl bg-zinc-900/90 text-zinc-100 shadow-2xl ring-1 ring-white/10 backdrop-blur-md">
        <div className="p-4">
          {/* Header */}
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-sky-400 shadow-[0_0_8px] shadow-sky-400/60" />
            <h1 className="text-[15px] font-semibold tracking-tight text-white">
              Flock-avoidance routing
            </h1>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {cameraCount != null
              ? `${cameraCount.toLocaleString()} ALPR cameras · Bay Area`
              : "Loading cameras…"}
          </p>

          {/* Address / coordinate inputs */}
          <div className="mt-4 space-y-2">
            <LocationInput
              placeholder="Start — address or lat, lng"
              value={startText}
              dotColor="#34d399"
              onChange={setStartText}
              onSelect={(pt) => setStartPt(pt)}
            />
            <LocationInput
              placeholder="Destination — address or lat, lng"
              value={endText}
              dotColor="#f43f5e"
              onChange={setEndText}
              onSelect={(pt) => setEndPt(pt)}
            />
            <p className="text-[11px] text-zinc-500">
              Type for suggestions, or click the map to drop points.
            </p>
          </div>

          {/* Direction toggle */}
          <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-sm text-zinc-200">
            <input
              type="checkbox"
              checked={useDirection}
              onChange={(e) => setUseDirection(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-sky-500"
            />
            <span>
              Use camera direction
              <span className="mt-0.5 block text-[11px] leading-snug text-zinc-500">
                Only avoid cameras facing your way; ignore ones facing the other
                direction.
              </span>
            </span>
          </label>

          {/* Avoidance strength */}
          <div className="mt-4">
            <Segmented
              options={[
                { key: "balanced", label: "Balanced" },
                { key: "max", label: "Maximum avoidance" },
              ]}
              value={level}
              onChange={(v) => setLevel(v as "balanced" | "max")}
            />
            <p className="mt-1.5 text-[11px] leading-snug text-zinc-500">
              {level === "max"
                ? "Avoids every dodgeable camera at any cost — accepts large detours for the fewest cameras. Takes a few seconds."
                : "Fast, sensible tradeoffs between time and cameras."}
            </p>
          </div>

          {result?.note && (
            <p className="mt-3 rounded-lg bg-amber-500/10 p-2.5 text-xs leading-snug text-amber-300 ring-1 ring-amber-500/20">
              {result.note}
            </p>
          )}
          {loading && (
            <p className="mt-4 flex items-center gap-2 text-sm text-sky-400">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-sky-400/30 border-t-sky-400" />
              Computing routes…
            </p>
          )}
          {error && (
            <p className="mt-4 rounded-lg bg-red-500/10 p-2.5 text-sm text-red-300 ring-1 ring-red-500/20">
              {error}
            </p>
          )}

          {start && end && !loading && !error && options.length > 0 && (
            <p className="mt-4 text-xs font-medium uppercase tracking-wide text-zinc-500">
              {result?.cameraFreeExists
                ? "Camera-free route available"
                : "No camera-free route — lowest exposure"}
            </p>
          )}

          {/* Route option cards */}
          <div className="mt-2 space-y-2">
            {options.map((opt, i) => {
              const isSelected = opt.id === selectedId;
              return (
                <button
                  key={opt.id}
                  onClick={() => setSelectedId(opt.id)}
                  className={`w-full rounded-xl border p-3 text-left transition ${
                    isSelected
                      ? "border-sky-500/60 bg-sky-500/10"
                      : "border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 font-semibold text-zinc-100">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full"
                        style={{
                          background: ROUTE_COLORS[i % ROUTE_COLORS.length],
                        }}
                      />
                      {opt.label}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        opt.cameraCount === 0
                          ? "bg-emerald-500/15 text-emerald-300"
                          : "bg-red-500/15 text-red-300"
                      }`}
                    >
                      {opt.cameraCount === 0
                        ? "0 cameras"
                        : `${opt.cameraCount} camera${opt.cameraCount > 1 ? "s" : ""}`}
                    </span>
                  </div>
                  <div className="mt-1.5 text-sm text-zinc-400">
                    {fmtTime(opt.timeSec)}
                    <span className="px-1.5 text-zinc-600">·</span>
                    {opt.distanceMi.toFixed(1)} mi
                  </div>
                  {opt.facingAwayCount > 0 && (
                    <div className="mt-1 text-[11px] text-amber-400/80">
                      +{opt.facingAwayCount} facing away (not avoided)
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {selected && selected.facingAwayCount > 0 && (
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-500">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: "#f59e0b" }}
              />
              Amber dots: cameras you pass facing the other way.
            </p>
          )}

          {/* Follow / export the selected route */}
          {selected && start && end && (
            <div className="mt-4 border-t border-white/10 pt-4">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
                Follow this route
              </p>
              <a
                href={googleMapsUrl(start, end, selected.geometry)}
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full rounded-lg bg-sky-500 py-2.5 text-center text-sm font-semibold text-white transition hover:bg-sky-400"
              >
                Open in Google Maps
              </a>
              <p className="mt-1.5 text-[11px] leading-snug text-zinc-500">
                Google follows the avoidance route via waypoints pinned at each
                turn.
              </p>
              <div className="mt-2.5 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={downloadGpx}
                  className="rounded-lg border border-white/10 bg-white/[0.03] py-2 text-center text-xs font-medium text-zinc-300 transition hover:bg-white/[0.07]"
                >
                  Download GPX
                </button>
                <button
                  type="button"
                  onClick={copyShareLink}
                  className="rounded-lg border border-white/10 bg-white/[0.03] py-2 text-center text-xs font-medium text-zinc-300 transition hover:bg-white/[0.07]"
                >
                  {copied ? "Link copied" : "Copy link"}
                </button>
              </div>
              <p className="mt-1.5 text-[11px] leading-snug text-zinc-500">
                GPX is the exact path — imports into OsmAnd, Gaia, Garmin, Komoot.
              </p>
            </div>
          )}

          {(start || end || startText || endText) && (
            <button
              onClick={reset}
              className="mt-4 w-full rounded-lg border border-white/10 bg-white/[0.03] py-2 text-sm font-medium text-zinc-300 transition hover:bg-white/[0.07]"
            >
              Reset
            </button>
          )}

          <p className="mt-5 border-t border-white/10 pt-3 text-[11px] leading-snug text-zinc-500">
            Free hobby project, “as is.” Shows{" "}
            <span className="text-zinc-400">known</span> ALPR cameras only
            (DeFlock/OSM) — coverage is incomplete and a “0 cameras” route is no
            guarantee. Route planning only; obey traffic laws and drive safely.
            Not legal advice.{" "}
            <a
              href="/terms"
              target="_blank"
              className="text-zinc-400 underline hover:text-zinc-200"
            >
              Terms &amp; Disclaimer
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: { key: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex gap-1 rounded-lg bg-white/[0.04] p-1 text-sm ring-1 ring-white/10">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={`flex-1 rounded-md px-2 py-1.5 font-medium transition ${
            value === o.key
              ? "bg-sky-500 text-white shadow-sm"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

type Suggestion = { lat: number; lng: number; label: string };

function LocationInput({
  placeholder,
  value,
  dotColor,
  onChange,
  onSelect,
}: {
  placeholder: string;
  value: string;
  dotColor: string;
  onChange: (v: string) => void;
  onSelect: (pt: Pt) => void;
}) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const skipNextFetch = useRef(false);

  // Debounced autocomplete: fetch suggestions ~350ms after the user stops typing.
  useEffect(() => {
    if (skipNextFetch.current) {
      skipNextFetch.current = false;
      return;
    }
    const text = value.trim();
    if (text.length < 3 || parseCoordinates(text)) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    const id = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(text)}`);
        const json = await res.json();
        if (res.ok && Array.isArray(json.results)) {
          setSuggestions(json.results);
          setOpen(json.results.length > 0);
        } else {
          setSuggestions([]);
          setOpen(false);
        }
      } catch {
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    }, 350);
    return () => clearTimeout(id);
  }, [value]);

  function choose(s: Suggestion) {
    skipNextFetch.current = true;
    onChange(s.label.split(",").slice(0, 2).join(",").trim());
    onSelect({ lat: s.lat, lng: s.lng });
    setSuggestions([]);
    setOpen(false);
  }

  function onEnter() {
    const coord = parseCoordinates(value);
    if (coord) {
      onSelect(coord);
      setOpen(false);
      return;
    }
    if (suggestions[0]) choose(suggestions[0]);
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-2.5 rounded-lg bg-white/[0.04] px-2.5 py-2 ring-1 ring-white/10 transition focus-within:ring-sky-500/60">
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: dotColor }}
        />
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onEnter();
            else if (e.key === "Escape") setOpen(false);
          }}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
        />
        {loading && (
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-300" />
        )}
      </div>
      {open && suggestions.length > 0 && (
        <ul className="absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-lg bg-zinc-800 p-1 shadow-xl ring-1 ring-white/10">
          {suggestions.map((s, i) => (
            <li key={i}>
              <button
                type="button"
                // onMouseDown (not onClick) so the input's blur doesn't close
                // the list before the selection registers.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(s);
                }}
                className="block w-full rounded-md px-2.5 py-2 text-left text-sm text-zinc-300 transition hover:bg-sky-500/20 hover:text-white"
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
