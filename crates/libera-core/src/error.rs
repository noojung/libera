use std::io;

/// Why a job ended without a result. The variants mirror the Electron
/// engine's error codes - `COMPRESSION_CANCELLED`, `DESTINATION_EXISTS` and so
/// on - so a UI maps them onto the messages it already has.
#[derive(Debug, thiserror::Error)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Error))]
pub enum LiberaError {
    #[error("Compression cancelled")]
    CompressionCancelled,
    #[error("Extraction cancelled")]
    ExtractionCancelled,
    #[error("{message}")]
    DestinationExists { message: String },
    #[error("{message}")]
    UnsafeArchive { message: String },
    #[error("{message}")]
    InvalidInput { message: String },
    #[error("{message}")]
    Io { message: String },
}

impl From<io::Error> for LiberaError {
    fn from(error: io::Error) -> Self {
        Self::Io { message: error.to_string() }
    }
}
