use std::fs::{self, File};
use std::io::{self, BufWriter, Read};
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use flate2::Compression;
use flate2::write::GzEncoder;
use tar::{Builder, Header, HeaderMode};

use crate::LiberaError;
use crate::inputs::{InputEntry, InputKind, collect_inputs};
use crate::progress::{CancelToken, ProgressListener, Reporter, Tracked};

/// The formats this engine writes so far, named after the Electron engine's
/// `ArchiveFormat` values. The others join as their writers are ported.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum ArchiveFormat {
    Tgz,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct CompressionOptions {
    pub input_paths: Vec<String>,
    pub output_path: String,
    pub format: ArchiveFormat,
    /// 0 (fastest) to 9 (smallest), and 6 when unset, as in the Electron engine.
    pub level: Option<u8>,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct CompressionResult {
    pub output_path: String,
    pub original_size: u64,
    pub compressed_size: u64,
    pub duration_ms: u64,
}

const DEFAULT_LEVEL: u8 = 6;

/// Writes `options.input_paths` into a new archive at `options.output_path`.
/// A job that fails or is cancelled leaves no archive behind.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn compress_archive(
    options: CompressionOptions,
    listener: Arc<dyn ProgressListener>,
    cancel: Arc<CancelToken>,
) -> Result<CompressionResult, LiberaError> {
    let started = Instant::now();
    let level = options.level.unwrap_or(DEFAULT_LEVEL);
    if level > 9 {
        return Err(LiberaError::InvalidInput { message: format!("Compression level {level} is outside 0-9.") });
    }
    if options.input_paths.is_empty() {
        return Err(LiberaError::InvalidInput { message: "No input files specified.".into() });
    }
    if cancel.is_cancelled() {
        return Err(LiberaError::CompressionCancelled);
    }

    let output_path = Path::new(&options.output_path);
    let entries = collect_inputs(&options.input_paths, output_path)?;
    let original_size = entries.iter().map(|entry| entry.size).sum();
    let reporter = Reporter::new(listener, Some(original_size));

    let written = File::create(output_path).map_err(LiberaError::from).and_then(|file| match options.format {
        ArchiveFormat::Tgz => write_tar_gz(file, &entries, level, &reporter, &cancel),
    });
    if let Err(error) = written {
        let _ = fs::remove_file(output_path);
        return Err(if cancel.is_cancelled() { LiberaError::CompressionCancelled } else { error });
    }

    let compressed_size = fs::metadata(output_path)?.len();
    reporter.complete();
    Ok(CompressionResult {
        output_path: options.output_path,
        original_size,
        compressed_size,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

fn write_tar_gz(
    file: File,
    entries: &[InputEntry],
    level: u8,
    reporter: &Reporter,
    cancel: &CancelToken,
) -> Result<(), LiberaError> {
    let encoder = GzEncoder::new(BufWriter::new(file), Compression::new(level.into()));
    let mut builder = Builder::new(encoder);
    for entry in entries {
        if cancel.is_cancelled() {
            return Err(LiberaError::CompressionCancelled);
        }
        reporter.set_current_file(&entry.stored_path);
        let metadata = fs::symlink_metadata(&entry.disk_path)?;
        let mut header = Header::new_gnu();
        header.set_metadata_in_mode(&metadata, HeaderMode::Complete);
        match entry.kind {
            InputKind::Directory => {
                header.set_size(0);
                builder.append_data(&mut header, format!("{}/", entry.stored_path), io::empty())?;
            }
            InputKind::File => {
                header.set_size(entry.size);
                let content = ExactLength::new(File::open(&entry.disk_path)?, entry.size);
                builder.append_data(&mut header, &entry.stored_path, Tracked::new(content, reporter, cancel))?;
            }
            InputKind::Symlink => {
                header.set_size(0);
                builder.append_link(&mut header, &entry.stored_path, fs::read_link(&entry.disk_path)?)?;
            }
        }
    }
    builder.into_inner()?.finish()?.into_inner().map_err(io::IntoInnerError::into_error)?;
    Ok(())
}

/// Reads exactly the length a tar header already promised, failing rather
/// than writing a corrupt entry when the file changes size mid-read.
struct ExactLength<R> {
    inner: R,
    remaining: u64,
}

impl<R: Read> ExactLength<R> {
    fn new(inner: R, length: u64) -> Self {
        Self { inner, remaining: length }
    }
}

impl<R: Read> Read for ExactLength<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.remaining == 0 {
            return Ok(0);
        }
        let limit = buf.len().min(usize::try_from(self.remaining).unwrap_or(usize::MAX));
        let read = self.inner.read(&mut buf[..limit])?;
        if read == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "a file shrank while it was being archived"));
        }
        self.remaining -= read as u64;
        Ok(read)
    }
}
