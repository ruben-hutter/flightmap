//! Mercator-grid binning of climb centroids. Solves the deck.gl
//! `HeatmapLayer` per-frame density-recompute lag by pre-aggregating in
//! Rust and letting a cheap `ScatterPlotLayer` render the result.
//!
//! Strategy (PLAN.md §3.5 / §7 Phase 1 — kk7-style Mercator grid):
//!   1. Project each climb centroid to Web-Mercator metres.
//!   2. Floor to a `cell_size_m` × `cell_size_m` grid.
//!   3. Per cell: count climbs, sum/peak climb rates, sum altitude gain.
//!   4. Emit cell centres as GeoJSON Points with the aggregated properties.
//!
//! Fixed cell size gives natural LOD: cells appear larger at low zoom
//! (regional overview) and smaller at high zoom (individual thermal cores),
//! but always represent the same ground area. Phase 4 may add multi-LOD
//! vector tiles if single-resolution becomes the bottleneck.

use std::collections::HashMap;

use crate::geo::{latlon_to_webmercator, webmercator_to_latlon};
use crate::model::ClimbSegment;

/// A single aggregated grid cell.
#[derive(Debug, Clone, PartialEq)]
pub struct BinnedCell {
    pub centroid_lat: f64,
    pub centroid_lon: f64,
    pub count: u32,
    /// Mean climb rate over all climbs in this cell, m/s.
    pub avg_climb_ms: f32,
    /// Peak climb rate observed in this cell, m/s.
    pub peak_climb_ms: f32,
    /// Sum of altitude gained across all climbs in this cell, metres.
    pub total_gain_m: i64,
}

#[derive(Debug)]
struct Accumulator {
    cell_key: (i64, i64),
    cell_size_m: f64,
    count: u32,
    weight_sum: f32,
    peak_climb_ms: f32,
    total_gain_m: i64,
}

impl Accumulator {
    fn new(cell_key: (i64, i64), cell_size_m: f64) -> Self {
        Self {
            cell_key,
            cell_size_m,
            count: 0,
            weight_sum: 0.0,
            peak_climb_ms: f32::NEG_INFINITY,
            total_gain_m: 0,
        }
    }

    fn add(&mut self, c: &ClimbSegment) {
        self.count += 1;
        self.weight_sum += c.avg_climb_ms;
        if c.peak_climb_ms > self.peak_climb_ms {
            self.peak_climb_ms = c.peak_climb_ms;
        }
        self.total_gain_m += c.gain_m as i64;
    }

    fn finalize(self) -> BinnedCell {
        // Cell centre = floor(key * size) + size/2.
        let center_x = (self.cell_key.0 as f64 * self.cell_size_m) + self.cell_size_m / 2.0;
        let center_y = (self.cell_key.1 as f64 * self.cell_size_m) + self.cell_size_m / 2.0;
        let (lat, lon) = webmercator_to_latlon(center_x, center_y);
        BinnedCell {
            centroid_lat: lat,
            centroid_lon: lon,
            count: self.count,
            avg_climb_ms: if self.count > 0 {
                self.weight_sum / self.count as f32
            } else {
                0.0
            },
            peak_climb_ms: self.peak_climb_ms,
            total_gain_m: self.total_gain_m,
        }
    }
}

/// Bin a slice of [`ClimbSegment`]s into a Mercator grid of `cell_size_m`
/// metres. Cells with one or more climbs are returned; empty cells are
/// omitted (sparse encoding — fine for typical flight densities).
pub fn bin_climbs(climbs: &[ClimbSegment], cell_size_m: f64) -> Vec<BinnedCell> {
    let mut bins: HashMap<(i64, i64), Accumulator> = HashMap::new();
    for c in climbs {
        let (x, y) = latlon_to_webmercator(c.centroid.0, c.centroid.1);
        let key = (
            (x / cell_size_m).floor() as i64,
            (y / cell_size_m).floor() as i64,
        );
        bins.entry(key)
            .or_insert_with(|| Accumulator::new(key, cell_size_m))
            .add(c);
    }
    bins.into_values().map(|a| a.finalize()).collect()
}

/// Default cell size: 150 m. Empirically a good balance — fine enough to
/// separate neighbouring thermals, coarse enough to aggregate a season's
/// flights into a usable density signal.
pub const DEFAULT_CELL_SIZE_M: f64 = 150.0;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ClimbSegment;
    use chrono::NaiveDate;

    fn climb_at(lat: f64, lon: f64, rate: f32, gain: i32) -> ClimbSegment {
        ClimbSegment {
            flight_id: "local:t.igc".into(),
            start_time: NaiveDate::from_ymd_opt(2025, 1, 1)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
            end_time: NaiveDate::from_ymd_opt(2025, 1, 1)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
            avg_climb_ms: rate,
            peak_climb_ms: rate * 1.5,
            gain_m: gain,
            centroid: (lat, lon),
        }
    }

    #[test]
    fn nearby_climbs_collapse_into_one_cell() {
        // Two climbs within a few metres of each other must bin together.
        let climbs = vec![
            climb_at(46.0, 8.0, 1.5, 100),
            climb_at(46.0001, 8.0001, 2.5, 200), // ~13 m away
        ];
        let cells = bin_climbs(&climbs, 150.0);
        assert_eq!(cells.len(), 1);
        let c = &cells[0];
        assert_eq!(c.count, 2);
        assert!((c.avg_climb_ms - 2.0).abs() < 1e-3);
        assert!((c.peak_climb_ms - 3.75).abs() < 1e-3); // max peak (1.5*1.5=2.25, 2.5*1.5=3.75)
        assert_eq!(c.total_gain_m, 300);
    }

    #[test]
    fn distant_climbs_stay_separate() {
        let climbs = vec![
            climb_at(46.0, 8.0, 1.5, 100),
            climb_at(46.5, 8.5, 2.5, 200), // ~60 km away
        ];
        let cells = bin_climbs(&climbs, 150.0);
        assert_eq!(cells.len(), 2);
    }

    #[test]
    fn empty_input_yields_empty_output() {
        let cells = bin_climbs(&[], 150.0);
        assert!(cells.is_empty());
    }
}
