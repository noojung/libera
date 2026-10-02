//! The TAR family and the lone-file writers, read back by the engine itself
//! and by the reference tools.

mod common;

use std::fs::{self, File};
use std::io::Read;
use std::path::Path;
use std::sync::Arc;

use common::*;
use flate2::read::GzDecoder;
use libera_core::{
    ArchiveFormat, CancelToken, CompressionOptions, DeflateStrategy, LiberaError, ProgressPhase, ZstdStrategy,
    compress_archive,
};

fn gunzip(archive: &Path) -> Vec<u8> {
    let mut bytes = Vec::new();
    GzDecoder::new(File::open(archive).unwrap()).read_to_end(&mut bytes).unwrap();
    bytes
}

fn unzstd(archive: &Path) -> Vec<u8> {
    zstd::decode_all(File::open(archive).unwrap()).unwrap()
}

/// The paths stored in a TAR, TAR.GZ or TAR.ZST, in order.
fn stored_paths(archive: &Path) -> Vec<String> {
    let bytes = fs::read(archive).unwrap();
    let name = archive.to_string_lossy();
    if name.ends_with(".tgz") || name.ends_with(".tar.gz") {
        tar_paths(&gunzip(archive))
    } else if name.ends_with(".tar.zst") {
        tar_paths(&unzstd(archive))
    } else {
        tar_paths(&bytes)
    }
}

fn names(archive: &Path) -> Vec<String> {
    stored_paths(archive)
        .iter()
        .map(|stored| stored.trim_end_matches('/').rsplit('/').next().unwrap().to_owned())
        .collect()
}

#[test]
fn round_trips_a_folder_and_a_file_through_each_tar_format() {
    for (format, suffix) in [(ArchiveFormat::Tar, "tar"), (ArchiveFormat::Tgz, "tgz"), (ArchiveFormat::Tzst, "tar.zst")]
    {
        let work = TempDir::new().unwrap();
        let folder = work.path().join("photos");
        write_file(&folder, "notes.txt", "hello");
        write_file(&folder, "2026/raw.bin", noise(300_000));
        let single = write_file(work.path(), "readme.md", "# readme");
        let archive = work.path().join(format!("out.{suffix}"));
        let listener = Recorder::new();

        let result =
            compress_archive(options(&[&folder, &single], &archive, format), listener.clone(), CancelToken::new())
                .unwrap();

        assert_eq!(result.original_size, 300_000 + 5 + 8, "{suffix}");
        assert_eq!(result.compressed_size, fs::metadata(&archive).unwrap().len());
        assert_eq!(result.volume_paths, None);
        assert_eq!(
            stored_paths(&archive),
            ["photos/", "photos/2026/", "photos/2026/raw.bin", "photos/notes.txt", "readme.md"],
            "{suffix}"
        );
        let last = listener.last();
        assert_eq!(
            (last.phase, last.percent, last.processed_bytes),
            (ProgressPhase::Complete, Some(100), result.original_size)
        );

        let target = work.path().join("unpacked");
        let extracted = extract(extraction(&archive, &target)).unwrap();
        assert_eq!(extracted.extracted_count, 3, "{suffix}");
        assert_eq!(fs::read(target.join("photos/2026/raw.bin")).unwrap(), noise(300_000));
        assert_eq!(read(&target, "readme.md"), "# readme");
    }
}

#[test]
fn names_same_named_roots_apart() {
    let work = TempDir::new().unwrap();
    for parent in ["a", "b", "c"] {
        fs::create_dir_all(work.path().join(parent).join("src")).unwrap();
    }
    fs::create_dir(work.path().join("other")).unwrap();
    let archive = work.path().join("out.tar");
    let roots: Vec<_> = ["a/src", "b/src", "other", "c/src"].iter().map(|root| work.path().join(root)).collect();

    compress(options(&roots.iter().map(|root| root.as_path()).collect::<Vec<_>>(), &archive, ArchiveFormat::Tar))
        .unwrap();

    assert_eq!(stored_paths(&archive), ["src/", "src (2)/", "other/", "src (3)/"]);
}

#[test]
fn leaves_out_an_archive_saved_inside_its_own_input() {
    let work = TempDir::new().unwrap();
    let folder = work.path().join("docs");
    write_file(&folder, "a.txt", "a");
    let archive = folder.join("docs.tgz");

    let result = compress(options(&[&folder], &archive, ArchiveFormat::Tgz)).unwrap();

    assert_eq!(result.original_size, 1);
    assert_eq!(stored_paths(&archive), ["docs/", "docs/a.txt"]);
}

#[cfg(unix)]
#[test]
fn stores_a_symbolic_link_as_a_link_entry_that_extracts_back_as_one() {
    let work = TempDir::new().unwrap();
    let folder = work.path().join("source");
    write_file(&folder, "real.txt", "real contents");
    std::os::unix::fs::symlink("real.txt", folder.join("link.txt")).unwrap();
    let archive = work.path().join("links.tar");

    compress(options(&[&folder], &archive, ArchiveFormat::Tar)).unwrap();
    let target = work.path().join("restored");
    extract(libera_core::ExtractionOptions { restore_symlinks: Some(true), ..extraction(&archive, &target) }).unwrap();

    assert_eq!(fs::read_link(target.join("source/link.txt")).unwrap().to_str(), Some("real.txt"));
}

#[cfg(unix)]
#[test]
fn leaves_symbolic_links_out_when_they_are_excluded() {
    let work = TempDir::new().unwrap();
    let folder = work.path().join("source");
    write_file(&folder, "real.txt", "real contents");
    std::os::unix::fs::symlink("real.txt", folder.join("link.txt")).unwrap();
    let archive = work.path().join("filtered.tar");

    compress(CompressionOptions { exclude_symlinks: Some(true), ..options(&[&folder], &archive, ArchiveFormat::Tar) })
        .unwrap();

    assert_eq!(names(&archive), ["source", "real.txt"]);
}

/// A folder holding every kind of bookkeeping file macOS leaves behind.
fn noisy_source(root: &Path) -> std::path::PathBuf {
    let source = root.join("source");
    write_file(&source, "payload.txt", "payload");
    write_file(&source, ".DS_Store", "finder state");
    write_file(&source, "._payload.txt", "resource fork");
    write_file(&source, "__MACOSX/note.txt", "sidecar");
    write_file(&source, "docs/.DS_Store", "nested finder state");
    source
}

#[test]
fn leaves_macos_metadata_out_when_it_is_excluded_and_out_of_the_total_too() {
    let work = TempDir::new().unwrap();
    let source = noisy_source(work.path());
    let archive = work.path().join("clean.tar");

    let result = compress(CompressionOptions {
        exclude_mac_metadata: Some(true),
        ..options(&[&source], &archive, ArchiveFormat::Tar)
    })
    .unwrap();

    assert_eq!(names(&archive), ["source", "docs", "payload.txt"]);
    assert_eq!(result.original_size, "payload".len() as u64);
}

#[test]
fn keeps_macos_metadata_by_default() {
    let work = TempDir::new().unwrap();
    let source = noisy_source(work.path());
    let archive = work.path().join("noisy.tar");

    let result = compress(options(&[&source], &archive, ArchiveFormat::Tar)).unwrap();

    let names = names(&archive);
    for name in [".DS_Store", "._payload.txt", "__MACOSX"] {
        assert!(names.contains(&name.to_owned()), "{name}");
    }
    assert_eq!(result.original_size, "payloadfinder stateresource forksidecarnested finder state".len() as u64);
}

/// A folder whose dot-prefixed names hold the only copy of some content.
fn dotted_source(root: &Path) -> std::path::PathBuf {
    let source = root.join("source");
    write_file(&source, "payload.txt", "payload");
    write_file(&source, ".env", "SECRET=1");
    write_file(&source, ".git/HEAD", "ref: refs/heads/main");
    write_file(&source, "docs/notes.md", "# notes");
    write_file(&source, "docs/scratch.tmp", "scratch");
    source
}

#[test]
fn leaves_hidden_names_and_their_subtrees_out_when_they_are_excluded() {
    let work = TempDir::new().unwrap();
    let source = dotted_source(work.path());
    let archive = work.path().join("visible.tar");

    let result = compress(CompressionOptions {
        exclude_hidden_files: Some(true),
        ..options(&[&source], &archive, ArchiveFormat::Tar)
    })
    .unwrap();

    assert_eq!(names(&archive), ["source", "docs", "notes.md", "scratch.tmp", "payload.txt"]);
    assert_eq!(result.original_size, "payload# notesscratch".len() as u64);
}

#[test]
fn keeps_only_the_files_a_filter_pattern_matches() {
    let work = TempDir::new().unwrap();
    let source = dotted_source(work.path());
    let archive = work.path().join("matched.tar");

    let result = compress(CompressionOptions {
        filter_pattern: Some("*.txt, *.md".into()),
        ..options(&[&source], &archive, ArchiveFormat::Tar)
    })
    .unwrap();

    // A folder matches no pattern of its own, yet still carries what does.
    assert_eq!(names(&archive), ["source", ".git", "docs", "notes.md", "payload.txt"]);
    assert_eq!(result.original_size, "payload# notes".len() as u64);
}

#[test]
fn subtracts_an_exclusion_only_pattern_from_the_whole_tree() {
    let work = TempDir::new().unwrap();
    let source = dotted_source(work.path());
    let archive = work.path().join("subtracted.tar");

    compress(CompressionOptions {
        filter_pattern: Some("!*.tmp".into()),
        ..options(&[&source], &archive, ArchiveFormat::Tar)
    })
    .unwrap();

    let names = names(&archive);
    assert!(names.contains(&".env".to_owned()));
    assert!(names.contains(&"payload.txt".to_owned()));
    assert!(!names.contains(&"scratch.tmp".to_owned()));
}

#[test]
fn creates_gz_and_zst_archives_for_a_single_file_and_reports_completion() {
    for (format, suffix) in [(ArchiveFormat::Gz, "gz"), (ArchiveFormat::Zst, "zst")] {
        let work = TempDir::new().unwrap();
        let input = write_file(work.path(), "report.txt", noise(500_000));
        let archive = work.path().join(format!("report.txt.{suffix}"));
        let listener = Recorder::new();

        let result =
            compress_archive(options(&[&input], &archive, format), listener.clone(), CancelToken::new()).unwrap();

        assert_eq!(result.original_size, 500_000);
        let decoded = if format == ArchiveFormat::Gz { gunzip(&archive) } else { unzstd(&archive) };
        assert_eq!(decoded, noise(500_000), "{suffix}");
        let last = listener.last();
        assert_eq!((last.phase, last.percent), (ProgressPhase::Complete, Some(100)));
        assert_eq!(last.current_file, None);
        assert!(listener.events().iter().any(|event| event.current_file.as_deref() == Some("report.txt")));
    }
}

#[test]
fn refuses_a_folder_or_nothing_for_the_formats_that_wrap_one_file() {
    let work = TempDir::new().unwrap();
    let folder = work.path().join("folder");
    fs::create_dir(&folder).unwrap();

    for format in [ArchiveFormat::Gz, ArchiveFormat::Zst] {
        let archive = work.path().join("out");
        let folder_result = compress(options(&[&folder], &archive, format));
        assert!(matches!(folder_result, Err(LiberaError::InvalidSingleFileInput { .. })), "{folder_result:?}");
        let empty_result = compress(options(&[], &archive, format));
        assert!(matches!(empty_result, Err(LiberaError::InvalidSingleFileInput { .. })), "{empty_result:?}");
        assert!(!archive.exists());
    }
}

#[test]
fn rejects_source_filters_for_a_format_that_holds_a_single_stream() {
    let work = TempDir::new().unwrap();
    let input = write_file(work.path(), "report.txt", "report");

    let result = compress(CompressionOptions {
        exclude_mac_metadata: Some(true),
        ..options(&[&input], &work.path().join("report.txt.gz"), ArchiveFormat::Gz)
    });

    let Err(LiberaError::InvalidInput { message }) = result else { panic!("{result:?}") };
    assert!(message.contains("Source filters"), "{message}");
}

/// A payload whose only repeat is `distance` bytes back, past anything a
/// narrow window can reach.
fn far_repeat(distance: usize) -> Vec<u8> {
    let block = noise(distance);
    [block.clone(), block].concat()
}

fn compressed_size(work: &Path, input: &Path, tune: impl FnOnce(CompressionOptions) -> CompressionOptions) -> u64 {
    let archive = work.join("tuned.zst");
    let _ = fs::remove_file(&archive);
    compress(tune(options(&[input], &archive, ArchiveFormat::Zst))).unwrap();
    assert_eq!(unzstd(&archive), fs::read(input).unwrap());
    fs::metadata(&archive).unwrap().len()
}

#[test]
fn reaches_further_for_a_repeat_when_the_window_is_widened() {
    let work = TempDir::new().unwrap();
    let input = write_file(work.path(), "far.bin", far_repeat(6 << 20));

    let narrow = compressed_size(work.path(), &input, |options| CompressionOptions {
        level: Some(1),
        zstd_window_size: Some(1 << 20),
        ..options
    });
    let wide = compressed_size(work.path(), &input, |options| CompressionOptions {
        level: Some(1),
        zstd_window_size: Some(8 << 20),
        ..options
    });

    assert!(wide < narrow * 2 / 3, "wide {wide}, narrow {narrow}");
}

#[test]
fn finds_the_same_far_repeat_through_long_distance_matching() {
    let work = TempDir::new().unwrap();
    let input = write_file(work.path(), "far.bin", far_repeat(6 << 20));

    let plain = compressed_size(work.path(), &input, |options| CompressionOptions { level: Some(1), ..options });
    let long = compressed_size(work.path(), &input, |options| CompressionOptions {
        level: Some(1),
        zstd_long_distance: Some(true),
        zstd_window_size: Some(8 << 20),
        ..options
    });

    assert!(long < plain * 2 / 3, "long {long}, plain {plain}");
}

#[test]
fn writes_every_strategy_and_thread_count_so_the_reference_decoder_reads_it_back() {
    let work = TempDir::new().unwrap();
    let input = write_file(work.path(), "mixed.bin", [noise(100_000), vec![b'a'; 100_000]].concat());
    for strategy in [ZstdStrategy::Fast, ZstdStrategy::Lazy2, ZstdStrategy::Btultra2] {
        for workers in [0, 2] {
            compressed_size(work.path(), &input, |options| CompressionOptions {
                zstd_strategy: Some(strategy),
                zstd_workers: Some(workers),
                ..options
            });
        }
    }
}

#[test]
fn carries_the_zstandard_settings_into_a_tar_zst_as_well() {
    let work = TempDir::new().unwrap();
    let folder = work.path().join("far");
    write_file(&folder, "far.bin", far_repeat(6 << 20));
    let size = |window| {
        let archive = work.path().join("far.tar.zst");
        let _ = fs::remove_file(&archive);
        compress(CompressionOptions {
            level: Some(1),
            zstd_window_size: Some(window),
            ..options(&[&folder], &archive, ArchiveFormat::Tzst)
        })
        .unwrap()
        .compressed_size
    };

    assert!(size(8 << 20) < size(1 << 20) * 2 / 3);
}

#[test]
fn turns_the_level_slider_into_a_stronger_setting() {
    let work = TempDir::new().unwrap();
    // Compressible enough that the levels have room to disagree.
    let input = write_file(work.path(), "payload.txt", "libera ".repeat(20_000));

    for format in [ArchiveFormat::Gz, ArchiveFormat::Zst] {
        let size = |level| {
            let archive = work.path().join("log.out");
            let _ = fs::remove_file(&archive);
            compress(CompressionOptions { level: Some(level), ..options(&[&input], &archive, format) })
                .unwrap()
                .compressed_size
        };
        // Zstandard squeezes text this repetitive to nearly nothing at any
        // level, so there the stronger setting only has to do no worse.
        let (strong, fast) = (size(9), size(0));
        assert!(strong < fast || format == ArchiveFormat::Zst && strong <= fast, "{format:?}: {strong} vs {fast}");
    }
}

#[test]
fn refuses_codec_options_that_do_not_belong_to_the_format_or_the_codec() {
    let work = TempDir::new().unwrap();
    let input = write_file(work.path(), "a.txt", "a");
    let archive = work.path().join("out");
    let base = |format| options(&[&input], &archive, format);

    let refused = [
        CompressionOptions { zstd_workers: Some(2), ..base(ArchiveFormat::Tgz) },
        CompressionOptions { zstd_strategy: Some(ZstdStrategy::Fast), ..base(ArchiveFormat::Gz) },
        CompressionOptions { zstd_workers: Some(17), ..base(ArchiveFormat::Zst) },
        CompressionOptions { zstd_window_size: Some(3 << 20), ..base(ArchiveFormat::Zst) },
        CompressionOptions { deflate_strategy: Some(DeflateStrategy::Rle), ..base(ArchiveFormat::Tzst) },
        CompressionOptions { mem_level: Some(4), ..base(ArchiveFormat::Tar) },
        CompressionOptions { mem_level: Some(10), ..base(ArchiveFormat::Gz) },
        CompressionOptions { level: Some(10), ..base(ArchiveFormat::Gz) },
    ];
    for options in refused {
        let description = format!("{options:?}");
        assert!(matches!(compress(options), Err(LiberaError::InvalidInput { .. })), "{description}");
        assert!(!archive.exists());
    }
}

#[test]
fn applies_deflate_tuning_to_gz_and_tar_gz() {
    let work = TempDir::new().unwrap();
    let input = write_file(work.path(), "data.bin", [noise(50_000), vec![0; 50_000]].concat());
    for format in [ArchiveFormat::Gz, ArchiveFormat::Tgz] {
        for strategy in
            [DeflateStrategy::Filtered, DeflateStrategy::HuffmanOnly, DeflateStrategy::Rle, DeflateStrategy::Fixed]
        {
            let archive = work.path().join("tuned.gz");
            let _ = fs::remove_file(&archive);
            compress(CompressionOptions {
                deflate_strategy: Some(strategy),
                mem_level: Some(9),
                ..options(&[&input], &archive, format)
            })
            .unwrap();
            let decoded = gunzip(&archive);
            if format == ArchiveFormat::Gz {
                assert_eq!(decoded, fs::read(&input).unwrap());
            } else {
                assert_eq!(tar_paths(&decoded), ["data.bin"]);
            }
        }
    }
}

#[test]
fn writes_tarballs_the_system_tar_lists() {
    let work = TempDir::new().unwrap();
    let folder = work.path().join("site");
    write_file(&folder, "index.html", "<p>hi</p>");
    let long_name = format!("{}/{}.txt", "nested".repeat(12), "long".repeat(30));
    write_file(&folder, &long_name, "deep");

    for (format, flag) in [(ArchiveFormat::Tar, "-tf"), (ArchiveFormat::Tgz, "-tzf")] {
        let archive = work.path().join("site.archive");
        let _ = fs::remove_file(&archive);
        compress(options(&[&folder], &archive, format)).unwrap();

        let listed = system_tar(&[flag, &path(&archive)], work.path());

        assert_eq!(
            listed.lines().collect::<Vec<_>>(),
            ["site/", "site/index.html", &format!("site/{}/", "nested".repeat(12)), &format!("site/{long_name}")]
        );
    }
}

#[test]
fn cancelling_before_the_start_writes_nothing() {
    let work = TempDir::new().unwrap();
    let input = write_file(work.path(), "a.txt", "a");
    let archive = work.path().join("out.tgz");
    let token = CancelToken::new();
    token.cancel();

    let result = compress_archive(options(&[&input], &archive, ArchiveFormat::Tgz), Recorder::new(), token);

    assert!(matches!(result, Err(LiberaError::CompressionCancelled)));
    assert!(!archive.exists());
}

#[test]
fn cancelling_midway_removes_the_partial_archive() {
    for (format, name) in
        [(ArchiveFormat::Tgz, "out.tgz"), (ArchiveFormat::Gz, "big.bin.gz"), (ArchiveFormat::Tzst, "out.tar.zst")]
    {
        let work = TempDir::new().unwrap();
        let input = write_file(work.path(), "big.bin", noise(4 << 20));
        let archive = work.path().join(name);
        let token = CancelToken::new();

        let result =
            compress_archive(options(&[&input], &archive, format), Recorder::cancelling(&token), Arc::clone(&token));

        assert!(matches!(result, Err(LiberaError::CompressionCancelled)), "{name}: {result:?}");
        assert!(!archive.exists(), "{name}");
    }
}
