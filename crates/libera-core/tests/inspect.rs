//! The inspector's listing and the previews it hands out, for every format.

mod common;
#[allow(dead_code)]
mod fixtures {
    pub mod seven_zip;
}

use std::fs;
use std::path::Path;
use std::sync::Arc;

use common::*;
use fixtures::seven_zip;
use libera_core::{
    ArchiveFormat, ArchiveInspection, ArchivePreview, CancelToken, CompressionOptions, ImageType, LiberaError,
    MIN_SPLIT_SIZE, TextEncoding, ZipEncryptionMethod, inspect_archive, preview_archive_entry,
};

fn inspect(archive: &Path) -> Result<ArchiveInspection, LiberaError> {
    inspect_archive(path(archive), None, CancelToken::new())
}

fn preview(archive: &Path, index: u64) -> Result<ArchivePreview, LiberaError> {
    preview_archive_entry(path(archive), index, None, false, CancelToken::new())
}

fn index_of(inspection: &ArchiveInspection, entry_path: &str) -> u64 {
    inspection.entries.iter().find(|entry| entry.path == entry_path).unwrap_or_else(|| panic!("{entry_path}")).index
}

fn text(preview: ArchivePreview) -> (String, bool) {
    match preview {
        ArchivePreview::Text { text, truncated, .. } => (text, truncated),
        other => panic!("not text: {other:?}"),
    }
}

/// A PNG as far as the preview reads one: the signature and the IHDR chunk.
fn png(width: u32, height: u32, padding: usize) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
    bytes.extend(width.to_be_bytes());
    bytes.extend(height.to_be_bytes());
    bytes.extend(vec![0; padding]);
    bytes
}

#[test]
fn reports_zip_entry_metadata_and_password_protection() {
    let work = TempDir::new().unwrap();
    let contents = "secret contents\n".repeat(100);
    let input = write_file(work.path(), "secret.txt", &contents);
    let archive = work.path().join("secret.zip");
    compress(CompressionOptions {
        password: Some("password".into()),
        ..options(&[&input], &archive, ArchiveFormat::Zip)
    })
    .unwrap();

    let result = inspect(&archive).unwrap();

    assert_eq!(result.format, "ZIP");
    assert!(result.password_protected);
    assert_eq!((result.total_files, result.total_uncompressed_size), (1, Some(contents.len() as u64)));
    let entry = &result.entries[0];
    assert_eq!((entry.path.as_str(), entry.name.as_str(), entry.is_directory), ("secret.txt", "secret.txt", false));
    assert_eq!(entry.size, Some(contents.len() as u64));
    assert_eq!(entry.codec.as_deref(), Some("Deflate"));
    assert_eq!(entry.encryption_method, "ZipCrypto");
    assert_eq!(entry.crc32, Some(crc32fast::hash(contents.as_bytes())));
    assert_eq!(entry.offset, Some(0));
    assert!(result.header.signature.as_deref().unwrap().ends_with("(ZIP)"));
    assert_eq!(result.header.encryption_algorithm.as_deref(), Some("ZipCrypto"));
    assert!(result.header.central_directory_offset.unwrap() > 0);
    assert!(result.header.central_directory_size.unwrap() > 0);
    assert_eq!(result.total_compressed_size, fs::metadata(&archive).unwrap().len());
}

#[test]
fn names_aes_and_reports_jar_and_war_as_their_own_formats() {
    let work = TempDir::new().unwrap();
    let input = write_file(work.path(), "a.txt", "aes");
    let archive = work.path().join("aes.zip");
    compress(CompressionOptions {
        password: Some("pw".into()),
        encryption_method: Some(ZipEncryptionMethod::Aes256),
        ..options(&[&input], &archive, ArchiveFormat::Zip)
    })
    .unwrap();
    assert_eq!(inspect(&archive).unwrap().entries[0].encryption_method, "AES-256");

    for (name, label) in [("library.jar", "JAR"), ("webapp.war", "WAR")] {
        let jar = work.path().join(name);
        fs::write(&jar, raw_zip(&[RawZipEntry::file("META-INF/MANIFEST.MF", b"Manifest-Version: 1.0\n")], None))
            .unwrap();
        let result = inspect(&jar).unwrap();
        assert_eq!((result.format.as_str(), result.password_protected), (label, false));
    }
}

#[test]
fn reports_tarballs_by_their_wrapping() {
    for (name, expected) in [("archive.tar", "TAR"), ("archive.tgz", "TAR.GZ"), ("archive.tar.gz", "TAR.GZ")] {
        let work = TempDir::new().unwrap();
        let archive = work.path().join(name);
        write_tar(&archive, &[TarEntry::Folder("docs/"), TarEntry::File("docs/guide.txt", b"guide")]);

        let result = inspect(&archive).unwrap();

        assert_eq!(result.format, expected, "{name}");
        assert_eq!(result.total_files, 1);
        let guide = result.entries.iter().find(|entry| entry.path == "docs/guide.txt").unwrap();
        assert_eq!((guide.size, guide.mode_string.as_deref()), (Some(5), Some("-rw-r--r--")));
        assert!(result.entries.iter().any(|entry| entry.path == "docs/" && entry.is_directory));
    }
    let work = TempDir::new().unwrap();
    let ustar = work.path().join("ustar.tar");
    write_tar(&ustar, &[TarEntry::File("a.txt", b"a")]);
    let header = inspect(&ustar).unwrap().header;
    assert_eq!(header.format_version.as_deref(), Some("POSIX ustar"));
    assert!(header.signature.unwrap().ends_with("(ustar)"));
    let legacy = work.path().join("legacy.tar");
    write_tar(&legacy, &[TarEntry::RawFile(b"a.txt", b"a")]);
    assert_eq!(inspect(&legacy).unwrap().header.format_version.as_deref(), Some("V7 / legacy TAR"));
}

#[test]
fn reports_a_lone_stream_with_its_size_unknown() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("notes.txt.gz");
    fs::write(&archive, gzip(b"notes")).unwrap();

    let result = inspect(&archive).unwrap();

    assert_eq!((result.format.as_str(), result.total_files), ("GZ", 1));
    assert_eq!((result.total_uncompressed_size, result.overall_ratio), (None, None));
    assert_eq!(result.entries[0].path, "notes.txt");
    assert_eq!(result.entries[0].size, None);
    assert_eq!(result.header.signature.as_deref(), Some("1F 8B (GZIP)"));
}

#[test]
fn reports_seven_zip_codecs_solid_blocks_and_encryption() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("solid.7z");
    fs::write(&archive, base64(seven_zip::SOLID)).unwrap();

    let result = inspect(&archive).unwrap();

    assert!(result.header.solid);
    assert_eq!(result.header.format_version.as_deref(), Some("0.4"));
    let files: Vec<_> = result.entries.iter().filter(|entry| !entry.is_directory).collect();
    assert!(files.iter().all(|entry| entry.codec.as_deref().unwrap().starts_with("LZMA2 [")));
    let block = files[0].solid_block.clone().unwrap();
    assert_eq!((block.id, block.file_count), (1, files.len() as u64));
    assert!(block.uncompressed_size > 0 && block.compressed_size > 0);
    assert!(files.iter().all(|entry| entry.compressed_size.is_none() && entry.solid_block.as_ref() == Some(&block)));
    let expected_ratio =
        ((1.0 - block.compressed_size as f64 / block.uncompressed_size as f64) * 10_000.0).round() / 100.0;
    assert_eq!(files[0].ratio, Some(expected_ratio));

    let encrypted = work.path().join("aes.7z");
    fs::write(&encrypted, base64(seven_zip::AES_DATA)).unwrap();
    let result = inspect(&encrypted).unwrap();
    assert!(result.password_protected);
    assert_eq!(result.entries[0].encryption_method, "AES-256 (SHA-256 KDF)");

    let hidden = work.path().join("hidden.7z");
    fs::write(&hidden, base64(seven_zip::AES_HEADER)).unwrap();
    assert!(matches!(inspect(&hidden), Err(LiberaError::PasswordRequired)));
    let listed = inspect_archive(path(&hidden), Some("hunter2".into()), CancelToken::new()).unwrap();
    assert_eq!(listed.entries[0].path, "secret.txt");
}

#[test]
fn reports_a_split_set_opened_from_any_volume_as_one_archive() {
    let work = TempDir::new().unwrap();
    let input = write_file(work.path(), "big.bin", noise(3 << 20));
    for (format, name, later) in
        [(ArchiveFormat::Zip, "set.zip", "set.z02"), (ArchiveFormat::SevenZip, "set.7z", "set.7z.002")]
    {
        let archive = work.path().join(name);
        let result = compress(CompressionOptions {
            level: Some(0),
            split_size: Some(MIN_SPLIT_SIZE),
            ..options(&[&input], &archive, format)
        })
        .unwrap();
        let total: u64 = result.volume_paths.unwrap().iter().map(|volume| fs::metadata(volume).unwrap().len()).sum();

        let inspected = inspect(&work.path().join(later)).unwrap();

        assert_eq!(inspected.total_compressed_size, total, "{name}");
        assert!(inspected.volumes.as_ref().unwrap().len() > 1, "{name}");
        assert_eq!(inspected.entries.iter().filter(|entry| !entry.is_directory).count(), 1);
        let index = index_of(&inspected, "big.bin");
        let previewed = preview(&work.path().join(later), index);
        assert!(matches!(previewed, Err(LiberaError::NotText)), "{name}: {previewed:?}");
    }
}

#[test]
fn refuses_missing_files_and_unsupported_ones() {
    let work = TempDir::new().unwrap();
    assert!(matches!(inspect(&work.path().join("missing.zip")), Err(LiberaError::ArchiveMissing { .. })));
    let notes = write_file(work.path(), "notes.txt", "notes");
    assert!(matches!(inspect(&notes), Err(LiberaError::UnsupportedArchive { .. })));
}

/// The same small project in every format the engine writes.
fn archives(work: &Path) -> Vec<std::path::PathBuf> {
    let source = work.join("project");
    write_file(&source, "readme.md", "# Libera\n");
    write_file(&source, "logo.png", png(64, 32, 100));
    write_file(&source, "data.bin", noise(4096));
    [
        (ArchiveFormat::Zip, "p.zip"),
        (ArchiveFormat::Tgz, "p.tgz"),
        (ArchiveFormat::Tzst, "p.tar.zst"),
        (ArchiveFormat::SevenZip, "p.7z"),
    ]
    .into_iter()
    .map(|(format, name)| {
        let archive = work.join(name);
        compress(options(&[&source], &archive, format)).unwrap();
        archive
    })
    .collect()
}

#[test]
fn previews_text_and_images_and_refuses_binary_data_and_folders_in_every_format() {
    let work = TempDir::new().unwrap();
    for archive in archives(work.path()) {
        let listed = inspect(&archive).unwrap();
        let name = archive.file_name().unwrap().to_string_lossy().into_owned();

        assert_eq!(
            text(preview(&archive, index_of(&listed, "project/readme.md")).unwrap()),
            ("# Libera\n".into(), false),
            "{name}"
        );
        match preview(&archive, index_of(&listed, "project/logo.png")).unwrap() {
            ArchivePreview::Image { media_type, width, height, data, .. } => {
                assert_eq!((media_type, width, height, data), (ImageType::Png, 64, 32, png(64, 32, 100)), "{name}");
            }
            other => panic!("{name}: {other:?}"),
        }
        assert!(
            matches!(preview(&archive, index_of(&listed, "project/data.bin")), Err(LiberaError::NotText)),
            "{name}"
        );
        let folder = listed.entries.iter().find(|entry| entry.is_directory).unwrap().index;
        assert!(matches!(preview(&archive, folder), Err(LiberaError::EntryNotPreviewable { .. })), "{name}");
        assert!(matches!(preview(&archive, 999), Err(LiberaError::EntryNotFound)), "{name}");
    }
}

#[test]
fn keeps_exactly_one_mebibyte_and_truncates_anything_larger() {
    let work = TempDir::new().unwrap();
    let source = work.path().join("src");
    write_file(&source, "exact.txt", "a".repeat(1 << 20));
    write_file(&source, "larger.txt", "b".repeat((1 << 20) + 10));
    let archive = work.path().join("sizes.zip");
    compress(options(&[&source], &archive, ArchiveFormat::Zip)).unwrap();
    let listed = inspect(&archive).unwrap();

    let (exact, exact_truncated) = text(preview(&archive, index_of(&listed, "src/exact.txt")).unwrap());
    let (larger, larger_truncated) = text(preview(&archive, index_of(&listed, "src/larger.txt")).unwrap());

    assert_eq!((exact.len(), exact_truncated), (1 << 20, false));
    assert_eq!((larger.len(), larger_truncated), (1 << 20, true));
}

#[test]
fn decodes_byte_order_marks_and_hands_back_raw_bytes_when_asked() {
    let work = TempDir::new().unwrap();
    let source = work.path().join("src");
    write_file(
        &source,
        "le.txt",
        [vec![0xff, 0xfe], "hi".encode_utf16().flat_map(u16::to_le_bytes).collect()].concat(),
    );
    write_file(
        &source,
        "be.txt",
        [vec![0xfe, 0xff], "hi".encode_utf16().flat_map(u16::to_be_bytes).collect()].concat(),
    );
    let archive = work.path().join("boms.tar");
    compress(options(&[&source], &archive, ArchiveFormat::Tar)).unwrap();
    let listed = inspect(&archive).unwrap();

    for (name, encoding) in [("src/le.txt", TextEncoding::Utf16Le), ("src/be.txt", TextEncoding::Utf16Be)] {
        let previewed =
            preview_archive_entry(path(&archive), index_of(&listed, name), None, true, CancelToken::new()).unwrap();
        let ArchivePreview::Text { text, encoding: found, raw_bytes, .. } = previewed else { panic!("{name}") };
        assert_eq!((text.as_str(), found), ("hi", encoding));
        assert_eq!(raw_bytes.unwrap().len(), 6);
    }
}

#[test]
fn refuses_images_past_the_byte_and_dimension_limits_and_unsupported_ones() {
    let work = TempDir::new().unwrap();
    let source = work.path().join("src");
    write_file(&source, "huge.png", png(10, 10, 10 << 20));
    write_file(&source, "wide.png", png(20_000, 10, 0));
    write_file(&source, "photo.bmp", b"BM\0\0\0\0\0\0\0\0\0\0\0\0");
    write_file(&source, "drawing.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    let archive = work.path().join("images.zip");
    compress(options(&[&source], &archive, ArchiveFormat::Zip)).unwrap();
    let listed = inspect(&archive).unwrap();

    assert!(matches!(preview(&archive, index_of(&listed, "src/huge.png")), Err(LiberaError::ImageTooLarge)));
    assert!(matches!(preview(&archive, index_of(&listed, "src/wide.png")), Err(LiberaError::ImageDimensionsTooLarge)));
    assert!(matches!(preview(&archive, index_of(&listed, "src/photo.bmp")), Err(LiberaError::UnsupportedImage)));
    assert!(text(preview(&archive, index_of(&listed, "src/drawing.svg")).unwrap()).0.starts_with("<svg"));
}

#[test]
fn previews_encrypted_entries_once_given_the_password() {
    let work = TempDir::new().unwrap();
    let input = write_file(work.path(), "secret.txt", "classified");
    for (format, name, encrypt_file_names) in
        [(ArchiveFormat::Zip, "secret.zip", None), (ArchiveFormat::SevenZip, "secret.7z", Some(true))]
    {
        let archive = work.path().join(name);
        compress(CompressionOptions {
            password: Some("hunter2".into()),
            encrypt_file_names,
            ..options(&[&input], &archive, format)
        })
        .unwrap();
        let listed = inspect_archive(path(&archive), Some("hunter2".into()), CancelToken::new()).unwrap();
        let index = index_of(&listed, "secret.txt");

        assert!(matches!(preview(&archive, index), Err(LiberaError::PasswordRequired)), "{name}");
        let wrong = preview_archive_entry(path(&archive), index, Some("wrong".into()), false, CancelToken::new());
        assert!(matches!(wrong, Err(LiberaError::WrongPassword)), "{name}: {wrong:?}");
        let right =
            preview_archive_entry(path(&archive), index, Some("hunter2".into()), false, CancelToken::new()).unwrap();
        assert_eq!(text(right).0, "classified", "{name}");
    }
}

#[test]
fn previews_the_lone_file_of_a_stream_and_a_reference_solid_block() {
    let work = TempDir::new().unwrap();
    let stream = work.path().join("notes.txt.zst");
    fs::write(&stream, zstd::encode_all(&b"stream notes"[..], 3).unwrap()).unwrap();
    assert_eq!(text(preview(&stream, 0).unwrap()), ("stream notes".into(), false));
    assert!(matches!(preview(&stream, 1), Err(LiberaError::EntryNotFound)));

    let solid = work.path().join("solid.7z");
    fs::write(&solid, base64(seven_zip::SOLID)).unwrap();
    let listed = inspect(&solid).unwrap();
    let c = listed.entries.iter().find(|entry| entry.path.ends_with("c.txt")).unwrap().index;
    let (contents, truncated) = text(preview(&solid, c).unwrap());
    assert_eq!((contents, truncated), ("charlie ".repeat(20_000), false));
    let a = listed.entries.iter().find(|entry| entry.path.ends_with("a.txt")).unwrap().index;
    let (contents, truncated) = text(preview(&solid, a).unwrap());
    assert_eq!((contents.len(), truncated), (1 << 20, true));
}

#[test]
fn reports_a_cancelled_preview_and_damage_with_stable_errors() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("notes.txt.gz");
    fs::write(&archive, gzip(b"notes")).unwrap();
    let token = CancelToken::new();
    token.cancel();
    assert!(matches!(
        preview_archive_entry(path(&archive), 0, None, false, Arc::clone(&token)),
        Err(LiberaError::PreviewCancelled)
    ));

    let damaged = work.path().join("damaged.txt.gz");
    let bytes = gzip(&noise(100_000));
    fs::write(&damaged, &bytes[..bytes.len() / 2]).unwrap();
    assert!(matches!(preview(&damaged, 0), Err(LiberaError::CorruptArchive { .. } | LiberaError::NotText)));
}
