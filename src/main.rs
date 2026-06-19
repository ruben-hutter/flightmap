//! flightmap-cli — Phase 0 entrypoint: parse one IGC file, print stats.

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::Parser;

use flightmap::{parse_igc, SourceKind};

#[derive(Parser)]
#[command(
    name = "flightmap",
    version,
    about = "Parse IGC tracklogs and emit stats / GeoJSON"
)]
struct Cli {
    /// Path to a single .igc file.
    path: PathBuf,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let text = std::fs::read_to_string(&cli.path)
        .with_context(|| format!("reading {}", cli.path.display()))?;
    let id = format!(
        "{}:{}",
        SourceKind::Local.prefix(),
        cli.path.file_name().unwrap_or_default().to_string_lossy()
    );
    let flight = parse_igc(&text, &id).context("parsing IGC")?;

    let stats = flightmap_stats::summarize(&flight);
    println!("{}", stats);

    Ok(())
}

// Kept in an inner module so the rendering logic is unit-testable without
// pulling the binary into a test build.
mod flightmap_stats {
    use flightmap::Flight;

    pub struct Summary {
        pub id: String,
        pub point_count: usize,
        pub start: chrono::NaiveDateTime,
        pub end: chrono::NaiveDateTime,
        pub min_lat: f64,
        pub max_lat: f64,
        pub min_lon: f64,
        pub max_lon: f64,
        pub baro_min: Option<i32>,
        pub baro_max: Option<i32>,
        pub gps_min: Option<i32>,
        pub gps_max: Option<i32>,
    }

    pub fn summarize(f: &Flight) -> Summary {
        let mut s = Summary {
            id: f.id.clone(),
            point_count: f.points.len(),
            start: f.points.first().unwrap().time,
            end: f.points.last().unwrap().time,
            min_lat: f64::INFINITY,
            max_lat: f64::NEG_INFINITY,
            min_lon: f64::INFINITY,
            max_lon: f64::NEG_INFINITY,
            baro_min: None,
            baro_max: None,
            gps_min: None,
            gps_max: None,
        };
        for p in &f.points {
            s.min_lat = s.min_lat.min(p.lat);
            s.max_lat = s.max_lat.max(p.lat);
            s.min_lon = s.min_lon.min(p.lon);
            s.max_lon = s.max_lon.max(p.lon);
            if let Some(b) = p.alt_baro {
                s.baro_min = Some(s.baro_min.map_or(b, |m| m.min(b)));
                s.baro_max = Some(s.baro_max.map_or(b, |m| m.max(b)));
            }
            if let Some(g) = p.alt_gps {
                s.gps_min = Some(s.gps_min.map_or(g, |m| m.min(g)));
                s.gps_max = Some(s.gps_max.map_or(g, |m| m.max(g)));
            }
        }
        s
    }

    impl std::fmt::Display for Summary {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            writeln!(f, "flight:     {}", self.id)?;
            writeln!(f, "points:     {}", self.point_count)?;
            writeln!(f, "start(UTC): {}", self.start)?;
            writeln!(f, "end  (UTC): {}", self.end)?;
            writeln!(
                f,
                "bbox:       lat [{:.5}, {:.5}]  lon [{:.5}, {:.5}]",
                self.min_lat, self.max_lat, self.min_lon, self.max_lon
            )?;
            if let (Some(lo), Some(hi)) = (self.baro_min, self.baro_max) {
                writeln!(f, "alt baro:   {lo} .. {hi} m")?;
            }
            if let (Some(lo), Some(hi)) = (self.gps_min, self.gps_max) {
                writeln!(f, "alt gps:    {lo} .. {hi} m")?;
            }
            Ok(())
        }
    }
}
