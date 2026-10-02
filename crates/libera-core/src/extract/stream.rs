use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::time::{Duration, SystemTime};

use super::{Counts, Job};
use crate::LiberaError;
use crate::codec::{StreamCodec, decoder};
use crate::formats::stream_entry_name;
use crate::progress::Cancellable;
use crate::safety::paths::{is_mac_metadata_path, require_entry_path};
use crate::safety::plan::ArchiveEntry;
use crate::safety::target::ensure_safe_parent_directories;
use crate::safety::write::{apply_modified_time, create_owned_file};

const NOTHING: Counts = Counts { extracted: 0, links_excluded: 0 };

/// Writes out the lone file inside a codec stream - a `.gz`, `.xz`, `.bz2` or
/// `.zst` that wraps one file and carries no entry table. Its name comes from
/// the archive's own, minus the codec suffix, because that is all these
/// formats record about what is inside them.
pub(super) fn extract(job: &mut Job, codec: StreamCodec) -> Result<Counts, LiberaError> {
    let output_name = require_entry_path(&stream_entry_name(job.archive_path))?;
    if !job.filter.allows(&output_name) || (job.exclude_mac_metadata() && is_mac_metadata_path(&output_name)) {
        return Ok(NOTHING);
    }
    let (plan, _) = job.plan(vec![ArchiveEntry {
        archive_path: output_name.clone(),
        is_directory: false,
        size: 0,
        is_link: false,
        link_target: None,
        mode: None,
        modified: None,
        source: (),
    }])?;
    // Read back after the destination policy, which may have renamed or
    // skipped it.
    let Some(planned) = plan.selected().next() else { return Ok(NOTHING) };
    ensure_safe_parent_directories(&job.target_root, &planned.output_path, job.transaction)?;

    // The stream records no expanded size, so progress has no total.
    let meter = job.meter(None);
    let mut output = BufWriter::new(create_owned_file(&planned.output_path, job.transaction)?);
    let source = BufReader::new(Cancellable::new(File::open(job.archive_path)?, job.cancel));
    meter.copy(&mut decoder(codec, source)?, &mut output, &output_name, job.cancel)?;
    output.flush()?;
    let file = output.into_inner().map_err(io::IntoInnerError::into_error)?;

    // Gzip is the only one of these that records when the file was last
    // written, and its time comes back only when asked for.
    if job.options.restore_timestamps == Some(true)
        && codec == StreamCodec::Gzip
        && let Some(modified) = gzip_modification_time(job.archive_path)?
    {
        apply_modified_time(&file, modified)?;
    }

    meter.complete();
    job.propagate_quarantine(&plan);
    Ok(Counts { extracted: 1, links_excluded: 0 })
}

fn gzip_modification_time(archive_path: &std::path::Path) -> io::Result<Option<SystemTime>> {
    let mut header = [0; 8];
    let mut file = File::open(archive_path)?;
    if file.read_exact(&mut header).is_err() || header[..2] != [0x1f, 0x8b] {
        return Ok(None);
    }
    let seconds = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
    Ok((seconds != 0).then(|| SystemTime::UNIX_EPOCH + Duration::from_secs(u64::from(seconds))))
}
