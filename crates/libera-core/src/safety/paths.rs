use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use crate::LiberaError;

/// The `/`-separated form every check below reads, with any `./` in front
/// dropped, since archives written on Windows use backslashes.
fn slashed(entry_path: &str) -> String {
    let slashed = entry_path.replace('\\', "/");
    slashed.strip_prefix("./").map(str::to_owned).unwrap_or(slashed)
}

fn has_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes.len() == 2 || bytes[2] == b'/')
}

/// True for what macOS writes into a folder for itself, read as an archive
/// path. `._name` sidecars are left alone here, since the ZIP reader folds
/// them back onto the file they describe.
pub(crate) fn is_mac_metadata_path(entry_path: &str) -> bool {
    let normalized = slashed(entry_path);
    normalized == "__MACOSX"
        || normalized.starts_with("__MACOSX/")
        || normalized == ".DS_Store"
        || normalized.ends_with("/.DS_Store")
}

/// Whether an entry is one of the selected paths or sits below one.
pub(crate) fn matches_selected_entry(entry_path: &str, selected: Option<&HashSet<String>>) -> bool {
    let Some(selected) = selected else { return true };
    let entry = slashed(entry_path);
    selected.iter().any(|selected_path| {
        let selected_path = slashed(selected_path);
        let selected_path = selected_path.trim_end_matches('/');
        entry == selected_path || entry.strip_prefix(selected_path).is_some_and(|rest| rest.starts_with('/'))
    })
}

/// The safe, `/`-separated form of an entry's path, or the reason it has
/// none: absolute paths, drive letters and `..` all reach outside the
/// destination.
///
/// `Ok(None)` is an entry that names the destination itself - the `./` a tar
/// written from inside a folder starts with - which has nothing to create.
pub(crate) fn normalize_entry_path(entry_path: &str) -> Result<Option<String>, LiberaError> {
    if entry_path.is_empty() || entry_path.contains('\0') {
        return Err(LiberaError::unsafe_archive("entry path is empty or contains a null byte"));
    }
    let normalized = entry_path.replace('\\', "/");
    if normalized.starts_with('/') || has_drive_prefix(&normalized) || normalized.split('/').any(|part| part == "..") {
        return Err(LiberaError::unsafe_archive(format!("entry path escapes the destination: {entry_path}")));
    }
    let parts: Vec<&str> = normalized.split('/').filter(|part| !part.is_empty() && *part != ".").collect();
    Ok(if parts.is_empty() { None } else { Some(parts.join("/")) })
}

/// Like [`normalize_entry_path`], for an entry that has to name something.
pub(crate) fn require_entry_path(entry_path: &str) -> Result<String, LiberaError> {
    normalize_entry_path(entry_path)?
        .ok_or_else(|| LiberaError::unsafe_archive(format!("invalid entry path: {entry_path}")))
}

/// Where a normalized entry path lands under `target_root`. Each segment has
/// to stay a plain name once the OS reads it, which is what catches a `C:`
/// in the middle of a path on Windows.
pub(crate) fn resolve_output_path(target_root: &Path, entry_path: &str) -> Result<PathBuf, LiberaError> {
    let mut output = target_root.to_path_buf();
    for segment in entry_path.split('/') {
        let mut components = Path::new(segment).components();
        match (components.next(), components.next()) {
            (Some(Component::Normal(name)), None) => output.push(name),
            _ => {
                return Err(LiberaError::unsafe_archive(format!(
                    "entry path resolves outside the destination: {entry_path}"
                )));
            }
        }
    }
    Ok(output)
}

/// A symlink entry stores its target as free-form text, so it needs its own
/// escape check: an absolute target reaches outside the destination outright,
/// and a relative one is resolved against the link's own folder (not the
/// destination, matching how the OS resolves it) before being range-checked.
pub(crate) fn assert_safe_symlink_target(
    target_root: &Path,
    output_path: &Path,
    link_target: &str,
) -> Result<(), LiberaError> {
    if link_target.is_empty() || link_target.contains('\0') {
        return Err(LiberaError::unsafe_archive(format!(
            "symlink has an empty or invalid target: {}",
            output_path.display()
        )));
    }
    let normalized = link_target.replace('\\', "/");
    if normalized.starts_with('/') || has_drive_prefix(&normalized) {
        return Err(LiberaError::unsafe_archive(format!("symlink target is an absolute path: {link_target}")));
    }

    // The link's folder as names below the destination, walked lexically.
    let link_folder = output_path.parent().and_then(|parent| parent.strip_prefix(target_root).ok());
    let mut depth: Vec<&str> = link_folder
        .map(|folder| folder.components().filter_map(|component| component.as_os_str().to_str()).collect())
        .unwrap_or_default();
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if depth.pop().is_none() {
                    return Err(LiberaError::unsafe_archive(format!(
                        "symlink target escapes the destination: {link_target}"
                    )));
                }
            }
            name => depth.push(name),
        }
    }
    Ok(())
}

// Past this many numbered names the folder is not one a person is tidying by
// hand, and the conflict is reported instead of probed any further.
pub(crate) const MAX_RENAME_ATTEMPTS: u32 = 10_000;

/// `report.txt` → `report (1).txt`, the way Finder and Explorer name the
/// second copy. Compound suffixes stay whole, so `backup.tar.gz` becomes
/// `backup (1).tar.gz`, and a dotfile such as `.env` has no extension to keep
/// apart, so it becomes `.env (1)`.
pub(crate) fn numbered_file_name(file_name: &str, number: u32) -> String {
    let extension_start = compound_extension_start(file_name).or_else(|| match file_name.rfind('.') {
        Some(0) | None => None,
        Some(_) if file_name.bytes().all(|byte| byte == b'.') => None,
        Some(index) => Some(index),
    });
    match extension_start {
        Some(index) => format!("{} ({number}){}", &file_name[..index], &file_name[index..]),
        None => format!("{file_name} ({number})"),
    }
}

/// Where a `.tar.<codec>` suffix starts, when it does not start the name.
fn compound_extension_start(file_name: &str) -> Option<usize> {
    let last_dot = file_name.rfind('.')?;
    if last_dot + 1 == file_name.len() {
        return None;
    }
    let before = &file_name[..last_dot];
    let tar_start = before.len().checked_sub(4)?;
    (tar_start > 0 && before.is_char_boundary(tar_start) && before[tar_start..].eq_ignore_ascii_case(".tar"))
        .then_some(tar_start)
}

/// The first segment of an entry path, which is what a quarantine flag goes on.
pub(crate) fn top_level_output_name(target_root: &Path, output_path: &Path) -> Option<PathBuf> {
    output_path
        .strip_prefix(target_root)
        .ok()?
        .components()
        .next()
        .map(|component| PathBuf::from(component.as_os_str()))
}

/// `path` made absolute and lexically normalized, as Node's `path.resolve`
/// does, without touching the filesystem.
pub(crate) fn absolute_normalized(path: &Path) -> std::io::Result<PathBuf> {
    let absolute = std::path::absolute(path)?;
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_ordinary_entry_paths() {
        for (input, expected) in [
            ("a.txt", "a.txt"),
            ("dir/a.txt", "dir/a.txt"),
            ("./dir//a.txt", "dir/a.txt"),
            ("dir\\a.txt", "dir/a.txt"),
            ("dir/", "dir"),
            ("dir/./a.txt", "dir/a.txt"),
            ("..notes.txt", "..notes.txt"),
        ] {
            assert_eq!(normalize_entry_path(input).unwrap().as_deref(), Some(expected), "{input}");
        }
    }

    #[test]
    fn rejects_paths_that_escape_the_destination() {
        for input in [
            "/etc/passwd",
            "../a.txt",
            "..\\a.txt",
            "dir/../../a.txt",
            "C:/a.txt",
            "c:",
            "C:\\a.txt",
            "\\\\server\\a",
            "a\0b",
            "",
        ] {
            assert!(matches!(normalize_entry_path(input), Err(LiberaError::UnsafeArchive { .. })), "{input:?}");
        }
    }

    #[test]
    fn reads_a_path_that_normalizes_away_to_nothing_as_the_destination_itself() {
        for input in [".", "./", ".//"] {
            assert_eq!(normalize_entry_path(input).unwrap(), None, "{input}");
            assert!(require_entry_path(input).is_err());
        }
    }

    #[test]
    fn checks_symlink_targets_against_the_link_folder() {
        let root = Path::new("/dest");
        let link = Path::new("/dest/dir/link");
        assert!(assert_safe_symlink_target(root, link, "../a.txt").is_ok());
        assert!(assert_safe_symlink_target(root, link, "sub/./a.txt").is_ok());
        assert!(assert_safe_symlink_target(root, link, "..").is_ok());
        assert!(assert_safe_symlink_target(root, link, "../../a.txt").is_err());
        assert!(assert_safe_symlink_target(root, link, "/etc/passwd").is_err());
        assert!(assert_safe_symlink_target(root, link, "C:\\x").is_err());
        assert!(assert_safe_symlink_target(root, link, "").is_err());
    }

    #[test]
    fn numbers_a_clashing_name_the_way_file_managers_name_a_second_copy() {
        for (name, expected) in [
            ("report.txt", "report (1).txt"),
            ("archive.tar.gz", "archive (1).tar.gz"),
            ("ARCHIVE.TAR.ZST", "ARCHIVE (1).TAR.ZST"),
            (".env", ".env (1)"),
            ("README", "README (1)"),
            (".tar.gz", ".tar (1).gz"),
            ("a.b.c", "a.b (1).c"),
        ] {
            assert_eq!(numbered_file_name(name, 1), expected, "{name}");
        }
    }

    #[test]
    fn recognizes_macos_metadata_paths() {
        for path in ["__MACOSX", "__MACOSX/a", "./__MACOSX/._a", ".DS_Store", "dir/.DS_Store", "dir\\.DS_Store"] {
            assert!(is_mac_metadata_path(path), "{path}");
        }
        for path in ["dir/__MACOSX", "._a", "DS_Store", "a.DS_Store"] {
            assert!(!is_mac_metadata_path(path), "{path}");
        }
    }

    #[test]
    fn matches_selected_folders_and_their_descendants() {
        let selected: HashSet<String> = ["docs/".to_owned(), "a.txt".to_owned()].into();
        for path in ["docs", "docs/x/y.txt", "./a.txt"] {
            assert!(matches_selected_entry(path, Some(&selected)), "{path}");
        }
        for path in ["docsx/y.txt", "b.txt", "a.txt.bak"] {
            assert!(!matches_selected_entry(path, Some(&selected)), "{path}");
        }
        assert!(matches_selected_entry("anything", None));
    }
}
