use std::fs::{self, File, FileTimes, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use super::transaction::Transaction;

/// Creates a file only this job owns: it must not exist yet, and it stays
/// readable by its owner alone until its contents are complete.
pub(crate) fn create_owned_file(path: &Path, transaction: &mut Transaction) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let file = options.open(path)?;
    transaction.record_file(path);
    Ok(file)
}

#[cfg(unix)]
pub(crate) fn create_owned_symlink(path: &Path, target: &str, transaction: &mut Transaction) -> io::Result<()> {
    std::os::unix::fs::symlink(target, path)?;
    transaction.record_file(path);
    Ok(())
}

#[cfg(not(unix))]
pub(crate) fn create_owned_symlink(path: &Path, _target: &str, _transaction: &mut Transaction) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, format!("cannot restore the link {}", path.display())))
}

/// Whether link entries can be restored here at all. Windows creates them only
/// for a process that is elevated or in developer mode, and this engine does
/// not restore them there yet.
pub(crate) const RESTORES_SYMBOLIC_LINKS: bool = cfg!(unix);

/// Windows collapses a whole unix mode onto a single read-only flag, so
/// restoring one buys nothing and can leave an undeletable file behind.
pub(crate) const RESTORES_UNIX_MODE: bool = cfg!(unix);

/// The permission bits an entry should end up with, with setuid, setgid and
/// sticky stripped so no archive can grant them. Entries written by non-Unix
/// tools carry no mode at all and keep the restrictive mode they are created
/// with, which is why a zero result means "leave it alone" rather than mode 0.
pub(crate) fn archive_permissions(unix_mode: u32) -> Option<u32> {
    let permissions = unix_mode & 0o777;
    (permissions != 0).then_some(permissions)
}

/// Widens a finished file to the mode its entry recorded. Done only once the
/// contents are complete, so a half written file is never executable and
/// never readable by anyone but the owner.
pub(crate) fn apply_mode(path: &Path, mode: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
        Ok(())
    }
}

pub(crate) fn apply_modified_time(file: &File, modified: SystemTime) -> io::Result<()> {
    file.set_times(FileTimes::new().set_modified(modified).set_accessed(modified))
}

// Finder's Archive Utility copies the archive's own quarantine flag onto
// everything it extracts, which is what makes Gatekeeper evaluate a freshly
// unzipped app on first open. A plain filesystem writer has nothing to inherit
// that flag from, so it is restored by hand here, on the top level output
// items only - that already covers everything the user can double click.
#[cfg(target_os = "macos")]
pub(crate) fn propagate_quarantine(archive_path: &Path, target_root: &Path, top_level_names: &[PathBuf]) {
    const QUARANTINE: &str = "com.apple.quarantine";
    let Ok(Some(value)) = xattr::get(archive_path, QUARANTINE) else { return };
    if value.is_empty() {
        return;
    }
    for name in top_level_names {
        let _ = xattr::set(target_root.join(name), QUARANTINE, &value);
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn propagate_quarantine(_archive_path: &Path, _target_root: &Path, _top_level_names: &[PathBuf]) {}
