//! flightmap-cli — entrypoint for Phase 0+ operations.
//!
//! Subcommands:
//!   flightmap stats <file>       Print point count / bbox / alt range for one IGC.
//!   flightmap scan  <folder>     Parse every .igc in <folder>, print summary.
//!   flightmap emit  <folder>     Parse + simplify + detect climbs, write
//!                                skyway.geojson + thermal.geojson to --out.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

use flightmap::{build_products, detect_climbs, simplify_flight, ClimbConfig, LocalFolder, Source};

#[derive(Parser)]
#[command(
    name = "flightmap",
    version,
    about = "Parse IGC tracklogs → personal paragliding heatmap (skyway + thermal GeoJSON)"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Print stats for a single IGC file (point count, UTC range, bbox, alt range).
    Stats { path: PathBuf },

    /// Parse every `.igc` under <folder> (recursively) and print a one-line summary.
    Scan { folder: PathBuf },

    /// Parse + simplify + detect climbs, then write skyway.geojson and
    /// thermal.geojson to --out (defaults to `./out`). The web/ frontend
    /// fetches these files.
    Emit(EmitArgs),
}

#[derive(Parser)]
struct EmitArgs {
    /// Folder of `.igc` files (recursive).
    folder: PathBuf,
    /// Output directory for skyway.geojson + thermal.geojson. Created if missing.
    #[arg(long, default_value = "./out")]
    out: PathBuf,
    /// Douglas–Peucker track simplification tolerance, metres.
    #[arg(long, default_value_t = 5.0)]
    tolerance_m: f64,
    /// Minimum smoothed climb rate, m/s.
    #[arg(long, default_value_t = 0.5)]
    min_climb_ms: f32,
    /// Minimum climb segment duration, seconds.
    #[arg(long, default_value_t = 10.0)]
    min_duration_s: f32,
    /// Altitude smoothing window, seconds.
    #[arg(long, default_value_t = 5.0)]
    smoothing_window_s: f32,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Stats { path } => stats(&path),
        Command::Scan { folder } => scan(&folder),
        Command::Emit(args) => emit(args),
    }
}

fn stats(path: &Path) -> Result<()> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let id = format!(
        "{}:{}",
        flightmap::SourceKind::Local.prefix(),
        path.file_name().unwrap_or_default().to_string_lossy()
    );
    let flight = flightmap::parse_igc(&text, &id).context("parsing IGC")?;
    print!("{}", render_stats(&flight));
    Ok(())
}

fn scan(folder: &Path) -> Result<()> {
    let source = LocalFolder::new(folder.to_path_buf());
    let flights = source.flights().context("scanning folder")?;

    eprintln!("parsed {} flights from {}", flights.len(), folder.display());

    let total_points: usize = flights.iter().map(|f| f.points.len()).sum();
    let total_climbs: usize = flights
        .iter()
        .map(|f| detect_climbs(f, &ClimbConfig::default()).len())
        .sum();

    let simplified_points: usize = flights
        .iter()
        .map(|f| simplify_flight(f, 5.0).points.len())
        .sum();

    println!(
        "flights: {n}\n\
         raw points: {total_points}\n\
         simplified points (@5m): {simplified_points}\n\
         compression: {ratio:.1}×\n\
         climbs detected: {total_climbs}",
        n = flights.len(),
        ratio = total_points as f64 / simplified_points.max(1) as f64,
    );

    Ok(())
}

fn emit(args: EmitArgs) -> Result<()> {
    let source = LocalFolder::new(args.folder.clone());
    let flights = source.flights().context("scanning folder")?;

    eprintln!("parsed {} flights", flights.len());

    let climb_config = ClimbConfig {
        min_climb_ms: args.min_climb_ms,
        min_duration_s: args.min_duration_s,
        smoothing_window_s: args.smoothing_window_s,
    };
    let products = build_products(&flights, args.tolerance_m, &climb_config);

    std::fs::create_dir_all(&args.out)
        .with_context(|| format!("creating {}", args.out.display()))?;

    let skyway_path = args.out.join("skyway.geojson");
    let thermal_path = args.out.join("thermal.geojson");
    let density_path = args.out.join("thermal_density.geojson");

    let skyway_json = serde_json::to_string_pretty(&products.skyway)?;
    let thermal_json = serde_json::to_string_pretty(&products.thermal)?;
    let density_json = serde_json::to_string_pretty(&products.thermal_density)?;

    std::fs::write(&skyway_path, skyway_json)?;
    std::fs::write(&thermal_path, thermal_json)?;
    std::fs::write(&density_path, density_json)?;

    let skyway_size = std::fs::metadata(&skyway_path)?.len();
    let thermal_size = std::fs::metadata(&thermal_path)?.len();
    let density_size = std::fs::metadata(&density_path)?.len();
    let skyway_features = products.skyway.features.len();
    let thermal_features = products.thermal.features.len();
    let density_features = products.thermal_density.features.len();

    println!(
        "wrote:\n  {} ({skyway_features} features, {} bytes)\n  {} ({thermal_features} features, {} bytes)\n  {} ({density_features} features, {} bytes)",
        skyway_path.display(),
        skyway_size,
        thermal_path.display(),
        thermal_size,
        density_path.display(),
        density_size,
    );

    Ok(())
}

fn render_stats(flight: &flightmap::Flight) -> String {
    let mut s = String::new();
    use std::fmt::Write;
    let _ = writeln!(s, "flight:     {}", flight.id);
    let _ = writeln!(s, "points:     {}", flight.points.len());
    if let Some(first) = flight.points.first() {
        let _ = writeln!(s, "start(UTC): {}", first.time);
    }
    if let Some(last) = flight.points.last() {
        let _ = writeln!(s, "end  (UTC): {}", last.time);
    }
    let (min_lat, max_lat) = min_max(flight.points.iter().map(|p| p.lat));
    let (min_lon, max_lon) = min_max(flight.points.iter().map(|p| p.lon));
    let _ = writeln!(
        s,
        "bbox:       lat [{min_lat:.5}, {max_lat:.5}]  lon [{min_lon:.5}, {max_lon:.5}]"
    );
    if let (Some(lo), Some(hi)) = (
        flight.points.iter().filter_map(|p| p.alt_baro).min(),
        flight.points.iter().filter_map(|p| p.alt_baro).max(),
    ) {
        let _ = writeln!(s, "alt baro:   {lo} .. {hi} m");
    }
    if let (Some(lo), Some(hi)) = (
        flight.points.iter().filter_map(|p| p.alt_gps).min(),
        flight.points.iter().filter_map(|p| p.alt_gps).max(),
    ) {
        let _ = writeln!(s, "alt gps:    {lo} .. {hi} m");
    }
    s
}

fn min_max(iter: impl IntoIterator<Item = f64>) -> (f64, f64) {
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for v in iter {
        if v < min {
            min = v;
        }
        if v > max {
            max = v;
        }
    }
    (min, max)
}
