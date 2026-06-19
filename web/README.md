# web/

Phase 1 frontend lives here: Vite + TypeScript with MapLibre GL (basemap) and
deck.gl (skyway PathLayer + thermal HeatmapLayer).

Not scaffolded yet — Phase 0 stops at the Rust crate. The flake already pins
`nodejs_22` and `pnpm` so the moment we hit Phase 1, `pnpm create vite .`
inside this directory drops straight into the right toolchain.

See `PLAN.md §7 Phase 1` for what gets built here, including the early
deck.gl ↔ MapLibre integration spike.
