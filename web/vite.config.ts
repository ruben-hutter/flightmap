import { defineConfig } from "vite";

// Vite serves `web/` as root. The page fetches GeoJSON from `/data/`; for
// dev, either symlink `web/public/data -> ../../out` or run
// `cargo run --release -- emit flights/2026 --out web/public/data` so the
// emitted files land where Vite can serve them.
export default defineConfig({
  server: {
    port: 5173,
    open: true,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
