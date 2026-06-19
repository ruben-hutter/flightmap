# flightmap

Personal paragliding flight heatmap from IGC tracklogs. Turns a local folder of
your own flights into personal "skyways" + thermal-core maps, with paragliding-
specific layers kk7's aggregated tiles can't give you.

**Status: Phases 0–2 done.** The tool renders a personal heatmap from a local
folder of IGC files. Phase 3 (XContest source + axum server) is next. See
[`PLAN.md §0`](./PLAN.md) for the full status snapshot.

## What's here

- Single Rust crate (`flightmap`, lib + bin) with the locked data model from
  `PLAN.md §4`.
- Lenient IGC parser handles both `HFDTE` (Skytraxx) and `HFDTEDATE:`
  (XCTrack) date formats — tested against 245 real flights.
- CLI: `stats <file>`, `scan <folder>`, `emit <folder>` subcommands.
- Web frontend (Vite + TS, MapLibre GL + deck.gl):
  - Skyway layer (Douglas–Peucker-simplified tracks, optional altitude bands).
  - Thermal layer (Float32 density buffer + BitmapLayer, colored by peak
    climb rate, smooth pan/zoom).
  - Season + time-of-day filters (DST-aware).
  - kk7 raster comparison overlay.
- Insta snapshot tests, clippy clean, fmt clean.

## Dev environment

This project uses **nix flakes + direnv**. With both installed:

```sh
cd /path/to/flightmap   # direnv auto-loads the dev shell
```

Without direnv: `nix develop`. The flake pins the Rust toolchain (stable, via
`rust-overlay`) and node/pnpm for the frontend.

## Daily workflow

End-to-end: folder of IGC files → GeoJSON → heatmap page.

```sh
# 1. Drop your .igc files under flights/ (gitignored).
#    e.g. flights/2022/, flights/2023/, …, flights/2026/

# 2. Emit GeoJSON straight into the dev server's static dir.
cargo run --release -- emit flights/ --out web/public/data

# 3. Start the web dev server.
pnpm --dir web dev
# → open http://localhost:5173/
```

Or via `just`:

```sh
just serve flights     # = emit + dev in one shot
just scan flights      # folder summary without writing files
just stats flights/2026/foo.IGC   # single-file stats
just test              # cargo test
just lint              # cargo clippy -- -D warnings
```

Tunable knobs on `emit`:

```
--tolerance-m <m>         Douglas–Peucker track tolerance (default 5)
--min-climb-ms <x>        Minimum climb rate to count as a thermal (default 0.5)
--min-duration-s <x>      Minimum sustained climb duration (default 10)
--smoothing-window-s <x>  Altitude smoothing window (default 5)
```

## Layout

See `PLAN.md §3` for the directory map. TL;DR:

- `src/` — Rust crate (`model.rs`, `igc.rs`, `ingest/`, `climb.rs`,
  `simplify.rs`, `bin.rs`, `aggregate.rs`, `main.rs`)
- `tests/fixtures/` — committed, anonymised real IGCs for snapshot tests
- `flights/` — gitignored; drop your real `.igc` files here
  (e.g. `flights/2026/`)
- `web/` — Vite + TS frontend (MapLibre GL + deck.gl)
- `out/` — gitignored default emit target; the dev workflow writes to
  `web/public/data/` instead
- `flake.nix` / `.envrc` / `justfile` — tooling

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
