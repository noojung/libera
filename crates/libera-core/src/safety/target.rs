use std::collections::HashSet;
use std::fs::{self, Metadata};
use std::io;
use std::path::{Path, PathBuf};

use super::paths::{MAX_RENAME_ATTEMPTS, absolute_normalized, numbered_file_name};
use super::plan::PlannedEntry;
use super::transaction::Transaction;
use crate::LiberaError;

fn lstat_if_exists(path: &Path) -> io::Result<Option<Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn is_real_directory(metadata: &Metadata) -> bool {
    metadata.file_type().is_dir()
}

fn unsafe_at(message: &str, path: &Path) -> LiberaError {
    LiberaError::unsafe_archive(format!("{message}: {}", path.display()))
}

/// Fails on a link or a file anywhere along the part of `path` that exists.
fn assert_safe_existing_path_components(path: &Path) -> Result<(), LiberaError> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        let Some(metadata) = lstat_if_exists(&current)? else { return Ok(()) };
        if metadata.file_type().is_symlink() {
            return Err(unsafe_at("destination contains a symbolic link", &current));
        }
        if !is_real_directory(&metadata) {
            return Err(unsafe_at("destination path component is not a directory", &current));
        }
    }
    Ok(())
}

/// `path` with every link in its existing part resolved - `/tmp` is a link to
/// `/private/tmp` on macOS - and the missing part appended unchanged.
fn resolve_through_existing_ancestor(path: &Path) -> Result<PathBuf, LiberaError> {
    let mut missing = Vec::new();
    let mut existing = path.to_path_buf();
    while lstat_if_exists(&existing)?.is_none() {
        let Some(name) = existing.file_name().map(ToOwned::to_owned) else {
            return Err(unsafe_at("unable to resolve extraction target", path));
        };
        missing.push(name);
        existing.pop();
    }
    let mut resolved = fs::canonicalize(&existing)?;
    resolved.extend(missing.iter().rev());
    Ok(resolved)
}

/// Makes sure `target_dir` is a real folder to extract into - creating it, and
/// recording what it created, when it is missing - and returns its resolved
/// path. A `reject_existing` job has to be the one that creates it.
pub(crate) fn prepare_target_root(
    target_dir: &Path,
    transaction: &mut Transaction,
    reject_existing: bool,
) -> Result<PathBuf, LiberaError> {
    let requested = absolute_normalized(target_dir)?;
    let requested_metadata = lstat_if_exists(&requested)?;
    if requested_metadata.as_ref().is_some_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(LiberaError::unsafe_archive("extraction target must not be a symbolic link"));
    }
    let already_exists = || LiberaError::DestinationExists {
        message: format!("extraction target already exists: {}", requested.display()),
    };
    if reject_existing && requested_metadata.is_some() {
        return Err(already_exists());
    }

    let target = resolve_through_existing_ancestor(&requested)?;
    assert_safe_existing_path_components(&target)?;
    let mut missing = Vec::new();
    let mut probe = target.clone();
    while lstat_if_exists(&probe)?.is_none() {
        missing.push(probe.clone());
        if !probe.pop() {
            break;
        }
    }
    for directory in missing.into_iter().rev() {
        match fs::create_dir(&directory) {
            Ok(()) => transaction.record_directory(&directory),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if reject_existing && directory == target {
                    return Err(already_exists());
                }
                let raced = fs::symlink_metadata(&directory)?;
                if !is_real_directory(&raced) {
                    return Err(unsafe_at("extraction target path is not a real directory", &directory));
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
    assert_safe_existing_path_components(&target)?;
    if !is_real_directory(&fs::symlink_metadata(&target)?) {
        return Err(LiberaError::unsafe_archive("extraction target must be a real directory"));
    }
    Ok(fs::canonicalize(&target)?)
}

/// The folders between `target_root` and `output_path`, outermost first.
fn intermediate_directories(target_root: &Path, output_path: &Path) -> Vec<PathBuf> {
    let mut directories: Vec<PathBuf> = output_path
        .ancestors()
        .skip(1)
        .take_while(|ancestor| *ancestor != target_root && ancestor.starts_with(target_root))
        .map(Path::to_path_buf)
        .collect();
    directories.reverse();
    directories
}

/// Fails when writing `output_path` would go through a link or a file, or
/// would land on something already there. An existing folder is fine for a
/// folder entry, which is merged into it.
pub(crate) fn assert_safe_destination(
    target_root: &Path,
    output_path: &Path,
    is_directory: bool,
) -> Result<(), LiberaError> {
    for directory in intermediate_directories(target_root, output_path) {
        let Some(metadata) = lstat_if_exists(&directory)? else { break };
        if metadata.file_type().is_symlink() {
            return Err(unsafe_at("destination parent is a symbolic link", &directory));
        }
        if !is_real_directory(&metadata) {
            return Err(unsafe_at("destination parent is not a directory", &directory));
        }
    }
    let Some(existing) = lstat_if_exists(output_path)? else { return Ok(()) };
    if existing.file_type().is_symlink() {
        return Err(unsafe_at("destination already contains a symbolic link", output_path));
    }
    if !is_directory || !is_real_directory(&existing) {
        return Err(LiberaError::DestinationExists {
            message: format!("destination already exists: {}", output_path.display()),
        });
    }
    Ok(())
}

pub(crate) fn ensure_safe_parent_directories(
    target_root: &Path,
    output_path: &Path,
    transaction: &mut Transaction,
) -> Result<(), LiberaError> {
    for directory in intermediate_directories(target_root, output_path) {
        match lstat_if_exists(&directory)? {
            None => {
                fs::create_dir(&directory)?;
                transaction.record_directory(&directory);
            }
            Some(metadata) if is_real_directory(&metadata) => {}
            Some(_) => return Err(unsafe_at("cannot create files through destination path", &directory)),
        }
    }
    Ok(())
}

pub(crate) fn ensure_safe_directory(
    target_root: &Path,
    output_path: &Path,
    transaction: &mut Transaction,
) -> Result<(), LiberaError> {
    ensure_safe_parent_directories(target_root, output_path, transaction)?;
    match lstat_if_exists(output_path)? {
        None => {
            fs::create_dir(output_path)?;
            transaction.record_directory(output_path);
            Ok(())
        }
        Some(metadata) if is_real_directory(&metadata) => Ok(()),
        Some(_) => Err(unsafe_at("cannot create directory at destination", output_path)),
    }
}

/// What to do when an entry lands on something already in the destination.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum OverwritePolicy {
    /// Replace the file, keeping the old one aside until the job succeeds.
    Overwrite,
    /// Leave the existing file and do not extract the entry.
    Skip,
    /// Keep both, writing the entry under the first free numbered name.
    Rename,
}

// Always folded: a name that differs from a claimed one only by case is
// skipped as well, which costs one number and spares a case-insensitive
// volume (the default on macOS and Windows) from writing two entries to one file.
fn claim_key(path: &Path) -> String {
    path.to_string_lossy().to_lowercase()
}

/// Every path the plan will write, and every folder those paths sit in, so a
/// renamed entry never lands on a name another entry or its parent folder is
/// about to take.
fn claimed_output_paths<S>(target_root: &Path, entries: &[PlannedEntry<S>]) -> HashSet<String> {
    let mut claimed = HashSet::new();
    for planned in entries {
        for path in
            planned.output_path.ancestors().take_while(|path| *path != target_root && path.starts_with(target_root))
        {
            if !claimed.insert(claim_key(path)) {
                break;
            }
        }
    }
    claimed
}

fn rename_to_free_name<S>(
    target_root: &Path,
    planned: &mut PlannedEntry<S>,
    claimed: &mut HashSet<String>,
) -> Result<(), LiberaError> {
    let directory = planned.output_path.parent().unwrap_or(target_root).to_path_buf();
    let file_name = planned.output_path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    for number in 1..=MAX_RENAME_ATTEMPTS {
        let candidate = directory.join(numbered_file_name(&file_name, number));
        if claimed.contains(&claim_key(&candidate)) || lstat_if_exists(&candidate)?.is_some() {
            continue;
        }
        // The candidate sits beside the original, so every parent check already
        // passed; this only guards the name itself.
        assert_safe_destination(target_root, &candidate, planned.entry.is_directory)?;
        claimed.insert(claim_key(&candidate));
        planned.output_path = candidate;
        return Ok(());
    }
    Err(LiberaError::DestinationExists {
        message: format!("no free name is left beside an existing file: {}", planned.output_path.display()),
    })
}

/// Checks every selected entry's destination and settles each clash with an
/// existing file the way `policy` says; `None` refuses them all.
pub(crate) fn prepare_selected_destinations<S>(
    target_root: &Path,
    entries: &mut [PlannedEntry<S>],
    policy: Option<OverwritePolicy>,
    transaction: &mut Transaction,
) -> Result<(), LiberaError> {
    let mut claimed: Option<HashSet<String>> = None;
    for index in 0..entries.len() {
        if !entries[index].should_extract {
            continue;
        }
        let error = match assert_safe_destination(
            target_root,
            &entries[index].output_path,
            entries[index].entry.is_directory,
        ) {
            Ok(()) => continue,
            Err(error @ LiberaError::DestinationExists { .. }) => error,
            Err(error) => return Err(error),
        };
        // Folders are merged rather than renamed or replaced, as they are under
        // every policy; doing either would have to carry everything below along.
        let is_directory = entries[index].entry.is_directory;
        match policy {
            Some(OverwritePolicy::Skip) => entries[index].should_extract = false,
            Some(OverwritePolicy::Overwrite) if !is_directory => {
                transaction.backup_existing(&entries[index].output_path, target_root)?;
            }
            Some(OverwritePolicy::Rename) if !is_directory => {
                let claimed = claimed.get_or_insert_with(|| claimed_output_paths(target_root, entries));
                rename_to_free_name(target_root, &mut entries[index], claimed)?;
            }
            _ => return Err(error),
        }
    }
    Ok(())
}
