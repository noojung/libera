use std::cmp::Ordering;
use std::collections::HashSet;
use std::fs::{self, FileType};
use std::io;
use std::path::{Path, PathBuf};

use crate::LiberaError;
use crate::patterns::EntryFilter;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InputKind {
    Directory,
    File,
    Symlink,
}

impl InputKind {
    fn of(file_type: FileType) -> Option<Self> {
        if file_type.is_dir() {
            Some(Self::Directory)
        } else if file_type.is_file() {
            Some(Self::File)
        } else if file_type.is_symlink() {
            Some(Self::Symlink)
        } else {
            // Sockets, pipes and devices have no content an archive could carry.
            None
        }
    }
}

/// One thing an archive will hold, found by walking the inputs without ever
/// following a link.
pub(crate) struct InputEntry {
    pub disk_path: PathBuf,
    /// The path inside the archive, `/`-separated, without a trailing slash.
    pub stored_path: String,
    pub kind: InputKind,
    pub size: u64,
}

/// The source-side filters every writer honours. Extraction has the mirror of
/// these, and these decide what reaches the archive in the first place.
#[derive(Debug, Clone, Default)]
pub(crate) struct InputFilters {
    /// Drops symbolic links instead of storing them as link entries.
    pub exclude_symlinks: bool,
    /// Drops the bookkeeping files macOS leaves in a folder it has opened.
    pub exclude_mac_metadata: bool,
    /// Drops dot-prefixed names, and everything below a dot-prefixed folder.
    pub exclude_hidden_files: bool,
    pub pattern: EntryFilter,
}

impl InputFilters {
    /// False for a name whose whole subtree is skipped. A blocked name prunes
    /// everything under it - `.git` and `__MACOSX` are worth nothing without
    /// their contents - while the pattern only ever drops leaves, since a
    /// folder that matches no pattern still holds the files that do.
    fn allows_name(&self, name: &str) -> bool {
        !(self.exclude_mac_metadata && is_mac_metadata_name(name) || self.exclude_hidden_files && is_hidden_name(name))
    }

    fn allows_entry(&self, stored_path: &str, kind: InputKind) -> bool {
        match kind {
            InputKind::Symlink if self.exclude_symlinks => false,
            // A folder carries no content of its own to match against.
            InputKind::Directory => true,
            _ => self.pattern.allows(stored_path),
        }
    }
}

/// True for a name macOS writes for itself: the Finder's `.DS_Store`, the
/// `__MACOSX` folder an archiver adds, and `._name` AppleDouble sidecars.
pub(crate) fn is_mac_metadata_name(name: &str) -> bool {
    name == ".DS_Store" || name == "__MACOSX" || name.starts_with("._")
}

/// True for a name every desktop platform hides by convention. Windows has a
/// hidden attribute too, but the dot is the one rule that reads the same on
/// every platform.
pub(crate) fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.') && name != "." && name != ".."
}

/// Every entry under `input_paths` the filters let through, parents before
/// children and siblings in name order. `output` is left out wherever the
/// walk meets it, since an archive saved inside a folder it compresses would
/// otherwise take itself in, and its read would never reach the end.
pub(crate) fn collect_inputs(
    input_paths: &[String],
    output: &Path,
    filters: &InputFilters,
) -> Result<Vec<InputEntry>, LiberaError> {
    let output = without_final_link(output)?;
    let mut root_name = unique_root_namer();
    let mut entries = Vec::new();
    for input in input_paths {
        let path = match without_final_link(Path::new(input)) {
            Ok(path) => path,
            // A root that vanished since it was picked is skipped, as the
            // Electron engine's walk does.
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        let name = path
            .file_name()
            .ok_or_else(|| LiberaError::invalid_input(format!("{input} has no name to store it under.")))?
            .to_string_lossy()
            .into_owned();
        if path == output || !filters.allows_name(&name) {
            continue;
        }
        let Some(metadata) = lstat_unless_gone(&path)? else { continue };
        let Some(kind) = InputKind::of(metadata.file_type()) else { continue };
        if !filters.allows_entry(&name, kind) {
            continue;
        }
        // Claimed only once the root is known to be going in, so a filtered out
        // root does not push the next one onto a suffix.
        let stored = root_name(&name);
        walk(path, stored, kind, metadata.len(), &output, filters, &mut entries)?;
    }
    Ok(entries)
}

fn lstat_unless_gone(path: &Path) -> io::Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn walk(
    path: PathBuf,
    stored_path: String,
    kind: InputKind,
    length: u64,
    output: &Path,
    filters: &InputFilters,
    entries: &mut Vec<InputEntry>,
) -> io::Result<()> {
    let size = if kind == InputKind::File { length } else { 0 };
    entries.push(InputEntry { disk_path: path.clone(), stored_path: stored_path.clone(), kind, size });
    if kind != InputKind::Directory {
        return Ok(());
    }

    let mut children =
        fs::read_dir(&path)?.map(|child| child.map(|child| child.file_name())).collect::<io::Result<Vec<_>>>()?;
    children.sort();
    for name in children {
        let child = path.join(&name);
        let name = name.to_string_lossy();
        if child == output || !filters.allows_name(&name) {
            continue;
        }
        // Anything that disappears between the listing and here is skipped.
        let Some(metadata) = lstat_unless_gone(&child)? else { continue };
        let Some(child_kind) = InputKind::of(metadata.file_type()) else { continue };
        let child_stored = format!("{stored_path}/{name}");
        if filters.allows_entry(&child_stored, child_kind) {
            walk(child, child_stored, child_kind, metadata.len(), output, filters, entries)?;
        }
    }
    Ok(())
}

/// The absolute, link-free path to `path` itself: its parent is resolved but
/// a link in the last place stays the link, since that is what gets stored.
fn without_final_link(path: &Path) -> io::Result<PathBuf> {
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => {
            let parent = if parent.as_os_str().is_empty() { Path::new(".") } else { parent };
            Ok(parent.canonicalize()?.join(name))
        }
        _ => path.canonicalize(),
    }
}

/// Names the input roots so no two share one: the roots a user picks carry
/// only their basename into the archive, so two folders called `src` would
/// otherwise land on the same path. Later ones become `src (2)`, `src (3)`.
///
/// Windows compares names without case, so `Src` collides with `src` there
/// and not elsewhere, as in the Electron engine.
pub(crate) fn unique_root_namer() -> impl FnMut(&str) -> String {
    let mut used = HashSet::new();
    let key = |name: &str| if cfg!(windows) { name.to_lowercase() } else { name.to_owned() };
    move |name| {
        let mut candidate = name.to_owned();
        let mut suffix = 2;
        while used.contains(&key(&candidate)) {
            candidate = format!("{name} ({suffix})");
            suffix += 1;
        }
        used.insert(key(&candidate));
        candidate
    }
}

/// A file or folder as the UI lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct FileItem {
    pub path: String,
    pub name: String,
    pub is_directory: bool,
    /// A folder's size is everything below it, links not followed.
    pub size: u64,
}

fn display_name(path: &Path) -> String {
    path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string())
}

/// What the compression panel shows for each picked path. A path that cannot
/// be read is listed as an empty file rather than dropped, so the user still
/// sees what they picked.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn item_stats(paths: Vec<String>) -> Vec<FileItem> {
    paths
        .into_iter()
        .map(|path| {
            let disk_path = PathBuf::from(&path);
            let name = display_name(&disk_path);
            match fs::symlink_metadata(&disk_path) {
                Ok(metadata) if metadata.is_dir() => {
                    FileItem { size: tree_size(&disk_path), path, name, is_directory: true }
                }
                Ok(metadata) => FileItem { size: metadata.len(), path, name, is_directory: false },
                Err(_) => FileItem { path, name, is_directory: false, size: 0 },
            }
        })
        .collect()
}

/// The bytes below a folder, without following links. Whatever cannot be read
/// counts as nothing.
fn tree_size(directory: &Path) -> u64 {
    let Ok(children) = fs::read_dir(directory) else { return 0 };
    children
        .filter_map(Result::ok)
        .map(|child| match child.path().symlink_metadata() {
            Ok(metadata) if metadata.is_dir() => tree_size(&child.path()),
            Ok(metadata) if metadata.is_file() => metadata.len(),
            _ => 0,
        })
        .sum()
}

/// One folder level for the per-file method dialogs: links are left out, as
/// the compressor's own walk never follows them, and folders come first in
/// natural name order.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn list_input_children(directory: String) -> Result<Vec<FileItem>, LiberaError> {
    let mut items: Vec<FileItem> = fs::read_dir(&directory)?
        .filter_map(Result::ok)
        .filter_map(|child| {
            let metadata = child.path().symlink_metadata().ok()?;
            if metadata.file_type().is_symlink() {
                return None;
            }
            Some(FileItem {
                path: child.path().to_string_lossy().into_owned(),
                name: child.file_name().to_string_lossy().into_owned(),
                is_directory: metadata.is_dir(),
                size: if metadata.is_dir() { 0 } else { metadata.len() },
            })
        })
        .collect();
    items.sort_by(|left, right| {
        right.is_directory.cmp(&left.is_directory).then_with(|| natural_order(&left.name, &right.name))
    });
    Ok(items)
}

/// Case-insensitive order that reads runs of digits as numbers, so `file2`
/// comes before `file10` the way Finder sorts them.
pub(crate) fn natural_order(left: &str, right: &str) -> Ordering {
    let mut left_chars = left.chars().peekable();
    let mut right_chars = right.chars().peekable();
    loop {
        match (left_chars.peek().copied(), right_chars.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(l), Some(r)) if l.is_ascii_digit() && r.is_ascii_digit() => {
                let take_number = |chars: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut digits = String::new();
                    while let Some(&c) = chars.peek().filter(|c| c.is_ascii_digit()) {
                        digits.push(c);
                        chars.next();
                    }
                    digits
                };
                let (l_digits, r_digits) = (take_number(&mut left_chars), take_number(&mut right_chars));
                let (l_trimmed, r_trimmed) = (l_digits.trim_start_matches('0'), r_digits.trim_start_matches('0'));
                let order = l_trimmed.len().cmp(&r_trimmed.len()).then_with(|| l_trimmed.cmp(r_trimmed));
                if order != Ordering::Equal {
                    return order;
                }
            }
            (Some(l), Some(r)) => {
                let order = l.to_lowercase().cmp(r.to_lowercase());
                if order != Ordering::Equal {
                    return order;
                }
                left_chars.next();
                right_chars.next();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_what_macos_writes_for_itself() {
        for name in [".DS_Store", "__MACOSX", "._photo.jpg"] {
            assert!(is_mac_metadata_name(name), "{name}");
        }
        for name in ["DS_Store", "MACOSX", "_photo.jpg", "photo._jpg", ".gitignore"] {
            assert!(!is_mac_metadata_name(name), "{name}");
        }
    }

    #[test]
    fn hides_dot_prefixed_names_only() {
        assert!(is_hidden_name(".git"));
        assert!(is_hidden_name(".env"));
        for name in [".", "..", "file.txt", "a.b"] {
            assert!(!is_hidden_name(name), "{name}");
        }
    }

    #[test]
    fn numbers_repeated_root_names_from_2_and_skips_names_already_taken() {
        let mut name = unique_root_namer();
        assert_eq!(name("src"), "src");
        assert_eq!(name("src"), "src (2)");
        assert_eq!(name("src (3)"), "src (3)");
        assert_eq!(name("src"), "src (4)");
        assert_eq!(unique_root_namer()("src"), "src");
        assert_eq!(name("Src"), if cfg!(windows) { "Src (2)" } else { "Src" });
    }

    #[test]
    fn matches_the_pattern_against_files_and_never_against_folders() {
        let filters = InputFilters { pattern: EntryFilter::new(Some("*.txt")), ..InputFilters::default() };
        assert!(filters.allows_entry("docs", InputKind::Directory));
        assert!(filters.allows_entry("docs/a.txt", InputKind::File));
        assert!(!filters.allows_entry("docs/a.md", InputKind::File));
    }

    #[test]
    fn drops_symbolic_links_only_when_asked() {
        let keep = InputFilters::default();
        let drop = InputFilters { exclude_symlinks: true, ..InputFilters::default() };
        assert!(keep.allows_entry("link", InputKind::Symlink));
        assert!(!drop.allows_entry("link", InputKind::Symlink));
    }

    #[test]
    fn sorts_names_the_way_finder_does() {
        let mut names = vec!["file10", "File2", "file1", "alpha", "file02b"];
        names.sort_by(|left, right| natural_order(left, right));
        assert_eq!(names, ["alpha", "file1", "File2", "file02b", "file10"]);
    }
}
