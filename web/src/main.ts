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
import { PathLayer, ScatterplotLayer, PolygonLayer } from "@deck.gl/layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type {
  Feature,
  FeatureCollection,
  LineString,
  Point,
  Polygon,
  MultiPolygon,
} from "geojson";

type SkywayFeature = Feature<LineString, {
  id: string;
  points: number;
  start: string;
  end: string;
}>;
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
type ThermalDensityFeature = Feature<
  Point,
  {
    count: number;
    avg_climb_ms: number;
    peak_climb_ms: number;
    total_gain_m: number;
  }
>;
// Airspace polygons are pass-through; their properties depend on the data
// source (OpenAIP vs OpenFlightMaps vs a local dump). We just need to find
// a "name" if there is one for the legend / popup.
type AirspaceFeature = Feature<
  Polygon | MultiPolygon,
  Record<string, unknown> & { name?: string }
>;

type Season = "all" | "spring" | "summer" | "autumn" | "winter";
type TimeOfDay = "all" | "morning" | "midday" | "afternoon";

// Where `flightmap emit` writes its products. Override per-deployment via
// ?data=... query param if needed.
const DATA_DIR = new URLSearchParams(location.search).get("data") ?? "/data";
const SKYWAY_URL = `${DATA_DIR}/skyway.geojson`;
const THERMAL_URL = `${DATA_DIR}/thermal.geojson`;
const AIRSPACE_URL = `${DATA_DIR}/airspace.geojson`;

// Pilot tz — used for season / time-of-day filters. IGC timestamps are UTC
// (PLAN.md §4); we convert via Intl so DST is handled correctly. Make this
// configurable when the Phase 3 server lands.
const PILOT_TZ = "Europe/Zurich";

// Cell size for client-side thermal re-binning. Must match
// `DEFAULT_CELL_SIZE_M` in `src/bin.rs` so the unfiltered view is identical
// to the server-binned `thermal_density.geojson`.
const CELL_SIZE_M = 150;
const EARTH_R = 6_378_137;

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
const kk7Toggle = document.getElementById("toggle-kk7") as HTMLInputElement;
const airspaceToggle = document.getElementById(
  "toggle-airspace",
) as HTMLInputElement;
const skywayColorRadios = document.querySelectorAll<HTMLInputElement>(
  'input[name="skyway-color"]',
);
const seasonSelect = document.getElementById("filter-season") as HTMLSelectElement;
const todSelect = document.getElementById("filter-tod") as HTMLSelectElement;

let airspace: FeatureCollection<Polygon | MultiPolygon, AirspaceFeature["properties"]> | null =
  null;

// kk7 thermal/skyways tile overlay. `{-y}` in the URL means TMS y-scheme;
// MapLibre's `scheme: "tms"` on the source handles the flip. Only the
// `skyways_all_all` product is referenced here — kk7 also exposes season /
// time-of-day filtered variants (`skyways_summer_midday` etc.) which we'll
// wire up when the filters land on the server side (Phase 3).
const KK7_TILES_URL = "https://thermal.kk7.ch/tiles/skyways_all_all/{z}/{x}/{y}.png";
const KK7_SOURCE_ID = "kk7-thermal";
const KK7_LAYER_ID = "kk7-thermal-overlay";

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
      paint: {
        // Semi-transparent so the basemap shows through; this is a
        // comparison overlay, not the primary view.
        "raster-opacity": 0.45,
      },
    });
  } else if (!on && hasSource) {
    if (map.getLayer(KK7_LAYER_ID)) map.removeLayer(KK7_LAYER_ID);
    map.removeSource(KK7_SOURCE_ID);
  }
}

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

  // Airspace is optional — fail silently if absent.
  const airspacePromise = fetch(AIRSPACE_URL).then((r) => {
    if (!r.ok) throw new Error(`${AIRSPACE_URL}: ${r.status}`);
    return r.json() as Promise<
      FeatureCollection<Polygon | MultiPolygon, AirspaceFeature["properties"]>
    >;
  });
  void airspacePromise.then(
    (fc) => {
      airspace = fc;
      rerender();
    },
    () => {
      /* airspace.geojson optional */
    },
  );

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

function skywayColorMode(): "uniform" | "altitude" {
  for (const r of skywayColorRadios) {
    if (r.checked) return r.value as "uniform" | "altitude";
  }
  return "uniform";
}

// ---- Pilot-tz conversion (UTC → Europe/Zurich) ----
// Intl.DateTimeFormat with `timeZone` handles DST; no library needed.
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

// ---- Client-side Mercator binning of filtered climbs ----
// Mirrors src/bin.rs so an unfiltered view == server-side thermal_density.
function project(latDeg: number, lonDeg: number): [number, number] {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  return [EARTH_R * lon, EARTH_R * Math.asinh(Math.tan(lat))];
}

function unproject(x: number, y: number): [number, number] {
  const lon = (x / EARTH_R) * (180 / Math.PI);
  const lat = (Math.atan(Math.sinh(y / EARTH_R)) * 180) / Math.PI;
  return [lat, lon];
}

function binClimbs(climbs: ThermalFeature[]): ThermalDensityFeature[] {
  const bins = new Map<
    string,
    {
      kx: number;
      ky: number;
      count: number;
      rateSum: number;
      peak: number;
      gainSum: number;
    }
  >();
  for (const f of climbs) {
    const [lon, lat] = f.geometry.coordinates as [number, number];
    const [x, y] = project(lat, lon);
    const kx = Math.floor(x / CELL_SIZE_M);
    const ky = Math.floor(y / CELL_SIZE_M);
    const key = `${kx},${ky}`;
    let b = bins.get(key);
    if (!b) {
      b = {
        kx,
        ky,
        count: 0,
        rateSum: 0,
        peak: -Infinity,
        gainSum: 0,
      };
      bins.set(key, b);
    }
    b.count++;
    b.rateSum += f.properties.avg_climb_ms;
    if (f.properties.peak_climb_ms > b.peak) b.peak = f.properties.peak_climb_ms;
    b.gainSum += f.properties.gain_m;
  }
  const out: ThermalDensityFeature[] = [];
  for (const b of bins.values()) {
    const cx = b.kx * CELL_SIZE_M + CELL_SIZE_M / 2;
    const cy = b.ky * CELL_SIZE_M + CELL_SIZE_M / 2;
    const [lat, lon] = unproject(cx, cy);
    out.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {
        count: b.count,
        avg_climb_ms: b.rateSum / b.count,
        peak_climb_ms: b.peak,
        total_gain_m: b.gainSum,
      },
    });
  }
  return out;
}

// Apply the current season + time-of-day filters. Returns null if the
// filter rejects everything (so the caller can show an empty state).
function applyFilters(): {
  skyway: SkywayFeature[] | null;
  thermal: ThermalDensityFeature[];
  totalClimbs: number;
} {
  const season = seasonSelect.value as Season;
  const tod = todSelect.value as TimeOfDay;

  const filteredSkyway: SkywayFeature[] | null = skyway
    ? skyway.features.filter((f) => {
        if (season === "all" && tod === "all") return true;
        const parts = localParts(f.properties.start);
        if (!parts) return true; // unparseable → keep
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

  const binned = binClimbs(filteredThermalRaw);
  return {
    skyway: filteredSkyway,
    thermal: binned,
    totalClimbs: filteredThermalRaw.length,
  };
}

function rerender(): void {
  const filtered = applyFilters();

  const skywayCount = filtered.skyway?.length ?? 0;
  statsEl.textContent = `${skywayCount} flights · ${filtered.totalClimbs} climbs`;

  const layers: (
    | PathLayer<SkywayFeature>
    | ScatterplotLayer<ThermalDensityFeature>
    | PolygonLayer<AirspaceFeature>
  )[] = [];

  // Airspace polygons render first (under skyway/thermal so they don't
  // obscure the data). Polygon outlines only — fills would block the map.
  if (airspaceToggle.checked && airspace && airspace.features.length > 0) {
    layers.push(
      new PolygonLayer<AirspaceFeature>({
        id: "airspace",
        data: airspace.features,
        getPolygon: (f: AirspaceFeature) => {
          // deck.gl wants the polygon as a flat position array; both
          // Polygon and MultiPolygon can be unwrapped here.
          const g = f.geometry;
          if (g.type === "Polygon") {
            return g.coordinates as unknown as number[][];
          }
          // MultiPolygon: use the first ring of the largest polygon as
          // a rough outline. Phase 3 will do per-polygon rendering when
          // the airspace layer moves server-side.
          return (g.coordinates as unknown as number[][][][])
            .map((poly) => poly[0])
            .flat() as unknown as number[][];
        },
        getFillColor: [200, 80, 80, 30],
        getLineColor: [200, 60, 60, 180],
        lineWidthMinPixels: 1,
        stroked: true,
        filled: true,
        pickable: true,
        onClick: (info) => {
          if (!info.object) return;
          const name =
            (info.object.properties.name as string | undefined) ??
            (info.object.properties.Name as string | undefined) ??
            "(unnamed)";
          new maplibregl.Popup()
            .setLngLat(info.coordinate as maplibregl.LngLatLike)
            .setHTML(`<b>${name}</b>`)
            .addTo(map);
        },
      }),
    );
  }

  if (skywayToggle.checked && filtered.skyway && filtered.skyway.length > 0) {
    const colorMode = skywayColorMode();
    const useAltitude = colorMode === "altitude";
    layers.push(
      new PathLayer<SkywayFeature>({
        id: "skyway",
        data: filtered.skyway,
        // Drop the altitude (positions[2]) from the geometry — deck.gl's
        // PathLayer reads every position element and would otherwise render
        // the track at altitude, floating it off the map. We keep altitude
        // available only for the colour lookup in getColor below.
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

  if (thermalToggle.checked && filtered.thermal.length > 0) {
    layers.push(
      new ScatterplotLayer<ThermalDensityFeature>({
        id: "thermal",
        data: filtered.thermal,
        getPosition: (f: ThermalDensityFeature) =>
          f.geometry.coordinates as unknown as [number, number],
        getRadius: (f: ThermalDensityFeature) =>
          40 + Math.min(200, f.properties.count * 8),
        radiusUnits: "meters",
        radiusMinPixels: 4,
        radiusMaxPixels: 80,
        getFillColor: (f: ThermalDensityFeature) => {
          const rgb = climbColor(f.properties.avg_climb_ms);
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
kk7Toggle.addEventListener("change", () => setKk7Overlay(kk7Toggle.checked));
airspaceToggle.addEventListener("change", rerender);
skywayColorRadios.forEach((r) => r.addEventListener("change", rerender));
seasonSelect.addEventListener("change", rerender);
todSelect.addEventListener("change", rerender);
kk7Toggle.addEventListener("change", () => setKk7Overlay(kk7Toggle.checked));

map.on("load", () => {
  void load();
});
