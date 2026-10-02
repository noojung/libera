use std::fs::{self, File, Metadata};
use std::io;
use std::path::Path;
use std::time::UNIX_EPOCH;

use super::{Job, Written};
use crate::LiberaError;
use crate::codec::ZstdTuning;
use crate::deflate::{DeflateStrategy, DeflateTuning};
use crate::inputs::{InputEntry, InputKind, OwnOutput, collect_inputs};
use crate::progress::{CancelToken, Reporter, Tracked};
use crate::zip::crypto::AesStrength;
use crate::zip::format::S_IFLNK;
use crate::zip::methods::MethodRules;
use crate::zip::volumes::{FileSink, MAX_SPLIT_VOLUMES, Sink, SplitSink, remove_stale_volumes};
use crate::zip::write::{EntryEncryption, EntryMethod, ZipWriter};
use crate::zip::{ZipEncryptionMethod, ZipMethod};

/// Decides each entry's method from the archive's settings and the per-file
/// rules, the way the Electron engine's writer did.
struct MethodPlanner {
    default: ZipMethod,
    level: u8,
    rules: MethodRules,
    deflate_strategy: Option<DeflateStrategy>,
    mem_level: Option<u8>,
    zstd: ZstdTuning,
}

impl MethodPlanner {
    fn method_for(&self, source: &Path) -> EntryMethod {
        let resolved = self.rules.resolve(source, self.default);
        let (method, level) = if resolved.explicit {
            // A rule that names a method compresses even in a level 0 archive.
            let level =
                if resolved.method == ZipMethod::Store { 0 } else { resolved.level.unwrap_or(self.level.max(1)) };
            (resolved.method, level)
        } else {
            (self.default, self.level)
        };
        // Level 0 is Store, whatever method the archive otherwise uses.
        if level == 0 {
            return EntryMethod::Store;
        }
        match method {
            ZipMethod::Store => EntryMethod::Store,
            ZipMethod::Deflate => EntryMethod::Deflate(DeflateTuning::new(
                level,
                resolved.deflate_strategy.or(self.deflate_strategy),
                resolved.mem_level.or(self.mem_level),
            )),
            ZipMethod::Lzma => EntryMethod::Lzma(level),
            ZipMethod::Zstd => EntryMethod::Zstd(level, self.zstd),
        }
    }
}

/// A file that vanished or cannot be read since the walk found it is left out
/// rather than failing the archive, as the Electron engine's ZIP writer did.
fn is_skippable(error: &io::Error) -> bool {
    matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied)
}

/// The Unix mode an entry records, type bits included, since readers tell a
/// link entry by its type alone.
fn unix_mode(metadata: &Metadata) -> u32 {
    #[cfg(unix)]
    {
        std::os::unix::fs::PermissionsExt::mode(&metadata.permissions()) & 0xffff
    }
    #[cfg(not(unix))]
    {
        if metadata.is_dir() { 0o040_755 } else { 0o100_644 }
    }
}

pub(super) fn write(job: &Job) -> Result<Written, LiberaError> {
    let options = job.options;
    let output_path = Path::new(&options.output_path);
    // Before the walk, so last run's volumes are neither counted nor swept in.
    if options.split_size.is_some() {
        remove_stale_volumes(output_path);
    }
    let own_output =
        if options.split_size.is_some() { OwnOutput::split_set(output_path)? } else { OwnOutput::file(output_path)? };
    let entries = collect_inputs(&options.input_paths, &own_output, &options.filters())?;
    let original_size: u64 = entries.iter().map(|entry| entry.size).sum();
    if job.cancel.is_cancelled() {
        return Err(LiberaError::CompressionCancelled);
    }

    let planner = MethodPlanner {
        default: options.zip_method.unwrap_or_default(),
        level: job.level,
        rules: MethodRules::new(options.zip_method_overrides.as_deref().unwrap_or_default()),
        deflate_strategy: options.deflate_strategy,
        mem_level: options.mem_level,
        zstd: options.zstd(),
    };
    let encryption = match options.password.as_deref().filter(|password| !password.is_empty()) {
        None => EntryEncryption::None,
        Some(password) => match options.encryption_method.unwrap_or_default() {
            ZipEncryptionMethod::ZipCrypto => EntryEncryption::ZipCrypto(password.to_owned()),
            ZipEncryptionMethod::Aes128 => EntryEncryption::Aes(AesStrength::Aes128, password.to_owned()),
            ZipEncryptionMethod::Aes256 => EntryEncryption::Aes(AesStrength::Aes256, password.to_owned()),
        },
    };
    let reporter = Reporter::new(job.listener.clone(), Some(original_size));
    let write = |sink: &mut dyn Sink, spanning: bool| -> Result<(), LiberaError> {
        let mut writer = ZipWriter::new(sink, spanning)?;
        write_entries(&mut writer, &entries, &planner, &encryption, &reporter, job.cancel)?;
        writer.finish()?;
        Ok(())
    };

    // A set that fits in one volume is written as an ordinary archive: a lone
    // volume would open with the spanning marker, which strict readers -
    // this one included - take for data put in front of the archive.
    let volumes = match options.split_size {
        Some(split_size) if original_size > split_size => {
            if original_size.div_ceil(split_size) + 1 > u64::from(MAX_SPLIT_VOLUMES) {
                return Err(LiberaError::SplitTooManyVolumes {
                    message: "The split size produces too many volumes.".into(),
                });
            }
            let mut sink = SplitSink::new(output_path, split_size);
            if let Err(error) = write(&mut sink, true) {
                for volume in sink.volumes() {
                    let _ = fs::remove_file(volume);
                }
                return Err(error);
            }
            Some(sink.finish()?)
        }
        _ => {
            let mut sink = FileSink::create(output_path)?;
            write(&mut sink, false)?;
            sink.finish()?;
            None
        }
    };
    reporter.complete();
    Ok(Written { original_size, volumes })
}

fn write_entries<S: Sink>(
    writer: &mut ZipWriter<S>,
    entries: &[InputEntry],
    planner: &MethodPlanner,
    encryption: &EntryEncryption,
    reporter: &Reporter,
    cancel: &CancelToken,
) -> Result<(), LiberaError> {
    for entry in entries {
        if cancel.is_cancelled() {
            return Err(LiberaError::CompressionCancelled);
        }
        reporter.set_current_file(&entry.stored_path);
        let metadata = match fs::symlink_metadata(&entry.disk_path) {
            Ok(metadata) => metadata,
            Err(error) if is_skippable(&error) => continue,
            Err(error) => return Err(error.into()),
        };
        let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
        let mode = unix_mode(&metadata);
        match entry.kind {
            InputKind::Directory => writer.add_directory(&entry.stored_path, modified, mode)?,
            InputKind::Symlink => {
                let target = match fs::read_link(&entry.disk_path) {
                    Ok(target) => target,
                    Err(error) if is_skippable(&error) => continue,
                    Err(error) => return Err(error.into()),
                };
                let permissions = if mode & 0o7777 == 0 { 0o777 } else { mode & 0o7777 };
                let target = target.to_string_lossy();
                writer.add_symlink(
                    &entry.stored_path,
                    modified,
                    S_IFLNK | permissions,
                    target.as_bytes(),
                    encryption,
                    cancel,
                )?;
            }
            InputKind::File => {
                let file = match File::open(&entry.disk_path) {
                    Ok(file) => file,
                    Err(error) if is_skippable(&error) => {
                        reporter.advance(entry.size);
                        continue;
                    }
                    Err(error) => return Err(error.into()),
                };
                let method = planner.method_for(&entry.disk_path);
                let mut content = Tracked::new(file, reporter, cancel);
                writer.add_file(
                    &entry.stored_path,
                    modified,
                    mode,
                    method,
                    encryption,
                    &mut content,
                    entry.size,
                    cancel,
                )?;
            }
        }
    }
    Ok(())
}
