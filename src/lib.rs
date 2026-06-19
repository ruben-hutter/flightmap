//! flightmap — personal paragliding flight heatmap from IGC tracklogs.
//!
//! See PLAN.md for the design. This crate grows with phases 0–4.

pub mod aggregate;
pub mod bin;
pub mod climb;
pub mod geo;
pub mod igc;
pub mod ingest;
pub mod model;
pub mod simplify;

pub use aggregate::{build_products, skyway_collection, thermal_collection, Products};
pub use bin::{bin_climbs, BinnedCell, DEFAULT_CELL_SIZE_M};
pub use climb::{detect_climbs, ClimbConfig};
pub use igc::{parse_igc, IgcError};
pub use ingest::{local::LocalFolder, Source, SourceError};
pub use model::{ClimbSegment, Flight, SourceKind, TrackPoint};
pub use simplify::simplify_flight;
