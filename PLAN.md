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

## 3. Architecture — single crate, split later

Start as **one crate** (`flightmap`, bin + lib). Don't pre-split into core/cli/server —
the server doesn't exist until Phase 3, and you'll know the real boundary better once
core features exist. Split into a workspace when the second crate has a concrete reason
to exist; not before. Premature splits cost compile time and re-exports for nothing.

```
flightmap/
├── flake.nix                   # nix flakes + direnv dev env (see §3.5)
├── .envrc                      # use flake
├── Cargo.toml                  # single crate, [package] + [lib] + [[bin]]
├── src/
│   ├── lib.rs                  # re-exports
│   ├── main.rs                 # flightmap-cli (point at folder → emit GeoJSON)
│   ├── model.rs                # TrackPoint, Flight, ClimbSegment, layers
│   ├── igc.rs                  # IGC B-record parser (lenient)
│   ├── ingest/
│   │   ├── mod.rs              # trait Source
│   │   ├── local.rs            # folder of .igc (Phase 1)
│   │   └── xcontest.rs         # username source (Phase 3)
│   ├── climb.rs                # vertical-speed + climb-segment detection
│   ├── simplify.rs             # Douglas–Peucker track simplification before emit
│   ├── cache.rs                # parse cache (mtime+size+path keyed)
│   ├── geo.rs                  # Web-Mercator + equirectangular (no UTM, no PROJ)
│   ├── aggregate.rs            # skyway / thermal density products
│   └── airspace.rs             # OpenAIP load + proximity (Phase 2)
├── tests/
│   ├── fixtures/               # committed, anonymised IGCs for snapshot tests
│   └── snapshot_igc.rs         # insta golden tests vs fixtures
├── web/                        # Vite + TS: MapLibre GL + deck.gl frontend
├── flights/                    # gitignored: your real IGCs, never committed
└── .github/workflows/ci.yml    # fmt + clippy + test, driven via flake
```

**Split of responsibilities:** Rust does parse → climb-extract → simplify →
(optionally) bin, and emits GeoJSON / vector tiles. The browser (deck.gl) does
the density rendering. Push binning into Rust only when GPU-side aggregation
stops scaling (Phase 4).

**When to split the workspace:** once Phase 3 lands `flightmap-server` as a
separate binary that needs its own deps (axum, reqwest, scraper) and is
clearly independent of the CLI — that's the trigger to extract
`flightmap-core` as a lib crate. Until then the single crate is faster to
iterate on and avoids `pub use` plumbing.

## 3.5 Dev environment — nix flakes + direnv

We already have nix, direnv, distrobox, podman on this machine. For this project
**nix flakes + direnv is the right choice**; distrobox is unnecessary overhead.

- `flake.nix` pins Rust (via `rust-overlay` or `fenix`) **and** node + pnpm for
  `web/` in a single file. One `nix develop` (or just `cd` thanks to direnv)
  gives both toolchains.
- `flake.lock` is committed for reproducibility — same Rust, same node across
  machines and CI.
- `.envrc` contains `use flake` (plus a `dotenv_if_exists` for optional
  `XCONTEST_USER`-style local secrets). No manual activation step.
- CI runs `nix flake check` (and/or `nix develop --command bash -c '...'`),
  so GitHub Actions gets the exact same environment as the local shell.

**Why not distrobox:** no exotic C deps to co-locate (no CUDA, no libv8, no
database cluster). distrobox would only add container startup latency and a
double-filesystem layer with no upside.

**No PROJ C dependency.** UTM accuracy isn't needed: thermal extraction uses
the equirectangular approximation (`m = deg · 111 320 · cos(lat)`), which is
< 0.5 % error at paragliding latitudes, and deck.gl renders in Web-Mercator
anyway. Killing PROJ removes the one C dep that complicates the flake.

**Tooling in the flake:** `rustup`-less rust, `cargo-edit`, `cargo-insta`,
`nixpkgs-fmt`, `rustfmt`, `clippy`, `node`, `pnpm`, `just` (for the few
cross-cutting tasks). Anything not in nixpkgs gets pinned via
`rust-overlay`/`fenix`.

---

## 4. Core data model (`model.rs`)

```rust
pub struct TrackPoint {
    pub time: chrono::NaiveDateTime,   // IGC timestamps are UTC — store UTC everywhere
    pub lat: f64,
    pub lon: f64,
    pub alt_gps: Option<i32>,          // metres MSL
    pub alt_baro: Option<i32>,         // metres, preferred for vario
}

pub struct Flight {
    pub id: String,                    // prefixed: "local:foo.igc" or "xcontest:1234"
    pub pilot: Option<String>,
    pub points: Vec<TrackPoint>,
    pub source: SourceKind,            // Local | XContest
}

pub struct ClimbSegment {
    pub flight_id: String,             // so the segment is self-describing for the cache
    pub start_time: chrono::NaiveDateTime,
    pub end_time: chrono::NaiveDateTime,
    pub avg_climb_ms: f32,             // weight for the thermal layer
    pub peak_climb_ms: f32,
    pub gain_m: i32,
    pub centroid: (f64, f64),          // circle-fit centroid (not time-weighted — see note)
}
```

Every ingest source and every output layer speaks through these types. Lock this
before writing features.

**Why no `Vec<usize>` indices into `Flight.points`:** indices couple `ClimbSegment`
to a specific `Flight` instance, defeat `Copy`/cheap serialisation, and give
nothing the metadata fields above don't already provide. Time range + `flight_id`
is enough for every downstream layer and keeps the parse cache message-packable.

**Circle-fit centroid:** the time-weighted average of climb fixes biases toward
where you circled slowly, not where the thermal core is. A least-squares circle
fit (`Kåsa's method`, ~10 lines of code) over the climb fixes gives the actual
core. kk7-style Mercator grid binning is the simpler, cheaper version of the
same idea — pick during Phase 1 after seeing the data.

**Timezone policy:** store UTC everywhere (IGC is already UTC). Add a single
`pilot_local_tz: chrono_tz::Tz` (e.g. `Europe/Zurich`) on the *pilot*, not the
flight, and convert at filter time for the season/time-of-day layers in Phase 2.
Never carry tz per point.

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
- `chrono` (+ `chrono-tz` for the Phase 2 local-time filter) — timestamps
- `geo` + `geojson` — geometry + output. `geo` also has Douglas–Peucker built in
  (`Simplify`/`SimplifyIdx`); use it in `simplify.rs` before emitting tracks.
- `serde` / `serde_json` (+ `rmp-serde` for the parse-cache msgpack payload)
- IGC: parse by hand (recommended) or evaluate an `igc` crate
- `insta` (dev) — snapshot tests for the parser against `tests/fixtures/`
- Phase 2: OpenAIP airspace (load their GeoJSON), `geo` for proximity tests
- Phase 3: `reqwest` + `scraper`, `tokio`, `axum`
- **No `proj`.** UTM accuracy isn't worth the PROJ C dependency on the flake.
  Use Web-Mercator directly and the equirectangular approximation for metres
  (see §3.5). Revisit only if a Phase 2+ layer actually needs true projection.

---

## 7. Phases

### Phase 0 — Foundations (½ day)
- `Apache-2.0 LICENSE`, `README.md`, `.gitignore` (covers `flights/`, `target/`,
  `node_modules/`, `dist/`, `.direnv/`).
- `flake.nix` + `.envrc` (see §3.5) — one `cd` and both Rust + node toolchains
  are live. `flake.lock` committed.
- Single crate `flightmap` (lib + bin) with the directory layout from §3.
- Implement `model.rs` (the §4 types, locked) and a minimal `igc.rs` that
  parses one file.
- `flightmap-cli` (`src/main.rs`): read one IGC, print point count + bounding
  box + alt min/max.
- `tests/fixtures/` with anonymised real IGCs (one Skytraxx vario + one
  XCTrack phone file, covering both `HFDTE` and `HFDTEDATE:` date formats in
  the wild), `insta` snapshot tests asserting the parser output. Real IGCs go
  in gitignored `flights/` (e.g. `flights/2026/`).
- `justfile` for cross-cutting tasks (`just fmt`, `just lint`, `just test`,
  `just web-dev`).
- `.github/workflows/ci.yml` running `cargo fmt --check`,
  `cargo clippy -- -D warnings`, `cargo test` (and `pnpm -C web build` once
  web/ exists). Driven through the flake where reasonable.
- **Done when:** `cd` enters the dev shell, `cargo run -- flights/2026/<x>.IGC`
  prints sane stats, and `cargo test` green locally and on CI.

### Phase 1 — Personal heatmap MVP
- `ingest/local.rs`: `Source` trait + folder scanner (parallel via rayon).
- `climb.rs`: smooth the **altitudes** (rolling ~3–5 s) then difference to get
  vertical speed — differencing raw fixes lets baro noise dominate. Flag climb
  segments where smoothed vario > ~0.5 m/s sustained > N s, weighted by avg rate.
  Emit `ClimbSegment`s per §4; decide circle-fit vs grid binning once you see data.
- `simplify.rs`: Douglas–Peucker (`geo::Simplify`) the tracks to ~5 m tolerance
  *before* emitting GeoJSON. Hundreds of flights × thousands of fixes will choke
  deck.gl; this is cheaper and more impactful than server-side binning.
- `cache.rs`: parse cache keyed by `blake3(path || mtime || size)`, payload as
  msgpack via `rmp-serde`. Flat dir under `~/.cache/flightmap/`. No DB.
- `aggregate.rs`: emit two GeoJSON products —
  - **skyway** = simplified track lines (deck.gl `PathLayer`)
  - **thermal** = climb-segment points w/ `avg_climb_ms` weight (deck.gl `HeatmapLayer`)
- **deck.gl ↔ MapLibre spike (early in the phase):** verify the
  `@deck.gl/mapbox` `MapboxOverlay` adapter actually composes with MapLibre GL
  before committing the frontend stack. This is the one non-obvious integration
  point; spike it before building UI on top.
- `web/` (Vite + TS): MapLibre GL basemap + deck.gl layers + toggle UI; loads
  the GeoJSON. Borrow running-heatmap tricks: log-scale toggle, parse cache so
  re-renders are instant.
- **Done when:** open the page, see your personal skyways + thermal cores, and
  `cargo test` still green.

### Phase 2 — Paragliding-specific layers (the differentiators)
- Altitude-banded tracks (colour by MSL/AGL).
- Climb-rate colormap on the thermal layer.
- Season + time-of-day filters (kk7 TimeFilter idea) — filter at aggregate time,
  in the pilot's local tz (`chrono_tz`, set once per pilot per §4), never stored
  per-point.
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

**Resolved:**
- **License:** Apache-2.0 (patent grant, compatible with MapLibre/deck.gl dual
  license ecosystem).
- **Output format Phase 1:** GeoJSON, GPU-binned by deck.gl. Server-side binning
  deferred to Phase 4 and only if needed.
- **Samples vs fixtures:** `flights/` gitignored for real flights;
  `tests/fixtures/` committed with anonymised real IGCs (one Skytraxx, one
  XCTrack) powering snapshot tests.
- **Dev environment:** nix flakes + direnv (single toolchain pin for Rust + node).
  No distrobox, no PROJ C dep.
- **Frontend:** Vite + TypeScript.
- **Workspace shape:** single crate until Phase 3 gives a reason to extract core.

**Still open (decide against real data, not now):**
- Circle-fit centroid (`Kåsa`) vs kk7-style Mercator grid binning for thermal
  cores. Both are easy; pick after the Phase 1 spike.
- Climb-detection thresholds (vario floor, min duration, smoothing window): tune
  against `flights/`.
- Project name (`flightmap` is a working title — there's a public product by
  that name; consider something more specific before publishing).

