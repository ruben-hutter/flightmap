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
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Feature, FeatureCollection, LineString, Point } from "geojson";

type SkywayFeature = Feature<LineString, { id: string; points: number }>;
type ThermalDensityFeature = Feature<
  Point,
  {
    count: number;
    avg_climb_ms: number;
    peak_climb_ms: number;
    total_gain_m: number;
  }
>;

// Where `flightmap emit` writes its products. Override per-deployment via
// ?data=... query param if needed.
const DATA_DIR = new URLSearchParams(location.search).get("data") ?? "/data";
const SKYWAY_URL = `${DATA_DIR}/skyway.geojson`;
const THERMAL_DENSITY_URL = `${DATA_DIR}/thermal_density.geojson`;

// Colour scale for climb intensity (m/s). Thresholds are loose paraglider
// intuition: <1.5 weak scratch, 1.5-3.5 average thermal, >3.5 strong climb.
// Maps to a 6-stop yellow→orange→red ramp; alpha encoded separately.
function climbColor(rate: number): [number, number, number] {
  // Stops: 0→blue, 1.5→cyan, 2.5→green, 3.5→yellow, 5→orange, 6+→red
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [33, 102, 172]],
    [1.5, [103, 169, 207]],
    [2.5, [128, 200, 100]],
    [3.5, [253, 200, 50]],
    [5.0, [239, 138, 98]],
    [6.5, [178, 24, 43]],
  ];
  if (rate <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (rate <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (rate - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

// Free, no-API-key style. Swap for a self-hosted style.json in production.
const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

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
let thermalDensity: FeatureCollection<
  Point,
  ThermalDensityFeature["properties"]
> | null = null;

async function load(): Promise<void> {
  const skywayPromise = fetch(SKYWAY_URL).then((r) => {
    if (!r.ok) throw new Error(`${SKYWAY_URL}: ${r.status}`);
    return r.json() as Promise<FeatureCollection<LineString, SkywayFeature["properties"]>>;
  });
  const densityPromise = fetch(THERMAL_DENSITY_URL).then((r) => {
    if (!r.ok) throw new Error(`${THERMAL_DENSITY_URL}: ${r.status}`);
    return r.json() as Promise<
      FeatureCollection<Point, ThermalDensityFeature["properties"]>
    >;
  });

  const [sky, density] = await Promise.allSettled([skywayPromise, densityPromise]);
  if (sky.status === "fulfilled") skyway = sky.value;
  if (density.status === "fulfilled") thermalDensity = density.value;

  const missing: string[] = [];
  if (sky.status !== "fulfilled") missing.push("skyway");
  if (density.status !== "fulfilled") missing.push("thermal_density");

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
  const climbCount = thermalDensity?.features.reduce(
    (sum, f) => sum + f.properties.count,
    0,
  ) ?? 0;
  statsEl.textContent = `${skywayCount} flights · ${climbCount} climbs`;

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
  const layers: (PathLayer<SkywayFeature> | ScatterplotLayer<ThermalDensityFeature>)[] = [];

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

  if (thermalToggle.checked && thermalDensity) {
    // ScatterplotLayer on the pre-binned Mercator grid. Much cheaper than
    // HeatmapLayer (no per-frame density recompute); the binned cells +
    // large translucent radii fake the heatmap look naturally.
    layers.push(
      new ScatterplotLayer<ThermalDensityFeature>({
        id: "thermal",
        data: thermalDensity.features,
        getPosition: (f: ThermalDensityFeature) =>
          f.geometry.coordinates as unknown as [number, number],
        // Radius scales with climb count: more visits = bigger blob.
        // In metres so it tracks zoom naturally.
        getRadius: (f: ThermalDensityFeature) =>
          40 + Math.min(200, f.properties.count * 8),
        radiusUnits: "meters",
        radiusMinPixels: 4,
        radiusMaxPixels: 80,
        // Color by avg climb rate (the Phase 2 climb-rate colormap).
        getFillColor: (f: ThermalDensityFeature) => {
          const rgb = climbColor(f.properties.avg_climb_ms);
          // Alpha: busier cells are more opaque.
          const alpha = Math.min(220, 80 + f.properties.count * 12);
          return [rgb[0], rgb[1], rgb[2], alpha];
        },
        opacity: 0.75,
        stroked: false,
        pickable: true,
        onClick: (info) => {
          if (!info.object) return;
          const p = info.object.properties;
          new maplibregl.Popup()
            .setLngLat(info.coordinate as maplibregl.LngLatLike)
            .setHTML(
              `<b>${p.count} climbs</b><br/>
               avg ${p.avg_climb_ms.toFixed(1)} m/s<br/>
               peak ${p.peak_climb_ms.toFixed(1)} m/s<br/>
               total gain ${p.total_gain_m} m`,
            )
            .addTo(map);
        },
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
