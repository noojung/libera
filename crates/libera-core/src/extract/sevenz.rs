use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::{self, BufWriter, Read, Write};

use super::{Counts, Job};
use crate::LiberaError;
use crate::safety::plan::ArchiveEntry;
use crate::safety::target::{ensure_safe_directory, ensure_safe_parent_directories};
use crate::safety::write::{
    apply_mode, apply_modified_time, archive_permissions, create_owned_file, create_owned_symlink,
};
use crate::sevenz::read::SevenZipArchive;

/// Link targets are paths; anything longer than this is not one.
const MAX_LINK_TARGET_BYTES: u64 = 64 * 1024;

/// The blocks holding the entries at `indices`, each with the entries it holds.
fn blocks_of(archive: &SevenZipArchive, indices: impl IntoIterator<Item = usize>) -> BTreeMap<usize, HashSet<usize>> {
    let mut blocks: BTreeMap<usize, HashSet<usize>> = BTreeMap::new();
    for index in indices {
        if let Some(block) = archive.entries[index].block {
            blocks.entry(block).or_default().insert(index);
        }
    }
    blocks
}

fn drain(reader: &mut dyn Read) -> Result<(), LiberaError> {
    io::copy(reader, &mut io::sink())?;
    Ok(())
}

pub(super) fn extract(job: &mut Job) -> Result<Counts, LiberaError> {
    let options = job.options;
    let mut archive = SevenZipArchive::open(job.archive_path, options.password.as_deref(), &job.policy)?;
    let restore_symlinks = job.restore_symlinks();
    let restore_permissions = job.restore_permissions();

    let mut listed: Vec<ArchiveEntry<usize>> = archive
        .entries
        .iter()
        .enumerate()
        .map(|(index, entry)| ArchiveEntry {
            archive_path: entry.path.clone(),
            is_directory: entry.is_directory,
            size: entry.size,
            is_link: entry.is_symlink,
            link_target: None,
            mode: if restore_permissions { entry.mode.and_then(archive_permissions) } else { None },
            modified: entry.modified,
            source: index,
        })
        .collect();

    // A selected link's target is its content, read before the plan is made
    // so the plan can check where it points.
    if restore_symlinks {
        let selection = job.selection();
        let links: Vec<usize> =
            listed.iter().filter(|entry| entry.is_link && selection.selects(entry)).map(|entry| entry.source).collect();
        let mut targets = HashMap::new();
        for (block, wanted) in blocks_of(&archive, links) {
            archive.for_each_in_block(block, |index, reader| {
                if !wanted.contains(&index) {
                    return drain(reader);
                }
                let mut target = Vec::new();
                reader.take(MAX_LINK_TARGET_BYTES).read_to_end(&mut target)?;
                drain(reader)?;
                targets.insert(index, String::from_utf8_lossy(&target).into_owned());
                Ok(())
            })?;
        }
        for entry in &mut listed {
            entry.link_target = targets.remove(&entry.source);
        }
    }

    let (plan, links_excluded) = job.plan(listed)?;
    for planned in plan.selected() {
        if planned.entry.is_directory {
            ensure_safe_directory(&job.target_root, &planned.output_path, job.transaction)?;
        } else {
            ensure_safe_parent_directories(&job.target_root, &planned.output_path, job.transaction)?;
        }
    }

    // A 7z's times come back only when asked for, as in the Electron engine.
    let restore_timestamps = options.restore_timestamps == Some(true);
    let meter = job.meter(Some(plan.selected_total_bytes));
    let mut extracted = 0;
    let mut files = HashMap::new();
    for planned in plan.selected().filter(|planned| !planned.entry.is_directory) {
        if let Some(target) = &planned.entry.link_target {
            meter.consume(planned.entry.size, 0, &planned.entry.archive_path)?;
            create_owned_symlink(&planned.output_path, target, job.transaction)?;
            extracted += 1;
        } else {
            files.insert(planned.entry.source, planned);
        }
    }

    let finish = |planned: &crate::safety::plan::PlannedEntry<usize>| -> Result<(), LiberaError> {
        if let Some(mode) = planned.entry.mode {
            apply_mode(&planned.output_path, mode)?;
        }
        if restore_timestamps && let Some(modified) = planned.entry.modified {
            apply_modified_time(&File::open(&planned.output_path)?, modified)?;
        }
        Ok(())
    };

    // Files with no data sit in no block.
    for planned in files.values().filter(|planned| archive.entries[planned.entry.source].block.is_none()) {
        drop(create_owned_file(&planned.output_path, job.transaction)?);
        finish(planned)?;
        extracted += 1;
    }

    let cancel = job.cancel;
    let transaction = &mut *job.transaction;
    for (block, wanted) in blocks_of(&archive, files.keys().copied()) {
        archive.for_each_in_block(block, |index, reader| {
            if cancel.is_cancelled() {
                return Err(LiberaError::ExtractionCancelled);
            }
            let Some(planned) = files.get(&index).filter(|_| wanted.contains(&index)) else { return drain(reader) };
            let mut output = BufWriter::new(create_owned_file(&planned.output_path, transaction)?);
            let written = meter.copy(reader, &mut output, &planned.entry.archive_path, cancel)?;
            output.flush()?;
            drop(output.into_inner().map_err(io::IntoInnerError::into_error)?);
            if written != planned.entry.size {
                return Err(LiberaError::unsafe_archive(format!(
                    "archive declares {} bytes but supplied {written}: {}",
                    planned.entry.size, planned.entry.archive_path
                )));
            }
            finish(planned)?;
            extracted += 1;
            Ok(())
        })?;
    }

    meter.complete();
    job.propagate_quarantine(&plan);
    Ok(Counts { extracted, links_excluded })
}
