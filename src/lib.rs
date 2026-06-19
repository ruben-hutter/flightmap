//! flightmap — personal paragliding flight heatmap from IGC tracklogs.
//!
//! See PLAN.md for the design. This crate will grow with phases 0–4; right now
//! (Phase 0) it exposes the core data model and the IGC parser.

pub mod igc;
pub mod model;

pub use igc::{parse_igc, IgcError};
pub use model::{ClimbSegment, Flight, SourceKind, TrackPoint};
