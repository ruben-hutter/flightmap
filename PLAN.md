# flightmap — personal paragliding flight heatmap (Rust)

> Working title. A self-hostable tool that turns IGC tracklogs into personal
> "skyways" + thermal-core maps. Starts from a local folder of your own flights;
> later ingests an XContest username. Built in Rust, rendered with MapLibre GL +
> deck.gl.

---

## 1. Why this exists (don't reinvent the wheels next to it)

- **kk7 (thermal.kk7.ch)** is *not* open source and its data is aggregated/anonymised
  across *all* pilots — there is structurally no way to get a single pilot out of it.
  We consume kk7 only as an optional comparison tile overlay
  (`https://thermal.kk7.ch/tiles/skyways_all_all/{z}/{x}/{-y}.png`).
- **running-heatmap** is a local Strava-export notebook. We borrow its *ideas*
  (Web-Mercator grid for rasterising, local UTM for real-metre measurements,
  log-scale layer, parse cache) but not its code or data model.
- **The gap we fill:** a *personalized* heatmap for one pilot, with paragliding-specific
  layers (thermal cores from climb rate, airspace proximity) that kk7's global
  average can't give.

## 2. Data-access reality (drives the phasing)

- **XContest has no official public API.** Don't build on a promise of one.
- **Phase 1 source = your own local IGC files** (from XCTrack/vario). No scraping,
  no ToS friction, full history, and IGC carries baro altitude + vertical speed —
  the thing that makes the paragliding version rich.
- **XContest username = a *later*, pluggable source** (Phase 3): scrape per-pilot
  flight list → download + **cache** each IGC once, RSS for incremental updates.
  Quarantined so it can never block Phases 1–2.

---

## 3. Architecture — Cargo workspace

```
flightmap/
├── Cargo.toml                  # [workspace]
├── crates/
│   ├── flightmap-core/         # lib: ingest, parse, climb extraction, aggregation
│   │   ├── src/
│   │   │   ├── lib.rs
│   │   │   ├── model.rs        # TrackPoint, Flight, ClimbSegment, layers
│   │   │   ├── igc.rs          # IGC B-record parser (lenient)
│   │   │   ├── ingest/
│   │   │   │   ├── mod.rs      # trait Source
│   │   │   │   ├── local.rs    # folder of .igc (Phase 1)
│   │   │   │   └── xcontest.rs # username source (Phase 3)
│   │   │   ├── climb.rs        # vertical-speed + climb-segment detection
│   │   │   ├── geo.rs          # mercator helpers, optional UTM
│   │   │   ├── aggregate.rs    # skyway / thermal density products
│   │   │   └── airspace.rs     # OpenAIP load + proximity (Phase 2)
│   │   └── Cargo.toml
│   ├── flightmap-cli/          # bin: point at folder → emit GeoJSON/tiles
│   └── flightmap-server/       # bin (Phase 3+): axum API + static hosting
├── web/                        # MapLibre GL + deck.gl frontend (TS, separate)
└── samples/                    # 5–10 of your own IGCs as fixtures
```

**Split of responsibilities:** Rust does parse → climb-extract → (optionally) bin,
and emits GeoJSON / vector tiles. The browser (deck.gl) does the density rendering.
Push binning into Rust only when GPU-side aggregation stops scaling (Phase 4).

## 4. Core data model (`model.rs`)

```rust
pub struct TrackPoint {
    pub time: chrono::NaiveDateTime,
    pub lat: f64,
    pub lon: f64,
    pub alt_gps: Option<i32>,   // metres MSL
    pub alt_baro: Option<i32>,  // metres, preferred for vario
}

pub struct Flight {
    pub id: String,             // filename or xcontest flight id
    pub pilot: Option<String>,
    pub points: Vec<TrackPoint>,
    pub source: SourceKind,     // Local | XContest
}

pub struct ClimbSegment {
    pub points: Vec<usize>,     // indices into Flight.points
    pub avg_climb_ms: f32,      // weight for the thermal layer
    pub gain_m: i32,
    pub centroid: (f64, f64),
}
```

Every ingest source and every output layer speaks through these types. Lock this
before writing features.

## 5. IGC parsing notes (`igc.rs`)

B-record is fixed-width — parse by hand, it's robust against off-spec phone files:

```
B HHMMSS DDMMmmm N DDDMMmmm E A PPPPP GGGGG
  └time┘ └─lat──┘   └─lon───┘   └baro┘└gps┘
```

- cols 1–6 time `HHMMSS`
- 7–14 lat `DDMMmmm` + N/S (mmm = thousandths of a minute)
- 15–23 lon `DDDMMmmm` + E/W
- 24 fix validity `A`/`V`
- 25–29 pressure altitude (m), 30–34 GPS altitude (m)

Be lenient: tolerate short lines, missing G-record, weird altitudes. Prefer
`alt_baro` for climb rate; fall back to `alt_gps`. Use `rayon` to parse a folder
in parallel.

## 6. Crate choices (verify current versions on crates.io)

- `walkdir` — folder traversal
- `rayon` — parallel parse
- `chrono` — timestamps
- `geo` + `geojson` — geometry + output
- `serde` / `serde_json`
- IGC: parse by hand (recommended) or evaluate an `igc` crate
- Phase 2: OpenAIP airspace (load their GeoJSON), `geo` for proximity tests
- Phase 3: `reqwest` + `scraper`, `tokio`, `axum`
- Optional: `proj` for accurate UTM (needs PROJ C lib) — otherwise do Web-Mercator
  math directly and a local equirectangular approximation for metres

---

## 7. Phases

### Phase 0 — Foundations (½ day)
- `cargo new --lib` workspace + the layout above.
- Implement `model.rs` and a minimal `igc.rs` that parses one file.
- `flightmap-cli`: read one IGC, print point count + bounding box.
- Drop sample IGCs in `samples/`.
- **Done when:** `flightmap-cli samples/foo.igc` prints sane stats.

### Phase 1 — Personal heatmap MVP
- `ingest/local.rs`: `Source` trait + folder scanner (parallel via rayon).
- `climb.rs`: vertical speed between fixes → smooth (rolling ~3–5 s) → climb
  segments where smoothed vario > ~0.5 m/s sustained > N s, weighted by avg rate.
- `aggregate.rs`: emit two GeoJSON products —
  - **skyway** = track lines (deck.gl `PathLayer`)
  - **thermal** = climb-segment points w/ `avg_climb_ms` weight (deck.gl `HeatmapLayer`)
- `web/`: MapLibre GL basemap + deck.gl layers + toggle UI; loads the GeoJSON.
- Borrow running-heatmap tricks: log-scale toggle, parse cache (serialise parsed
  flights so re-renders are instant).
- **Done when:** open the page, see your personal skyways + thermal cores.

### Phase 2 — Paragliding-specific layers (the differentiators)
- Altitude-banded tracks (colour by MSL/AGL).
- Climb-rate colormap on the thermal layer.
- Season + time-of-day filters (kk7 TimeFilter idea) — filter at aggregate time.
- `airspace.rs`: load OpenAIP airspace, flag track segments brushing floors/laterals
  → "airspace proximity" layer. (Ties into the Locarno TMA / LSZL interest.)
- kk7 comparison tiles as an XYZ overlay (inverted-y TMS).
- **Done when:** it's a tool you'd open before flying a site.

### Phase 3 — XContest username source (harder, grayer; pluggable)
- `ingest/xcontest.rs`: per-pilot flight list → flight ids → download + **cache**
  each IGC (fetch once, store forever, never re-hit).
- Use existing XContest RSS tooling as the incremental path: RSS surfaces new
  flights cheaply; deep-fetch only new ones.
- Politeness budget: rate-limit, handle private/missing flights, respect ToS.
- `flightmap-server` (axum): `GET /pilot/:username` → same layered map.
- **Done when:** `buba` returns the same map, sourced from XContest.

### Phase 4 — Polish & extras (pick what's fun)
- 3D replay (deck.gl `TripsLayer`).
- Wind estimate from thermal-circle drift.
- Per-site / per-season stats dashboard (airtime, max alt, XC distance, climb dist).
- Server-side binning / vector tiles (`mvt`) if GPU aggregation stops scaling.
- Self-host on the homelab as a Quadlet container.

---

## 8. Open decisions
- Output format Phase 1: GeoJSON (simplest, GPU-binned) vs pre-binned grid JSON.
  Recommendation: GeoJSON first, bin server-side later only if needed.
- Climb-detection thresholds (vario floor, min duration, smoothing window): tune
  against `samples/`.
- Project name + license.

