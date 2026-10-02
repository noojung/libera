mod stream;
mod tar;

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use crate::LiberaError;
use crate::codec::{ZstdStrategy, ZstdTuning};
use crate::deflate::DeflateStrategy;
use crate::formats::ArchiveFormat;
use crate::inputs::InputFilters;
use crate::patterns::EntryFilter;
use crate::progress::{CancelToken, ProgressListener};

/// One compression job. Every expert option is optional, and one that does
/// not apply to `format` fails the job instead of being silently ignored.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct CompressionOptions {
    pub input_paths: Vec<String>,
    pub output_path: String,
    pub format: ArchiveFormat,
    /// 0 (fastest) to 9 (smallest), and 6 when unset, as in the Electron engine.
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub level: Option<u8>,
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub exclude_symlinks: Option<bool>,
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub exclude_mac_metadata: Option<bool>,
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub exclude_hidden_files: Option<bool>,
    /// The glob list that decides which files are worth archiving at all.
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub filter_pattern: Option<String>,
    /// Deflate tuning, for GZ and TAR.GZ.
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub deflate_strategy: Option<DeflateStrategy>,
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub mem_level: Option<u8>,
    /// Zstandard tuning, for ZST and TAR.ZST.
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub zstd_strategy: Option<ZstdStrategy>,
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub zstd_window_size: Option<u32>,
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub zstd_long_distance: Option<bool>,
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub zstd_workers: Option<u8>,
}

impl CompressionOptions {
    /// Options for `format` with every expert setting left to its default.
    pub fn new(input_paths: Vec<String>, output_path: String, format: ArchiveFormat) -> Self {
        Self {
            input_paths,
            output_path,
            format,
            level: None,
            exclude_symlinks: None,
            exclude_mac_metadata: None,
            exclude_hidden_files: None,
            filter_pattern: None,
            deflate_strategy: None,
            mem_level: None,
            zstd_strategy: None,
            zstd_window_size: None,
            zstd_long_distance: None,
            zstd_workers: None,
        }
    }

    fn has_source_filters(&self) -> bool {
        self.exclude_symlinks.is_some()
            || self.exclude_mac_metadata.is_some()
            || self.exclude_hidden_files.is_some()
            || self.filter_pattern.is_some()
    }

    fn filters(&self) -> InputFilters {
        InputFilters {
            exclude_symlinks: self.exclude_symlinks == Some(true),
            exclude_mac_metadata: self.exclude_mac_metadata == Some(true),
            exclude_hidden_files: self.exclude_hidden_files == Some(true),
            pattern: EntryFilter::new(self.filter_pattern.as_deref()),
        }
    }

    fn zstd(&self) -> ZstdTuning {
        ZstdTuning {
            strategy: self.zstd_strategy,
            window_size: self.zstd_window_size,
            long_distance_matching: self.zstd_long_distance == Some(true),
            workers: self.zstd_workers.unwrap_or(0),
        }
    }

    fn zstd_requested(&self) -> bool {
        self.zstd_strategy.is_some()
            || self.zstd_window_size.is_some()
            || self.zstd_long_distance.is_some()
            || self.zstd_workers.is_some()
    }
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct CompressionResult {
    pub output_path: String,
    pub original_size: u64,
    pub compressed_size: u64,
    pub duration_ms: u64,
    /// Every volume of a split set, in order; `None` for a single file.
    pub volume_paths: Option<Vec<String>>,
}

pub(crate) const DEFAULT_LEVEL: u8 = 6;

/// Refuses options that contradict the format or fall outside what its
/// codec takes, before anything is read or written.
fn validate(options: &CompressionOptions) -> Result<u8, LiberaError> {
    let format = options.format;
    let level = options.level.unwrap_or(DEFAULT_LEVEL);
    if level > 9 {
        return Err(LiberaError::invalid_input(format!("Compression level {level} is outside 0-9.")));
    }
    if format.is_single_file() && options.has_source_filters() {
        return Err(LiberaError::invalid_input(
            "Source filters cannot be used with a format that wraps a single file.",
        ));
    }
    if options.zstd_requested() && !format.uses_zstd() {
        return Err(LiberaError::invalid_input(
            "Zstandard codec options can only be used with ZST or TAR.ZST archives.",
        ));
    }
    options.zstd().validate()?;
    if (options.deflate_strategy.is_some() || options.mem_level.is_some()) && !format.uses_deflate() {
        return Err(LiberaError::invalid_input("Deflate tuning options can only be used with GZ or TAR.GZ archives."));
    }
    if options.mem_level.is_some_and(|mem_level| !(1..=9).contains(&mem_level)) {
        return Err(LiberaError::invalid_input("Deflate memory level must be between 1 and 9."));
    }
    Ok(level)
}

/// Writes `options.input_paths` into a new archive at `options.output_path`.
/// A job that fails or is cancelled leaves no archive behind.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn compress_archive(
    options: CompressionOptions,
    listener: Arc<dyn ProgressListener>,
    cancel: Arc<CancelToken>,
) -> Result<CompressionResult, LiberaError> {
    let started = Instant::now();
    let level = validate(&options)?;
    if cancel.is_cancelled() {
        return Err(LiberaError::CompressionCancelled);
    }

    let output_path = Path::new(&options.output_path);
    if let Some(parent) = output_path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    let job = Job { options: &options, level, listener, cancel: &cancel };
    let written = if options.format.is_single_file() { stream::write(&job) } else { tar::write(&job) };
    let original_size = match written {
        Ok(original_size) => original_size,
        Err(error) => {
            let _ = fs::remove_file(output_path);
            return Err(if cancel.is_cancelled() { LiberaError::CompressionCancelled } else { error });
        }
    };

    Ok(CompressionResult {
        compressed_size: fs::metadata(output_path)?.len(),
        output_path: options.output_path,
        original_size,
        duration_ms: started.elapsed().as_millis() as u64,
        volume_paths: None,
    })
}

/// What a format writer needs from the job. Each one returns the bytes it
/// read from the inputs, which the result reports as the original size.
struct Job<'a> {
    options: &'a CompressionOptions,
    level: u8,
    listener: Arc<dyn ProgressListener>,
    cancel: &'a CancelToken,
}
