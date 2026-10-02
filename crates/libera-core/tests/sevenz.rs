//! 7z read through archives the reference 7-Zip and the Electron app wrote,
//! and written by the engine itself, which libarchive's bsdtar reads back.

mod common;
#[allow(dead_code)]
mod fixtures {
    pub mod seven_zip;
}

use std::fs;
use std::path::{Path, PathBuf};

use common::*;
use fixtures::seven_zip;
use libera_core::{
    ArchiveFormat, CancelToken, CompressionOptions, ExtractionOptions, LiberaError, MIN_SPLIT_SIZE, OverrideScope,
    SevenZipDictionary, SevenZipMethod, SevenZipMethodOverride, compress_archive, extract_archive_with,
    plan_seven_zip_solid_blocks, resolve_extraction_input,
};

fn fixture(work: &Path, name: &str, base64_text: &str) -> PathBuf {
    let archive = work.join(name);
    fs::write(&archive, base64(base64_text)).unwrap();
    archive
}

fn with_password(archive: &Path, target: &Path, password: &str) -> ExtractionOptions {
    ExtractionOptions { password: Some(password.into()), ..extraction(archive, target) }
}

/// The one file of a fixture whose name ends with `name`, read back.
fn read_named(target: &Path, name: &str) -> Vec<u8> {
    let found = tree(target)
        .into_iter()
        .find(|path| path.ends_with(name))
        .unwrap_or_else(|| panic!("{name} in {:?}", tree(target)));
    fs::read(target.join(found)).unwrap()
}

#[test]
fn decodes_every_coder_the_reference_7_zip_wrote() {
    let cases: Vec<(&str, &str, &str, Vec<u8>)> = vec![
        ("lzma2", seven_zip::LZMA2, "repeated.txt", "external lzma2 match stream\n".repeat(10_000).into_bytes()),
        (
            "lzma1-plain",
            seven_zip::LZMA1_PLAIN_HEADER,
            "repeated.txt",
            "external lzma1 match stream\n".repeat(10_000).into_bytes(),
        ),
        (
            "lzma1-encoded",
            seven_zip::LZMA1_ENCODED_HEADER,
            "repeated.txt",
            "external lzma1 match stream\n".repeat(10_000).into_bytes(),
        ),
        ("deflate", seven_zip::DEFLATE, "repeated.txt", "external deflate match stream\n".repeat(10_000).into_bytes()),
        ("bzip2", seven_zip::BZIP2, "repeated.txt", "external bzip2 match stream\n".repeat(10_000).into_bytes()),
        ("ppmd", seven_zip::PPMD, "repeated.txt", "external ppmd match stream\n".repeat(10_000).into_bytes()),
        ("bcj", seven_zip::FILTER_BCJ, "filtered.bin", vec![0xe8, 0x10, 0, 0, 0, 0x90, 0xe9, 0xf0, 0xff, 0xff, 0xff]),
        ("ppc", seven_zip::FILTER_PPC, "filtered.bin", vec![0x48, 0, 0, 1, 0x48, 0, 1, 1]),
        ("arm", seven_zip::FILTER_ARM, "filtered.bin", vec![0, 0, 0, 0xeb, 4, 0, 0, 0xeb]),
        ("armt", seven_zip::FILTER_ARMT, "filtered.bin", vec![0, 0xf0, 0, 0xf8, 1, 0xf0, 2, 0xf8]),
        ("sparc", seven_zip::FILTER_SPARC, "filtered.bin", vec![0x40, 0, 0, 0, 0x7f, 0xff, 0xff, 0xff]),
        ("ia64", seven_zip::FILTER_IA64, "filtered.bin", (0..64u32).map(|index| (index * 17) as u8).collect()),
        (
            "delta",
            seven_zip::FILTER_DELTA_4,
            "filtered.bin",
            (0..257u32).map(|index| ((index * 29) & 0xff) as u8).collect(),
        ),
        (
            "bcj2",
            seven_zip::BCJ2,
            "program.bin",
            [0x90, 0xe8, 0x10, 0, 0, 0, 0x0f, 0x84, 0x20, 0, 0, 0, 0xe9, 0xf0, 0xff, 0xff, 0xff].repeat(1_000),
        ),
    ];
    for (name, data, file, expected) in cases {
        let work = TempDir::new().unwrap();
        let archive = fixture(work.path(), &format!("{name}.7z"), data);
        let target = work.path().join("out");

        extract(extraction(&archive, &target)).unwrap_or_else(|error| panic!("{name}: {error:?}"));

        assert_eq!(read_named(&target, file), expected, "{name}");
    }
}

/// The coders sevenz-rust2 does not decode. The Electron engine's own reader
/// did; here they are refused by name rather than misread.
#[test]
fn refuses_the_byte_swap_filters_and_deflate64_cleanly() {
    for (name, data) in
        [("swap2", seven_zip::FILTER_SWAP2), ("swap4", seven_zip::FILTER_SWAP4), ("deflate64", seven_zip::DEFLATE64)]
    {
        let work = TempDir::new().unwrap();
        let archive = fixture(work.path(), &format!("{name}.7z"), data);
        let target = work.path().join("out");

        let result = extract(extraction(&archive, &target));

        assert!(matches!(result, Err(LiberaError::UnsupportedArchive { .. })), "{name}: {result:?}");
        assert!(!target.exists(), "{name}");
    }
}

#[test]
fn reads_selected_files_out_of_a_reference_solid_block() {
    let work = TempDir::new().unwrap();
    let archive = fixture(work.path(), "solid.7z", seven_zip::SOLID);
    let everything = work.path().join("all");
    extract(extraction(&archive, &everything)).unwrap();
    assert_eq!(read_named(&everything, "a.txt"), "alpha ".repeat(400_000).into_bytes());
    assert_eq!(read_named(&everything, "c.txt"), "charlie ".repeat(20_000).into_bytes());

    let c_path = tree(&everything).into_iter().find(|path| path.ends_with("c.txt")).unwrap();
    let target = work.path().join("one");
    extract(ExtractionOptions { selected_entries: Some(vec![c_path.clone()]), ..extraction(&archive, &target) })
        .unwrap();
    assert_eq!(tree(&target).into_iter().filter(|path| !path.ends_with('/')).collect::<Vec<_>>(), [c_path]);
}

#[test]
fn decrypts_reference_aes_data_and_asks_for_the_password_it_needs() {
    let expected = "encrypted external archive\n".repeat(1_000).into_bytes();
    let work = TempDir::new().unwrap();
    let archive = fixture(work.path(), "aes-data.7z", seven_zip::AES_DATA);
    let target = work.path().join("out");

    let missing = extract(extraction(&archive, &target));
    assert!(matches!(missing, Err(LiberaError::PasswordRequired)), "{missing:?}");
    let wrong = extract(with_password(&archive, &target, "wrong"));
    assert!(matches!(wrong, Err(LiberaError::WrongPassword)), "{wrong:?}");
    assert!(!target.exists());
    extract(with_password(&archive, &target, "hunter2")).unwrap();
    assert_eq!(read_named(&target, "secret.txt"), expected);
}

#[test]
fn needs_the_password_to_read_even_the_names_under_an_encrypted_header() {
    for (name, data) in [("aes-header", seven_zip::AES_HEADER), ("py7zr", seven_zip::AES_HEADER_PY7ZR)] {
        let work = TempDir::new().unwrap();
        let archive = fixture(work.path(), "hidden.7z", data);
        let target = work.path().join("out");

        let missing = extract(extraction(&archive, &target));
        assert!(matches!(missing, Err(LiberaError::PasswordRequired)), "{name}: {missing:?}");
        let wrong = extract(with_password(&archive, &target, "wrong"));
        assert!(matches!(wrong, Err(LiberaError::WrongPassword)), "{name}: {wrong:?}");
        extract(with_password(&archive, &target, "hunter2")).unwrap();
        assert_eq!(
            read_named(&target, "secret.txt"),
            "encrypted external archive\n".repeat(1_000).into_bytes(),
            "{name}"
        );
    }
}

#[test]
fn reads_the_solid_archives_the_electron_app_wrote() {
    for (name, data, password) in [
        ("solid", seven_zip::LIBERA7Z_SOLID, None),
        ("hidden", seven_zip::LIBERA7Z_SOLID_ENCRYPTED_HEADER, Some("hunter2")),
    ] {
        let work = TempDir::new().unwrap();
        let archive = fixture(work.path(), "electron.7z", data);
        let target = work.path().join("out");

        let result =
            extract(ExtractionOptions { password: password.map(Into::into), ..extraction(&archive, &target) }).unwrap();

        assert_eq!(result.extracted_count, 5, "{name}");
        assert_eq!(
            tree(&target),
            [
                "project/",
                "project/a.txt",
                "project/c.txt",
                "project/link",
                "project/sub/",
                "project/sub/b.txt",
                "project/sub/empty.txt"
            ]
        );
        assert_eq!(read(&target, "project/a.txt"), "alpha ".repeat(2000));
        assert_eq!(read(&target, "project/sub/b.txt"), "bravo ".repeat(1500));
        assert_eq!(read(&target, "project/c.txt"), "charlie ".repeat(1000));
        assert_eq!(read(&target, "project/sub/empty.txt"), "");
        #[cfg(unix)]
        assert_eq!(fs::read_link(target.join("project/link")).unwrap().to_str(), Some("a.txt"));
    }
}

fn seven_zip(inputs: &[&Path], output: &Path) -> CompressionOptions {
    options(inputs, output, ArchiveFormat::SevenZip)
}

/// A project with nested folders, an empty file and a link, so solid blocks
/// have things between their files in walk order.
fn project(root: &Path) -> PathBuf {
    let source = root.join("project");
    write_file(&source, "a.txt", "alpha ".repeat(5000));
    write_file(&source, "sub/b.txt", "bravo ".repeat(3000));
    write_file(&source, "sub/empty.txt", "");
    write_file(&source, "c.bin", noise(70_000));
    fs::create_dir_all(source.join("empty-dir")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("a.txt", source.join("link")).unwrap();
    source
}

fn assert_project(target: &Path) {
    assert_eq!(read(target, "project/a.txt"), "alpha ".repeat(5000));
    assert_eq!(read(target, "project/sub/b.txt"), "bravo ".repeat(3000));
    assert_eq!(read(target, "project/sub/empty.txt"), "");
    assert_eq!(fs::read(target.join("project/c.bin")).unwrap(), noise(70_000));
    assert!(target.join("project/empty-dir").is_dir());
    #[cfg(unix)]
    assert_eq!(fs::read_link(target.join("project/link")).unwrap().to_str(), Some("a.txt"));
}

#[test]
fn round_trips_a_project_whole_and_solid_and_bsdtar_agrees() {
    for solid in [false, true] {
        let work = TempDir::new().unwrap();
        let source = project(work.path());
        let archive = work.path().join("project.7z");

        let result =
            compress(CompressionOptions { solid_archive: Some(solid), ..seven_zip(&[&source], &archive) }).unwrap();

        assert_eq!(result.original_size, 30_000 + 18_000 + 70_000);
        assert_eq!(result.volume_paths, None);
        let target = work.path().join("out");
        extract(extraction(&archive, &target)).unwrap();
        assert_project(&target);

        let unpacked = work.path().join("bsdtar");
        fs::create_dir(&unpacked).unwrap();
        run("tar", &["-xf", &path(&archive), "-C", &path(&unpacked)], work.path());
        assert_project(&unpacked);
    }
}

#[test]
fn stores_with_copy_at_level_zero_or_when_asked() {
    let work = TempDir::new().unwrap();
    let source = project(work.path());
    for (name, options) in [
        ("level0.7z", CompressionOptions { level: Some(0), ..seven_zip(&[&source], &work.path().join("level0.7z")) }),
        (
            "copy.7z",
            CompressionOptions {
                seven_zip_method: Some(SevenZipMethod::Copy),
                ..seven_zip(&[&source], &work.path().join("copy.7z"))
            },
        ),
    ] {
        let result = compress(options).unwrap();
        assert!(result.compressed_size > result.original_size, "{name}");
        let target = work.path().join(name.replace(".7z", ""));
        extract(extraction(&work.path().join(name), &target)).unwrap();
        assert_project(&target);
    }
}

#[test]
fn reads_the_7z_archives_bsdtar_writes() {
    let work = TempDir::new().unwrap();
    write_file(work.path(), "data/notes.txt", "notes ".repeat(4000));
    write_file(work.path(), "data/blob.bin", noise(50_000));
    write_file(work.path(), "data/empty.txt", "");
    for compression in ["store", "deflate", "bzip2", "lzma1", "lzma2", "ppmd"] {
        let archive = work.path().join(format!("{compression}.7z"));
        run(
            "tar",
            &[
                "-cf",
                &path(&archive),
                "--format",
                "7zip",
                "--options",
                &format!("7zip:compression={compression}"),
                "data",
            ],
            work.path(),
        );
        let target = work.path().join(format!("out-{compression}"));

        extract(extraction(&archive, &target)).unwrap_or_else(|error| panic!("{compression}: {error:?}"));

        assert_eq!(read(&target, "data/notes.txt"), "notes ".repeat(4000), "{compression}");
        assert_eq!(fs::read(target.join("data/blob.bin")).unwrap(), noise(50_000), "{compression}");
        assert_eq!(read(&target, "data/empty.txt"), "", "{compression}");
    }
}

#[test]
fn encrypts_the_data_and_on_request_the_names() {
    for encrypt_file_names in [false, true] {
        let work = TempDir::new().unwrap();
        let source = project(work.path());
        let archive = work.path().join("secret.7z");

        compress(CompressionOptions {
            password: Some("hunter2".into()),
            encrypt_file_names: Some(encrypt_file_names),
            solid_archive: Some(true),
            ..seven_zip(&[&source], &archive)
        })
        .unwrap();

        // The data is never in the clear; the names are, unless hidden too.
        let bytes = fs::read(&archive).unwrap();
        let contains = |needle: &[u8]| bytes.windows(needle.len()).any(|window| window == needle);
        let name: Vec<u8> = "empty.txt".encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert!(!contains(b"bravo bravo"));
        assert_eq!(contains(&name), !encrypt_file_names);

        let target = work.path().join("out");
        let missing = extract(extraction(&archive, &target));
        assert!(matches!(missing, Err(LiberaError::PasswordRequired)), "{missing:?}");
        let wrong = extract(with_password(&archive, &target, "wrong"));
        assert!(matches!(wrong, Err(LiberaError::WrongPassword)), "{wrong:?}");
        assert!(!target.exists());
        extract(with_password(&archive, &target, "hunter2")).unwrap();
        assert_project(&target);
    }
}

#[test]
fn applies_a_folder_method_with_a_file_exception_and_plans_the_blocks_a_write_lays_down() {
    let work = TempDir::new().unwrap();
    let source = work.path().join("src");
    write_file(&source, "a.txt", "alpha ".repeat(1000));
    write_file(&source, "photos/b.jpg", noise(10_000));
    write_file(&source, "photos/c.jpg", noise(10_000));
    write_file(&source, "photos/keep.txt", "keep ".repeat(1000));
    write_file(&source, "z.txt", "zulu ".repeat(1000));
    write_file(&source, "empty.txt", "");
    let rules = vec![
        SevenZipMethodOverride {
            source_path: path(&source.join("photos")),
            scope: OverrideScope::Tree,
            method: SevenZipMethod::Copy,
            level: None,
            dictionary_size: None,
            match_finder_word_size: None,
            search_cycles: None,
        },
        SevenZipMethodOverride {
            source_path: path(&source.join("photos/keep.txt")),
            scope: OverrideScope::File,
            method: SevenZipMethod::Lzma2,
            level: Some(9),
            dictionary_size: Some(SevenZipDictionary::Bytes { size: 1 << 20 }),
            match_finder_word_size: None,
            search_cycles: None,
        },
    ];
    let archive = work.path().join("rules.7z");
    let options = CompressionOptions {
        level: Some(5),
        solid_archive: Some(true),
        seven_zip_method_overrides: Some(rules),
        ..seven_zip(&[&source], &archive)
    };

    let blocks = plan_seven_zip_solid_blocks(options.clone()).unwrap();

    let names = |block: &libera_core::SevenZipSolidBlock| {
        block.entries.iter().map(|entry| entry.path.clone()).collect::<Vec<_>>()
    };
    assert_eq!(
        blocks.iter().map(|block| (block.method, names(block))).collect::<Vec<_>>(),
        [
            (SevenZipMethod::Lzma2, vec!["src/a.txt".to_owned()]),
            (SevenZipMethod::Copy, vec!["src/photos/b.jpg".to_owned()]),
            (SevenZipMethod::Copy, vec!["src/photos/c.jpg".to_owned()]),
            (SevenZipMethod::Lzma2, vec!["src/photos/keep.txt".to_owned()]),
            (SevenZipMethod::Lzma2, vec!["src/z.txt".to_owned()]),
        ]
    );
    assert_eq!(blocks[3].dictionary_size, Some(1 << 20));
    assert_eq!(blocks[0].dictionary_size, Some(64 << 10));

    compress(options).unwrap();
    let mut file = fs::File::open(&archive).unwrap();
    let written = sevenz_rust2::Archive::read(&mut file, &sevenz_rust2::Password::empty()).unwrap();
    let coders: Vec<Vec<u8>> = written
        .blocks
        .iter()
        .map(|block| block.coders.iter().flat_map(|coder| coder.encoder_method_id().to_vec()).collect())
        .collect();
    assert_eq!(coders, [vec![0x21], vec![0x00], vec![0x00], vec![0x21], vec![0x21]]);
    let target = work.path().join("out");
    extract(extraction(&archive, &target)).unwrap();
    assert_eq!(fs::read(target.join("src/photos/c.jpg")).unwrap(), noise(10_000));
}

#[test]
fn joins_adjacent_files_into_one_solid_block_only_in_solid_mode() {
    let work = TempDir::new().unwrap();
    let source = work.path().join("src");
    for name in ["a.txt", "b.txt", "c.txt"] {
        write_file(&source, name, name.repeat(1000));
    }
    let count = |solid: bool| {
        plan_seven_zip_solid_blocks(CompressionOptions {
            solid_archive: Some(solid),
            ..seven_zip(&[&source], &work.path().join("x.7z"))
        })
        .unwrap()
        .len()
    };
    assert_eq!((count(true), count(false)), (1, 3));
    assert!(plan_seven_zip_solid_blocks(seven_zip(&[], &work.path().join("x.7z"))).unwrap().is_empty());
}

#[test]
fn splits_into_numbered_volumes_that_open_from_any_of_them() {
    let work = TempDir::new().unwrap();
    let input = write_file(work.path(), "big.bin", noise(3 << 20));
    let archive = work.path().join("set.7z");
    fs::write(work.path().join("set.7z.009"), "stale").unwrap();
    fs::write(&archive, "stale whole archive").unwrap();

    let result = compress(CompressionOptions {
        level: Some(0),
        split_size: Some(MIN_SPLIT_SIZE),
        ..seven_zip(&[&input], &archive)
    })
    .unwrap();

    let volumes = result.volume_paths.unwrap();
    assert_eq!(volumes.len(), 4);
    assert_eq!(result.output_path, volumes[0]);
    assert!(volumes[0].ends_with("set.7z.001"));
    assert!(!work.path().join("set.7z.009").exists());
    assert!(!archive.exists());
    for entry_point in ["set.7z.001", "set.7z.003"] {
        let resolved = resolve_extraction_input(path(&work.path().join(entry_point))).unwrap();
        assert_eq!(resolved.volumes.as_ref().map(Vec::len), Some(4));
        assert_eq!(resolved.path, volumes[0]);
        let target = work.path().join(format!("out-{entry_point}"));
        extract(extraction(&work.path().join(entry_point), &target)).unwrap();
        assert_eq!(fs::read(target.join("big.bin")).unwrap(), noise(3 << 20));
    }

    fs::remove_file(&volumes[3]).unwrap();
    let truncated = resolve_extraction_input(path(&work.path().join("set.7z.001")));
    let Err(LiberaError::SplitVolumeMissing { message }) = truncated else { panic!("{truncated:?}") };
    assert!(message.contains("set.7z.004"), "{message}");
    fs::remove_file(&volumes[1]).unwrap();
    let gap = resolve_extraction_input(path(&work.path().join("set.7z.001")));
    let Err(LiberaError::SplitVolumeMissing { message }) = gap else { panic!("{gap:?}") };
    assert!(message.contains("set.7z.002"), "{message}");
}

#[test]
fn numbers_a_set_that_fits_in_one_volume() {
    let work = TempDir::new().unwrap();
    let input = write_file(work.path(), "small.txt", "small");
    let archive = work.path().join("one.7z");

    let result =
        compress(CompressionOptions { split_size: Some(MIN_SPLIT_SIZE), ..seven_zip(&[&input], &archive) }).unwrap();

    assert_eq!(result.volume_paths.unwrap().len(), 1);
    assert!(work.path().join("one.7z.001").exists());
    extract(extraction(&work.path().join("one.7z.001"), &work.path().join("out"))).unwrap();
}

#[test]
fn leaves_the_previous_set_alone_when_a_split_run_is_cancelled() {
    let work = TempDir::new().unwrap();
    let input = write_file(work.path(), "big.bin", noise(3 << 20));
    let archive = work.path().join("set.7z");
    let split =
        CompressionOptions { level: Some(0), split_size: Some(MIN_SPLIT_SIZE), ..seven_zip(&[&input], &archive) };
    let before = compress(split.clone()).unwrap().volume_paths.unwrap();
    let contents: Vec<Vec<u8>> = before.iter().map(|volume| fs::read(volume).unwrap()).collect();

    let token = CancelToken::new();
    let result = compress_archive(split, Recorder::cancelling(&token), token.clone());

    assert!(matches!(result, Err(LiberaError::CompressionCancelled)), "{result:?}");
    assert_eq!(before.iter().map(|volume| fs::read(volume).unwrap()).collect::<Vec<_>>(), contents);
    assert!(tree(work.path()).iter().all(|name| !name.ends_with(".partial")), "{:?}", tree(work.path()));
}

#[test]
fn keeps_its_own_archive_and_volumes_out_of_the_input() {
    let work = TempDir::new().unwrap();
    let source = work.path().join("source");
    write_file(&source, "data.txt", "data");
    fs::write(source.join("inside.7z.001"), "an earlier set").unwrap();
    let archive = source.join("inside.7z");

    compress(seven_zip(&[&source], &archive)).unwrap();

    let target = work.path().join("out");
    extract(extraction(&archive, &target)).unwrap();
    assert_eq!(tree(&target), ["source/", "source/data.txt"]);
}

#[cfg(unix)]
#[test]
fn refuses_a_link_that_points_out_of_the_destination() {
    let work = TempDir::new().unwrap();
    let source = work.path().join("source");
    fs::create_dir(&source).unwrap();
    std::os::unix::fs::symlink("../../outside", source.join("escape")).unwrap();
    let archive = work.path().join("escape.7z");
    compress(seven_zip(&[&source], &archive)).unwrap();

    let result = extract(extraction(&archive, &work.path().join("out")));

    let Err(LiberaError::UnsafeArchive { message }) = result else { panic!("{result:?}") };
    assert!(message.contains("symlink target escapes the destination"), "{message}");
    let excluded =
        extract(ExtractionOptions { restore_symlinks: Some(false), ..extraction(&archive, &work.path().join("out2")) })
            .unwrap();
    assert_eq!(excluded.symbolic_links_excluded, 1);
}

#[test]
fn refuses_7z_options_it_cannot_follow() {
    let work = TempDir::new().unwrap();
    let input = write_file(work.path(), "a.txt", "a");
    let output = work.path().join("out.7z");
    let refused = [
        CompressionOptions { solid_archive: Some(true), ..options(&[&input], &output, ArchiveFormat::Zip) },
        CompressionOptions { dictionary_size: Some(1 << 10), ..seven_zip(&[&input], &output) },
        CompressionOptions { match_finder_word_size: Some(100), ..seven_zip(&[&input], &output) },
        CompressionOptions { search_cycles: Some(2000), ..seven_zip(&[&input], &output) },
        CompressionOptions { encrypt_file_names: Some(true), ..seven_zip(&[&input], &output) },
        CompressionOptions {
            encrypt_file_names: Some(true),
            password: Some("pw".into()),
            ..options(&[&input], &output, ArchiveFormat::Zip)
        },
        CompressionOptions { zstd_workers: Some(2), ..seven_zip(&[&input], &output) },
    ];
    for options in refused {
        let description = format!("{options:?}");
        assert!(matches!(compress(options), Err(LiberaError::InvalidInput { .. })), "{description}");
    }
    let too_many = compress(CompressionOptions { split_size: Some(MIN_SPLIT_SIZE), ..seven_zip(&[&input], &output) });
    assert!(too_many.is_ok());
}

#[test]
fn cancels_compression_and_extraction_and_removes_what_they_wrote() {
    let work = TempDir::new().unwrap();
    let input = write_file(work.path(), "big.bin", noise(4 << 20));
    let archive = work.path().join("big.7z");
    let token = CancelToken::new();
    let result = compress_archive(seven_zip(&[&input], &archive), Recorder::cancelling(&token), token.clone());
    assert!(matches!(result, Err(LiberaError::CompressionCancelled)), "{result:?}");
    assert!(!archive.exists());

    compress(CompressionOptions { level: Some(0), ..seven_zip(&[&input], &archive) }).unwrap();
    let target = work.path().join("nested/out");
    let token = CancelToken::new();
    let result =
        extract_archive_with(extraction(&archive, &target), Recorder::cancelling(&token), token.clone(), roomy());
    assert!(matches!(result, Err(LiberaError::ExtractionCancelled)), "{result:?}");
    assert!(!work.path().join("nested").exists());
}
