// flightmap web — Phase 1+2 frontend.
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
import { BitmapLayer } from "@deck.gl/layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Feature, FeatureCollection, LineString, Point } from "geojson";

type SkywayFeature = Feature<
  LineString,
  { id: string; points: number; start: string; end: string }
>;
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

type Season = "all" | "spring" | "summer" | "autumn" | "winter";
type TimeOfDay = "all" | "morning" | "midday" | "afternoon";

// Free, no-API-key style. Swap for a self-hosted style.json in production.
const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

// Where `flightmap emit` writes its products. Override per-deployment via
// ?data=... query param if needed.
const DATA_DIR = new URLSearchParams(location.search).get("data") ?? "/data";
const SKYWAY_URL = `${DATA_DIR}/skyway.geojson`;
const THERMAL_URL = `${DATA_DIR}/thermal.geojson`;

// kk7 thermal/skyways tile overlay. `{-y}` in the URL means TMS y-scheme;
// MapLibre's `scheme: "tms"` on the source handles the flip.
const KK7_TILES_URL = "https://thermal.kk7.ch/tiles/skyways_all_all/{z}/{x}/{y}.png";
const KK7_SOURCE_ID = "kk7-thermal";
const KK7_LAYER_ID = "kk7-thermal-overlay";

// Pilot tz — used for season / time-of-day filters. IGC timestamps are UTC
// (PLAN.md §4); we convert via Intl so DST is handled correctly.
const PILOT_TZ = "Europe/Zurich";

// Altitude colour ramp for the skyway layer (metres MSL). Thresholds cover
// the paragliding envelope: 0=ground (green), 1000=scratch (yellow),
// 2000=cloudbase-ish (orange), 3500+=wave/high (purple/white).
function altitudeColor(altM: number): [number, number, number] {
  const stops: Array<[number, [number, number, number]]> = [
    [0, [80, 140, 60]],
    [800, [180, 200, 80]],
    [1600, [240, 180, 60]],
    [2400, [220, 110, 50]],
    [3200, [160, 80, 160]],
    [4000, [240, 240, 255]],
  ];
  if (altM <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (altM <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (altM - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

// ---- Thermal density rendering ----
//
// Build a true density field (Float32 accumulation per pixel), normalise,
// then map through the colour ramp. Same algorithm as deck.gl's
// HeatmapLayer but rendered once per filter change into a static texture —
// pan/zoom just transform a quad, no per-frame work, no lag.
//
// Why not canvas radial gradients + 'lighter' compositing (previous attempt):
// the colour ramp has light middle tones (pale blue, peach) that saturate
// to white under additive blending → the "white stains" look. Per-pixel
// density-then-colormap avoids that — each output pixel looks up its colour
// from a single density value, so saturating to white is impossible.

let thermalCanvas: HTMLCanvasElement | null = null;
// [left, bottom, right, top] in lon/lat degrees — matches deck.gl's
// BitmapBoundingBox 4-number form.
let thermalBounds: [number, number, number, number] | null = null;

// Same 6-stop RdYlBu_r ramp as the original HeatmapLayer colorRange.
const DENSITY_STOPS: Array<[number, [number, number, number]]> = [
  [0.0, [33, 102, 172]], // blue (low density)
  [0.2, [103, 169, 207]],
  [0.4, [209, 229, 240]],
  [0.6, [253, 219, 199]],
  [0.8, [239, 138, 98]],
  [1.0, [178, 24, 43]], // red (high density)
];

function densityColor(t: number): [number, number, number] {
  if (t <= DENSITY_STOPS[0][0]) return DENSITY_STOPS[0][1];
  for (let i = 1; i < DENSITY_STOPS.length; i++) {
    if (t <= DENSITY_STOPS[i][0]) {
      const [t0, c0] = DENSITY_STOPS[i - 1];
      const [t1, c1] = DENSITY_STOPS[i];
      const f = (t - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return DENSITY_STOPS[DENSITY_STOPS.length - 1][1];
}

function rebuildThermalCanvas(climbs: ThermalFeature[]): void {
  if (climbs.length === 0) {
    thermalCanvas = null;
    thermalBounds = null;
    return;
  }

  // ---- Bounds ----
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const f of climbs) {
    const [lon, lat] = f.geometry.coordinates as [number, number];
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }
  const pad = 0.01;
  minLon -= pad;
  minLat -= pad;
  maxLon += pad;
  maxLat += pad;

  const aspect = (maxLon - minLon) / (maxLat - minLat);
  const width = 1024;
  const height = Math.max(1, Math.round(width / aspect));

  // ---- Gaussian kernel (precomputed) ----
  // Sigma in pixels. Controls smoothness — 8 px gives soft, overlapping
  // gradients similar to the HeatmapLayer at radiusPixels=60 on this bbox.
  const sigma = 8;
  const kernelRadius = Math.ceil(sigma * 3);
  const kernelSize = kernelRadius * 2 + 1;
  const kernel = new Float32Array(kernelSize * kernelSize);
  for (let dy = -kernelRadius; dy <= kernelRadius; dy++) {
    for (let dx = -kernelRadius; dx <= kernelRadius; dx++) {
      const r2 = dx * dx + dy * dy;
      kernel[(dy + kernelRadius) * kernelSize + (dx + kernelRadius)] = Math.exp(
        -r2 / (2 * sigma * sigma),
      );
    }
  }

  // ---- Accumulate density (MAX, not SUM) ----
  // Per pixel, store the strongest peak climb rate that touched it (scaled
  // by the Gaussian falloff). This is "what's the best thermal I could
  // expect at this spot" — multiple weak thermals don't combine into a
  // strong colour. A single 5 m/s climb paints red; ten 1 m/s climbs stay
  // blue.
  const density = new Float32Array(width * height);
  const xScale = width / (maxLon - minLon);
  const yScale = height / (maxLat - minLat);

  for (const f of climbs) {
    const [lon, lat] = f.geometry.coordinates as [number, number];
    const px = Math.round((lon - minLon) * xScale);
    const py = Math.round((maxLat - lat) * yScale); // Y flipped
    // Peak rate is the strongest instant within the climb — the "how good
    // was the core" signal. Floor at 0.5 so we don't divide-by-zero on
    // degenerate climbs.
    const peak = Math.max(0.5, f.properties.peak_climb_ms);

    for (let dy = -kernelRadius; dy <= kernelRadius; dy++) {
      const y = py + dy;
      if (y < 0 || y >= height) continue;
      const rowBase = y * width;
      const kernelRow = (dy + kernelRadius) * kernelSize;
      for (let dx = -kernelRadius; dx <= kernelRadius; dx++) {
        const x = px + dx;
        if (x < 0 || x >= width) continue;
        const k = kernel[kernelRow + (dx + kernelRadius)];
        const contribution = peak * k;
        const idx = rowBase + x;
        if (contribution > density[idx]) density[idx] = contribution;
      }
    }
  }

  // ---- Density → RGBA (absolute scale, no normalisation) ----
  // colours are tied to absolute m/s values, so the meaning is stable
  // across filter changes: 5+ m/s is always red, 1 m/s is always blue.
  const MAX_RATE = 6.0; // m/s — top of the colour ramp
  const FULL_OPACITY_RATE = 2.5; // m/s — alpha saturates here

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;

  for (let i = 0; i < density.length; i++) {
    const rate = density[i]; // peak m/s at this pixel (gauss-scaled)
    if (rate < 0.3) continue; // skip near-zero — keep canvas transparent
    const colorT = Math.min(1, rate / MAX_RATE);
    const [r, g, b] = densityColor(colorT);
    const alphaT = Math.min(1, rate / FULL_OPACITY_RATE);
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = Math.round(alphaT * 255);
  }
  ctx.putImageData(imageData, 0, 0);

  thermalCanvas = canvas;
  thermalBounds = [minLon, minLat, maxLon, maxLat];
}

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
const kk7Toggle = document.getElementById("toggle-kk7") as HTMLInputElement;
const skywayColorRadios = document.querySelectorAll<HTMLInputElement>(
  'input[name="skyway-color"]',
);
const seasonSelect = document.getElementById("filter-season") as HTMLSelectElement;
const todSelect = document.getElementById("filter-tod") as HTMLSelectElement;

let skyway: FeatureCollection<LineString, SkywayFeature["properties"]> | null = null;
let thermalRaw: FeatureCollection<Point, ThermalFeature["properties"]> | null = null;

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
  if (therm.status === "fulfilled") thermalRaw = therm.value;

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

  recenter();
  refreshThermalCanvas();
}

function recenter(): void {
  if (!skyway || skyway.features.length === 0) return;
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

function skywayColorMode(): "uniform" | "altitude" {
  for (const r of skywayColorRadios) {
    if (r.checked) return r.value as "uniform" | "altitude";
  }
  return "uniform";
}

// ---- Pilot-tz conversion (UTC → Europe/Zurich) ----
function localParts(isoUtc: string): { month: number; hour: number } | null {
  // The Rust side emits "YYYY-MM-DD HH:MM:SS" — a NaiveDateTime, implicitly
  // UTC because IGC is UTC. Re-parse as UTC explicitly.
  const d = new Date(isoUtc.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return null;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: PILOT_TZ,
    month: "numeric",
    hour: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const month = Number(parts.find((p) => p.type === "month")?.value ?? 0);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  return { month, hour: hour === 24 ? 0 : hour };
}

function classifySeason(month: number): Season {
  if (month === 12 || month <= 2) return "winter";
  if (month <= 5) return "spring";
  if (month <= 8) return "summer";
  return "autumn";
}

function classifyTod(hour: number): TimeOfDay {
  if (hour < 12) return "morning";
  if (hour < 15) return "midday";
  return "afternoon";
}

function applyFilters(): {
  skyway: SkywayFeature[] | null;
  thermal: ThermalFeature[];
} {
  const season = seasonSelect.value as Season;
  const tod = todSelect.value as TimeOfDay;

  const filteredSkyway: SkywayFeature[] | null = skyway
    ? skyway.features.filter((f) => {
        if (season === "all" && tod === "all") return true;
        const parts = localParts(f.properties.start);
        if (!parts) return true;
        if (season !== "all" && classifySeason(parts.month) !== season) return false;
        if (tod !== "all" && classifyTod(parts.hour) !== tod) return false;
        return true;
      })
    : null;

  const filteredThermalRaw: ThermalFeature[] = thermalRaw
    ? thermalRaw.features.filter((f) => {
        if (season === "all" && tod === "all") return true;
        const parts = localParts(f.properties.start);
        if (!parts) return true;
        if (season !== "all" && classifySeason(parts.month) !== season) return false;
        if (tod !== "all" && classifyTod(parts.hour) !== tod) return false;
        return true;
      })
    : [];

  return { skyway: filteredSkyway, thermal: filteredThermalRaw };
}

function setKk7Overlay(on: boolean): void {
  const hasSource = !!map.getSource(KK7_SOURCE_ID);
  if (on && !hasSource) {
    map.addSource(KK7_SOURCE_ID, {
      type: "raster",
      tiles: [KK7_TILES_URL],
      tileSize: 256,
      scheme: "tms",
      attribution: "thermal.kk7.ch",
      maxzoom: 14,
    });
    map.addLayer({
      id: KK7_LAYER_ID,
      type: "raster",
      source: KK7_SOURCE_ID,
      paint: { "raster-opacity": 0.45 },
    });
  } else if (!on && hasSource) {
    if (map.getLayer(KK7_LAYER_ID)) map.removeLayer(KK7_LAYER_ID);
    map.removeSource(KK7_SOURCE_ID);
  }
}

function rerender(): void {
  const filtered = applyFilters();

  const skywayCount = filtered.skyway?.length ?? 0;
  statsEl.textContent = `${skywayCount} flights · ${filtered.thermal.length} climbs`;

  const layers: (PathLayer<SkywayFeature> | BitmapLayer)[] = [];

  if (skywayToggle.checked && filtered.skyway && filtered.skyway.length > 0) {
    const colorMode = skywayColorMode();
    const useAltitude = colorMode === "altitude";
    layers.push(
      new PathLayer<SkywayFeature>({
        id: "skyway",
        data: filtered.skyway,
        // Drop the altitude (positions[2]) from the geometry — deck.gl's
        // PathLayer reads every position element and would otherwise render
        // the track at altitude, floating it off the map. Altitude stays
        // available for the colour lookup in getColor.
        getPath: (f: SkywayFeature) => {
          const coords = f.geometry.coordinates as unknown as Array<
            [number, number, number]
          >;
          return coords.map(([lon, lat]) => [lon, lat]) as unknown as [
            number,
            number,
          ][];
        },
        getColor: (f: SkywayFeature) => {
          if (!useAltitude) return [80, 120, 200, 180];
          const coords = f.geometry.coordinates as unknown as Array<
            [number, number, number]
          >;
          return coords.map(([_, __, alt]) => {
            const [r, g, b] = altitudeColor(alt);
            return [r, g, b, 200];
          }) as unknown as [number, number, number, number];
        },
        getWidth: 1.2,
        widthMinPixels: 1,
        widthUnits: "pixels",
        pickable: false,
      }),
    );
  }

  if (thermalToggle.checked && thermalCanvas && thermalBounds) {
    // BitmapLayer on the pre-rendered density canvas. No per-frame work —
    // pan/zoom just transforms a static texture. Smooth regardless of how
    // many climbs are in the dataset.
    layers.push(
      new BitmapLayer({
        id: "thermal",
        image: thermalCanvas,
        bounds: thermalBounds,
        pickable: false,
      }),
    );
  }

  overlay.setProps({ layers });
}

// Rebuild the thermal density canvas whenever the underlying filtered climb
// set changes — i.e. on load and on filter/tod changes. Pan/zoom do NOT
// trigger a rebuild; that's the whole point.
function refreshThermalCanvas(): void {
  const filtered = applyFilters();
  rebuildThermalCanvas(filtered.thermal);
  rerender();
}

skywayToggle.addEventListener("change", rerender);
thermalToggle.addEventListener("change", rerender);
kk7Toggle.addEventListener("change", () => setKk7Overlay(kk7Toggle.checked));
skywayColorRadios.forEach((r) => r.addEventListener("change", rerender));
seasonSelect.addEventListener("change", refreshThermalCanvas);
todSelect.addEventListener("change", refreshThermalCanvas);

map.on("load", () => {
  void load();
});
