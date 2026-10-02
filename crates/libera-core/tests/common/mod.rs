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

/// One entry of a hand-built ZIP, stored rather than compressed, so a test
/// can write what no well-behaved writer would.
pub struct RawZipEntry<'a> {
    pub name: &'a [u8],
    pub data: &'a [u8],
    /// The Unix mode for the high half of the external attributes.
    pub unix_mode: Option<u32>,
    pub flags: u16,
}

impl<'a> RawZipEntry<'a> {
    pub fn file(name: &'a str, data: &'a [u8]) -> Self {
        Self { name: name.as_bytes(), data, unix_mode: Some(0o100_644), flags: 0 }
    }

    pub fn with_mode(mut self, unix_mode: Option<u32>) -> Self {
        self.unix_mode = unix_mode;
        self
    }
}

/// A ZIP of stored entries, laid out the ordinary way. `duplicate_first`
/// adds a second central record pointing at the first entry's data, the
/// shape of an overlapping-entry zip bomb.
pub fn raw_zip(entries: &[RawZipEntry], duplicate_first: Option<&str>) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut central = Vec::new();
    let mut records = 0u16;
    let mut central_record = |name: &[u8], entry: &RawZipEntry, offset: u32, crc: u32, central: &mut Vec<u8>| {
        let made_by: u16 = if entry.unix_mode.is_some() { (3 << 8) | 30 } else { 20 };
        central.extend(0x0201_4b50u32.to_le_bytes());
        central.extend(made_by.to_le_bytes());
        central.extend(20u16.to_le_bytes());
        central.extend(entry.flags.to_le_bytes());
        central.extend(0u16.to_le_bytes());
        central.extend([0, 0, 0x21, 0]);
        central.extend(crc.to_le_bytes());
        central.extend((entry.data.len() as u32).to_le_bytes());
        central.extend((entry.data.len() as u32).to_le_bytes());
        central.extend((name.len() as u16).to_le_bytes());
        central.extend([0; 8]);
        central.extend((entry.unix_mode.unwrap_or(0) << 16).to_le_bytes());
        central.extend(offset.to_le_bytes());
        central.extend(name);
        records += 1;
    };
    let mut first = None;
    for entry in entries {
        let offset = bytes.len() as u32;
        let crc = crc32fast::hash(entry.data);
        bytes.extend(0x0403_4b50u32.to_le_bytes());
        bytes.extend(20u16.to_le_bytes());
        bytes.extend(entry.flags.to_le_bytes());
        bytes.extend(0u16.to_le_bytes());
        bytes.extend([0, 0, 0x21, 0]);
        bytes.extend(crc.to_le_bytes());
        bytes.extend((entry.data.len() as u32).to_le_bytes());
        bytes.extend((entry.data.len() as u32).to_le_bytes());
        bytes.extend((entry.name.len() as u16).to_le_bytes());
        bytes.extend(0u16.to_le_bytes());
        bytes.extend(entry.name);
        bytes.extend(entry.data);
        central_record(entry.name, entry, offset, crc, &mut central);
        first.get_or_insert((entry, offset, crc));
    }
    if let (Some(name), Some((entry, offset, crc))) = (duplicate_first, first) {
        central_record(name.as_bytes(), entry, offset, crc, &mut central);
    }
    let central_offset = bytes.len() as u32;
    bytes.extend(&central);
    bytes.extend(0x0605_4b50u32.to_le_bytes());
    bytes.extend([0; 4]);
    bytes.extend(records.to_le_bytes());
    bytes.extend(records.to_le_bytes());
    bytes.extend((central.len() as u32).to_le_bytes());
    bytes.extend(central_offset.to_le_bytes());
    bytes.extend(0u16.to_le_bytes());
    bytes
}

/// One central directory record, as a test reads it back.
#[derive(Debug, Clone)]
pub struct Listed {
    pub name: String,
    pub flags: u16,
    /// The method field, which is 99 for an AES entry.
    pub method: u16,
    /// The real method under AES, from its extra field.
    pub aes_method: Option<u16>,
    pub aes_strength: Option<u8>,
    pub compressed_size: u64,
    pub external_attributes: u32,
}

impl Listed {
    pub fn real_method(&self) -> u16 {
        self.aes_method.unwrap_or(self.method)
    }
}

/// The central directory of a single-volume ZIP without Zip64.
pub fn zip_listing(archive: &Path) -> Vec<Listed> {
    let bytes = fs::read(archive).unwrap();
    let end = (0..=bytes.len() - 22).rev().find(|&at| bytes[at..at + 4] == 0x0605_4b50u32.to_le_bytes()).unwrap();
    let u16_at = |at: usize| u16::from_le_bytes([bytes[at], bytes[at + 1]]);
    let u32_at = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
    let count = u16_at(end + 10);
    let mut at = u32_at(end + 16) as usize;
    let mut listed = Vec::new();
    for _ in 0..count {
        let name_length = u16_at(at + 28) as usize;
        let extra_length = u16_at(at + 30) as usize;
        let comment_length = u16_at(at + 32) as usize;
        let name = String::from_utf8_lossy(&bytes[at + 46..at + 46 + name_length]).into_owned();
        let extra = &bytes[at + 46 + name_length..at + 46 + name_length + extra_length];
        let (mut aes_method, mut aes_strength) = (None, None);
        let mut field = 0;
        while field + 4 <= extra.len() {
            let id = u16::from_le_bytes([extra[field], extra[field + 1]]);
            let length = u16::from_le_bytes([extra[field + 2], extra[field + 3]]) as usize;
            if id == 0x9901 {
                aes_strength = Some(extra[field + 8]);
                aes_method = Some(u16::from_le_bytes([extra[field + 9], extra[field + 10]]));
            }
            field += 4 + length;
        }
        listed.push(Listed {
            name,
            flags: u16_at(at + 8),
            method: u16_at(at + 10),
            aes_method,
            aes_strength,
            compressed_size: u64::from(u32_at(at + 20)),
            external_attributes: u32_at(at + 38),
        });
        at += 46 + name_length + extra_length + comment_length;
    }
    listed
}

/// The listing as name → real method, directories left out.
pub fn methods_by_name(archive: &Path) -> std::collections::BTreeMap<String, u16> {
    zip_listing(archive)
        .into_iter()
        .filter(|entry| !entry.name.ends_with('/'))
        .map(|entry| (entry.name.rsplit('/').next().unwrap().to_owned(), entry.real_method()))
        .collect()
}

pub fn base64(text: &str) -> Vec<u8> {
    let value = |byte: u8| match byte {
        b'A'..=b'Z' => byte - b'A',
        b'a'..=b'z' => byte - b'a' + 26,
        b'0'..=b'9' => byte - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => panic!("not base64: {byte}"),
    };
    let digits: Vec<u8> = text.bytes().filter(|&byte| byte != b'=').map(value).collect();
    digits
        .chunks(4)
        .flat_map(|chunk| {
            let bits = chunk
                .iter()
                .enumerate()
                .fold(0u32, |bits, (index, &digit)| bits | (u32::from(digit) << (18 - 6 * index)));
            let bytes = bits.to_be_bytes();
            bytes[1..chunk.len()].to_vec()
        })
        .collect()
}

/// Runs a system tool, failing the test with its error output if it fails.
pub fn run(program: &str, args: &[&str], cwd: &Path) -> String {
    let output = std::process::Command::new(program).args(args).current_dir(cwd).output().unwrap();
    assert!(
        output.status.success(),
        "{program} {args:?}: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}
