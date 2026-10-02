use std::fs::{self, File};
use std::io::{self, BufWriter, Cursor, Read};
use std::path::{Path, PathBuf};

use super::{CompressionOptions, DEFAULT_LEVEL, Job, Written};
use crate::LiberaError;
use crate::formats::ArchiveFormat;
use crate::inputs::{InputKind, OwnOutput, collect_inputs};
use crate::progress::Reporter;
use crate::sevenz::plan::{
    ArchiveSettings, PlanInput, Rules, Run, SevenZipMethod, validate_dictionary, validate_overrides,
    validate_search_cycles, validate_word_size,
};
use crate::sevenz::volumes::{MAX_SEVEN_ZIP_VOLUMES, VolumeSink, remove_stale_volumes};
use crate::sevenz::write::{Entry, SevenZipWriter};

pub(super) fn validate(options: &CompressionOptions) -> Result<(), LiberaError> {
    if let Some(size) = options.dictionary_size {
        validate_dictionary(size)?;
    }
    if let Some(word_size) = options.match_finder_word_size {
        validate_word_size(word_size)?;
    }
    if let Some(cycles) = options.search_cycles {
        validate_search_cycles(cycles)?;
    }
    if let Some(overrides) = &options.seven_zip_method_overrides {
        validate_overrides(overrides, &options.input_paths)?;
    }
    Ok(())
}

/// One input as the 7z writer stores it.
struct Collected {
    entry: Entry,
    disk_path: PathBuf,
    /// A link's target, which is its stored content.
    link_target: Option<Vec<u8>>,
}

/// Everything a write lays down, short of writing it: the entries in header
/// order - those without data first - and the streams the ones with data go
/// into. The solid-block preview asks the same question.
struct Layout {
    entries: Vec<Collected>,
    /// Where the entries with data start in `entries`.
    first_with_data: usize,
    runs: Vec<Run>,
}

fn layout(options: &CompressionOptions, level: u8) -> Result<Layout, LiberaError> {
    let output = OwnOutput::seven_zip(Path::new(&options.output_path))?;
    let inputs = collect_inputs(&options.input_paths, &output, &options.filters())?;
    if inputs.is_empty() {
        return Err(LiberaError::invalid_input("No supported 7z inputs remain."));
    }
    let mut without_data = Vec::new();
    let mut with_data = Vec::new();
    for input in inputs {
        let metadata = fs::symlink_metadata(&input.disk_path)?;
        let link_target = match input.kind {
            InputKind::Symlink => Some(fs::read_link(&input.disk_path)?.to_string_lossy().into_owned().into_bytes()),
            _ => None,
        };
        let size = match input.kind {
            InputKind::Directory => 0,
            InputKind::File => metadata.len(),
            InputKind::Symlink => link_target.as_ref().map_or(0, |target| target.len() as u64),
        };
        let collected = Collected {
            entry: Entry {
                path: input.stored_path,
                size,
                is_directory: input.kind == InputKind::Directory,
                is_symlink: input.kind == InputKind::Symlink,
                modified: metadata.modified().ok(),
                mode: permission_bits(&metadata),
            },
            disk_path: input.disk_path,
            link_target,
        };
        if size == 0 { without_data.push(collected) } else { with_data.push(collected) }
    }

    let settings = ArchiveSettings::new(
        level,
        options.seven_zip_method,
        options.dictionary_size,
        options.match_finder_word_size,
        options.search_cycles,
        options.solid_archive == Some(true),
    );
    let rules = Rules::new(options.seven_zip_method_overrides.as_deref().unwrap_or_default());
    let plan_inputs: Vec<PlanInput> = with_data
        .iter()
        .map(|collected| PlanInput { source: &collected.disk_path, size: collected.entry.size })
        .collect();
    let runs = crate::sevenz::plan::plan_runs(&plan_inputs, &rules, &settings);
    let first_with_data = without_data.len();
    Ok(Layout { entries: without_data.into_iter().chain(with_data).collect(), first_with_data, runs })
}

fn permission_bits(metadata: &fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        std::os::unix::fs::PermissionsExt::mode(&metadata.permissions()) & 0o7777
    }
    #[cfg(not(unix))]
    {
        if metadata.is_dir() { 0o755 } else { 0o644 }
    }
}

pub(super) fn write(job: &Job) -> Result<Written, LiberaError> {
    let options = job.options;
    let output_path = Path::new(&options.output_path);
    let layout = layout(options, job.level)?;
    let original_size: u64 = layout
        .entries
        .iter()
        .filter(|collected| !collected.entry.is_symlink)
        .map(|collected| collected.entry.size)
        .sum();
    if let Some(split_size) = options.split_size
        && original_size.div_ceil(split_size) > u64::from(MAX_SEVEN_ZIP_VOLUMES)
    {
        return Err(LiberaError::SplitTooManyVolumes { message: "The split size produces too many volumes.".into() });
    }
    if job.cancel.is_cancelled() {
        return Err(LiberaError::CompressionCancelled);
    }

    let password = options.password.as_deref().filter(|password| !password.is_empty());
    let encrypt_header = options.encrypt_file_names == Some(true);
    let reporter = Reporter::new(job.listener.clone(), Some(original_size));
    let entries: Vec<Entry> = layout.entries.iter().map(|collected| collected.entry.clone()).collect();
    let write_into = |sink: &mut dyn SeekWrite| -> Result<(), LiberaError> {
        let mut writer = SevenZipWriter::new(sink, password, job.cancel)?;
        for run in &layout.runs {
            let members: Vec<&Collected> =
                run.entries.iter().map(|&index| &layout.entries[layout.first_with_data + index]).collect();
            let sizes: Vec<u64> = members.iter().map(|collected| collected.entry.size).collect();
            let mut open = |index: usize| -> io::Result<Box<dyn Read>> {
                let collected = members[index];
                reporter.set_current_file(&collected.entry.path);
                Ok(match &collected.link_target {
                    Some(target) => Box::new(Cursor::new(target.clone())),
                    None => Box::new(File::open(&collected.disk_path)?),
                })
            };
            writer.write_run(&sizes, run.lzma2, &mut open, &mut |_, bytes| reporter.advance(bytes), job.cancel)?;
        }
        writer.finish(&entries, encrypt_header)?;
        Ok(())
    };

    let volumes = match options.split_size {
        // 7z sets are numbered even when they fit in one volume.
        Some(split_size) => {
            let mut sink = VolumeSink::new(output_path, split_size);
            if let Err(error) = write_into(&mut sink) {
                sink.discard();
                return Err(error);
            }
            Some(sink.commit()?)
        }
        None => {
            let mut sink = BufWriter::new(File::create(output_path)?);
            write_into(&mut sink)?;
            sink.into_inner().map_err(io::IntoInnerError::into_error)?;
            // Only now that the archive is whole does a set an earlier split
            // run left beside it go.
            remove_stale_volumes(output_path, true);
            None
        }
    };
    reporter.complete();
    Ok(Written { original_size, volumes })
}

/// What the 7z writer writes into: a file, or a set of volumes.
trait SeekWrite: io::Write + io::Seek {}
impl<T: io::Write + io::Seek> SeekWrite for T {}

/// One file of a planned block, as the solid-block dialog lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct PlannedFile {
    pub path: String,
    pub size: u64,
}

/// A stream a 7z write would lay down. A block of one file is a stream to
/// itself rather than a solid block; the dialog counts the two apart.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct SevenZipSolidBlock {
    pub method: SevenZipMethod,
    /// The dictionary every file in the block shares. Copy blocks have none.
    pub dictionary_size: Option<u32>,
    pub entries: Vec<PlannedFile>,
    pub total_bytes: u64,
}

/// The streams a 7z write of `options` would lay down, without writing one.
/// Only files with data reach a stream; folders and empty files never do.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn plan_seven_zip_solid_blocks(options: CompressionOptions) -> Result<Vec<SevenZipSolidBlock>, LiberaError> {
    if options.input_paths.is_empty() {
        return Ok(Vec::new());
    }
    let options = CompressionOptions { format: ArchiveFormat::SevenZip, ..options };
    validate(&options)?;
    let layout = layout(&options, options.level.unwrap_or(DEFAULT_LEVEL))?;
    Ok(layout
        .runs
        .iter()
        .map(|run| {
            let entries: Vec<PlannedFile> = run
                .entries
                .iter()
                .map(|&index| {
                    let entry = &layout.entries[layout.first_with_data + index].entry;
                    PlannedFile { path: entry.path.clone(), size: entry.size }
                })
                .collect();
            SevenZipSolidBlock {
                method: if run.lzma2.is_some() { SevenZipMethod::Lzma2 } else { SevenZipMethod::Copy },
                dictionary_size: run.lzma2.map(|settings| settings.dictionary_size),
                total_bytes: entries.iter().map(|entry| entry.size).sum(),
                entries,
            }
        })
        .collect())
}
