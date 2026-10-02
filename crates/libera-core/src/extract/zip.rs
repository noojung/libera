use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{self, BufWriter, Read, Write};

use super::{Counts, Job};
use crate::LiberaError;
use crate::apple_double::{self, MAX_SIDECAR_BYTES, MERGES_SIDECARS};
use crate::safety::paths::matches_selected_entry;
use crate::safety::plan::ArchiveEntry;
use crate::safety::target::{ensure_safe_directory, ensure_safe_parent_directories};
use crate::safety::write::{
    apply_mode, apply_modified_time, archive_permissions, create_owned_file, create_owned_symlink,
};
use crate::zip::read::{OpenOptions, ZipArchive};

/// Link targets are paths; anything longer than this is not one.
const MAX_LINK_TARGET_BYTES: u64 = 64 * 1024;

fn read_whole(mut reader: impl Read, limit: u64) -> Result<Vec<u8>, LiberaError> {
    let mut bytes = Vec::new();
    reader.by_ref().take(limit).read_to_end(&mut bytes)?;
    // Drained to the end, so the length and CRC checks run.
    io::copy(&mut reader, &mut io::sink())?;
    Ok(bytes)
}

pub(super) fn extract(job: &mut Job) -> Result<Counts, LiberaError> {
    let options = job.options;
    let open_options = OpenOptions { policy: job.policy, encoding: options.encoding.unwrap_or_default() };
    let mut archive = ZipArchive::open(job.archive_path, &open_options)?;
    let password = options.password.as_deref();
    let verify_crc = options.strict_crc != Some(false);
    let restore_symlinks = job.restore_symlinks();
    let restore_permissions = job.restore_permissions();
    let requested: Option<HashSet<String>> =
        options.selected_entries.as_ref().map(|entries| entries.iter().cloned().collect());
    let names: HashSet<String> = archive.entries.iter().map(|entry| entry.name.clone()).collect();
    let merge_sidecars = MERGES_SIDECARS && !job.exclude_mac_metadata();

    // Sidecars are folded onto their subject rather than written out, keyed by
    // the archive path of the file they describe.
    let mut sidecars = HashMap::new();
    let mut listed = Vec::with_capacity(archive.entries.len());
    for index in 0..archive.entries.len() {
        let entry = archive.entries[index].clone();
        if merge_sidecars
            && !entry.is_directory
            && entry.uncompressed_size <= MAX_SIDECAR_BYTES
            && let Some(subject) = apple_double::subject_path(&entry.name)
            && names.contains(&subject)
            && matches_selected_entry(&subject, requested.as_ref())
        {
            let bytes = read_whole(archive.open_entry(index, password, verify_crc)?, MAX_SIDECAR_BYTES)?;
            // Bytes that are not AppleDouble belong to a file that merely looks
            // like a sidecar, and are extracted like any other.
            if let Some(metadata) = apple_double::parse(&bytes) {
                sidecars.insert(subject, metadata);
                continue;
            }
        }

        let is_link = entry.is_symlink();
        // Only a link slated for extraction has its target read, so an
        // unselected, undecryptable one cannot block the rest of the archive.
        let link_target = if is_link && restore_symlinks && matches_selected_entry(&entry.name, requested.as_ref()) {
            if entry.uncompressed_size > MAX_LINK_TARGET_BYTES {
                return Err(LiberaError::unsafe_archive(format!("symlink target is too long: {}", entry.name)));
            }
            let target = read_whole(archive.open_entry(index, password, verify_crc)?, MAX_LINK_TARGET_BYTES)?;
            Some(String::from_utf8_lossy(&target).into_owned())
        } else {
            None
        };
        listed.push(ArchiveEntry {
            archive_path: entry.name,
            is_directory: entry.is_directory,
            size: if entry.is_directory { 0 } else { entry.uncompressed_size },
            is_link,
            link_target,
            mode: if restore_permissions { archive_permissions(entry.unix_mode) } else { None },
            modified: entry.modified,
            source: index,
        });
    }

    let (plan, links_excluded) = job.plan(listed)?;
    for planned in plan.selected() {
        if planned.entry.is_directory {
            ensure_safe_directory(&job.target_root, &planned.output_path, job.transaction)?;
        } else {
            ensure_safe_parent_directories(&job.target_root, &planned.output_path, job.transaction)?;
        }
    }

    // A ZIP's times come back only when asked for, as in the Electron engine.
    let restore_timestamps = options.restore_timestamps == Some(true);
    let meter = job.meter(Some(plan.selected_total_bytes));
    let mut extracted = 0;
    for planned in plan.selected() {
        if job.cancel.is_cancelled() {
            return Err(LiberaError::ExtractionCancelled);
        }
        let entry = &planned.entry;
        if entry.is_directory {
            continue;
        }
        if let Some(target) = &entry.link_target {
            create_owned_symlink(&planned.output_path, target, job.transaction)?;
            meter.consume(entry.size, 0, &entry.archive_path)?;
            extracted += 1;
            continue;
        }

        let mut output = BufWriter::new(create_owned_file(&planned.output_path, job.transaction)?);
        let mut content = archive.open_entry(entry.source, password, verify_crc)?;
        meter.copy(&mut content, &mut output, &entry.archive_path, job.cancel)?;
        drop(content);
        output.flush()?;
        drop(output.into_inner().map_err(io::IntoInnerError::into_error)?);

        // Metadata goes on while the file is still owner writable, since a
        // read-only mode would block the resource fork write.
        if let Some(sidecar) = sidecars.get(&entry.archive_path) {
            apple_double::apply(&planned.output_path, sidecar);
        }
        if let Some(mode) = entry.mode {
            apply_mode(&planned.output_path, mode)?;
        }
        // Last, since writing a resource fork moves the time on.
        if restore_timestamps && let Some(modified) = entry.modified {
            apply_modified_time(&File::open(&planned.output_path)?, modified)?;
        }
        extracted += 1;
    }

    meter.complete();
    job.propagate_quarantine(&plan);
    Ok(Counts { extracted, links_excluded })
}
