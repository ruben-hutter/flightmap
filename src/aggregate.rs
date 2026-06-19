//! Output-layer aggregation. Produces the two GeoJSON products the frontend
//! consumes (PLAN.md §7 Phase 1):
//!
//!   * **skyway** — `FeatureCollection` of LineStrings, one per flight, each
//!     simplified in Web-Mercator metres via [`crate::simplify`]. Loaded by
//!     deck.gl's `PathLayer`.
//!   * **thermal** — `FeatureCollection` of Points, one per [`ClimbSegment`],
//!     with `avg_climb_ms` as a property. Loaded by deck.gl's `HeatmapLayer`.
//!
//! Both products stay in lat/lon degrees for output (GeoJSON spec); the
//! metre-tolerance simplification happens internally before projection back.

use geojson::{Feature, FeatureCollection, Geometry, Value};

use crate::bin::{bin_climbs, BinnedCell, DEFAULT_CELL_SIZE_M};
use crate::climb::detect_climbs;
use crate::model::{ClimbSegment, Flight};
use crate::simplify::simplify_flight;

/// All Phase 1+2 output products, ready to serialise.
pub struct Products {
    pub skyway: FeatureCollection,
    /// Per-climb raw points (one per [`ClimbSegment`]); used for detail
    /// inspection / click popups. Heavy: one feature per climb.
    pub thermal: FeatureCollection,
    /// Mercator-grid-binned climb density (one feature per non-empty cell).
    /// Cheap to render with a `ScatterPlotLayer` — replaces the laggy
    /// `HeatmapLayer` on the raw thermal layer.
    pub thermal_density: FeatureCollection,
}

/// Build the skyway + thermal + density products for a set of flights.
///
/// `tolerance_m` is the Douglas–Peucker tolerance in metres (5 m is a good
/// default; smaller = more detail + bigger JSON, larger = coarser tracks).
/// `climb_config` controls thermal detection; see [`crate::climb::ClimbConfig`].
pub fn build_products(
    flights: &[Flight],
    tolerance_m: f64,
    climb_config: &crate::climb::ClimbConfig,
) -> Products {
    let skyway = skyway_collection(flights, tolerance_m);

    let thermals: Vec<ClimbSegment> = flights
        .iter()
        .flat_map(|f| detect_climbs(f, climb_config))
        .collect();
    let thermal = thermal_collection(&thermals);
    let thermal_density = thermal_density_collection(&thermals, DEFAULT_CELL_SIZE_M);

    Products {
        skyway,
        thermal,
        thermal_density,
    }
}

/// Skyway product: one LineString feature per flight, simplified to
/// `tolerance_m` metres on the ground.
pub fn skyway_collection(flights: &[Flight], tolerance_m: f64) -> FeatureCollection {
    let features: Vec<Feature> = flights
        .iter()
        .map(|f| flight_to_skyway_feature(f, tolerance_m))
        .collect();
    FeatureCollection {
        bbox: None,
        features,
        foreign_members: None,
    }
}

/// Thermal product: one Point feature per climb segment, weighted by
/// `avg_climb_ms` for deck.gl's `HeatmapLayer`.
pub fn thermal_collection(climbs: &[ClimbSegment]) -> FeatureCollection {
    let features: Vec<Feature> = climbs.iter().map(climb_to_thermal_feature).collect();
    FeatureCollection {
        bbox: None,
        features,
        foreign_members: None,
    }
}

/// Thermal density product: one Point feature per non-empty Mercator grid
/// cell. Use this with deck.gl's `ScatterPlotLayer` — far cheaper than
/// `HeatmapLayer` on the raw thermals (no per-frame density recompute).
pub fn thermal_density_collection(climbs: &[ClimbSegment], cell_size_m: f64) -> FeatureCollection {
    let cells = bin_climbs(climbs, cell_size_m);
    let features: Vec<Feature> = cells.iter().map(cell_to_density_feature).collect();
    FeatureCollection {
        bbox: None,
        features,
        foreign_members: None,
    }
}

fn flight_to_skyway_feature(flight: &Flight, tolerance_m: f64) -> Feature {
    let simplified = simplify_flight(flight, tolerance_m);
    let coords: Vec<Vec<f64>> = simplified
        .points
        .iter()
        .map(|p| vec![p.lon, p.lat])
        .collect();
    Feature {
        bbox: None,
        geometry: Some(Geometry::new(Value::LineString(coords))),
        id: None,
        properties: Some(
            serde_json::json!({
                "id": simplified.id,
                "points": simplified.points.len(),
            })
            .as_object()
            .unwrap()
            .clone(),
        ),
        foreign_members: None,
    }
}

fn climb_to_thermal_feature(c: &ClimbSegment) -> Feature {
    let (lat, lon) = c.centroid;
    Feature {
        bbox: None,
        geometry: Some(Geometry::new(Value::Point(vec![lon, lat]))),
        id: None,
        properties: Some(
            serde_json::json!({
                "flight_id": c.flight_id,
                "avg_climb_ms": c.avg_climb_ms,
                "peak_climb_ms": c.peak_climb_ms,
                "gain_m": c.gain_m,
                "start": c.start_time.to_string(),
                "end": c.end_time.to_string(),
            })
            .as_object()
            .unwrap()
            .clone(),
        ),
        foreign_members: None,
    }
}

fn cell_to_density_feature(c: &BinnedCell) -> Feature {
    Feature {
        bbox: None,
        geometry: Some(Geometry::new(Value::Point(vec![
            c.centroid_lon,
            c.centroid_lat,
        ]))),
        id: None,
        properties: Some(
            serde_json::json!({
                "count": c.count,
                "avg_climb_ms": c.avg_climb_ms,
                "peak_climb_ms": c.peak_climb_ms,
                "total_gain_m": c.total_gain_m,
            })
            .as_object()
            .unwrap()
            .clone(),
        ),
        foreign_members: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::climb::ClimbConfig;
    use crate::model::{SourceKind, TrackPoint};
    use chrono::{Duration, NaiveDate};

    fn flat_flight(n: usize) -> Flight {
        let base = NaiveDate::from_ymd_opt(2025, 7, 20)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        let points: Vec<TrackPoint> = (0..n)
            .map(|i| TrackPoint {
                time: base + Duration::seconds(i as i64),
                lat: 46.0 + (i as f64) * 0.001,
                lon: 8.0,
                alt_baro: Some(1000),
                alt_gps: None,
            })
            .collect();
        Flight {
            id: "local:flat.igc".into(),
            pilot: None,
            points,
            source: SourceKind::Local,
        }
    }

    #[test]
    fn skyway_has_one_feature_per_flight() {
        let flights = vec![flat_flight(10), flat_flight(20), flat_flight(5)];
        let collection = skyway_collection(&flights, 5.0);
        assert_eq!(collection.features.len(), 3);
    }

    #[test]
    fn thermal_collection_has_no_features_for_flat_flight() {
        let flights = [flat_flight(60)]; // constant altitude → no climbs
        let climbs = flights
            .iter()
            .flat_map(|f| detect_climbs(f, &ClimbConfig::default()))
            .collect::<Vec<_>>();
        let collection = thermal_collection(&climbs);
        assert!(collection.features.is_empty());
    }

    #[test]
    fn products_round_trip_through_json() {
        // Smoke test: products must be JSON-serialisable so the CLI can write
        // them and the browser can fetch them.
        let flights = [flat_flight(30)];
        let products = build_products(&flights, 5.0, &ClimbConfig::default());
        let skyway_json = serde_json::to_string(&products.skyway).unwrap();
        let thermal_json = serde_json::to_string(&products.thermal).unwrap();
        assert!(skyway_json.contains("\"LineString\""));
        // No climbs in a flat flight, but the thermal JSON should still be a
        // valid (empty) FeatureCollection.
        assert!(thermal_json.contains("\"FeatureCollection\""));
    }
}
