//! What the extraction panel lists for a picked path: the logical archive,
//! and every volume it is read from.

use std::fs;
use std::path::{Path, PathBuf};

use crate::LiberaError;
use crate::formats::{ReadFormat, read_format};
use crate::safety::ExtractionPolicy;
use crate::zip::read::{OpenOptions, ZipArchive};
use crate::zip::volumes::terminal_volume_path;

/// The one volume of a set that can actually be opened, whichever volume was
/// picked: a ZIP set is read from its terminal `.zip`.
pub(crate) fn canonical_archive_path(path: &Path) -> PathBuf {
    terminal_volume_path(path)
}

/// The path every volume of one set shares, so a UI can list the set once
/// however many of its volumes were dropped.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn canonical_archive(path: String) -> String {
    canonical_archive_path(Path::new(&path)).to_string_lossy().into_owned()
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ArchiveVolume {
    pub path: String,
    pub name: String,
    pub size: u64,
}

/// A picked archive as the extraction panel lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ResolvedArchive {
    pub path: String,
    pub name: String,
    /// Every volume together.
    pub size: u64,
    /// The volumes, in order, for a set of more than one.
    pub volumes: Option<Vec<ArchiveVolume>>,
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string())
}

fn volume(path: &Path) -> Result<ArchiveVolume, LiberaError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| LiberaError::ArchiveMissing {
        message: format!("Archive file does not exist: {}", path.display()),
    })?;
    if !metadata.is_file() {
        return Err(LiberaError::invalid_input(format!("Archive volume is not a file: {}", path.display())));
    }
    Ok(ArchiveVolume { path: path.to_string_lossy().into_owned(), name: file_name(path), size: metadata.len() })
}

/// Resolves one picked path to the archive it belongs to and the volumes that
/// archive needs. A terminal `.zip` may be an ordinary archive or the last
/// volume of a set; the reader decides from what the archive itself records,
/// rather than trusting a similarly named `.z01` beside it.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn resolve_extraction_input(path: String) -> Result<ResolvedArchive, LiberaError> {
    let archive_path = canonical_archive_path(Path::new(&path));
    let volumes = match read_format(&archive_path) {
        Some(ReadFormat::Zip) => {
            let options = OpenOptions { policy: ExtractionPolicy::default(), encoding: Default::default() };
            let archive = ZipArchive::open(&archive_path, &options)?;
            archive
                .volume_paths
                .iter()
                .zip(&archive.volume_sizes)
                .map(|(path, size)| ArchiveVolume {
                    path: path.to_string_lossy().into_owned(),
                    name: file_name(path),
                    size: *size,
                })
                .collect()
        }
        _ => vec![volume(&archive_path)?],
    };
    Ok(ResolvedArchive {
        path: archive_path.to_string_lossy().into_owned(),
        name: file_name(&archive_path),
        size: volumes.iter().map(|volume| volume.size).sum(),
        volumes: (volumes.len() > 1).then_some(volumes),
    })
}
