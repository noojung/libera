use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::LiberaError;

pub(crate) enum InputKind {
    Directory,
    File,
    Symlink,
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

/// Every entry under `input_paths`, parents before children and siblings in
/// name order. `output` is left out wherever the walk meets it, since an
/// archive saved inside a folder it compresses would otherwise take itself in.
pub(crate) fn collect_inputs(input_paths: &[String], output: &Path) -> Result<Vec<InputEntry>, LiberaError> {
    let output = without_final_link(output)?;
    let mut root_name = unique_root_namer();
    let mut entries = Vec::new();
    for input in input_paths {
        let path = without_final_link(Path::new(input))?;
        let name = path
            .file_name()
            .ok_or_else(|| LiberaError::InvalidInput { message: format!("{input} has no name to store it under.") })?;
        let stored = root_name(&name.to_string_lossy());
        walk(path, stored, &output, &mut entries)?;
    }
    Ok(entries)
}

fn walk(path: PathBuf, stored_path: String, output: &Path, entries: &mut Vec<InputEntry>) -> io::Result<()> {
    if path == output {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(&path)?;
    let file_type = metadata.file_type();
    let kind = if file_type.is_dir() {
        InputKind::Directory
    } else if file_type.is_file() {
        InputKind::File
    } else if file_type.is_symlink() {
        InputKind::Symlink
    } else {
        // Sockets, pipes and devices have no content an archive could carry.
        return Ok(());
    };
    let size = if matches!(kind, InputKind::File) { metadata.len() } else { 0 };
    entries.push(InputEntry { disk_path: path.clone(), stored_path: stored_path.clone(), kind, size });

    if file_type.is_dir() {
        let mut children =
            fs::read_dir(&path)?.map(|child| child.map(|child| child.file_name())).collect::<io::Result<Vec<_>>>()?;
        children.sort();
        for name in children {
            let child_stored = format!("{stored_path}/{}", name.to_string_lossy());
            walk(path.join(&name), child_stored, output, entries)?;
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
fn unique_root_namer() -> impl FnMut(&str) -> String {
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
