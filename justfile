# flightmap justfile — cross-cutting tasks. Run `just --list` to see all.

default:
    @just --list

# ---- Rust ----

# Format everything (rust + nix).
fmt:
    cargo fmt
    @command -v nixpkgs-fmt >/dev/null && nixpkgs-fmt flake.nix || true

# Check formatting without writing.
fmt-check:
    cargo fmt --check

# Lint (clippy with -D warnings across all targets).
lint:
    cargo clippy --all-targets -- -D warnings

# Run all tests.
test:
    cargo test

# Accept all pending insta snapshots without review. Use sparingly.
snap-accept:
    cargo insta accept

# Review pending insta snapshots interactively.
snap-review:
    cargo insta review

# ---- CLI ----

# Single-file stats: point count, UTC range, bbox, alt range.
stats file:
    cargo run --quiet -- stats {{file}}

# Folder summary: total points, climbs detected, compression ratio.
scan folder:
    cargo run --quiet -- scan {{folder}}

# Emit GeoJSON products into web/public/data so the dev server can serve them.
# Use --release for fast parallel parse of large folders.
emit folder:
    cargo run --release --quiet -- emit {{folder}} --out web/public/data

# ---- Web ----

# Start the Vite dev server (auto-opens http://localhost:5173/).
dev:
    pnpm --dir web dev

# Build the web bundle for production (output: web/dist/).
build-web:
    pnpm --dir web build

# Install/reinstall web deps (after pulling changes that touched package.json).
install-web:
    pnpm --dir web install

# ---- Full rebuild + serve ----

# One-shot: re-emit data + start the dev server. The combo you usually want.
serve folder='flights':
    just emit {{folder}}
    just dev

# ---- Environment ----

# Enter the nix dev shell explicitly (normally direnv handles this).
shell:
    nix develop

# Verify the flake builds cleanly (run in CI).
flake-check:
    nix flake check --no-build

# Wipe build artefacts.
clean:
    cargo clean
    rm -rf web/dist web/node_modules web/.vite
