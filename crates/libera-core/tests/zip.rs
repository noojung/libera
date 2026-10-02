//! ZIP written and read by the engine, and checked against Info-ZIP's `zip`
//! and `unzip` and libarchive's bsdtar wherever they can speak to it.

mod common;

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use common::*;
use flate2::Compression;
use flate2::write::DeflateEncoder;
use libera_core::{
    ArchiveFormat, CancelToken, CompressionOptions, DeflateStrategy, ExtractionOptions, FilenameEncoding, LiberaError,
    MIN_SPLIT_SIZE, OverrideScope, OverwritePolicy, ProgressPhase, ZipEncryptionMethod, ZipMethod, ZipMethodOverride,
    compress_archive, extract_archive_with, resolve_extraction_input,
};

const STORE: u16 = 0;
const DEFLATE: u16 = 8;
const LZMA: u16 = 14;
const ZSTD: u16 = 93;

fn zip(inputs: &[&Path], output: &Path) -> CompressionOptions {
    options(inputs, output, ArchiveFormat::Zip)
}

fn rule(source: &Path, scope: OverrideScope, method: ZipMethod) -> ZipMethodOverride {
    ZipMethodOverride { source_path: path(source), scope, method, deflate_strategy: None, mem_level: None, level: None }
}

fn raw_deflate_size(contents: &[u8], level: u32) -> u64 {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::new(level));
    encoder.write_all(contents).unwrap();
    encoder.finish().unwrap().len() as u64
}

/// A folder holding a compressible, a tiny, and an incompressible entry.
fn mixed_source(root: &Path) -> PathBuf {
    let source = root.join("source");
    write_file(&source, "notes.txt", "the quick brown fox\n".repeat(500));
    write_file(&source, "tiny.txt", "hello");
    write_file(&source, "photo.jpg", noise(64 * 1024));
    source
}

#[test]
fn round_trips_a_folder_that_unzip_tests_clean() {
    let work = TempDir::new().unwrap();
    let source = work.path().join("project");
    write_file(&source, "readme.md", "# project\n".repeat(100));
    write_file(&source, "src/main.rs", "fn main() {}\n");
    write_file(&source, "assets/blob.bin", noise(200_000));
    fs::create_dir_all(source.join("empty")).unwrap();
    let archive = work.path().join("project.zip");
    let listener = Recorder::new();

    let result = compress_archive(zip(&[&source], &archive), listener.clone(), CancelToken::new()).unwrap();

    assert_eq!(result.original_size, 1000 + 13 + 200_000);
    assert_eq!(result.compressed_size, fs::metadata(&archive).unwrap().len());
    assert_eq!(listener.last().phase, ProgressPhase::Complete);
    let tested = run("unzip", &["-t", &path(&archive)], work.path());
    assert!(tested.contains("No errors detected"), "{tested}");
    let names = run("unzip", &["-Z1", &path(&archive)], work.path());
    assert_eq!(
        names.lines().collect::<Vec<_>>(),
        [
            "project/",
            "project/assets/",
            "project/assets/blob.bin",
            "project/empty/",
            "project/readme.md",
            "project/src/",
            "project/src/main.rs"
        ]
    );

    let target = work.path().join("output");
    let extracted = extract(extraction(&archive, &target)).unwrap();
    assert_eq!(extracted.extracted_count, 3);
    assert_eq!(fs::read(target.join("project/assets/blob.bin")).unwrap(), noise(200_000));
    assert!(target.join("project/empty").is_dir());
}

#[test]
fn deflates_every_entry_when_nothing_asks_for_store() {
    let work = TempDir::new().unwrap();
    let source = mixed_source(work.path());
    let archive = work.path().join("mixed.zip");

    compress(zip(&[&source], &archive)).unwrap();

    assert_eq!(methods_by_name(&archive).into_values().collect::<Vec<_>>(), [DEFLATE; 3]);
    extract(extraction(&archive, &work.path().join("out"))).unwrap();
    assert_eq!(read(&work.path().join("out"), "source/tiny.txt"), "hello");
}

#[test]
fn stores_named_entries_under_lzma_and_keeps_the_archive_readable() {
    let work = TempDir::new().unwrap();
    let source = mixed_source(work.path());
    let archive = work.path().join("lzma.zip");

    compress(CompressionOptions {
        zip_method: Some(ZipMethod::Lzma),
        zip_method_overrides: Some(vec![
            rule(&source.join("tiny.txt"), OverrideScope::File, ZipMethod::Store),
            rule(&source.join("photo.jpg"), OverrideScope::File, ZipMethod::Store),
        ]),
        ..zip(&[&source], &archive)
    })
    .unwrap();

    let methods = methods_by_name(&archive);
    assert_eq!((methods["notes.txt"], methods["tiny.txt"], methods["photo.jpg"]), (LZMA, STORE, STORE));
    let target = work.path().join("out");
    extract(extraction(&archive, &target)).unwrap();
    assert_eq!(read(&target, "source/notes.txt"), "the quick brown fox\n".repeat(500));
    assert_eq!(fs::read(target.join("source/photo.jpg")).unwrap(), noise(64 * 1024));
}

#[test]
fn leaves_every_entry_alone_when_store_or_level_zero_was_asked_for() {
    let work = TempDir::new().unwrap();
    let source = mixed_source(work.path());
    for (name, options) in [
        (
            "store.zip",
            CompressionOptions {
                zip_method: Some(ZipMethod::Store),
                ..zip(&[&source], &work.path().join("store.zip"))
            },
        ),
        ("level0.zip", CompressionOptions { level: Some(0), ..zip(&[&source], &work.path().join("level0.zip")) }),
    ] {
        compress(options).unwrap();
        let listed = zip_listing(&work.path().join(name));
        assert!(listed.iter().all(|entry| entry.method == STORE), "{name}");
        let tiny = listed.iter().find(|entry| entry.name.ends_with("tiny.txt")).unwrap();
        assert_eq!(tiny.compressed_size, 5);
    }
}

#[test]
fn writes_store_deflate_lzma_and_zstandard_entries_in_one_archive() {
    let work = TempDir::new().unwrap();
    let source = work.path().join("source");
    let contents = [
        ("stored.txt", "stored bytes".to_owned()),
        ("forced.jpg", "a JPEG name that should still be explicitly deflated ".repeat(100)),
        ("inherited.png", "content that takes the archive method, having no rule ".repeat(100)),
        ("lzma.txt", "lzma content ".repeat(200)),
        ("zstd.txt", "zstandard content ".repeat(200)),
    ];
    for (name, text) in &contents {
        write_file(&source, name, text);
    }
    let archive = work.path().join("mixed-methods.zip");

    compress(CompressionOptions {
        zip_method: Some(ZipMethod::Deflate),
        zip_method_overrides: Some(vec![
            rule(&source.join("stored.txt"), OverrideScope::File, ZipMethod::Store),
            rule(&source.join("forced.jpg"), OverrideScope::File, ZipMethod::Deflate),
            rule(&source.join("lzma.txt"), OverrideScope::File, ZipMethod::Lzma),
            rule(&source.join("zstd.txt"), OverrideScope::File, ZipMethod::Zstd),
        ]),
        ..zip(&[&source], &archive)
    })
    .unwrap();

    let methods = methods_by_name(&archive);
    assert_eq!(
        ["stored.txt", "forced.jpg", "inherited.png", "lzma.txt", "zstd.txt"].map(|name| methods[name]),
        [STORE, DEFLATE, DEFLATE, LZMA, ZSTD]
    );
    let target = work.path().join("out");
    extract(extraction(&archive, &target)).unwrap();
    for (name, text) in &contents {
        assert_eq!(&read(&target, &format!("source/{name}")), text, "{name}");
    }
}

#[test]
fn applies_a_recursive_folder_method_while_allowing_a_file_exception() {
    let work = TempDir::new().unwrap();
    let source = work.path().join("source");
    write_file(&source, "nested/compressed.txt", "compress me ".repeat(200));
    write_file(&source, "nested/plain.txt", "leave me plain");
    let archive = work.path().join("folder-rules.zip");

    compress(CompressionOptions {
        zip_method_overrides: Some(vec![
            rule(&source, OverrideScope::Tree, ZipMethod::Lzma),
            rule(&source.join("nested/plain.txt"), OverrideScope::File, ZipMethod::Store),
        ]),
        ..zip(&[&source], &archive)
    })
    .unwrap();

    let methods = methods_by_name(&archive);
    assert_eq!((methods["compressed.txt"], methods["plain.txt"]), (LZMA, STORE));
}

#[test]
fn applies_compression_strength_independently_to_each_entry() {
    let work = TempDir::new().unwrap();
    let source = work.path().join("source");
    let contents = "per-file compression strength 000000111111222222333333\n".repeat(300);
    let levels = [1u8, 6, 9];
    for level in levels {
        write_file(&source, &format!("level-{level}.txt"), &contents);
    }
    let archive = work.path().join("strengths.zip");

    compress(CompressionOptions {
        level: Some(3),
        zip_method_overrides: Some(
            levels
                .iter()
                .map(|&level| ZipMethodOverride {
                    level: Some(level),
                    ..rule(&source.join(format!("level-{level}.txt")), OverrideScope::File, ZipMethod::Deflate)
                })
                .collect(),
        ),
        ..zip(&[&source], &archive)
    })
    .unwrap();

    let listed = zip_listing(&archive);
    for level in levels {
        let entry = listed.iter().find(|entry| entry.name.ends_with(&format!("level-{level}.txt"))).unwrap();
        assert_eq!(entry.compressed_size, raw_deflate_size(contents.as_bytes(), u32::from(level)), "level {level}");
    }
    extract(extraction(&archive, &work.path().join("out"))).unwrap();
}

#[test]
fn applies_each_deflate_strategy_and_memory_level_to_the_entry_that_chose_it() {
    let work = TempDir::new().unwrap();
    let source = work.path().join("source");
    let contents = "aaaaabbbbbcccccdddddeeeee-0123456789\n".repeat(2000);
    let strategies = [
        ("default", DeflateStrategy::Default),
        ("filtered", DeflateStrategy::Filtered),
        ("huffman", DeflateStrategy::HuffmanOnly),
        ("rle", DeflateStrategy::Rle),
        ("fixed", DeflateStrategy::Fixed),
    ];
    let mut rules = Vec::new();
    for (name, strategy) in strategies {
        let file = write_file(&source, &format!("{name}.txt"), &contents);
        rules.push(ZipMethodOverride {
            deflate_strategy: Some(strategy),
            ..rule(&file, OverrideScope::File, ZipMethod::Deflate)
        });
    }
    for mem_level in [1u8, 9] {
        let file = write_file(&source, &format!("memory-{mem_level}.txt"), &contents);
        rules.push(ZipMethodOverride {
            mem_level: Some(mem_level),
            ..rule(&file, OverrideScope::File, ZipMethod::Deflate)
        });
    }
    let archive = work.path().join("strategies.zip");

    compress(CompressionOptions { level: Some(6), zip_method_overrides: Some(rules), ..zip(&[&source], &archive) })
        .unwrap();

    let sizes: std::collections::BTreeMap<String, u64> = zip_listing(&archive)
        .into_iter()
        .filter(|entry| !entry.name.ends_with('/'))
        .map(|entry| {
            (entry.name.rsplit('/').next().unwrap().trim_end_matches(".txt").to_owned(), entry.compressed_size)
        })
        .collect();
    // zlib's defaults are what flate2 writes, so the default entry matches it.
    assert_eq!(sizes["default"], raw_deflate_size(contents.as_bytes(), 6));
    assert!(sizes["huffman"] > sizes["default"]);
    assert_ne!(sizes["memory-1"], sizes["memory-9"]);
    let target = work.path().join("out");
    extract(extraction(&archive, &target)).unwrap();
    for name in ["default", "filtered", "huffman", "rle", "fixed", "memory-1", "memory-9"] {
        assert_eq!(read(&target, &format!("source/{name}.txt")), contents, "{name}");
    }
}

#[test]
fn keeps_unnamed_entries_stored_at_level_zero_while_compressing_an_explicit_file() {
    let work = TempDir::new().unwrap();
    let source = work.path().join("source");
    let contents = "minimum per-file strength ".repeat(2000);
    let compressed = write_file(&source, "compressed.txt", &contents);
    write_file(&source, "stored.txt", &contents);
    let archive = work.path().join("store-with-exception.zip");

    compress(CompressionOptions {
        level: Some(0),
        zip_method_overrides: Some(vec![rule(&compressed, OverrideScope::File, ZipMethod::Deflate)]),
        ..zip(&[&source], &archive)
    })
    .unwrap();

    let listed = zip_listing(&archive);
    let entry = |name: &str| listed.iter().find(|entry| entry.name.ends_with(name)).unwrap().clone();
    assert_eq!((entry("compressed.txt").method, entry("stored.txt").method), (DEFLATE, STORE));
    assert_eq!(entry("compressed.txt").compressed_size, raw_deflate_size(contents.as_bytes(), 1));
}

#[test]
fn carries_the_zstandard_options_into_entries_written_with_that_method() {
    let work = TempDir::new().unwrap();
    let block = noise(512 * 1024);
    let input = write_file(work.path(), "payload.bin", [block.clone(), noise(2 << 20), block].concat());
    let size = |window: u32| {
        let archive = work.path().join(format!("w{window}.zip"));
        compress(CompressionOptions {
            zip_method: Some(ZipMethod::Zstd),
            level: Some(3),
            zstd_window_size: Some(window),
            ..zip(&[&input], &archive)
        })
        .unwrap()
        .compressed_size
    };

    let (narrow, wide) = (size(1 << 20), size(8 << 20));

    assert!(narrow - wide > 256 * 1024, "narrow {narrow}, wide {wide}");
    let target = work.path().join("out");
    extract(extraction(&work.path().join(format!("w{}.zip", 8 << 20)), &target)).unwrap();
    assert_eq!(fs::metadata(target.join("payload.bin")).unwrap().len(), (3 << 20) as u64);
}

#[test]
fn refuses_zip_options_for_other_formats_and_tuning_the_method_cannot_use() {
    let work = TempDir::new().unwrap();
    let input = write_file(work.path(), "input.txt", "content");
    let archive = work.path().join("out");
    let refused = [
        CompressionOptions { password: Some("secret".into()), ..options(&[&input], &archive, ArchiveFormat::Tar) },
        CompressionOptions {
            encryption_method: Some(ZipEncryptionMethod::Aes256),
            ..options(&[&input], &archive, ArchiveFormat::Tgz)
        },
        CompressionOptions { zip_method: Some(ZipMethod::Store), ..options(&[&input], &archive, ArchiveFormat::Tar) },
        CompressionOptions {
            zip_method_overrides: Some(vec![rule(&input, OverrideScope::File, ZipMethod::Store)]),
            ..options(&[&input], &archive, ArchiveFormat::Tar)
        },
        CompressionOptions {
            zip_method: Some(ZipMethod::Lzma),
            deflate_strategy: Some(DeflateStrategy::Rle),
            ..zip(&[&input], &archive)
        },
        CompressionOptions {
            zip_method_overrides: Some(vec![rule(
                &work.path().join("elsewhere"),
                OverrideScope::File,
                ZipMethod::Store,
            )]),
            ..zip(&[&input], &archive)
        },
    ];
    for options in refused {
        let description = format!("{options:?}");
        assert!(matches!(compress(options), Err(LiberaError::InvalidInput { .. })), "{description}");
    }
}

fn encrypted(source: &Path, archive: &Path, method: Option<ZipEncryptionMethod>) -> CompressionOptions {
    CompressionOptions { password: Some("hunter2".into()), encryption_method: method, ..zip(&[source], archive) }
}

#[test]
fn encrypts_with_the_traditional_cipher_that_unzip_opens() {
    let work = TempDir::new().unwrap();
    let source = mixed_source(work.path());
    let archive = work.path().join("secret.zip");

    compress(encrypted(&source, &archive, None)).unwrap();

    assert!(zip_listing(&archive).iter().filter(|entry| !entry.name.ends_with('/')).all(|entry| entry.flags & 1 == 1));
    let tested = run("unzip", &["-P", "hunter2", "-t", &path(&archive)], work.path());
    assert!(tested.contains("No errors detected"), "{tested}");

    let target = work.path().join("out");
    let wrong = extract(ExtractionOptions { password: Some("wrong".into()), ..extraction(&archive, &target) });
    assert!(matches!(wrong, Err(LiberaError::WrongPassword)), "{wrong:?}");
    let missing = extract(extraction(&archive, &target));
    assert!(matches!(missing, Err(LiberaError::PasswordRequired)), "{missing:?}");
    assert!(!target.exists());
    extract(ExtractionOptions { password: Some("hunter2".into()), ..extraction(&archive, &target) }).unwrap();
    assert_eq!(fs::read(target.join("source/photo.jpg")).unwrap(), noise(64 * 1024));
}

#[test]
fn reads_a_traditionally_encrypted_archive_info_zip_wrote() {
    let work = TempDir::new().unwrap();
    write_file(work.path(), "docs/secret.txt", "classified");
    let archive = work.path().join("info-zip.zip");
    run("zip", &["-q", "-r", "-P", "correct-password", &path(&archive), "docs"], work.path());

    let target = work.path().join("out");
    let wrong = extract(ExtractionOptions { password: Some("wrong-password".into()), ..extraction(&archive, &target) });
    assert!(matches!(wrong, Err(LiberaError::WrongPassword)), "{wrong:?}");
    extract(ExtractionOptions { password: Some("correct-password".into()), ..extraction(&archive, &target) }).unwrap();
    assert_eq!(read(&target, "docs/secret.txt"), "classified");
}

#[test]
fn encrypts_with_aes_that_bsdtar_opens() {
    for (method, strength) in [(ZipEncryptionMethod::Aes128, 1), (ZipEncryptionMethod::Aes256, 3)] {
        let work = TempDir::new().unwrap();
        let source = mixed_source(work.path());
        let archive = work.path().join("aes.zip");

        compress(encrypted(&source, &archive, Some(method))).unwrap();

        let files: Vec<Listed> = zip_listing(&archive).into_iter().filter(|entry| !entry.name.ends_with('/')).collect();
        assert!(files.iter().all(|entry| entry.method == 99 && entry.aes_strength == Some(strength)), "{files:?}");
        let unpacked = work.path().join("bsdtar");
        fs::create_dir(&unpacked).unwrap();
        run("tar", &["-xf", &path(&archive), "--passphrase", "hunter2", "-C", &path(&unpacked)], work.path());
        assert_eq!(fs::read(unpacked.join("source/photo.jpg")).unwrap(), noise(64 * 1024), "{method:?}");

        let target = work.path().join("out");
        let wrong = extract(ExtractionOptions { password: Some("wrong".into()), ..extraction(&archive, &target) });
        assert!(matches!(wrong, Err(LiberaError::WrongPassword)), "{wrong:?}");
        extract(ExtractionOptions { password: Some("hunter2".into()), ..extraction(&archive, &target) }).unwrap();
        assert_eq!(read(&target, "source/notes.txt"), "the quick brown fox\n".repeat(500));
    }
}

#[test]
fn reads_an_aes_archive_bsdtar_wrote() {
    let work = TempDir::new().unwrap();
    write_file(work.path(), "docs/secret.txt", "classified ".repeat(1000));
    let archive = work.path().join("bsdtar-aes.zip");
    run(
        "tar",
        &[
            "-cf",
            &path(&archive),
            "--format",
            "zip",
            "--options",
            "zip:encryption=aes256",
            "--passphrase",
            "pw",
            "docs",
        ],
        work.path(),
    );

    let target = work.path().join("out");
    extract(ExtractionOptions { password: Some("pw".into()), ..extraction(&archive, &target) }).unwrap();

    assert_eq!(read(&target, "docs/secret.txt"), "classified ".repeat(1000));
}

#[test]
fn writes_lzma_and_zstandard_entries_alongside_a_password() {
    for (zip_method, encryption) in [(ZipMethod::Lzma, None), (ZipMethod::Zstd, Some(ZipEncryptionMethod::Aes256))] {
        let work = TempDir::new().unwrap();
        let source = mixed_source(work.path());
        let archive = work.path().join("coded.zip");

        compress(CompressionOptions { zip_method: Some(zip_method), ..encrypted(&source, &archive, encryption) })
            .unwrap();

        let target = work.path().join("out");
        extract(ExtractionOptions { password: Some("hunter2".into()), ..extraction(&archive, &target) }).unwrap();
        assert_eq!(read(&target, "source/notes.txt"), "the quick brown fox\n".repeat(500), "{zip_method:?}");
    }
}

#[test]
fn restores_overwritten_files_when_a_wrong_password_fails_the_job() {
    let work = TempDir::new().unwrap();
    let input = write_file(work.path(), "existing.txt", "archive content");
    let archive = work.path().join("encrypted.zip");
    compress(encrypted(&input, &archive, None)).unwrap();
    let target = work.path().join("output");
    write_file(&target, "existing.txt", "original content");

    for policy in [OverwritePolicy::Overwrite, OverwritePolicy::Rename] {
        let result = extract(ExtractionOptions {
            overwrite_policy: Some(policy),
            password: Some("wrong-password".into()),
            ..extraction(&archive, &target)
        });
        assert!(matches!(result, Err(LiberaError::WrongPassword)), "{result:?}");
        assert_eq!(tree(&target), ["existing.txt"]);
        assert_eq!(read(&target, "existing.txt"), "original content");
    }
}

#[test]
fn reads_an_lzma_entry_another_encoder_wrote() {
    // Written by Python's zipfile with ZIP_LZMA: a foreign encoder, an 8 MB
    // dictionary, and the flag saying its stream ends in an end marker that
    // the decoder has to stop short of.
    let fixture = base64(concat!(
        "UEsDBD8AAgAOAHgRIV1P3xvjWAAAAFgbAAALAAAAZm9yZWlnbi50eHQJBAUAXQAAgAAANhpIajumvE0hvLEg0qFU524Tcen0",
        "Q43jOjIcjuJJfCepY+OqXuLHaBwIPHJc6Ns2STy/DO/Iqg1C6IOj2u3BiCBHw8VTuP93//8mTgAAUEsBAj8DPwACAA4AeBEh",
        "XU/fG+NYAAAAWBsAAAsAAAAAAAAAAAAAAIABAAAAAGZvcmVpZ24udHh0UEsFBgAAAAABAAEAOQAAAIEAAAAAAA=="
    ));
    let work = TempDir::new().unwrap();
    let archive = work.path().join("foreign.zip");
    fs::write(&archive, fixture).unwrap();
    let target = work.path().join("out");

    extract(extraction(&archive, &target)).unwrap();

    assert_eq!(read(&target, "foreign.txt"), "libera reads foreign LZMA entries.\n".repeat(200));
}

#[test]
fn extracts_jar_and_war_archives_through_the_zip_reader() {
    for name in ["library.jar", "webapp.war"] {
        let work = TempDir::new().unwrap();
        let archive = work.path().join(name);
        fs::write(&archive, raw_zip(&[RawZipEntry::file("META-INF/MANIFEST.MF", b"Manifest-Version: 1.0\n")], None))
            .unwrap();
        let target = work.path().join("out");

        extract(extraction(&archive, &target)).unwrap();

        assert_eq!(read(&target, "META-INF/MANIFEST.MF"), "Manifest-Version: 1.0\n", "{name}");
    }
}

#[test]
fn rejects_zip_slip_paths_before_writing_outside_the_target() {
    let work = TempDir::new().unwrap();
    for name in ["../escape.txt", "/tmp/escape.txt", "C:/escape.txt"] {
        let archive = work.path().join("slip.zip");
        fs::write(&archive, raw_zip(&[RawZipEntry::file(name, b"unsafe")], None)).unwrap();
        let target = work.path().join("output");

        let result = extract(extraction(&archive, &target));

        assert!(matches!(result, Err(LiberaError::UnsafeArchive { .. })), "{name}: {result:?}");
        assert!(!work.path().join("escape.txt").exists());
        assert!(!target.exists());
    }
}

#[test]
fn refuses_entries_that_share_their_data() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("overlap.zip");
    fs::write(&archive, raw_zip(&[RawZipEntry::file("a.txt", &[b'a'; 1000])], Some("b.txt"))).unwrap();

    let result = extract(extraction(&archive, &work.path().join("out")));

    let Err(LiberaError::UnsafeArchive { message }) = result else { panic!("{result:?}") };
    assert!(message.contains("overlap"), "{message}");
}

#[test]
fn refuses_data_put_in_front_of_or_after_the_archive() {
    let work = TempDir::new().unwrap();
    let plain = raw_zip(&[RawZipEntry::file("plain.txt", b"hello")], None);
    let prepended = work.path().join("prepended.zip");
    fs::write(&prepended, [vec![0x7f; 8], plain.clone()].concat()).unwrap();
    let appended = work.path().join("appended.zip");
    fs::write(&appended, [plain, vec![0x7f; 8]].concat()).unwrap();

    let prepended_result = extract(extraction(&prepended, &work.path().join("a")));
    assert!(matches!(prepended_result, Err(LiberaError::UnsafeArchive { .. })), "{prepended_result:?}");
    let appended_result = extract(extraction(&appended, &work.path().join("b")));
    assert!(matches!(appended_result, Err(LiberaError::CorruptArchive { .. })), "{appended_result:?}");
}

#[test]
fn reports_damage_to_an_unencrypted_entry_as_damage() {
    let work = TempDir::new().unwrap();
    let mut bytes = raw_zip(&[RawZipEntry::file("data.txt", b"hello world")], None);
    let at = bytes.windows(5).position(|window| window == b"hello").unwrap();
    bytes[at] = b'j';
    let archive = work.path().join("damaged.zip");
    fs::write(&archive, bytes).unwrap();

    let result = extract(extraction(&archive, &work.path().join("out")));
    assert!(matches!(result, Err(LiberaError::CorruptArchive { .. })), "{result:?}");

    let lenient =
        extract(ExtractionOptions { strict_crc: Some(false), ..extraction(&archive, &work.path().join("lenient")) });
    assert!(lenient.is_ok(), "{lenient:?}");
    assert_eq!(read(&work.path().join("lenient"), "data.txt"), "jello world");
}

#[cfg(unix)]
#[test]
fn restores_permissions_and_links_and_keeps_entries_without_a_mode_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    let work = TempDir::new().unwrap();
    let archive = work.path().join("modes.zip");
    fs::write(
        &archive,
        raw_zip(
            &[
                RawZipEntry::file("run.sh", b"#!/bin/sh\necho hi\n").with_mode(Some(0o104_755)),
                RawZipEntry::file("plain.txt", b"data").with_mode(Some(0o100_644)),
                RawZipEntry::file("dos.txt", b"no mode").with_mode(None),
                RawZipEntry::file("link.txt", b"plain.txt").with_mode(Some(0o120_777)),
            ],
            None,
        ),
    )
    .unwrap();
    let target = work.path().join("out");

    let result = extract(extraction(&archive, &target)).unwrap();

    assert_eq!(result.extracted_count, 4);
    let mode = |name: &str| fs::metadata(target.join(name)).unwrap().permissions().mode() & 0o7777;
    assert_eq!((mode("run.sh"), mode("plain.txt"), mode("dos.txt")), (0o755, 0o644, 0o600));
    assert_eq!(fs::read_link(target.join("link.txt")).unwrap().to_str(), Some("plain.txt"));

    let escaping = work.path().join("escaping.zip");
    fs::write(&escaping, raw_zip(&[RawZipEntry::file("link.txt", b"../escape.txt").with_mode(Some(0o120_777))], None))
        .unwrap();
    let result = extract(extraction(&escaping, &work.path().join("out2")));
    let Err(LiberaError::UnsafeArchive { message }) = result else { panic!("{result:?}") };
    assert!(message.contains("symlink target escapes the destination"), "{message}");
}

#[cfg(unix)]
#[test]
fn stores_symbolic_links_as_link_entries_and_leaves_them_out_when_asked() {
    let work = TempDir::new().unwrap();
    let source = work.path().join("source");
    write_file(&source, "real.txt", "real contents");
    std::os::unix::fs::symlink("real.txt", source.join("link.txt")).unwrap();
    let archive = work.path().join("links.zip");

    compress(zip(&[&source], &archive)).unwrap();
    let target = work.path().join("restored");
    extract(extraction(&archive, &target)).unwrap();
    assert_eq!(fs::read_link(target.join("source/link.txt")).unwrap().to_str(), Some("real.txt"));
    let listed = run("unzip", &["-Z", &path(&archive)], work.path());
    assert!(listed.lines().any(|line| line.starts_with('l') && line.ends_with("source/link.txt")), "{listed}");

    let filtered = work.path().join("filtered.zip");
    compress(CompressionOptions { exclude_symlinks: Some(true), ..zip(&[&source], &filtered) }).unwrap();
    assert!(!methods_by_name(&filtered).contains_key("link.txt"));
}

#[test]
fn reads_names_in_the_encoding_expert_mode_picks() {
    let work = TempDir::new().unwrap();
    let korean_cp949 = [0xc7, 0xd1, 0xb1, 0xdb, b'.', b't', b'x', b't'];
    let archive = work.path().join("korean.zip");
    fs::write(
        &archive,
        raw_zip(&[RawZipEntry { name: &korean_cp949, data: b"cp949", unix_mode: None, flags: 0 }], None),
    )
    .unwrap();
    let utf8 = work.path().join("utf8.zip");
    fs::write(&utf8, raw_zip(&[RawZipEntry::file("한글.txt", b"utf-8 without the flag")], None)).unwrap();

    let target = work.path().join("cp949");
    extract(ExtractionOptions { encoding: Some(FilenameEncoding::Cp949), ..extraction(&archive, &target) }).unwrap();
    assert_eq!(read(&target, "한글.txt"), "cp949");
    let auto = work.path().join("auto");
    extract(extraction(&utf8, &auto)).unwrap();
    assert_eq!(read(&auto, "한글.txt"), "utf-8 without the flag");
}

#[cfg(target_os = "macos")]
#[test]
fn folds_appledouble_sidecars_onto_the_files_they_describe() {
    let work = TempDir::new().unwrap();
    let source = work.path().join("src");
    let note = write_file(&source, "note.txt", "hello");
    xattr::set(&note, "user.libera", b"tagged").unwrap();
    let archive = work.path().join("ditto.zip");
    run("ditto", &["-c", "-k", &path(&source), &path(&archive)], work.path());
    assert!(methods_by_name(&archive).contains_key("._note.txt"));

    let target = work.path().join("out");
    extract(extraction(&archive, &target)).unwrap();
    assert_eq!(tree(&target), ["note.txt"]);
    assert_eq!(xattr::get(target.join("note.txt"), "user.libera").unwrap().as_deref(), Some(&b"tagged"[..]));

    let kept = work.path().join("kept");
    extract(ExtractionOptions { exclude_mac_metadata: Some(true), ..extraction(&archive, &kept) }).unwrap();
    assert_eq!(tree(&kept), ["._note.txt", "note.txt"]);
}

#[test]
fn reports_byte_progress_that_ends_at_the_total() {
    let work = TempDir::new().unwrap();
    let input = write_file(work.path(), "large.txt", "streamed zip contents");
    let archive = work.path().join("archive.zip");
    compress(zip(&[&input], &archive)).unwrap();
    let listener = Recorder::new();

    extract_reporting(extraction(&archive, &work.path().join("out")), listener.clone()).unwrap();

    let last = listener.last();
    assert_eq!((last.processed_bytes, last.total_bytes, last.percent), (21, Some(21), Some(100)));
}

#[test]
fn cancels_compression_and_extraction_and_removes_what_they_wrote() {
    let work = TempDir::new().unwrap();
    let input = write_file(work.path(), "large.bin", noise(4 << 20));
    let archive = work.path().join("large.zip");
    let token = CancelToken::new();
    let result = compress_archive(
        CompressionOptions { level: Some(0), ..zip(&[&input], &archive) },
        Recorder::cancelling(&token),
        token.clone(),
    );
    assert!(matches!(result, Err(LiberaError::CompressionCancelled)), "{result:?}");
    assert!(!archive.exists());

    compress(CompressionOptions { level: Some(0), ..zip(&[&input], &archive) }).unwrap();
    let target = work.path().join("nested/zip-output");
    let token = CancelToken::new();
    let result =
        extract_archive_with(extraction(&archive, &target), Recorder::cancelling(&token), token.clone(), roomy());
    assert!(matches!(result, Err(LiberaError::ExtractionCancelled)), "{result:?}");
    assert!(!work.path().join("nested").exists());
}

/// Four incompressible megabytes stored into 1 MiB volumes.
fn split_set(work: &Path) -> (PathBuf, Vec<String>) {
    let source = work.join("source");
    for index in 0..4 {
        write_file(&source, &format!("file-{index}.bin"), noise((1 << 20) + index));
    }
    let archive = work.join("archive.zip");
    let result =
        compress(CompressionOptions { level: Some(0), split_size: Some(MIN_SPLIT_SIZE), ..zip(&[&source], &archive) })
            .unwrap();
    (archive, result.volume_paths.unwrap())
}

#[test]
fn writes_numbered_volumes_with_the_final_one_named_zip() {
    let work = TempDir::new().unwrap();
    let (archive, volumes) = split_set(work.path());

    let names: Vec<String> =
        volumes.iter().map(|volume| Path::new(volume).file_name().unwrap().to_string_lossy().into_owned()).collect();
    assert_eq!(names, ["archive.z01", "archive.z02", "archive.z03", "archive.z04", "archive.zip"]);
    for volume in &volumes {
        assert!(fs::metadata(volume).unwrap().len() <= MIN_SPLIT_SIZE, "{volume}");
    }
    assert_eq!(&fs::read(&volumes[0]).unwrap()[..4], &[0x50, 0x4b, 0x07, 0x08]);

    // Info-ZIP joins the set back into one archive only if it is well formed.
    run("zip", &["-q", "-s", "0", &path(&archive), "--out", "merged.zip"], work.path());
    let tested = run("unzip", &["-t", "merged.zip"], work.path());
    assert!(tested.contains("No errors detected"), "{tested}");
}

#[test]
fn opens_a_split_set_through_any_of_its_volumes() {
    let work = TempDir::new().unwrap();
    let (archive, volumes) = split_set(work.path());
    let total: u64 = volumes.iter().map(|volume| fs::metadata(volume).unwrap().len()).sum();

    for entry_point in [archive.clone(), work.path().join("archive.z01"), work.path().join("archive.z03")] {
        let resolved = resolve_extraction_input(path(&entry_point)).unwrap();
        assert_eq!(resolved.path, path(&archive));
        assert_eq!(resolved.size, total);
        assert_eq!(resolved.volumes.unwrap().iter().map(|volume| volume.path.clone()).collect::<Vec<_>>(), volumes);

        let target = work.path().join("out").join(entry_point.file_name().unwrap());
        extract(extraction(&entry_point, &target)).unwrap();
        for index in 0..4 {
            assert_eq!(fs::read(target.join(format!("source/file-{index}.bin"))).unwrap(), noise((1 << 20) + index));
        }
    }
}

#[test]
fn names_a_missing_or_stray_volume() {
    let work = TempDir::new().unwrap();
    let (archive, volumes) = split_set(work.path());

    fs::rename(&volumes[1], work.path().join("aside")).unwrap();
    let missing = resolve_extraction_input(path(&archive));
    let Err(LiberaError::SplitVolumeMissing { message }) = missing else { panic!("{missing:?}") };
    assert!(message.contains("archive.z02"), "{message}");
    fs::rename(work.path().join("aside"), &volumes[1]).unwrap();

    fs::write(work.path().join("archive.z09"), "stale").unwrap();
    assert!(matches!(resolve_extraction_input(path(&archive)), Err(LiberaError::SplitVolumeMismatch { .. })));
    fs::remove_file(work.path().join("archive.z09")).unwrap();

    fs::remove_file(&volumes[2]).unwrap();
    fs::create_dir(&volumes[2]).unwrap();
    assert!(matches!(resolve_extraction_input(path(&archive)), Err(LiberaError::SplitVolumeMissing { .. })));
}

#[test]
fn reads_an_ordinary_archive_whatever_sits_beside_it() {
    let work = TempDir::new().unwrap();
    let input = write_file(work.path(), "plain.txt", "hello");
    let archive = work.path().join("plain.zip");
    compress(zip(&[&input], &archive)).unwrap();
    fs::write(work.path().join("plain.z01"), "not a volume").unwrap();

    let resolved = resolve_extraction_input(path(&archive)).unwrap();

    assert_eq!(resolved.volumes, None);
    extract(extraction(&archive, &work.path().join("out"))).unwrap();
}

#[test]
fn writes_an_ordinary_archive_when_everything_fits_in_one_volume() {
    let work = TempDir::new().unwrap();
    let input = write_file(work.path(), "small.txt", "fits easily");
    let archive = work.path().join("small.zip");

    let result = compress(CompressionOptions { split_size: Some(MIN_SPLIT_SIZE), ..zip(&[&input], &archive) }).unwrap();

    assert_eq!(result.volume_paths, None);
    assert_eq!(&fs::read(&archive).unwrap()[..4], &[0x50, 0x4b, 0x03, 0x04]);
}

#[test]
fn reads_a_set_that_compressed_down_to_a_single_volume() {
    let work = TempDir::new().unwrap();
    let input = write_file(work.path(), "repeated.txt", "a".repeat(2 << 20));
    let archive = work.path().join("archive.zip");

    let result = compress(CompressionOptions { split_size: Some(MIN_SPLIT_SIZE), ..zip(&[&input], &archive) }).unwrap();

    assert_eq!(result.volume_paths.as_ref().map(Vec::len), Some(1));
    assert_eq!(&fs::read(&archive).unwrap()[..4], &[0x50, 0x4b, 0x07, 0x08]);
    let target = work.path().join("out");
    extract(extraction(&archive, &target)).unwrap();
    assert_eq!(read(&target, "repeated.txt").len(), 2 << 20);
}

#[test]
fn clears_volumes_an_earlier_run_left_and_keeps_its_own_out_of_the_input() {
    let work = TempDir::new().unwrap();
    let source = work.path().join("source");
    write_file(&source, "big.bin", noise(3 << 20));
    let archive = source.join("archive.zip");
    for stale in ["archive.z01", "archive.z07", "archive.zip"] {
        fs::write(source.join(stale), "stale").unwrap();
    }

    let result =
        compress(CompressionOptions { level: Some(0), split_size: Some(MIN_SPLIT_SIZE), ..zip(&[&source], &archive) })
            .unwrap();

    assert!(!source.join("archive.z07").exists());
    assert_eq!(result.original_size, 3 << 20);
    let target = work.path().join("out");
    extract(extraction(&archive, &target)).unwrap();
    assert_eq!(tree(&target), ["source/", "source/big.bin"]);
}

#[test]
fn encrypts_a_split_set_and_removes_it_all_when_cancelled() {
    let work = TempDir::new().unwrap();
    let input = write_file(work.path(), "big.bin", noise(3 << 20));
    let archive = work.path().join("secret.zip");
    let options = CompressionOptions {
        level: Some(0),
        split_size: Some(MIN_SPLIT_SIZE),
        encryption_method: Some(ZipEncryptionMethod::Aes256),
        password: Some("hunter2".into()),
        ..zip(&[&input], &archive)
    };

    let result = compress(options.clone()).unwrap();
    assert!(result.volume_paths.unwrap().len() > 1);
    let target = work.path().join("out");
    extract(ExtractionOptions {
        password: Some("hunter2".into()),
        ..extraction(&work.path().join("secret.z02"), &target)
    })
    .unwrap();
    assert_eq!(fs::read(target.join("big.bin")).unwrap(), noise(3 << 20));

    let cancelled = TempDir::new().unwrap();
    let input = write_file(cancelled.path(), "big.bin", noise(3 << 20));
    let token = CancelToken::new();
    let result = compress_archive(
        CompressionOptions {
            input_paths: vec![path(&input)],
            output_path: path(&cancelled.path().join("secret.zip")),
            ..options
        },
        Recorder::cancelling(&token),
        token.clone(),
    );
    assert!(matches!(result, Err(LiberaError::CompressionCancelled)), "{result:?}");
    assert_eq!(tree(cancelled.path()), ["big.bin"]);
}

#[test]
fn reads_a_split_set_info_zip_wrote() {
    let work = TempDir::new().unwrap();
    write_file(work.path(), "data/a.bin", noise(1_500_000));
    write_file(work.path(), "data/b.txt", "after the split");
    run("zip", &["-q", "-r", "-0", "-s", "1m", "info-zip.zip", "data"], work.path());
    assert!(work.path().join("info-zip.z01").exists());

    let target = work.path().join("out");
    extract(extraction(&work.path().join("info-zip.z01"), &target)).unwrap();

    assert_eq!(fs::read(target.join("data/a.bin")).unwrap(), noise(1_500_000));
    assert_eq!(read(&target, "data/b.txt"), "after the split");
}

#[test]
fn refuses_split_sizes_and_formats_it_cannot_support() {
    let work = TempDir::new().unwrap();
    let input = write_file(work.path(), "a.txt", "a");
    let too_small = compress(CompressionOptions {
        split_size: Some(MIN_SPLIT_SIZE - 1),
        ..zip(&[&input], &work.path().join("a.zip"))
    });
    assert!(matches!(too_small, Err(LiberaError::SplitSizeTooSmall { .. })), "{too_small:?}");
    let wrong_format = compress(CompressionOptions {
        split_size: Some(MIN_SPLIT_SIZE),
        ..options(&[&input], &work.path().join("a.tar"), ArchiveFormat::Tar)
    });
    assert!(matches!(wrong_format, Err(LiberaError::SplitNotSupportedForFormat { .. })), "{wrong_format:?}");
}
