// flightmap web — Phase 1 frontend.
//
// Loads skyway.geojson + thermal.geojson emitted by `flightmap emit`, renders
// them via deck.gl on top of a MapLibre GL basemap. The deck.gl ↔ MapLibre
// integration uses `MapboxOverlay` from `@deck.gl/mapbox` — see PLAN.md §7
// Phase 1 for why this is the integration point worth verifying.
//
// Run dev server with the data in place:
//   cargo run --release -- emit flights/2026 --out web/public/data
//   pnpm --dir web dev

import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl from "maplibre-gl";
import { PathLayer } from "@deck.gl/layers";
import { HeatmapLayer } from "@deck.gl/aggregation-layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Feature, FeatureCollection, LineString, Point } from "geojson";

type SkywayFeature = Feature<LineString, { id: string; points: number }>;
type ThermalFeature = Feature<
  Point,
  {
    flight_id: string;
    avg_climb_ms: number;
    peak_climb_ms: number;
    gain_m: number;
    start: string;
    end: string;
  }
>;

// Free, no-API-key style. Swap for a self-hosted style.json in production.
const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

// Where `flightmap emit` writes its products. Override per-deployment via
// ?skyway=... query param if needed.
const DATA_DIR = new URLSearchParams(location.search).get("data") ?? "/data";
const SKYWAY_URL = `${DATA_DIR}/skyway.geojson`;
const THERMAL_URL = `${DATA_DIR}/thermal.geojson`;

const map = new maplibregl.Map({
  container: "map",
  style: BASEMAP_STYLE,
  center: [8.9, 46.1], // Locarno area; recenters on data once loaded
  zoom: 9,
});
map.addControl(new maplibregl.NavigationControl(), "top-right");

const overlay = new MapboxOverlay({ layers: [] });
map.addControl(overlay);

const statusEl = document.getElementById("status")!;
const statsEl = document.getElementById("stats")!;
const skywayToggle = document.getElementById("toggle-skyway") as HTMLInputElement;
const thermalToggle = document.getElementById("toggle-thermal") as HTMLInputElement;

let skyway: FeatureCollection<LineString, SkywayFeature["properties"]> | null = null;
let thermal: FeatureCollection<Point, ThermalFeature["properties"]> | null = null;

async function load(): Promise<void> {
  const skywayPromise = fetch(SKYWAY_URL).then((r) => {
    if (!r.ok) throw new Error(`${SKYWAY_URL}: ${r.status}`);
    return r.json() as Promise<FeatureCollection<LineString, SkywayFeature["properties"]>>;
  });
  const thermalPromise = fetch(THERMAL_URL).then((r) => {
    if (!r.ok) throw new Error(`${THERMAL_URL}: ${r.status}`);
    return r.json() as Promise<FeatureCollection<Point, ThermalFeature["properties"]>>;
  });

  const [sky, therm] = await Promise.allSettled([skywayPromise, thermalPromise]);
  if (sky.status === "fulfilled") skyway = sky.value;
  if (therm.status === "fulfilled") thermal = therm.value;

  const missing: string[] = [];
  if (sky.status !== "fulfilled") missing.push("skyway");
  if (therm.status !== "fulfilled") missing.push("thermal");

  if (missing.length === 2) {
    statusEl.textContent = `failed to load ${missing.join(" + ")}.`;
    return;
  }
  if (missing.length === 1) {
    statusEl.textContent = `partial: ${missing[0]} missing.`;
  } else {
    statusEl.textContent = "ready.";
  }

  const skywayCount = skyway?.features.length ?? 0;
  const thermalCount = thermal?.features.length ?? 0;
  statsEl.textContent = `${skywayCount} flights · ${thermalCount} climbs`;

  recenter();
  rerender();
}

function recenter(): void {
  if (!skyway || skyway.features.length === 0) return;
  // Compute bbox from all skyway line endpoints. The GeoJSON is already
  // pre-simplified so this stays cheap even for hundreds of flights.
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const f of skyway.features) {
    for (const [lon, lat] of f.geometry.coordinates) {
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
    }
  }
  map.fitBounds(
    [
      [minLon, minLat],
      [maxLon, maxLat],
    ],
    { padding: 60, animate: false },
  );
}

function rerender(): void {
  const layers: (PathLayer<SkywayFeature> | HeatmapLayer<ThermalFeature>)[] = [];

  if (skywayToggle.checked && skyway) {
    layers.push(
      new PathLayer<SkywayFeature>({
        id: "skyway",
        data: skyway.features,
        getPath: (f: SkywayFeature) =>
          f.geometry.coordinates as unknown as [number, number][],
        getColor: [80, 120, 200, 180],
        getWidth: 1.2,
        widthMinPixels: 1,
        widthUnits: "pixels",
        pickable: false,
      }),
    );
  }

  if (thermalToggle.checked && thermal) {
    layers.push(
      new HeatmapLayer<ThermalFeature>({
        id: "thermal",
        data: thermal.features,
        getPosition: (f: ThermalFeature) =>
          f.geometry.coordinates as unknown as [number, number],
        getWeight: (f: ThermalFeature) => f.properties.avg_climb_ms,
        radiusPixels: 60,
        intensity: 1,
        threshold: 0.05,
        colorRange: [
          [33, 102, 172],
          [103, 169, 207],
          [209, 229, 240],
          [253, 219, 199],
          [239, 138, 98],
          [178, 24, 43],
        ],
        pickable: false,
      }),
    );
  }

  overlay.setProps({ layers });
}

skywayToggle.addEventListener("change", rerender);
thermalToggle.addEventListener("change", rerender);

map.on("load", () => {
  void load();
});
