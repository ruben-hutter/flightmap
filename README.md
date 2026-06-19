# flightmap

Personal paragliding flight heatmap from IGC tracklogs. Turns a local folder of
your own flights into personal "skyways" + thermal-core maps, with paragliding-
specific layers kk7's aggregated tiles can't give you.

Status: **Phase 0 — foundations.** The IGC parser and CLI stats work; the map
UI comes in Phase 1. See [`PLAN.md`](./PLAN.md) for the full design.

## What's here now

- Single Rust crate (`flightmap`, lib + bin) with the locked data model from
  `PLAN.md §4`.
- Lenient IGC B-record parser (`src/igc.rs`) tolerant of off-spec phone/vario
  files.
- `flightmap <file.igc>` — prints point count, UTC time range, bbox, alt ranges.
- Insta snapshot tests against `tests/fixtures/`.

## Dev environment

This project uses **nix flakes + direnv**. With both installed:

```sh
cd /path/to/flightmap   # direnv auto-loads the dev shell
cargo test
cargo run -- flights/2026/<some-flight>.IGC
```

Without direnv: `nix develop`. The flake pins the Rust toolchain (stable, via
`rust-overlay`) and node/pnpm for the Phase 1 frontend.

## Layout

See `PLAN.md §3` for the directory map. TL;DR:

- `src/` — Rust crate (`model.rs`, `igc.rs`, `main.rs`, …)
- `tests/fixtures/` — committed, anonymised real IGCs for snapshot tests
- `flights/` — gitignored; drop your real `.igc` files here (e.g. `flights/2026/`)
- `web/` — Phase 1 frontend (Vite + TS, MapLibre GL + deck.gl)
- `flake.nix` / `.envrc` / `justfile` — tooling

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
