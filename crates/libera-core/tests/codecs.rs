//! Every codec the engine reads, around a tarball and on its own.

mod common;

use std::fs;
use std::io::Write;

use common::*;
use libera_core::LiberaError;
use lzma_rust2::{CheckType, XzOptions, XzWriter};

fn xz_with(bytes: &[u8], check_type: CheckType) -> Vec<u8> {
    let mut options = XzOptions::with_preset(6);
    options.check_type = check_type;
    let mut writer = XzWriter::new(Vec::new(), options).unwrap();
    writer.write_all(bytes).unwrap();
    writer.finish().unwrap()
}

fn xz(bytes: &[u8]) -> Vec<u8> {
    xz_with(bytes, CheckType::Crc64)
}

fn bzip2(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = ::bzip2::write::BzEncoder::new(Vec::new(), ::bzip2::Compression::best());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

fn zstd(bytes: &[u8]) -> Vec<u8> {
    ::zstd::encode_all(bytes, 3).unwrap()
}

/// A suffix the readers know, with an encoder for the codec it names.
type Encoding = (&'static str, fn(&[u8]) -> Vec<u8>);

fn encoders() -> Vec<Encoding> {
    vec![
        ("tar.gz", gzip),
        ("tgz", gzip),
        ("tar.xz", xz),
        ("txz", xz),
        ("tar.bz2", bzip2),
        ("tbz2", bzip2),
        ("tbz", bzip2),
        ("tar.zst", zstd),
        ("tzst", zstd),
    ]
}

fn stream_encoders() -> Vec<Encoding> {
    vec![("gz", gzip), ("xz", xz), ("bz2", bzip2), ("zst", zstd)]
}

fn sample_tar() -> Vec<u8> {
    tar_bytes(&[
        TarEntry::Folder("pkg/"),
        TarEntry::File("pkg/readme.txt", b"hello from inside"),
        TarEntry::File("pkg/data.bin", &noise(300_000)),
    ])
}

#[test]
fn extracts_every_entry_of_a_wrapped_tarball_byte_for_byte() {
    for (suffix, encode) in encoders() {
        let work = TempDir::new().unwrap();
        let archive = work.path().join(format!("archive.{suffix}"));
        fs::write(&archive, encode(&sample_tar())).unwrap();
        let target = work.path().join("output");

        let result = extract(extraction(&archive, &target)).unwrap_or_else(|error| panic!("{suffix}: {error}"));

        assert_eq!(result.extracted_count, 2, "{suffix}");
        assert_eq!(read(&target, "pkg/readme.txt"), "hello from inside", "{suffix}");
        assert_eq!(fs::read(target.join("pkg/data.bin")).unwrap(), noise(300_000), "{suffix}");
    }
}

/// The archive with its last tenth cut off, which no codec should mistake for
/// a shorter archive.
fn truncated(bytes: &[u8]) -> Vec<u8> {
    bytes[..bytes.len() * 9 / 10].to_vec()
}

#[test]
fn reports_a_damaged_tarball_rather_than_handing_back_what_it_decoded_so_far() {
    for (suffix, encode) in encoders() {
        let work = TempDir::new().unwrap();
        let archive = work.path().join(format!("archive.{suffix}"));
        fs::write(&archive, truncated(&encode(&sample_tar()))).unwrap();
        let target = work.path().join("output");

        let result = extract(extraction(&archive, &target));

        assert!(result.is_err(), "{suffix}: {result:?}");
        assert!(!target.exists(), "{suffix}");
    }
}

#[test]
fn extracts_the_lone_file_of_a_codec_stream_byte_for_byte() {
    for (suffix, encode) in stream_encoders() {
        let work = TempDir::new().unwrap();
        let archive = work.path().join(format!("report.txt.{}", suffix.to_uppercase()));
        fs::write(&archive, encode(&noise(200_000))).unwrap();
        let target = work.path().join("output");
        let listener = Recorder::new();

        let result = extract_reporting(extraction(&archive, &target), listener.clone()).unwrap();

        assert_eq!(result.extracted_count, 1, "{suffix}");
        assert_eq!(tree(&target), ["report.txt"], "{suffix}");
        assert_eq!(fs::read(target.join("report.txt")).unwrap(), noise(200_000), "{suffix}");
        // The stream records no expanded size, so only the end has a percentage.
        let events = listener.events();
        assert!(events[..events.len() - 1].iter().all(|event| event.total_bytes.is_none() && event.percent.is_none()));
        assert_eq!(listener.last().percent, Some(100));
    }
}

#[test]
fn reports_a_damaged_codec_stream_and_leaves_nothing_behind() {
    for (suffix, encode) in stream_encoders() {
        let work = TempDir::new().unwrap();
        let archive = work.path().join(format!("report.txt.{suffix}"));
        fs::write(&archive, truncated(&encode(&noise(200_000)))).unwrap();
        let target = work.path().join("output");

        let result = extract(extraction(&archive, &target));

        assert!(matches!(result, Err(LiberaError::CorruptArchive { .. })), "{suffix}: {result:?}");
        assert!(!target.exists(), "{suffix}");
    }
}

#[test]
fn reads_streams_concatenated_into_one_file() {
    for (suffix, encode) in stream_encoders() {
        let work = TempDir::new().unwrap();
        let archive = work.path().join(format!("joined.txt.{suffix}"));
        let mut joined = encode(b"first half, ");
        joined.extend(encode(b"second half"));
        fs::write(&archive, joined).unwrap();
        let target = work.path().join("output");

        extract(extraction(&archive, &target)).unwrap_or_else(|error| panic!("{suffix}: {error}"));

        assert_eq!(read(&target, "joined.txt"), "first half, second half", "{suffix}");
    }
}

#[test]
fn reads_an_xz_stream_under_every_integrity_check() {
    for check_type in [CheckType::None, CheckType::Crc32, CheckType::Crc64, CheckType::Sha256] {
        let work = TempDir::new().unwrap();
        let archive = work.path().join("checked.bin.xz");
        fs::write(&archive, xz_with(&noise(100_000), check_type)).unwrap();
        let target = work.path().join("output");

        extract(extraction(&archive, &target)).unwrap_or_else(|error| panic!("{check_type:?}: {error}"));

        assert_eq!(fs::read(target.join("checked.bin")).unwrap(), noise(100_000), "{check_type:?}");
    }
}

#[test]
fn rejects_an_xz_block_whose_check_does_not_match() {
    let work = TempDir::new().unwrap();
    let mut bytes = xz_with(b"payload that the check covers", CheckType::Crc32);
    // The footer records the index's size, and the block's CRC32 sits right
    // before the index; flip the check's first byte.
    let footer = bytes.len() - 12;
    let backward_size = u32::from_le_bytes(bytes[footer + 4..footer + 8].try_into().unwrap());
    let index_start = footer - (backward_size as usize + 1) * 4;
    bytes[index_start - 4] ^= 0xff;
    let archive = work.path().join("damaged.txt.xz");
    fs::write(&archive, bytes).unwrap();

    let result = extract(extraction(&archive, &work.path().join("output")));

    assert!(matches!(result, Err(LiberaError::CorruptArchive { .. })), "{result:?}");
}

#[test]
fn reads_a_tarball_whatever_its_suffix_says_about_the_codec() {
    let work = TempDir::new().unwrap();
    let plain = work.path().join("plain-really.tgz");
    fs::write(&plain, sample_tar()).unwrap();
    let gzipped = work.path().join("gzipped-really.tar");
    fs::write(&gzipped, gzip(&sample_tar())).unwrap();

    for archive in [plain, gzipped] {
        let target = work.path().join(archive.file_stem().unwrap());
        extract(extraction(&archive, &target)).unwrap();
        assert_eq!(read(&target, "pkg/readme.txt"), "hello from inside");
    }
}

#[test]
fn reads_the_tarballs_the_system_tar_writes() {
    let work = TempDir::new().unwrap();
    let source = work.path().join("source");
    write_file(&source, "docs/readme.md", "# readme");
    write_file(&source, "bin/data.bin", noise(50_000));
    for (flag, suffix) in [("-cf", "tar"), ("-czf", "tar.gz"), ("-cjf", "tar.bz2"), ("-cJf", "tar.xz")] {
        let archive = work.path().join(format!("system.{suffix}"));
        system_tar(&[flag, &path(&archive), "docs", "bin"], &source);
        let target = work.path().join(format!("output-{suffix}"));

        extract(extraction(&archive, &target)).unwrap_or_else(|error| panic!("{suffix}: {error}"));

        assert_eq!(read(&target, "docs/readme.md"), "# readme", "{suffix}");
        assert_eq!(fs::read(target.join("bin/data.bin")).unwrap(), noise(50_000), "{suffix}");
    }
}
