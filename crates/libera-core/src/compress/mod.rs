mod stream;
mod tar;
mod zip;

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use crate::LiberaError;
use crate::codec::{ZstdStrategy, ZstdTuning};
use crate::deflate::DeflateStrategy;
use crate::formats::{ArchiveFormat, supports_password, supports_split};
use crate::inputs::InputFilters;
use crate::patterns::EntryFilter;
use crate::progress::{CancelToken, ProgressListener};
use crate::zip::{MIN_SPLIT_SIZE, ZipEncryptionMethod, ZipMethod, ZipMethodOverride};

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
    /// Encrypts every entry with data. ZIP only.
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub password: Option<String>,
    /// The largest a volume may grow, in bytes, to write a split set. ZIP only.
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub split_size: Option<u64>,
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub encryption_method: Option<ZipEncryptionMethod>,
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub zip_method: Option<ZipMethod>,
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub zip_method_overrides: Option<Vec<ZipMethodOverride>>,
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub exclude_symlinks: Option<bool>,
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub exclude_mac_metadata: Option<bool>,
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub exclude_hidden_files: Option<bool>,
    /// The glob list that decides which files are worth archiving at all.
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub filter_pattern: Option<String>,
    /// Deflate tuning, for ZIP, GZ and TAR.GZ.
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub deflate_strategy: Option<DeflateStrategy>,
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub mem_level: Option<u8>,
    /// Zstandard tuning, for ZST, TAR.ZST, and ZIP entries written with it.
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
            password: None,
            split_size: None,
            encryption_method: None,
            zip_method: None,
            zip_method_overrides: None,
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
    if options.password.is_some() && !supports_password(format) {
        return Err(LiberaError::invalid_input("Password protection is currently available for ZIP archives only."));
    }
    let is_zip = format == ArchiveFormat::Zip;
    if options.encryption_method.is_some() && !is_zip {
        return Err(LiberaError::invalid_input("ZIP encryption method can only be used with ZIP archives."));
    }
    if options.zip_method.is_some() && !is_zip {
        return Err(LiberaError::invalid_input("ZIP compression method can only be used with ZIP archives."));
    }
    if let Some(overrides) = &options.zip_method_overrides {
        if !is_zip {
            return Err(LiberaError::invalid_input("ZIP method overrides can only be used with ZIP archives."));
        }
        crate::zip::methods::validate_overrides(overrides, &options.input_paths)?;
    }
    if format.is_single_file() && options.has_source_filters() {
        return Err(LiberaError::invalid_input(
            "Source filters cannot be used with a format that wraps a single file.",
        ));
    }
    if options.zstd_requested() && !format.uses_zstd() {
        return Err(LiberaError::invalid_input(
            "Zstandard codec options can only be used with ZST, TAR.ZST, or ZIP archives.",
        ));
    }
    options.zstd().validate()?;
    let deflate_tuned = options.deflate_strategy.is_some() || options.mem_level.is_some();
    if deflate_tuned && !format.uses_deflate() {
        return Err(LiberaError::invalid_input(
            "Deflate tuning options can only be used with ZIP, GZ, or TAR.GZ archives.",
        ));
    }
    if deflate_tuned && is_zip && options.zip_method.is_some_and(|method| method != ZipMethod::Deflate) {
        return Err(LiberaError::invalid_input("Deflate tuning options can only be used with the Deflate method."));
    }
    if options.mem_level.is_some_and(|mem_level| !(1..=9).contains(&mem_level)) {
        return Err(LiberaError::invalid_input("Deflate memory level must be between 1 and 9."));
    }
    if let Some(split_size) = options.split_size {
        if !supports_split(format) {
            return Err(LiberaError::SplitNotSupportedForFormat {
                message: "Split archives are currently available for ZIP archives only.".into(),
            });
        }
        if split_size < MIN_SPLIT_SIZE {
            return Err(LiberaError::SplitSizeTooSmall {
                message: "The split size is below the supported minimum.".into(),
            });
        }
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
    let written = match options.format {
        ArchiveFormat::Zip => zip::write(&job),
        format if format.is_single_file() => stream::write(&job).map(Written::single),
        _ => tar::write(&job).map(Written::single),
    };
    let written = match written {
        Ok(written) => written,
        Err(error) => {
            // A failed split job removes its own volumes; a single archive goes here.
            let _ = fs::remove_file(output_path);
            return Err(if cancel.is_cancelled() { LiberaError::CompressionCancelled } else { error });
        }
    };

    let (output_path, compressed_size, volume_paths) = match written.volumes {
        Some(volumes) => {
            let total =
                volumes.iter().map(|volume| fs::metadata(volume).map(|metadata| metadata.len()).unwrap_or(0)).sum();
            let terminal = volumes.last().map(|volume| volume.to_string_lossy().into_owned()).unwrap_or_default();
            (terminal, total, Some(volumes.iter().map(|volume| volume.to_string_lossy().into_owned()).collect()))
        }
        None => (options.output_path.clone(), fs::metadata(output_path)?.len(), None),
    };
    Ok(CompressionResult {
        output_path,
        original_size: written.original_size,
        compressed_size,
        duration_ms: started.elapsed().as_millis() as u64,
        volume_paths,
    })
}

/// What a format writer reports back: the bytes it read from the inputs, and
/// for a split set, every volume it wrote.
struct Written {
    original_size: u64,
    volumes: Option<Vec<std::path::PathBuf>>,
}

impl Written {
    fn single(original_size: u64) -> Self {
        Self { original_size, volumes: None }
    }
}

/// What a format writer needs from the job.
struct Job<'a> {
    options: &'a CompressionOptions,
    level: u8,
    listener: Arc<dyn ProgressListener>,
    cancel: &'a CancelToken,
}
