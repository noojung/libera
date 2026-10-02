use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use super::paths::{
    assert_safe_symlink_target, is_mac_metadata_path, matches_selected_entry, normalize_entry_path, resolve_output_path,
};
use super::{ExtractionPolicy, format_binary_bytes, format_count};
use crate::LiberaError;
use crate::patterns::EntryFilter;

/// One entry as a format reader lists it, before any of it is trusted.
/// `source` is whatever the reader needs to find the entry again when it
/// comes to write it.
#[derive(Debug, Clone)]
pub(crate) struct ArchiveEntry<S> {
    pub archive_path: String,
    pub is_directory: bool,
    pub size: u64,
    /// Any entry that is neither a file nor a folder. Only a symbolic link
    /// with a target the reader chose to restore can be written; the rest
    /// fail the job when they are selected.
    pub is_link: bool,
    pub link_target: Option<String>,
    /// The permission bits to give the file once written, if any.
    pub mode: Option<u32>,
    pub modified: Option<SystemTime>,
    pub source: S,
}

#[derive(Debug, Clone)]
pub(crate) struct PlannedEntry<S> {
    pub entry: ArchiveEntry<S>,
    pub output_path: PathBuf,
    pub should_extract: bool,
}

pub(crate) struct Plan<S> {
    pub entries: Vec<PlannedEntry<S>>,
    pub selected_total_bytes: u64,
}

impl<S> Plan<S> {
    pub(crate) fn selected(&self) -> impl Iterator<Item = &PlannedEntry<S>> {
        self.entries.iter().filter(|entry| entry.should_extract)
    }
}

/// What a user's choices say about which entries to write: the paths they
/// picked, the pattern, and the two exclusions. `None` writes everything.
pub(crate) struct Selection<'a> {
    pub selected_entries: Option<&'a [String]>,
    pub filter: &'a EntryFilter,
    pub exclude_mac_metadata: bool,
    pub restore_symlinks: bool,
}

impl Selection<'_> {
    fn requested(&self) -> Option<HashSet<String>> {
        self.selected_entries.map(|entries| entries.iter().cloned().collect())
    }

    /// Whether an entry survives everything but the link rule.
    fn admits(&self, path: &str, requested: Option<&HashSet<String>>) -> bool {
        matches_selected_entry(path, requested)
            && self.filter.allows(path)
            && !(self.exclude_mac_metadata && is_mac_metadata_path(path))
    }

    /// The set of archive paths to write, or `None` when nothing narrows it.
    pub(crate) fn paths<S>(&self, entries: &[ArchiveEntry<S>]) -> Option<HashSet<String>> {
        let narrows = self.selected_entries.is_some()
            || !self.filter.is_empty()
            || self.exclude_mac_metadata
            || !self.restore_symlinks;
        if !narrows {
            return None;
        }
        let requested = self.requested();
        Some(
            entries
                .iter()
                .filter(|entry| self.admits(&entry.archive_path, requested.as_ref()))
                .filter(|entry| self.restore_symlinks || !entry.is_link)
                .map(|entry| entry.archive_path.clone())
                .collect(),
        )
    }

    /// How many links were left out only because links are not being
    /// restored, which the result reports back.
    pub(crate) fn links_excluded<S>(&self, entries: &[ArchiveEntry<S>]) -> u64 {
        if self.restore_symlinks {
            return 0;
        }
        let requested = self.requested();
        entries.iter().filter(|entry| entry.is_link && self.admits(&entry.archive_path, requested.as_ref())).count()
            as u64
    }
}

fn too_many_entries(policy: &ExtractionPolicy) -> LiberaError {
    LiberaError::TooManyEntries {
        message: format!("archive contains more than {} entries", format_count(policy.max_entries)),
    }
}

/// Fails once a reader has listed more entries than the policy allows, so a
/// listing can stop early instead of collecting every one first.
pub(crate) fn check_entry_count(count: usize, policy: &ExtractionPolicy) -> Result<(), LiberaError> {
    if count as u64 > policy.max_entries { Err(too_many_entries(policy)) } else { Ok(()) }
}

/// Checks every entry against the limits and the destination, and decides
/// where each one lands. Nothing is written yet; a plan that comes back is one
/// the writer can follow without further path checks.
pub(crate) fn build_plan<S>(
    entries: Vec<ArchiveEntry<S>>,
    target_root: &Path,
    selected: Option<&HashSet<String>>,
    policy: &ExtractionPolicy,
) -> Result<Plan<S>, LiberaError> {
    check_entry_count(entries.len(), policy)?;

    let mut selected_total_bytes: u64 = 0;
    let mut output_keys: HashSet<String> = HashSet::with_capacity(entries.len());
    let mut planned = Vec::with_capacity(entries.len());
    for entry in entries {
        let should_extract = matches_selected_entry(&entry.archive_path, selected);
        // Unselected link entries are never read or written, so only entries
        // actually slated for extraction need a resolved, validated target.
        if entry.is_link && should_extract && entry.link_target.is_none() {
            return Err(LiberaError::unsafe_archive(format!(
                "symbolic and hard link entries are not supported: {}",
                entry.archive_path
            )));
        }
        if should_extract && entry.size > policy.max_file_bytes {
            return Err(LiberaError::FileTooLarge {
                message: format!(
                    "entry exceeds the {} file size limit: {}",
                    format_binary_bytes(policy.max_file_bytes),
                    entry.archive_path
                ),
            });
        }
        if should_extract {
            selected_total_bytes = selected_total_bytes.saturating_add(entry.size);
            if selected_total_bytes > policy.max_total_bytes {
                return Err(LiberaError::ArchiveTooLarge {
                    message: format!(
                        "archive exceeds the {} extraction limit",
                        format_binary_bytes(policy.max_total_bytes)
                    ),
                });
            }
        }

        let normalized = match normalize_entry_path(&entry.archive_path)? {
            Some(normalized) => normalized,
            // A folder entry naming the destination itself has nothing to make.
            None if entry.is_directory => continue,
            None => {
                return Err(LiberaError::unsafe_archive(format!("invalid entry path: {}", entry.archive_path)));
            }
        };
        let output_path = resolve_output_path(target_root, &normalized)?;
        if entry.is_link && should_extract {
            assert_safe_symlink_target(target_root, &output_path, entry.link_target.as_deref().unwrap_or(""))?;
        }
        if !output_keys.insert(output_key(&output_path)) {
            return Err(LiberaError::unsafe_archive(format!(
                "archive contains duplicate output paths: {}",
                entry.archive_path
            )));
        }
        planned.push(PlannedEntry { entry, output_path, should_extract });
    }

    let file_keys: HashSet<String> = planned
        .iter()
        .filter(|planned| !planned.entry.is_directory)
        .map(|planned| output_key(&planned.output_path))
        .collect();
    for planned in &planned {
        for parent in planned.output_path.ancestors().skip(1).take_while(|parent| *parent != target_root) {
            if file_keys.contains(&output_key(parent)) {
                return Err(LiberaError::unsafe_archive(format!(
                    "archive entry has a file as its parent path: {}",
                    planned.entry.archive_path
                )));
            }
        }
    }

    Ok(Plan { entries: planned, selected_total_bytes })
}

/// Windows compares paths without case, so two entries differing only in case
/// land on one file there and not elsewhere.
fn output_key(path: &Path) -> String {
    let key = path.to_string_lossy();
    if cfg!(windows) { key.to_lowercase() } else { key.into_owned() }
}

/// The top level names a plan writes, for the quarantine flag.
pub(crate) fn top_level_names<S>(plan: &Plan<S>, target_root: &Path) -> Vec<PathBuf> {
    let names: BTreeSet<PathBuf> = plan
        .selected()
        .filter_map(|planned| super::paths::top_level_output_name(target_root, &planned.output_path))
        .collect();
    names.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, size: u64) -> ArchiveEntry<()> {
        ArchiveEntry {
            archive_path: path.into(),
            is_directory: path.ends_with('/'),
            size,
            is_link: false,
            link_target: None,
            mode: None,
            modified: None,
            source: (),
        }
    }

    fn policy(max_file_bytes: u64, max_total_bytes: u64) -> ExtractionPolicy {
        ExtractionPolicy { max_file_bytes, max_total_bytes, ..ExtractionPolicy::default() }
    }

    #[test]
    fn counts_only_selected_entries_toward_extraction_size_limits() {
        let selected: HashSet<String> = ["small.txt".to_owned()].into();
        let plan = build_plan(
            vec![entry("small.txt", 10), entry("huge.bin", 1000)],
            Path::new("/dest"),
            Some(&selected),
            &policy(100, 100),
        )
        .unwrap();
        assert_eq!(plan.selected_total_bytes, 10);
        assert_eq!(plan.selected().count(), 1);
    }

    #[test]
    fn accepts_exact_boundaries_and_rejects_values_above_them() {
        let root = Path::new("/dest");
        assert!(build_plan(vec![entry("a", 100)], root, None, &policy(100, 100)).is_ok());
        assert!(matches!(
            build_plan(vec![entry("a", 101)], root, None, &policy(100, 1000)),
            Err(LiberaError::FileTooLarge { .. })
        ));
        assert!(matches!(
            build_plan(vec![entry("a", 60), entry("b", 41)], root, None, &policy(100, 100)),
            Err(LiberaError::ArchiveTooLarge { .. })
        ));
        let entries = (0..3).map(|index| entry(&index.to_string(), 0)).collect();
        assert!(matches!(
            build_plan(entries, root, None, &ExtractionPolicy { max_entries: 2, ..ExtractionPolicy::default() }),
            Err(LiberaError::TooManyEntries { .. })
        ));
    }

    #[test]
    fn rejects_duplicate_outputs_and_files_standing_in_for_folders() {
        let root = Path::new("/dest");
        assert!(
            build_plan(vec![entry("a/b", 1), entry("./a//b", 1)], root, None, &ExtractionPolicy::default()).is_err()
        );
        assert!(build_plan(vec![entry("a", 1), entry("a/b", 1)], root, None, &ExtractionPolicy::default()).is_err());
        assert!(build_plan(vec![entry("a/", 0), entry("a/b", 1)], root, None, &ExtractionPolicy::default()).is_ok());
    }

    #[test]
    fn skips_a_folder_entry_that_names_the_destination_itself() {
        let plan = build_plan(
            vec![entry("./", 0), entry("./a.txt", 1)],
            Path::new("/dest"),
            None,
            &ExtractionPolicy::default(),
        )
        .unwrap();
        assert_eq!(plan.entries.len(), 1);
        assert_eq!(plan.entries[0].output_path, Path::new("/dest/a.txt"));
    }

    #[test]
    fn refuses_a_selected_link_it_cannot_restore_but_not_an_unselected_one() {
        let mut link = entry("link", 0);
        link.is_link = true;
        let selected: HashSet<String> = ["other".to_owned()].into();
        assert!(build_plan(vec![link.clone()], Path::new("/dest"), None, &ExtractionPolicy::default()).is_err());
        assert!(build_plan(vec![link], Path::new("/dest"), Some(&selected), &ExtractionPolicy::default()).is_ok());
    }
}
