//! Core data model for flightmap.
//!
//! See PLAN.md §4. Every ingest source and every output layer speaks through
//! these types.

use chrono::NaiveDateTime;

/// Where a [`Flight`] came from. Drives the `Flight::id` prefix convention.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SourceKind {
    Local,
    XContest,
}

impl SourceKind {
    pub fn prefix(self) -> &'static str {
        match self {
            SourceKind::Local => "local",
            SourceKind::XContest => "xcontest",
        }
    }
}

/// One GPS/baro fix in a [`Flight`]. Times are always UTC (IGC is UTC-native).
#[derive(Debug, Clone, PartialEq)]
pub struct TrackPoint {
    pub time: NaiveDateTime,
    pub lat: f64,
    pub lon: f64,
    /// GPS altitude, metres MSL. Optional — many older varios only log baro.
    pub alt_gps: Option<i32>,
    /// Pressure/barometric altitude, metres. Preferred for climb-rate math.
    pub alt_baro: Option<i32>,
}

/// A single flight, parsed from one IGC file or one XContest entry.
#[derive(Debug, Clone)]
pub struct Flight {
    /// Prefixed id: `local:foo.igc` or `xcontest:1234` (see [`SourceKind::prefix`]).
    pub id: String,
    pub pilot: Option<String>,
    pub points: Vec<TrackPoint>,
    pub source: SourceKind,
}

/// A continuous segment of circling climb in a [`Flight`]. Phase 1+; declared
/// here so the data model is locked before features get built on it.
///
/// Note: no `Vec<usize>` indices into the parent flight's points — the time
/// range + `flight_id` is enough for every downstream layer and keeps the
/// struct message-packable for the parse cache. See PLAN.md §4.
#[derive(Debug, Clone)]
pub struct ClimbSegment {
    pub flight_id: String,
    pub start_time: NaiveDateTime,
    pub end_time: NaiveDateTime,
    /// Average climb rate over the segment, m/s. Weight for the thermal layer.
    pub avg_climb_ms: f32,
    /// Peak instantaneous climb rate within the segment, m/s.
    pub peak_climb_ms: f32,
    /// Total altitude gained, metres.
    pub gain_m: i32,
    /// Circle-fit centroid (lat, lon). Phase 1 may use a grid-binned centroid
    /// instead — see PLAN.md §4 and Phase 1 open decision.
    pub centroid: (f64, f64),
}
