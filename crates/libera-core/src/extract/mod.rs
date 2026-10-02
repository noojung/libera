mod sevenz;
mod stream;
pub(crate) mod tar;
mod zip;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use crate::LiberaError;
use crate::formats::{ReadFormat, read_format};
use crate::patterns::EntryFilter;
use crate::progress::{CancelToken, ProgressListener};
use crate::safety::ExtractionPolicy;
use crate::safety::meter::Meter;
use crate::safety::plan::{ArchiveEntry, Plan, Selection, build_plan, top_level_names};
use crate::safety::target::{OverwritePolicy, prepare_selected_destinations, prepare_target_root};
use crate::safety::transaction::Transaction;
use crate::safety::write::{RESTORES_SYMBOLIC_LINKS, RESTORES_UNIX_MODE, propagate_quarantine};
use crate::zip::FilenameEncoding;

/// One extraction job. The expert options are optional; each format applies
/// the Electron engine's default for the ones left unset.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ExtractionOptions {
    pub archive_path: String,
    pub target_dir: String,
    /// Require this job to create `target_dir` itself.
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub reject_existing_target: bool,
    /// Archive paths to extract, folders standing for everything below them.
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub selected_entries: Option<Vec<String>>,
    /// Decrypts a ZIP's encrypted entries.
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub password: Option<String>,
    /// The encoding a ZIP's entry names are read in, when its flag says nothing.
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub encoding: Option<FilenameEncoding>,
    /// Checks each ZIP entry's CRC; on unless turned off.
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub strict_crc: Option<bool>,
    /// What to do with an entry that lands on an existing file; unset refuses.
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub overwrite_policy: Option<OverwritePolicy>,
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub restore_timestamps: Option<bool>,
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub restore_permissions: Option<bool>,
    /// Restored by default wherever the OS allows it.
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub restore_symlinks: Option<bool>,
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub exclude_mac_metadata: Option<bool>,
    #[cfg_attr(feature = "uniffi", uniffi(default))]
    pub filter_pattern: Option<String>,
}

impl ExtractionOptions {
    /// Options with every expert setting left to its default.
    pub fn new(archive_path: String, target_dir: String) -> Self {
        Self {
            archive_path,
            target_dir,
            reject_existing_target: false,
            selected_entries: None,
            password: None,
            encoding: None,
            strict_crc: None,
            overwrite_policy: None,
            restore_timestamps: None,
            restore_permissions: None,
            restore_symlinks: None,
            exclude_mac_metadata: None,
            filter_pattern: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ExtractionResult {
    /// The destination as resolved, links in its path followed.
    pub target_dir: String,
    pub extracted_count: u64,
    pub duration_ms: u64,
    pub symbolic_links_excluded: u64,
}

/// Overrides for what an extraction reads from its surroundings, so tests can
/// reach the limits without writing a terabyte.
#[doc(hidden)]
#[derive(Debug, Clone, Default)]
pub struct ExtractionContext {
    pub policy: ExtractionPolicy,
    /// Free space to assume at the destination instead of asking the OS.
    pub available_bytes: Option<u64>,
}

/// Unpacks `options.archive_path` into `options.target_dir`.
///
/// Every entry is checked against the limits and the destination before
/// anything is written. A job that fails or is cancelled removes what it
/// wrote and puts back any file it replaced.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn extract_archive(
    options: ExtractionOptions,
    listener: Arc<dyn ProgressListener>,
    cancel: Arc<CancelToken>,
) -> Result<ExtractionResult, LiberaError> {
    extract_archive_with(options, listener, cancel, ExtractionContext::default())
}

#[doc(hidden)]
pub fn extract_archive_with(
    options: ExtractionOptions,
    listener: Arc<dyn ProgressListener>,
    cancel: Arc<CancelToken>,
    context: ExtractionContext,
) -> Result<ExtractionResult, LiberaError> {
    let started = Instant::now();
    if cancel.is_cancelled() {
        return Err(LiberaError::ExtractionCancelled);
    }
    // Any volume of a split set stands for the set, read from the volume that
    // holds its central directory.
    let archive_path = &crate::resolve::canonical_archive_path(Path::new(&options.archive_path));
    let format = check_archive(archive_path)?;

    let mut transaction = Transaction::default();
    let outcome = prepare_target_root(Path::new(&options.target_dir), &mut transaction, options.reject_existing_target)
        .and_then(|target_root| {
            let available = match context.available_bytes {
                Some(available) => available,
                None => fs4::available_space(&target_root)?,
            };
            let disk_budget = context.policy.usable_bytes(available);
            if disk_budget == 0 {
                return Err(LiberaError::InsufficientDiskSpace {
                    message: "Not enough disk space to preserve the configured reserve".into(),
                });
            }
            let mut job = Job {
                archive_path,
                target_root,
                options: &options,
                filter: EntryFilter::new(options.filter_pattern.as_deref()),
                policy: context.policy,
                disk_budget,
                transaction: &mut transaction,
                listener,
                cancel: &cancel,
            };
            let counts = match format {
                ReadFormat::Zip => zip::extract(&mut job)?,
                ReadFormat::SevenZip => sevenz::extract(&mut job)?,
                ReadFormat::Tar(_) => tar::extract(&mut job)?,
                ReadFormat::Stream(codec) => stream::extract(&mut job, codec)?,
            };
            Ok(ExtractionResult {
                target_dir: job.target_root.to_string_lossy().into_owned(),
                extracted_count: counts.extracted,
                duration_ms: started.elapsed().as_millis() as u64,
                symbolic_links_excluded: counts.links_excluded,
            })
        });

    match outcome {
        Ok(result) => {
            transaction.commit();
            Ok(result)
        }
        Err(error) => {
            transaction.rollback()?;
            Err(if cancel.is_cancelled() { LiberaError::ExtractionCancelled } else { error })
        }
    }
}

fn check_archive(archive_path: &Path) -> Result<ReadFormat, LiberaError> {
    let metadata = fs::symlink_metadata(archive_path).map_err(|_| LiberaError::ArchiveMissing {
        message: format!("Archive file does not exist: {}", archive_path.display()),
    })?;
    if !metadata.is_file() {
        return Err(LiberaError::invalid_input("Extraction requires an archive file, not a folder"));
    }
    read_format(archive_path).ok_or_else(|| LiberaError::UnsupportedArchive {
        message: format!("Unsupported archive format for extraction: {}", archive_path.display()),
    })
}

/// What a format handler reports back.
struct Counts {
    extracted: u64,
    links_excluded: u64,
}

/// One extraction, as every format handler sees it.
struct Job<'a> {
    archive_path: &'a Path,
    /// The destination, resolved and known to be a real folder.
    target_root: PathBuf,
    options: &'a ExtractionOptions,
    filter: EntryFilter,
    policy: ExtractionPolicy,
    disk_budget: u64,
    transaction: &'a mut Transaction,
    listener: Arc<dyn ProgressListener>,
    cancel: &'a CancelToken,
}

impl Job<'_> {
    /// Unix restores links by default; elsewhere they are never restored yet.
    fn restore_symlinks(&self) -> bool {
        RESTORES_SYMBOLIC_LINKS && self.options.restore_symlinks != Some(false)
    }

    fn restore_permissions(&self) -> bool {
        RESTORES_UNIX_MODE && self.options.restore_permissions != Some(false)
    }

    fn exclude_mac_metadata(&self) -> bool {
        self.options.exclude_mac_metadata == Some(true)
    }

    fn meter(&self, total: Option<u64>) -> Meter {
        Meter::new(self.listener.clone(), self.policy, self.disk_budget, total)
    }

    /// What the user's choices say about which entries to write.
    fn selection(&self) -> Selection<'_> {
        Selection::new(
            self.options.selected_entries.as_deref(),
            &self.filter,
            self.exclude_mac_metadata(),
            self.restore_symlinks(),
        )
    }

    /// Turns a format's listing into a plan: narrows it to what the user's
    /// choices select, checks it against the limits and the free space, and
    /// settles every clash with what is already in the destination.
    fn plan<S>(&mut self, entries: Vec<ArchiveEntry<S>>) -> Result<(Plan<S>, u64), LiberaError> {
        let selection = self.selection();
        let links_excluded = selection.links_excluded(&entries);
        let mut plan = build_plan(entries, &self.target_root, |entry| selection.selects(entry), &self.policy)?;
        if plan.selected_total_bytes > self.disk_budget {
            return Err(LiberaError::InsufficientDiskSpace {
                message: "Not enough disk space for extraction and the configured reserve".into(),
            });
        }
        prepare_selected_destinations(
            &self.target_root,
            &mut plan.entries,
            self.options.overwrite_policy,
            self.transaction,
        )?;
        Ok((plan, links_excluded))
    }

    fn propagate_quarantine<S>(&self, plan: &Plan<S>) {
        propagate_quarantine(self.archive_path, &self.target_root, &top_level_names(plan, &self.target_root));
    }
}
