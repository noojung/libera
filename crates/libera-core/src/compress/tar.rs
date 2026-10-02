use std::fs::{self, File};
use std::io::{self, BufWriter, Read, Write};
use std::path::Path;

use tar::{Builder, Header, HeaderMode};

use super::Job;
use crate::LiberaError;
use crate::codec::Encoder;
use crate::formats::ArchiveFormat;
use crate::inputs::{InputEntry, InputKind, collect_inputs};
use crate::progress::{Reporter, Tracked};

/// Writes a TAR, TAR.GZ or TAR.ZST: a tarball, inside the codec the format
/// names.
pub(super) fn write(job: &Job) -> Result<u64, LiberaError> {
    let options = job.options;
    if options.input_paths.is_empty() {
        return Err(LiberaError::invalid_input("No input files specified."));
    }
    let output_path = Path::new(&options.output_path);
    let entries = collect_inputs(&options.input_paths, output_path, &options.filters())?;
    let original_size = entries.iter().map(|entry| entry.size).sum();
    if job.cancel.is_cancelled() {
        return Err(LiberaError::CompressionCancelled);
    }
    let reporter = Reporter::new(job.listener.clone(), Some(original_size));

    let file = BufWriter::new(File::create(output_path)?);
    let encoder = match options.format {
        ArchiveFormat::Tgz => Encoder::gzip(file, job.level, options.deflate_strategy, options.mem_level)?,
        ArchiveFormat::Tzst => Encoder::zstd(file, job.level, options.zstd())?,
        _ => Encoder::Plain(file),
    };
    let encoder = append_entries(Builder::new(encoder), &entries, &reporter, job)?;
    encoder.finish()?.into_inner().map_err(io::IntoInnerError::into_error)?;
    reporter.complete();
    Ok(original_size)
}

fn append_entries<W: Write>(
    mut builder: Builder<W>,
    entries: &[InputEntry],
    reporter: &Reporter,
    job: &Job,
) -> Result<W, LiberaError> {
    for entry in entries {
        if job.cancel.is_cancelled() {
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
                builder.append_data(&mut header, &entry.stored_path, Tracked::new(content, reporter, job.cancel))?;
            }
            InputKind::Symlink => {
                header.set_size(0);
                builder.append_link(&mut header, &entry.stored_path, fs::read_link(&entry.disk_path)?)?;
            }
        }
    }
    Ok(builder.into_inner()?)
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
            return Err(io::Error::other("a file shrank while it was being archived"));
        }
        self.remaining -= read as u64;
        Ok(read)
    }
}
