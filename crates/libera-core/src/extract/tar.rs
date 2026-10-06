use std::fs::File;
use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};
use std::time::{Duration, SystemTime};

use tar::{Archive, EntryType};

use super::{Counts, Job};
use crate::LiberaError;
use crate::codec::{StreamCodec, decoder};
use crate::progress::Cancellable;
use crate::safety::plan::{ArchiveEntry, check_entry_count};
use crate::safety::target::{ensure_safe_directory, ensure_safe_parent_directories};
use crate::safety::write::{
    apply_mode, apply_modified_time, archive_permissions, create_owned_file, create_owned_symlink,
};

/// Opens the tarball inside whatever codec its leading bytes name. Trusting
/// the bytes over the suffix reads a plain tar saved as `.tgz` too, as the
/// Electron engine's reader does.
fn open<'a>(job: &Job<'a>) -> Result<Archive<Box<dyn Read + 'a>>, LiberaError> {
    let mut reader = BufReader::new(Cancellable::new(File::open(job.archive_path)?, job.cancel));
    let codec = StreamCodec::sniff(reader.fill_buf()?);
    let reader: Box<dyn Read + 'a> = match codec {
        Some(codec) => decoder(codec, reader)?,
        None => Box::new(reader),
    };
    Ok(Archive::new(reader))
}

/// A pax global header carries defaults for the entries after it - `git
/// archive` writes one with the commit id - and is not an entry of its own.
fn is_entry(entry_type: EntryType) -> bool {
    entry_type != EntryType::XGlobalHeader
}

/// Lists the archive, in order. Each entry's `source` is its position among
/// the entries, which is how the second pass finds its plan again.
fn list(job: &Job) -> Result<Vec<ArchiveEntry<usize>>, LiberaError> {
    let restore_symlinks = job.restore_symlinks();
    let restore_permissions = job.restore_permissions();
    let mut archive = open(job)?;
    let mut entries = Vec::new();
    for entry in archive.entries()? {
        let entry = entry?;
        let header = entry.header();
        let entry_type = header.entry_type();
        if !is_entry(entry_type) {
            continue;
        }
        let (is_directory, is_link) = match entry_type {
            EntryType::Regular | EntryType::Continuous | EntryType::GNUSparse => (false, false),
            EntryType::Directory => (true, false),
            // Hard links, devices and pipes are links too: none of them is
            // ever written, and each fails the job when selected.
            _ => (false, true),
        };
        let link_target = (entry_type == EntryType::Symlink && restore_symlinks)
            .then(|| entry.link_name_bytes().map(|target| String::from_utf8_lossy(&target).into_owned()))
            .flatten();
        entries.push(ArchiveEntry {
            archive_path: String::from_utf8_lossy(&entry.path_bytes()).into_owned(),
            is_directory,
            size: if is_directory || is_link { 0 } else { entry.size() },
            is_link,
            link_target,
            mode: header.mode().ok().filter(|_| restore_permissions).and_then(archive_permissions),
            modified: header.mtime().ok().map(|seconds| SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)),
            source: entries.len(),
        });
        check_entry_count(entries.len(), &job.policy)?;
    }
    Ok(entries)
}

pub(super) fn extract(job: &mut Job) -> Result<Counts, LiberaError> {
    let listed = list(job)?;
    let listed_count = listed.len();
    let (plan, links_excluded) = job.plan(listed)?;

    for planned in plan.selected() {
        if planned.entry.is_directory {
            ensure_safe_directory(&job.target_root, &planned.output_path, job.transaction)?;
        } else {
            ensure_safe_parent_directories(&job.target_root, &planned.output_path, job.transaction)?;
        }
    }

    // Timestamps come back unless asked not to, as the Electron engine's tar
    // reader restores them by default.
    let restore_timestamps = job.options.restore_timestamps != Some(false);
    let mut plan_index = vec![None; listed_count];
    for (index, planned) in plan.entries.iter().enumerate() {
        plan_index[planned.entry.source] = Some(index);
    }

    let meter = job.meter(Some(plan.selected_total_bytes));
    let mut extracted = 0;
    let mut archive = open(job)?;
    let mut position = 0;
    for entry in archive.entries()? {
        if job.cancel.is_cancelled() {
            return Err(LiberaError::ExtractionCancelled);
        }
        let mut entry = entry?;
        if !is_entry(entry.header().entry_type()) {
            continue;
        }
        let index = position;
        position += 1;
        let Some(planned) = plan_index.get(index).copied().flatten().map(|index| &plan.entries[index]) else {
            continue;
        };
        if !planned.should_extract || planned.entry.is_directory {
            continue;
        }

        if let Some(target) = &planned.entry.link_target {
            create_owned_symlink(&planned.output_path, target, job.transaction)?;
            extracted += 1;
            continue;
        }
        let mut output = BufWriter::new(create_owned_file(&planned.output_path, job.transaction)?);
        meter.copy(&mut entry, &mut output, &planned.entry.archive_path, job.cancel)?;
        output.flush()?;
        let file = output.into_inner().map_err(io::IntoInnerError::into_error)?;
        if restore_timestamps && let Some(modified) = planned.entry.modified {
            apply_modified_time(&file, modified)?;
        }
        drop(file);
        if let Some(mode) = planned.entry.mode {
            apply_mode(&planned.output_path, mode)?;
        }
        extracted += 1;
    }

    meter.complete();
    job.propagate_quarantine(&plan);
    Ok(Counts { extracted, links_excluded })
}
