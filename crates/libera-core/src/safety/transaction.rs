use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::LiberaError;

/// Everything one extraction created or moved aside, so a job that fails or
/// is cancelled can put the destination back the way it found it.
#[derive(Default)]
pub(crate) struct Transaction {
    files: Vec<PathBuf>,
    recorded_files: HashSet<PathBuf>,
    directories: Vec<PathBuf>,
    recorded_directories: HashSet<PathBuf>,
    /// Existing files an overwrite moved aside, and where they went.
    backups: Vec<(PathBuf, PathBuf)>,
    backed_up: HashSet<PathBuf>,
    backup_root: Option<PathBuf>,
}

impl Transaction {
    pub(crate) fn record_file(&mut self, path: &Path) {
        if self.recorded_files.insert(path.to_path_buf()) {
            self.files.push(path.to_path_buf());
        }
    }

    pub(crate) fn record_directory(&mut self, path: &Path) {
        if self.recorded_directories.insert(path.to_path_buf()) {
            self.directories.push(path.to_path_buf());
        }
    }

    /// Moves an existing file out of the way of an overwrite, into a hidden
    /// folder in the destination that a rollback restores it from.
    pub(crate) fn backup_existing(&mut self, file: &Path, target_root: &Path) -> Result<(), LiberaError> {
        if self.backed_up.contains(file) {
            return Ok(());
        }
        let metadata = fs::symlink_metadata(file)?;
        if !metadata.file_type().is_file() {
            return Err(LiberaError::unsafe_archive(format!(
                "destination cannot be safely overwritten: {}",
                file.display()
            )));
        }
        let backup_root = match &self.backup_root {
            Some(root) => root.clone(),
            None => {
                let root = tempfile::Builder::new().prefix(".libera-backup-").tempdir_in(target_root)?.keep();
                self.backup_root = Some(root.clone());
                root
            }
        };
        let backup = backup_root.join(self.backups.len().to_string());
        fs::rename(file, &backup)?;
        self.backed_up.insert(file.to_path_buf());
        self.backups.push((file.to_path_buf(), backup));
        Ok(())
    }

    /// Keeps what the job wrote and drops the files it replaced.
    pub(crate) fn commit(&mut self) {
        if let Some(root) = self.backup_root.take() {
            let _ = fs::remove_dir_all(root);
        }
        self.backups.clear();
        self.backed_up.clear();
    }

    /// Removes what the job wrote, newest first, and puts every replaced file
    /// back. Removal is best effort; a backup that cannot be restored is the
    /// one failure worth reporting, and its folder is then left in place.
    pub(crate) fn rollback(&mut self) -> Result<(), LiberaError> {
        for file in self.files.drain(..).rev() {
            let _ = fs::remove_file(&file);
        }

        let mut restore_error = None;
        for (file, backup) in self.backups.drain(..).rev() {
            if let Err(error) = fs::rename(&backup, &file) {
                restore_error.get_or_insert(error);
            }
        }

        let mut directories = std::mem::take(&mut self.directories);
        directories.sort_by_key(|directory| std::cmp::Reverse(directory.components().count()));
        for directory in directories {
            // Only empty folders go; one that something else wrote into stays.
            let _ = fs::remove_dir(&directory);
        }

        match restore_error {
            None => {
                if let Some(root) = self.backup_root.take() {
                    let _ = fs::remove_dir_all(root);
                }
                Ok(())
            }
            Some(error) => Err(LiberaError::Io {
                message: format!(
                    "Extraction rollback could not restore a backup from {}: {error}",
                    self.backup_root.as_deref().unwrap_or(Path::new("")).display()
                ),
            }),
        }
    }
}
