# flightmap justfile — cross-cutting tasks. Run `just --list` to see all.

default:
    @just --list

# Format everything (rust + nix + frontend once it exists).
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

# Run the Phase 0 CLI on a single IGC file.
run file:
    cargo run --quiet -- {{file}}

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
