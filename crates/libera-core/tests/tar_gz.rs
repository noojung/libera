use std::fs::{self, File};
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex};

use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use libera_core::{
    ArchiveFormat, CancelToken, CompressionOptions, ExtractionOptions, LiberaError, ProgressData, ProgressListener,
    ProgressPhase, compress_archive, extract_archive,
};
use tempfile::TempDir;

#[derive(Default)]
struct Recorder {
    events: Mutex<Vec<ProgressData>>,
    cancel_on_first: Option<Arc<CancelToken>>,
}

impl Recorder {
    fn cancelling(token: &Arc<CancelToken>) -> Arc<Self> {
        Arc::new(Self { events: Mutex::default(), cancel_on_first: Some(token.clone()) })
    }

    fn events(&self) -> Vec<ProgressData> {
        self.events.lock().unwrap().clone()
    }
}

impl ProgressListener for Recorder {
    fn on_progress(&self, progress: ProgressData) {
        self.events.lock().unwrap().push(progress);
        if let Some(token) = &self.cancel_on_first {
            token.cancel();
        }
    }
}

fn path(path: &Path) -> String {
    path.to_str().unwrap().to_owned()
}

fn compress(inputs: &[&Path], output: &Path) -> Result<libera_core::CompressionResult, LiberaError> {
    compress_archive(
        CompressionOptions {
            input_paths: inputs.iter().map(|input| path(input)).collect(),
            output_path: path(output),
            format: ArchiveFormat::Tgz,
            level: None,
        },
        Arc::new(Recorder::default()),
        CancelToken::new(),
    )
}

fn extract(archive: &Path, target: &Path) -> Result<libera_core::ExtractionResult, LiberaError> {
    extract_archive(
        ExtractionOptions { archive_path: path(archive), target_dir: path(target), reject_existing_target: true },
        Arc::new(Recorder::default()),
        CancelToken::new(),
    )
}

fn stored_paths(archive: &Path) -> Vec<String> {
    let mut archive = tar::Archive::new(GzDecoder::new(File::open(archive).unwrap()));
    archive.entries().unwrap().map(|entry| entry.unwrap().path().unwrap().to_string_lossy().into_owned()).collect()
}

/// Bytes gzip cannot shrink much, so a job over them takes many reads.
fn noise(length: usize) -> Vec<u8> {
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

#[test]
fn round_trips_a_folder_and_a_file() {
    let work = TempDir::new().unwrap();
    let folder = work.path().join("photos");
    fs::create_dir_all(folder.join("2026")).unwrap();
    fs::write(folder.join("notes.txt"), "hello").unwrap();
    fs::write(folder.join("2026/raw.bin"), noise(300_000)).unwrap();
    let single = work.path().join("readme.md");
    fs::write(&single, "# readme").unwrap();
    let archive = work.path().join("out.tgz");

    let listener = Arc::new(Recorder::default());
    let result = compress_archive(
        CompressionOptions {
            input_paths: vec![path(&folder), path(&single)],
            output_path: path(&archive),
            format: ArchiveFormat::Tgz,
            level: Some(9),
        },
        listener.clone(),
        CancelToken::new(),
    )
    .unwrap();

    assert_eq!(result.original_size, 300_000 + 5 + 8);
    assert_eq!(result.compressed_size, fs::metadata(&archive).unwrap().len());
    assert_eq!(
        stored_paths(&archive),
        ["photos/", "photos/2026/", "photos/2026/raw.bin", "photos/notes.txt", "readme.md"]
    );
    let events = listener.events();
    assert_eq!(events.first().unwrap().phase, ProgressPhase::Processing);
    let last = events.last().unwrap();
    assert_eq!(
        (last.phase, last.percent, last.processed_bytes),
        (ProgressPhase::Complete, Some(100), result.original_size)
    );

    let target = work.path().join("unpacked");
    let extracted = extract(&archive, &target).unwrap();
    assert_eq!((extracted.extracted_count, extracted.symbolic_links_excluded), (3, 0));
    assert_eq!(fs::read(target.join("photos/2026/raw.bin")).unwrap(), noise(300_000));
    assert_eq!(fs::read_to_string(target.join("photos/notes.txt")).unwrap(), "hello");
    assert_eq!(fs::read_to_string(target.join("readme.md")).unwrap(), "# readme");
}

#[test]
fn names_same_named_roots_apart() {
    let work = TempDir::new().unwrap();
    for parent in ["a", "b"] {
        fs::create_dir_all(work.path().join(parent).join("src")).unwrap();
    }
    let archive = work.path().join("out.tgz");

    compress(&[&work.path().join("a/src"), &work.path().join("b/src")], &archive).unwrap();

    assert_eq!(stored_paths(&archive), ["src/", "src (2)/"]);
}

#[test]
fn leaves_out_an_archive_saved_inside_its_own_input() {
    let work = TempDir::new().unwrap();
    let folder = work.path().join("docs");
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("a.txt"), "a").unwrap();

    compress(&[&folder], &folder.join("docs.tgz")).unwrap();

    assert_eq!(stored_paths(&folder.join("docs.tgz")), ["docs/", "docs/a.txt"]);
}

#[cfg(unix)]
#[test]
fn stores_links_as_links_and_does_not_restore_them() {
    let work = TempDir::new().unwrap();
    let folder = work.path().join("app");
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("real.txt"), "real").unwrap();
    std::os::unix::fs::symlink("real.txt", folder.join("alias.txt")).unwrap();
    let archive = work.path().join("out.tgz");

    compress(&[&folder], &archive).unwrap();

    let mut reader = tar::Archive::new(GzDecoder::new(File::open(&archive).unwrap()));
    let link = reader
        .entries()
        .unwrap()
        .map(Result::unwrap)
        .find(|entry| entry.path().unwrap().ends_with("alias.txt"))
        .unwrap();
    assert_eq!(link.header().entry_type(), tar::EntryType::Symlink);
    assert_eq!(link.link_name().unwrap().unwrap().to_str(), Some("real.txt"));

    let target = work.path().join("unpacked");
    let extracted = extract(&archive, &target).unwrap();
    assert_eq!((extracted.extracted_count, extracted.symbolic_links_excluded), (1, 1));
    assert!(fs::symlink_metadata(target.join("app/alias.txt")).is_err());
}

#[test]
fn cancelling_before_the_start_writes_nothing() {
    let work = TempDir::new().unwrap();
    fs::write(work.path().join("a.txt"), "a").unwrap();
    let archive = work.path().join("out.tgz");
    let token = CancelToken::new();
    token.cancel();

    let result = compress_archive(
        CompressionOptions {
            input_paths: vec![path(&work.path().join("a.txt"))],
            output_path: path(&archive),
            format: ArchiveFormat::Tgz,
            level: None,
        },
        Arc::new(Recorder::default()),
        token,
    );

    assert!(matches!(result, Err(LiberaError::CompressionCancelled)));
    assert!(!archive.exists());
}

#[test]
fn cancelling_midway_removes_the_partial_archive() {
    let work = TempDir::new().unwrap();
    fs::write(work.path().join("big.bin"), noise(4 << 20)).unwrap();
    let archive = work.path().join("out.tgz");
    let token = CancelToken::new();

    let result = compress_archive(
        CompressionOptions {
            input_paths: vec![path(&work.path().join("big.bin"))],
            output_path: path(&archive),
            format: ArchiveFormat::Tgz,
            level: None,
        },
        Recorder::cancelling(&token),
        token.clone(),
    );

    assert!(matches!(result, Err(LiberaError::CompressionCancelled)));
    assert!(!archive.exists());
}

#[test]
fn cancelling_an_extraction_removes_the_target_it_created() {
    let work = TempDir::new().unwrap();
    fs::write(work.path().join("big.bin"), noise(4 << 20)).unwrap();
    let archive = work.path().join("out.tgz");
    compress(&[&work.path().join("big.bin")], &archive).unwrap();
    let target = work.path().join("unpacked");
    let token = CancelToken::new();

    let result = extract_archive(
        ExtractionOptions { archive_path: path(&archive), target_dir: path(&target), reject_existing_target: true },
        Recorder::cancelling(&token),
        token.clone(),
    );

    assert!(matches!(result, Err(LiberaError::ExtractionCancelled)));
    assert!(!target.exists());
}

#[test]
fn refuses_an_existing_target_when_asked_to_create_one() {
    let work = TempDir::new().unwrap();
    fs::write(work.path().join("a.txt"), "a").unwrap();
    let archive = work.path().join("out.tgz");
    compress(&[&work.path().join("a.txt")], &archive).unwrap();
    fs::create_dir(work.path().join("taken")).unwrap();

    let result = extract(&archive, &work.path().join("taken"));

    assert!(matches!(result, Err(LiberaError::DestinationExists { .. })));
}

/// A one-entry tar.gz whose entry name is written raw, since the tar crate's
/// own builder refuses the names these tests need.
fn archive_with_entry_named(archive: &Path, name: &[u8]) {
    let mut header = tar::Header::new_old();
    header.as_old_mut().name[..name.len()].copy_from_slice(name);
    header.set_mode(0o644);
    header.set_size(4);
    header.set_entry_type(tar::EntryType::Regular);
    header.set_cksum();
    let mut builder = tar::Builder::new(GzEncoder::new(File::create(archive).unwrap(), Compression::default()));
    builder.append(&header, &b"evil"[..]).unwrap();
    builder.into_inner().unwrap().finish().unwrap();
}

#[test]
fn refuses_entries_that_reach_outside_the_target() {
    let work = TempDir::new().unwrap();
    let escape = work.path().join("escaped.txt");
    let absolute = format!("{}", escape.display());

    for name in [b"../escaped.txt".as_slice(), absolute.as_bytes()] {
        let archive = work.path().join("evil.tgz");
        archive_with_entry_named(&archive, name);
        let target = work.path().join("unpacked");

        let result = extract(&archive, &target);

        assert!(matches!(result, Err(LiberaError::UnsafeArchive { .. })), "{}", String::from_utf8_lossy(name));
        assert!(!escape.exists());
        assert!(!target.exists());
    }
}

#[test]
fn round_trips_through_the_system_tar() {
    let work = TempDir::new().unwrap();
    let folder = work.path().join("site");
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("index.html"), "<p>hi</p>").unwrap();
    let archive = work.path().join("site.tgz");
    compress(&[&folder], &archive).unwrap();

    let listed = std::process::Command::new("tar").arg("-tzf").arg(&archive).output().unwrap();

    assert!(listed.status.success());
    let mut names = String::new();
    listed.stdout.as_slice().read_to_string(&mut names).unwrap();
    assert_eq!(names.lines().collect::<Vec<_>>(), ["site/", "site/index.html"]);
}
