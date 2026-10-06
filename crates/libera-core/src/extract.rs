use std::fs::{self, File};
use std::io::BufReader;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use flate2::read::MultiGzDecoder;
use tar::{Archive, EntryType};

use crate::LiberaError;
use crate::progress::{CancelToken, ProgressListener, Reporter, Tracked};

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ExtractionOptions {
    pub archive_path: String,
    pub target_dir: String,
    /// Require this job to create `target_dir` itself.
    pub reject_existing_target: bool,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ExtractionResult {
    pub target_dir: String,
    pub extracted_count: u64,
    pub duration_ms: u64,
    pub symbolic_links_excluded: u64,
}

struct Counts {
    extracted: u64,
    links_excluded: u64,
}

/// Unpacks `options.archive_path` into `options.target_dir`.
///
/// Entries that would land outside the target fail the job, and links are
/// never restored yet. A target this job created is removed again when the
/// job fails or is cancelled; one that was already there keeps what reached
/// it, and files already on disk are never overwritten.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn extract_archive(
    options: ExtractionOptions,
    listener: Arc<dyn ProgressListener>,
    cancel: Arc<CancelToken>,
) -> Result<ExtractionResult, LiberaError> {
    let started = Instant::now();
    if cancel.is_cancelled() {
        return Err(LiberaError::ExtractionCancelled);
    }
    let archive_path = Path::new(&options.archive_path);
    if !is_tar_gz(archive_path) {
        return Err(LiberaError::InvalidInput {
            message: format!("{} is not an archive this engine reads yet.", options.archive_path),
        });
    }

    let archive = File::open(archive_path)?;
    let reporter = Reporter::new(listener, Some(archive.metadata()?.len()));
    let target = PathBuf::from(&options.target_dir);
    let created_target = prepare_target(&target, options.reject_existing_target)?;

    match unpack_tar_gz(archive, &target, &reporter, &cancel) {
        Ok(counts) => {
            reporter.complete();
            Ok(ExtractionResult {
                target_dir: options.target_dir,
                extracted_count: counts.extracted,
                duration_ms: started.elapsed().as_millis() as u64,
                symbolic_links_excluded: counts.links_excluded,
            })
        }
        Err(error) => {
            if created_target {
                let _ = fs::remove_dir_all(&target);
            }
            Err(if cancel.is_cancelled() { LiberaError::ExtractionCancelled } else { error })
        }
    }
}

fn is_tar_gz(path: &Path) -> bool {
    let name = path.to_string_lossy().to_lowercase();
    name.ends_with(".tar.gz") || name.ends_with(".tgz")
}

/// Makes sure `target` is a folder to extract into, and says whether this
/// job created it.
fn prepare_target(target: &Path, reject_existing: bool) -> Result<bool, LiberaError> {
    match fs::symlink_metadata(target) {
        Ok(_) if reject_existing => {
            Err(LiberaError::DestinationExists { message: format!("{} already exists.", target.display()) })
        }
        Ok(metadata) if metadata.is_dir() => Ok(false),
        Ok(_) => Err(LiberaError::InvalidInput { message: format!("{} is not a folder.", target.display()) }),
        Err(_) => {
            fs::create_dir_all(target)?;
            Ok(true)
        }
    }
}

fn unpack_tar_gz(
    archive: File,
    target: &Path,
    reporter: &Reporter,
    cancel: &CancelToken,
) -> Result<Counts, LiberaError> {
    let reader = Tracked::new(BufReader::new(archive), reporter, cancel);
    let mut archive = Archive::new(MultiGzDecoder::new(reader));
    archive.set_overwrite(false);
    let mut counts = Counts { extracted: 0, links_excluded: 0 };

    for entry in archive.entries()? {
        if cancel.is_cancelled() {
            return Err(LiberaError::ExtractionCancelled);
        }
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        require_inside(&path)?;
        reporter.set_current_file(path.to_string_lossy());

        let entry_type = entry.header().entry_type();
        match entry_type {
            EntryType::Symlink => {
                counts.links_excluded += 1;
                continue;
            }
            EntryType::Link => {
                if let Some(source) = entry.link_name()? {
                    require_inside(&source)?;
                }
            }
            EntryType::Directory | EntryType::Regular | EntryType::Continuous => {}
            // Devices, pipes and the like are never recreated.
            _ => continue,
        }
        if !entry.unpack_in(target)? {
            return Err(unsafe_entry(&path));
        }
        if entry_type != EntryType::Directory {
            counts.extracted += 1;
        }
    }
    Ok(counts)
}

/// Fails on an entry path that is absolute or climbs with `..`, either of
/// which would reach outside the extraction target.
fn require_inside(path: &Path) -> Result<(), LiberaError> {
    let escapes = path.as_os_str().is_empty()
        || path.components().any(|component| !matches!(component, Component::Normal(_) | Component::CurDir));
    if escapes { Err(unsafe_entry(path)) } else { Ok(()) }
}

fn unsafe_entry(path: &Path) -> LiberaError {
    LiberaError::UnsafeArchive {
        message: format!("Archive entry {} points outside the extraction folder.", path.display()),
    }
}
