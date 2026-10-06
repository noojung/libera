//! The archive engine behind Libera's native apps.
//!
//! Every job takes a [`ProgressListener`] and a [`CancelToken`] and blocks
//! until it ends, so the caller decides which thread it runs on. Options,
//! results and error codes follow the Electron engine's, which lets both apps
//! share one set of messages.

mod apple_double;
mod codec;
mod compress;
mod deflate;
mod error;
mod extract;
mod formats;
mod inputs;
mod patterns;
mod progress;
mod resolve;
mod safety;
mod sevenz;
mod zip;

pub use codec::{StreamCodec, ZSTD_MAX_WINDOW_SIZE, ZSTD_MAX_WORKERS, ZSTD_MIN_WINDOW_SIZE, ZstdStrategy};
pub use compress::{
    CompressionOptions, CompressionResult, PlannedFile, SevenZipSolidBlock, compress_archive,
    plan_seven_zip_solid_blocks,
};
pub use deflate::DeflateStrategy;
pub use error::LiberaError;
pub use extract::{ExtractionContext, ExtractionOptions, ExtractionResult, extract_archive, extract_archive_with};
pub use formats::{
    ArchiveFormat, compression_levels, is_supported_archive_path, nearest_level, supported_archive_extensions,
    supports_header_encryption, supports_level, supports_password, supports_split,
};
pub use inputs::{FileItem, item_stats, list_input_children};
pub use progress::{CancelToken, ProgressData, ProgressListener, ProgressPhase};
pub use resolve::{ArchiveVolume, ResolvedArchive, canonical_archive, resolve_extraction_input};
pub use safety::ExtractionPolicy;
pub use safety::target::OverwritePolicy;
pub use sevenz::{
    MAX_DICTIONARY_SIZE, MAX_SEVEN_ZIP_VOLUMES, MIN_DICTIONARY_SIZE, SevenZipDictionary, SevenZipMethod,
    SevenZipMethodOverride,
};
pub use zip::{
    FilenameEncoding, MAX_SPLIT_VOLUMES, MIN_SPLIT_SIZE, OverrideScope, ZipEncryptionMethod, ZipMethod,
    ZipMethodOverride,
};

#[cfg(feature = "uniffi")]
uniffi::setup_scaffolding!();
