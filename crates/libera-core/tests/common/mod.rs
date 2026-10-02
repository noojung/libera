//! What every test suite shares: a listener that records what it is told, and
//! quick ways to run a job and to build the archives the tests need.
#![allow(dead_code)]

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use flate2::Compression;
use flate2::write::GzEncoder;
use libera_core::{
    ArchiveFormat, CancelToken, CompressionOptions, CompressionResult, ExtractionContext, ExtractionOptions,
    ExtractionResult, LiberaError, ProgressData, ProgressListener, compress_archive, extract_archive_with,
};
pub use tempfile::TempDir;

#[derive(Default)]
pub struct Recorder {
    events: Mutex<Vec<ProgressData>>,
    /// Cancelled at the first report that has seen any bytes.
    cancel_on_progress: Option<Arc<CancelToken>>,
}

impl Recorder {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn cancelling(token: &Arc<CancelToken>) -> Arc<Self> {
        Arc::new(Self { events: Mutex::default(), cancel_on_progress: Some(token.clone()) })
    }

    pub fn events(&self) -> Vec<ProgressData> {
        self.events.lock().unwrap().clone()
    }

    pub fn last(&self) -> ProgressData {
        self.events().last().cloned().expect("no progress was reported")
    }
}

impl ProgressListener for Recorder {
    fn on_progress(&self, progress: ProgressData) {
        let seen_bytes = progress.processed_bytes > 0;
        self.events.lock().unwrap().push(progress);
        if let Some(token) = self.cancel_on_progress.as_ref().filter(|_| seen_bytes) {
            token.cancel();
        }
    }
}

pub fn path(path: &Path) -> String {
    path.to_str().unwrap().to_owned()
}

/// Bytes no codec can shrink much, so a job over them takes many reads.
pub fn noise(length: usize) -> Vec<u8> {
    let mut state = 0x2545_f491_4f6c_dd1d_u64;
    (0..length)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state as u8
        })
        .collect()
}

/// Writes `contents` at `relative` under `root`, creating the folders above it.
pub fn write_file(root: &Path, relative: &str, contents: impl AsRef<[u8]>) -> PathBuf {
    let file = root.join(relative);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, contents).unwrap();
    file
}

pub fn read(root: &Path, relative: &str) -> String {
    fs::read_to_string(root.join(relative)).unwrap_or_else(|error| panic!("{relative}: {error}"))
}

pub fn options(inputs: &[&Path], output: &Path, format: ArchiveFormat) -> CompressionOptions {
    CompressionOptions::new(inputs.iter().map(|input| path(input)).collect(), path(output), format)
}

pub fn compress(options: CompressionOptions) -> Result<CompressionResult, LiberaError> {
    compress_archive(options, Recorder::new(), CancelToken::new())
}

pub fn extraction(archive: &Path, target: &Path) -> ExtractionOptions {
    ExtractionOptions::new(path(archive), path(target))
}

/// Room enough for any test archive, so a full disk on the machine running
/// the tests does not fail them.
pub fn roomy() -> ExtractionContext {
    ExtractionContext { available_bytes: Some(1 << 40), ..ExtractionContext::default() }
}

pub fn extract(options: ExtractionOptions) -> Result<ExtractionResult, LiberaError> {
    extract_archive_with(options, Recorder::new(), CancelToken::new(), roomy())
}

pub fn extract_reporting(options: ExtractionOptions, listener: Arc<Recorder>) -> Result<ExtractionResult, LiberaError> {
    extract_archive_with(options, listener, CancelToken::new(), roomy())
}

/// Every name below `root`, `/`-separated and sorted, folders marked with a
/// trailing slash.
pub fn tree(root: &Path) -> Vec<String> {
    fn walk(root: &Path, folder: &Path, names: &mut Vec<String>) {
        for child in fs::read_dir(folder).unwrap() {
            let child = child.unwrap().path();
            let relative = child.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            let metadata = fs::symlink_metadata(&child).unwrap();
            if metadata.is_dir() {
                names.push(format!("{relative}/"));
                walk(root, &child, names);
            } else {
                names.push(relative);
            }
        }
    }
    let mut names = Vec::new();
    if root.exists() {
        walk(root, root, &mut names);
    }
    names.sort();
    names
}

/// One entry of a hand-built tar.
pub enum TarEntry<'a> {
    File(&'a str, &'a [u8]),
    Folder(&'a str),
    Symlink(&'a str, &'a str),
    HardLink(&'a str, &'a str),
    /// A name written straight into the header, past the tar crate's checks.
    RawFile(&'a [u8], &'a [u8]),
}

pub fn tar_bytes(entries: &[TarEntry]) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    for entry in entries {
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o644);
        header.set_mtime(1_700_000_000);
        match entry {
            TarEntry::File(name, contents) => {
                header.set_size(contents.len() as u64);
                header.set_entry_type(tar::EntryType::Regular);
                builder.append_data(&mut header, name, *contents).unwrap();
            }
            TarEntry::Folder(name) => {
                header.set_mode(0o755);
                header.set_size(0);
                header.set_entry_type(tar::EntryType::Directory);
                builder.append_data(&mut header, name, std::io::empty()).unwrap();
            }
            TarEntry::Symlink(name, target) | TarEntry::HardLink(name, target) => {
                header.set_size(0);
                header.set_entry_type(if matches!(entry, TarEntry::Symlink(..)) {
                    tar::EntryType::Symlink
                } else {
                    tar::EntryType::Link
                });
                builder.append_link(&mut header, name, target).unwrap();
            }
            TarEntry::RawFile(name, contents) => {
                let mut header = tar::Header::new_old();
                header.as_old_mut().name[..name.len()].copy_from_slice(name);
                header.set_mode(0o644);
                header.set_size(contents.len() as u64);
                header.set_entry_type(tar::EntryType::Regular);
                header.set_cksum();
                builder.append(&header, *contents).unwrap();
            }
        }
    }
    builder.into_inner().unwrap()
}

pub fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

pub fn write_tar(archive: &Path, entries: &[TarEntry]) {
    let bytes = tar_bytes(entries);
    let lower = archive.to_string_lossy().to_lowercase();
    let bytes = if lower.ends_with(".tgz") || lower.ends_with(".tar.gz") { gzip(&bytes) } else { bytes };
    File::create(archive).unwrap().write_all(&bytes).unwrap();
}

/// The paths a tar holds, in order, read back with the tar crate.
pub fn tar_paths(bytes: &[u8]) -> Vec<String> {
    let mut archive = tar::Archive::new(bytes);
    archive.entries().unwrap().map(|entry| entry.unwrap().path().unwrap().to_string_lossy().into_owned()).collect()
}

/// Runs the system `tar`, which on macOS is bsdtar with libarchive behind it.
/// macOS's copy also writes a `._name` entry for every file carrying extended
/// attributes, which these tests leave out.
pub fn system_tar(args: &[&str], cwd: &Path) -> String {
    let output =
        std::process::Command::new("tar").args(args).env("COPYFILE_DISABLE", "1").current_dir(cwd).output().unwrap();
    assert!(output.status.success(), "tar {args:?}: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap()
}
