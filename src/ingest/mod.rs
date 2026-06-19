//! Ingest sources. A [`Source`] produces [`Flight`]s; how it gets them is
//! implementation-specific. Phase 1 has [`local::LocalFolder`]; Phase 3 will
//! add `xcontest::XContest`.

use crate::model::Flight;

#[derive(Debug, thiserror::Error)]
pub enum SourceError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("parse: {0}")]
    Parse(#[from] crate::igc::IgcError),
    #[error("folder walk: {0}")]
    Walk(String),
    #[error("no .igc files found under {0}")]
    NoFiles(String),
}

pub trait Source {
    /// Returns all flights from this source. Individual flight failures
    /// (corrupt file, unparseable IGC) are skipped with a warning; the method
    /// only fails hard on structural errors (root doesn't exist, etc.).
    fn flights(&self) -> Result<Vec<Flight>, SourceError>;
}

pub mod local;
