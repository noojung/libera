use std::io::{self, Read, Write};
use std::sync::Arc;

use super::{ExtractionPolicy, format_binary_bytes};
use crate::LiberaError;
use crate::progress::{CancelToken, ProgressListener, Reporter};

/// Counts the bytes an extraction writes against its limits as they land, so
/// a decompression bomb is stopped by what it expands to rather than by what
/// its headers claim.
pub(crate) struct Meter {
    reporter: Reporter,
    policy: ExtractionPolicy,
    disk_budget: u64,
}

impl Meter {
    /// `total` is what the plan expects to write, or `None` for a lone codec
    /// stream that records no expanded size.
    pub(crate) fn new(
        listener: Arc<dyn ProgressListener>,
        policy: ExtractionPolicy,
        disk_budget: u64,
        total: Option<u64>,
    ) -> Self {
        Self { reporter: Reporter::new(listener, total), policy, disk_budget }
    }

    /// Accounts `length` more bytes of the file `current_file`, which already
    /// had `file_bytes` written, and returns the file's new count.
    pub(crate) fn consume(&self, length: u64, file_bytes: u64, current_file: &str) -> Result<u64, LiberaError> {
        let next_file_bytes = file_bytes + length;
        let next_processed = self.reporter.processed() + length;
        if next_file_bytes > self.policy.max_file_bytes {
            return Err(LiberaError::FileTooLarge {
                message: format!(
                    "entry exceeds the {} file size limit: {current_file}",
                    format_binary_bytes(self.policy.max_file_bytes)
                ),
            });
        }
        if next_processed > self.policy.max_total_bytes {
            return Err(LiberaError::ArchiveTooLarge {
                message: format!(
                    "archive exceeds the {} extraction limit",
                    format_binary_bytes(self.policy.max_total_bytes)
                ),
            });
        }
        if next_processed > self.disk_budget {
            return Err(LiberaError::InsufficientDiskSpace {
                message: "extraction would consume the reserved free disk space".into(),
            });
        }
        self.reporter.set_current_file(current_file);
        self.reporter.advance(length);
        Ok(next_file_bytes)
    }

    pub(crate) fn complete(&self) {
        self.reporter.complete();
    }

    /// Copies one entry's contents into `output`, metering every chunk and
    /// stopping at the first read after the job is cancelled.
    pub(crate) fn copy<R: Read + ?Sized>(
        &self,
        input: &mut R,
        output: &mut impl Write,
        current_file: &str,
        cancel: &CancelToken,
    ) -> Result<u64, LiberaError> {
        let mut buffer = vec![0; 64 * 1024];
        let mut written = 0;
        loop {
            cancel.check()?;
            let read = match input.read(&mut buffer) {
                Ok(0) => return Ok(written),
                Ok(read) => read,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error.into()),
            };
            written = self.consume(read as u64, written, current_file)?;
            output.write_all(&buffer[..read])?;
        }
    }
}
