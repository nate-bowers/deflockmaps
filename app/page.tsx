"use client";

import dynamic from "next/dynamic";

// Map must render client-side only (maplibre-gl needs the browser).
const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

export default function Home() {
  return <MapView />;
}
