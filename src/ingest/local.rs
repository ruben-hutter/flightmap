//! Phase 1 source: a folder of local `.igc` files, scanned in parallel via
//! `rayon`. Phase 3's XContest source will produce the same `Flight` type via
//! a different transport.

use std::path::{Path, PathBuf};

use rayon::prelude::*;
use walkdir::WalkDir;

use crate::igc::parse_igc;
use crate::model::SourceKind;

use super::{Source, SourceError};

/// Scan a folder (recursively) for `.igc` files and parse each into a [`Flight`].
pub struct LocalFolder {
    root: PathBuf,
}

impl LocalFolder {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
}

impl Source for LocalFolder {
    fn flights(&self) -> Result<Vec<crate::model::Flight>, SourceError> {
        let files = collect_igc_files(&self.root)?;
        if files.is_empty() {
            return Err(SourceError::NoFiles(self.root.display().to_string()));
        }

        // Parse in parallel. Per-file failures (corrupt IGC, weird format)
        // become warnings, not aborts — we want one bad file out of hundreds
        // to not nuke the whole run.
        let (flights, skipped): (Vec<_>, Vec<_>) =
            files
                .par_iter()
                .partition_map(|path| match read_and_parse(path) {
                    Ok(flight) => rayon::iter::Either::Left(flight),
                    Err(e) => rayon::iter::Either::Right((path.clone(), e)),
                });

        for (path, e) in &skipped {
            eprintln!("warn: skip {}: {}", path.display(), e);
        }

        Ok(flights)
    }
}

fn collect_igc_files(root: &Path) -> Result<Vec<PathBuf>, SourceError> {
    let mut files = Vec::new();
    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let is_igc = entry
            .path()
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("igc"));
        if !is_igc {
            continue;
        }
        files.push(entry.into_path());
    }
    files.sort();
    Ok(files)
}

fn read_and_parse(path: &Path) -> Result<crate::model::Flight, SourceError> {
    let text = std::fs::read_to_string(path)?;
    let filename = path.file_name().map_or_else(
        || path.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    );
    let id = format!("{}:{}", SourceKind::Local.prefix(), filename);
    let flight = parse_igc(&text, &id)?;
    Ok(flight)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixtures_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
    }

    #[test]
    fn local_folder_loads_both_fixtures() {
        let src = LocalFolder::new(fixtures_dir());
        let flights = src.flights().expect("fixtures must load");
        assert_eq!(flights.len(), 2, "expected skytraxx + xctrack fixtures");
        let ids: Vec<&str> = flights.iter().map(|f| f.id.as_str()).collect();
        assert!(ids.iter().any(|id| id.contains("skytraxx")));
        assert!(ids.iter().any(|id| id.contains("xctrack")));
    }

    #[test]
    fn missing_root_errors() {
        let src = LocalFolder::new("/nonexistent/path/that/should/not/exist");
        let err = src.flights().unwrap_err();
        assert!(matches!(err, SourceError::NoFiles(_)));
    }

    #[test]
    fn empty_dir_errors_with_no_files() {
        let tmp = std::env::temp_dir().join(format!("flightmap-empty-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let src = LocalFolder::new(&tmp);
        let err = src.flights().unwrap_err();
        std::fs::remove_dir_all(&tmp).ok();
        assert!(matches!(err, SourceError::NoFiles(_)));
    }
}
