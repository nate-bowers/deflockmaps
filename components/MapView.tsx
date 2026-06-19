"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { parseCoordinates } from "@/lib/parseLocation";
import {
  googleMapsUrl,
  appleMapsUrl,
  wazeUrl,
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

const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [
    // Gray backdrop so the map never flashes black while raster tiles load.
    { id: "bg", type: "background", paint: { "background-color": "#e5e7eb" } },
    { id: "osm", type: "raster", source: "osm" },
  ],
};

// SF Bay Area.
const INITIAL_CENTER: [number, number] = [-122.33, 37.83];
const INITIAL_ZOOM = 11;

const ROUTE_COLORS = ["#2563eb", "#0891b2", "#7c3aed", "#16a34a", "#d97706"];

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
      style: OSM_STYLE,
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl(), "top-right");

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
          "circle-color": "#6b7280",
          "circle-opacity": 0.45,
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
          "circle-stroke-width": 1,
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
          "circle-color": "#dc2626",
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 1,
        },
      });

      map.addSource("routes", { type: "geojson", data: empty });
      map.addLayer({
        id: "routes",
        type: "line",
        source: "routes",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["case", ["get", "selected"], 6, 3],
          "line-opacity": ["case", ["get", "selected"], 0.95, 0.35],
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

    // Run setup as soon as the style spec is parsed (the base layer exists) —
    // NOT isStyleLoaded(), which also waits for visible tiles to finish loading.
    let didSetup = false;
    const trySetup = () => {
      if (didSetup || !map.getLayer("osm")) return;
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
      startMarker.current = new maplibregl.Marker({ color: "#16a34a" })
        .setLngLat([start.lng, start.lat])
        .addTo(map);
    }
    if (end) {
      endMarker.current = new maplibregl.Marker({ color: "#dc2626" })
        .setLngLat([end.lng, end.lat])
        .addTo(map);
    }
    if (start && end) {
      map.fitBounds(
        [
          [Math.min(start.lng, end.lng), Math.min(start.lat, end.lat)],
          [Math.max(start.lng, end.lng), Math.max(start.lat, end.lat)],
        ],
        { padding: { top: 80, bottom: 80, left: 360, right: 80 }, maxZoom: 14 },
      );
    } else if (start) {
      map.easeTo({ center: [start.lng, start.lat] });
    }
  }, [start, end]);

  // Request routes when both points are set (or the direction toggle changes).
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
    <div className="relative h-screen w-screen">
      {/* h-full (not absolute inset-0): maplibre-gl.css forces position:relative on
          its container, which would override `absolute` and collapse the height. */}
      <div ref={mapContainer} className="h-full w-full" />

      <div className="absolute left-4 top-4 z-10 max-h-[calc(100vh-2rem)] w-80 max-w-[90vw] overflow-y-auto rounded-xl bg-white/95 p-4 shadow-xl backdrop-blur">
        <h1 className="text-lg font-bold text-zinc-900">
          Flock-avoidance routing
        </h1>
        <p className="mt-1 text-xs text-zinc-500">
          {cameraCount != null
            ? `${cameraCount.toLocaleString()} ALPR cameras loaded (Bay Area)`
            : "Loading cameras…"}
        </p>

        {/* Address / coordinate inputs */}
        <div className="mt-3 space-y-2">
          <LocationInput
            placeholder="Start — address or lat, lng"
            value={startText}
            dotColor="#16a34a"
            onChange={setStartText}
            onSelect={(pt) => setStartPt(pt)}
          />
          <LocationInput
            placeholder="Destination — address or lat, lng"
            value={endText}
            dotColor="#dc2626"
            onChange={setEndText}
            onSelect={(pt) => setEndPt(pt)}
          />
          <p className="text-[11px] text-zinc-400">
            Start typing for suggestions, or click the map to drop points.
          </p>
        </div>

        {/* Direction toggle */}
        <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-zinc-700">
          <input
            type="checkbox"
            checked={useDirection}
            onChange={(e) => setUseDirection(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Use camera direction
            <span className="block text-[11px] text-zinc-400">
              Only avoid cameras facing your way; ignore ones facing the other
              direction.
            </span>
          </span>
        </label>

        {/* Avoidance strength */}
        <div className="mt-3">
          <div className="flex rounded-lg border border-zinc-200 p-0.5 text-sm">
            {(["balanced", "max"] as const).map((lvl) => (
              <button
                key={lvl}
                type="button"
                onClick={() => setLevel(lvl)}
                className={`flex-1 rounded-md px-2 py-1 font-medium transition ${
                  level === lvl
                    ? "bg-blue-600 text-white"
                    : "text-zinc-600 hover:bg-zinc-100"
                }`}
              >
                {lvl === "balanced" ? "Balanced" : "Maximum avoidance"}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-zinc-400">
            {level === "max"
              ? "Avoid every dodgeable camera at any cost — accepts huge detours for the fewest cameras. Can take a few seconds."
              : "Fast, sensible tradeoffs between time and cameras."}
          </p>
        </div>

        {result?.note && (
          <p className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800">
            {result.note}
          </p>
        )}
        {loading && (
          <p className="mt-3 text-sm text-blue-600">Computing routes…</p>
        )}
        {error && (
          <p className="mt-3 rounded-md bg-red-50 p-2 text-sm text-red-700">
            {error}
          </p>
        )}

        {start && end && !loading && !error && options.length > 0 && (
          <p className="mt-3 text-sm text-zinc-500">
            {result?.cameraFreeExists
              ? "A camera-free route is available."
              : "No camera-free route — showing lowest-exposure options."}
          </p>
        )}

        {/* Route option cards */}
        <div className="mt-3 space-y-2">
          {options.map((opt, i) => {
            const isSelected = opt.id === selectedId;
            return (
              <button
                key={opt.id}
                onClick={() => setSelectedId(opt.id)}
                className={`w-full rounded-lg border p-3 text-left transition ${
                  isSelected
                    ? "border-blue-500 bg-blue-50"
                    : "border-zinc-200 bg-white hover:border-zinc-300"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 font-semibold text-zinc-900">
                    <span
                      className="inline-block h-3 w-3 rounded-full"
                      style={{
                        background: ROUTE_COLORS[i % ROUTE_COLORS.length],
                      }}
                    />
                    {opt.label}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      opt.cameraCount === 0
                        ? "bg-green-100 text-green-700"
                        : "bg-red-100 text-red-700"
                    }`}
                  >
                    {opt.cameraCount === 0
                      ? "0 cameras"
                      : `${opt.cameraCount} camera${opt.cameraCount > 1 ? "s" : ""}`}
                  </span>
                </div>
                <div className="mt-1 text-sm text-zinc-600">
                  {fmtTime(opt.timeSec)} · {opt.distanceMi.toFixed(1)} mi
                </div>
                {opt.facingAwayCount > 0 && (
                  <div className="mt-1 text-[11px] text-amber-600">
                    +{opt.facingAwayCount} facing the other way (not avoided)
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {selected && selected.facingAwayCount > 0 && (
          <p className="mt-2 text-[11px] text-zinc-400">
            <span className="inline-block h-2 w-2 rounded-full align-middle" style={{ background: "#f59e0b" }} />{" "}
            Amber dots: cameras you pass that face the other way.
          </p>
        )}

        {/* Follow / export the selected route */}
        {selected && start && end && (
          <div className="mt-3 border-t border-zinc-200 pt-3">
            <p className="mb-1.5 text-xs font-medium text-zinc-600">
              Follow this route
            </p>
            <a
              href={googleMapsUrl(start, end, selected.geometry)}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full rounded-lg bg-blue-600 py-2 text-center text-sm font-medium text-white hover:bg-blue-700"
            >
              Open in Google Maps
            </a>
            <p className="mt-1 text-[11px] text-zinc-400">
              Google follows the avoidance route via waypoints. Apple/Waze go
              straight to the destination only.
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <a
                href={appleMapsUrl(start, end)}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg border border-zinc-200 py-1.5 text-center text-xs font-medium text-zinc-600 hover:bg-zinc-50"
              >
                Apple Maps
              </a>
              <a
                href={wazeUrl(end)}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg border border-zinc-200 py-1.5 text-center text-xs font-medium text-zinc-600 hover:bg-zinc-50"
              >
                Waze
              </a>
              <button
                type="button"
                onClick={downloadGpx}
                className="rounded-lg border border-zinc-200 py-1.5 text-center text-xs font-medium text-zinc-600 hover:bg-zinc-50"
              >
                Download GPX
              </button>
              <button
                type="button"
                onClick={copyShareLink}
                className="rounded-lg border border-zinc-200 py-1.5 text-center text-xs font-medium text-zinc-600 hover:bg-zinc-50"
              >
                {copied ? "Copied!" : "Copy link"}
              </button>
            </div>
            <p className="mt-1 text-[11px] text-zinc-400">
              GPX is the precise path — imports into OsmAnd, Gaia, Garmin, Komoot, etc.
            </p>
          </div>
        )}

        {(start || end || startText || endText) && (
          <button
            onClick={reset}
            className="mt-3 w-full rounded-lg bg-zinc-100 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-200"
          >
            Reset
          </button>
        )}

        <p className="mt-4 border-t border-zinc-200 pt-3 text-[11px] leading-snug text-zinc-400">
          Free hobby project, provided “as is.” Shows <b>known</b> ALPR cameras
          only (crowd-sourced via DeFlock/OSM) — coverage is incomplete and a
          “0 cameras” route is not a guarantee. For route planning only; obey all
          traffic laws and drive safely. Not legal advice.{" "}
          <a href="/terms" target="_blank" className="underline hover:text-zinc-600">
            Terms &amp; Disclaimer
          </a>
          .
        </p>
      </div>
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

  // Debounced autocomplete: fetch suggestions ~350ms after the user stops
  // typing (skipped for coordinate input or right after picking a suggestion).
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
      <div className="flex items-center gap-2 rounded-lg border border-zinc-200 px-2 py-1.5 focus-within:border-blue-400">
        <span
          className="h-3 w-3 shrink-0 rounded-full"
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
          className="min-w-0 flex-1 bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400"
        />
        {loading && <span className="text-xs text-zinc-400">…</span>}
      </div>
      {open && suggestions.length > 0 && (
        <ul className="absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-zinc-200 bg-white shadow-lg">
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
                className="block w-full px-3 py-2 text-left text-sm text-zinc-700 hover:bg-blue-50"
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
