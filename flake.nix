{
  description = "flightmap — personal paragliding flight heatmap from IGC tracklogs";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, rust-overlay }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs { inherit system overlays; };

        # Pin a stable Rust toolchain. Bump deliberately; not auto-rolled.
        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          extensions = [ "rust-src" "rustfmt" "clippy" ];
        };

        # Keep node + pnpm pinned for the web/ frontend (Phase 1+).
        frontendDeps = with pkgs; [ nodejs_22 pnpm ];

        # Dev-only Cargo helpers — not part of the runtime closure.
        cargoTools = with pkgs; [ cargo-edit cargo-insta ];

      in
      {
        devShells.default = pkgs.mkShell {
          packages = [ rustToolchain pkgs.just ] ++ frontendDeps ++ cargoTools;
          RUST_LOG = "info";
        };

        # `nix build` produces nothing useful yet (Phase 0 has no release-ready
        # artifact). Once the CLI stabilises we'll add a package attr that does
        # crane or naersk build of flightmap.
      });
}
