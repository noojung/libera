//! The archive engine behind Libera's native apps.
//!
//! Every job takes a [`ProgressListener`] and a [`CancelToken`] and blocks
//! until it ends, so the caller decides which thread it runs on. Options,
//! results and error codes follow the Electron engine's, which lets both apps
//! share one set of messages.

mod compress;
mod error;
mod extract;
mod inputs;
mod progress;

pub use compress::{ArchiveFormat, CompressionOptions, CompressionResult, compress_archive};
pub use error::LiberaError;
pub use extract::{ExtractionOptions, ExtractionResult, extract_archive};
pub use progress::{CancelToken, ProgressData, ProgressListener, ProgressPhase};

#[cfg(feature = "uniffi")]
uniffi::setup_scaffolding!();
