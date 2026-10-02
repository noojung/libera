use std::fs::{self, File};
use std::io::{self, BufWriter};
use std::path::Path;

use super::Job;
use crate::LiberaError;
use crate::codec::Encoder;
use crate::formats::ArchiveFormat;
use crate::progress::{Reporter, Tracked};

/// Writes a GZ or ZST: one file, encoded as a single stream with no entry
/// table around it.
pub(super) fn write(job: &Job) -> Result<u64, LiberaError> {
    let options = job.options;
    let label = options.format.label();
    let Some(source) = options.input_paths.first() else {
        return Err(LiberaError::InvalidSingleFileInput {
            message: format!("No input files specified for {label} compression."),
        });
    };
    let source = Path::new(source);
    let metadata = fs::symlink_metadata(source)?;
    if metadata.is_dir() {
        let folder_format = if options.format == ArchiveFormat::Zst { ".tar.zst" } else { ".tgz" };
        return Err(LiberaError::InvalidSingleFileInput {
            message: format!(
                "{label} format supports single files only. Please use {folder_format} for folder compression."
            ),
        });
    }
    // A link is followed here: the stream carries content, not entries.
    let size = fs::metadata(source)?.len();
    let reporter = Reporter::new(job.listener.clone(), Some(size));
    if let Some(name) = source.file_name() {
        reporter.set_current_file(name.to_string_lossy());
    }

    let file = BufWriter::new(File::create(&options.output_path)?);
    let mut encoder = match options.format {
        ArchiveFormat::Zst => Encoder::zstd(file, job.level, options.zstd())?,
        _ => Encoder::gzip(file, job.level, options.deflate_strategy, options.mem_level)?,
    };
    io::copy(&mut Tracked::new(File::open(source)?, &reporter, job.cancel), &mut encoder)?;
    encoder.finish()?.into_inner().map_err(io::IntoInnerError::into_error)?;
    reporter.complete();
    Ok(size)
}
