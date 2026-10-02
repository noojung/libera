//! The safety layer and the destination policies, driven through the TAR and
//! GZ readers, which every other format's reader shares them with.

mod common;

use std::fs;
use std::time::{Duration, SystemTime};

use common::*;
use libera_core::{
    CancelToken, ExtractionContext, ExtractionPolicy, LiberaError, OverwritePolicy, ProgressPhase, extract_archive_with,
};

#[test]
fn extracts_a_tar_and_reports_byte_progress_that_ends_at_the_total() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("archive.tar");
    write_tar(
        &archive,
        &[TarEntry::Folder("docs/"), TarEntry::File("docs/a.txt", b"alpha"), TarEntry::File("b.txt", b"bravo!")],
    );
    let target = work.path().join("output");
    let listener = Recorder::new();

    let result = extract_reporting(extraction(&archive, &target), listener.clone()).unwrap();

    assert_eq!((result.extracted_count, result.symbolic_links_excluded), (2, 0));
    assert_eq!(result.target_dir, fs::canonicalize(&target).unwrap().to_string_lossy());
    assert_eq!(tree(&target), ["b.txt", "docs/", "docs/a.txt"]);
    assert_eq!(read(&target, "docs/a.txt"), "alpha");
    let last = listener.last();
    assert_eq!(
        (last.phase, last.percent, last.processed_bytes, last.total_bytes),
        (ProgressPhase::Complete, Some(100), 11, Some(11))
    );
    assert!(
        listener
            .events()
            .iter()
            .filter(|event| event.phase == ProgressPhase::Processing)
            .all(|event| event.percent <= Some(99))
    );
}

#[test]
fn rejects_an_existing_target_root_when_a_new_per_archive_subfolder_is_required() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("archive.tar");
    write_tar(&archive, &[TarEntry::File("a.txt", b"a")]);
    let target = work.path().join("taken");
    fs::create_dir(&target).unwrap();

    let result =
        extract(libera_core::ExtractionOptions { reject_existing_target: true, ..extraction(&archive, &target) });

    assert!(matches!(result, Err(LiberaError::DestinationExists { .. })));
    assert!(tree(&target).is_empty());
}

#[test]
fn does_not_overwrite_an_existing_destination_file() {
    let work = TempDir::new().unwrap();
    let tar_archive = work.path().join("archive.tar");
    write_tar(&tar_archive, &[TarEntry::File("existing.txt", b"archive content")]);
    let gz_archive = work.path().join("existing.txt.gz");
    fs::write(&gz_archive, gzip(b"archive content")).unwrap();

    for archive in [&tar_archive, &gz_archive] {
        let target = work.path().join(format!("output-{}", archive.extension().unwrap().to_string_lossy()));
        write_file(&target, "existing.txt", "original content");

        let result = extract(extraction(archive, &target));

        let Err(LiberaError::DestinationExists { message }) = result else { panic!("{result:?}") };
        assert!(message.contains("destination already exists"), "{message}");
        assert_eq!(read(&target, "existing.txt"), "original content");
        assert_eq!(tree(&target), ["existing.txt"]);
    }
}

#[test]
fn supports_overwrite_and_skip_policies_while_cleaning_transactional_backups() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("archive.tar");
    write_tar(
        &archive,
        &[TarEntry::File("existing.txt", b"archive content"), TarEntry::File("new.txt", b"new content")],
    );
    let target = work.path().join("output");
    write_file(&target, "existing.txt", "original content");

    extract(libera_core::ExtractionOptions {
        overwrite_policy: Some(OverwritePolicy::Skip),
        ..extraction(&archive, &target)
    })
    .unwrap();
    assert_eq!(read(&target, "existing.txt"), "original content");
    assert_eq!(read(&target, "new.txt"), "new content");

    fs::remove_file(target.join("new.txt")).unwrap();
    extract(libera_core::ExtractionOptions {
        overwrite_policy: Some(OverwritePolicy::Overwrite),
        ..extraction(&archive, &target)
    })
    .unwrap();
    assert_eq!(read(&target, "existing.txt"), "archive content");
    assert_eq!(tree(&target), ["existing.txt", "new.txt"]);
}

#[test]
fn restores_overwritten_files_when_extraction_fails_after_creating_backups() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("archive.tar");
    write_tar(&archive, &[TarEntry::File("existing.txt", &noise(1 << 20)), TarEntry::File("later.txt", b"later")]);
    let target = work.path().join("output");
    write_file(&target, "existing.txt", "original content");
    // Cancelled once the replacement has started landing, so the job fails
    // with the original already moved aside.
    let token = CancelToken::new();

    let result = extract_archive_with(
        libera_core::ExtractionOptions {
            overwrite_policy: Some(OverwritePolicy::Overwrite),
            ..extraction(&archive, &target)
        },
        Recorder::cancelling(&token),
        token.clone(),
        roomy(),
    );

    assert!(matches!(result, Err(LiberaError::ExtractionCancelled)), "{result:?}");
    assert_eq!(read(&target, "existing.txt"), "original content");
    assert_eq!(tree(&target), ["existing.txt"]);
}

#[test]
fn filters_selected_archive_paths_and_removes_macos_metadata_on_request() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("archive.tar");
    write_tar(
        &archive,
        &[
            TarEntry::File("notes.txt", b"keep"),
            TarEntry::File("secret.txt", b"exclude"),
            TarEntry::File("image.bin", b"exclude"),
            TarEntry::File("__MACOSX/notes.txt", b"metadata"),
            TarEntry::File(".DS_Store", b"metadata"),
        ],
    );
    let target = work.path().join("output");

    let result = extract(libera_core::ExtractionOptions {
        filter_pattern: Some("*.txt, !secret*".into()),
        exclude_mac_metadata: Some(true),
        ..extraction(&archive, &target)
    })
    .unwrap();

    assert_eq!(result.extracted_count, 1);
    assert_eq!(tree(&target), ["notes.txt"]);
}

#[test]
fn extracts_the_descendants_of_a_selected_directory() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("archive.tar.gz");
    write_tar(
        &archive,
        &[TarEntry::Folder("docs/"), TarEntry::File("docs/readme.txt", b"selected"), TarEntry::File("skip.txt", b"no")],
    );
    let target = work.path().join("output");

    extract(libera_core::ExtractionOptions {
        selected_entries: Some(vec!["docs/".into()]),
        ..extraction(&archive, &target)
    })
    .unwrap();

    assert_eq!(tree(&target), ["docs/", "docs/readme.txt"]);
}

#[test]
fn refuses_entries_that_reach_outside_the_target() {
    let work = TempDir::new().unwrap();
    let escape = work.path().join("escaped.txt");
    let absolute = path(&escape);

    for name in [b"../escaped.txt".as_slice(), b"nested/../../escaped.txt", absolute.as_bytes()] {
        let archive = work.path().join("evil.tar");
        write_tar(&archive, &[TarEntry::RawFile(name, b"evil")]);
        let target = work.path().join("unpacked");

        let result = extract(extraction(&archive, &target));

        assert!(matches!(result, Err(LiberaError::UnsafeArchive { .. })), "{}", String::from_utf8_lossy(name));
        assert!(!escape.exists());
        assert!(!target.exists());
    }
}

#[cfg(unix)]
#[test]
fn rejects_extraction_through_an_existing_destination_symbolic_link() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("archive.tar");
    write_tar(&archive, &[TarEntry::File("linked/escape.txt", b"unsafe")]);
    let target = work.path().join("output");
    let outside = work.path().join("outside");
    fs::create_dir_all(&target).unwrap();
    fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, target.join("linked")).unwrap();

    let result = extract(extraction(&archive, &target));

    let Err(LiberaError::UnsafeArchive { message }) = result else { panic!("{result:?}") };
    assert!(message.contains("destination parent is a symbolic link"), "{message}");
    assert!(tree(&outside).is_empty());
}

#[cfg(unix)]
#[test]
fn refuses_a_target_that_is_itself_a_symbolic_link() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("archive.tar");
    write_tar(&archive, &[TarEntry::File("a.txt", b"a")]);
    let real = work.path().join("real");
    fs::create_dir(&real).unwrap();
    std::os::unix::fs::symlink(&real, work.path().join("alias")).unwrap();

    let result = extract(extraction(&archive, &work.path().join("alias")));

    assert!(matches!(result, Err(LiberaError::UnsafeArchive { .. })), "{result:?}");
    assert!(tree(&real).is_empty());
}

#[cfg(unix)]
#[test]
fn restores_symbolic_links_that_stay_inside_the_destination_by_default() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("archive.tar");
    write_tar(&archive, &[TarEntry::File("dir/file.txt", b"content"), TarEntry::Symlink("dir/link.txt", "file.txt")]);
    let target = work.path().join("output");

    let result = extract(extraction(&archive, &target)).unwrap();

    assert_eq!((result.extracted_count, result.symbolic_links_excluded), (2, 0));
    assert_eq!(fs::read_link(target.join("dir/link.txt")).unwrap().to_str(), Some("file.txt"));
    assert_eq!(read(&target, "dir/link.txt"), "content");
}

#[cfg(unix)]
#[test]
fn rejects_a_symbolic_link_whose_target_escapes_the_destination() {
    let work = TempDir::new().unwrap();
    for target_text in ["../escape.txt", "/etc/passwd"] {
        let archive = work.path().join("archive.tar");
        write_tar(&archive, &[TarEntry::Symlink("link.txt", target_text)]);
        let target = work.path().join("output");

        let result = extract(extraction(&archive, &target));

        assert!(matches!(result, Err(LiberaError::UnsafeArchive { .. })), "{target_text}: {result:?}");
        assert!(!target.exists());
    }
}

#[test]
fn leaves_links_out_and_counts_them_when_asked_not_to_restore_them() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("archive.tar");
    write_tar(
        &archive,
        &[
            TarEntry::File("file.txt", b"content"),
            TarEntry::Symlink("soft.txt", "file.txt"),
            TarEntry::HardLink("hard.txt", "file.txt"),
        ],
    );
    let target = work.path().join("output");

    let result =
        extract(libera_core::ExtractionOptions { restore_symlinks: Some(false), ..extraction(&archive, &target) })
            .unwrap();

    assert_eq!((result.extracted_count, result.symbolic_links_excluded), (1, 2));
    assert_eq!(tree(&target), ["file.txt"]);
}

#[test]
fn refuses_a_hard_link_it_would_have_to_write() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("archive.tar");
    write_tar(&archive, &[TarEntry::File("file.txt", b"content"), TarEntry::HardLink("hard.txt", "file.txt")]);
    let target = work.path().join("output");

    let result = extract(extraction(&archive, &target));

    let Err(LiberaError::UnsafeArchive { message }) = result else { panic!("{result:?}") };
    assert!(message.contains("hard link entries are not supported"), "{message}");
    assert!(!target.exists());
}

#[test]
fn reads_a_tar_written_from_inside_its_own_folder() {
    let work = TempDir::new().unwrap();
    let source = work.path().join("source");
    write_file(&source, "a.txt", "a");
    write_file(&source, "sub/b.txt", "b");
    let archive = work.path().join("dot.tar.gz");
    system_tar(&["-czf", &path(&archive), "."], &source);
    let target = work.path().join("output");

    let result = extract(extraction(&archive, &target)).unwrap();

    assert_eq!(result.extracted_count, 2);
    assert_eq!(tree(&target), ["a.txt", "sub/", "sub/b.txt"]);
}

#[test]
fn skips_the_pax_global_header_git_archive_writes() {
    let work = TempDir::new().unwrap();
    let mut builder = tar::Builder::new(Vec::new());
    let mut global = tar::Header::new_ustar();
    let record = b"52 comment=0123456789abcdef0123456789abcdef01234567\n";
    global.set_entry_type(tar::EntryType::XGlobalHeader);
    global.set_size(record.len() as u64);
    builder.append_data(&mut global, "pax_global_header", &record[..]).unwrap();
    let mut file = tar::Header::new_ustar();
    file.set_size(5);
    file.set_mode(0o644);
    builder.append_data(&mut file, "repo/readme.md", &b"hello"[..]).unwrap();
    let archive = work.path().join("repo.tar");
    fs::write(&archive, builder.into_inner().unwrap()).unwrap();
    let target = work.path().join("output");

    let result = extract(extraction(&archive, &target)).unwrap();

    assert_eq!(result.extracted_count, 1);
    assert_eq!(tree(&target), ["repo/", "repo/readme.md"]);
}

#[cfg(unix)]
#[test]
fn restores_permissions_and_timestamps_from_a_tar_unless_asked_not_to() {
    use std::os::unix::fs::PermissionsExt;

    let work = TempDir::new().unwrap();
    let mut builder = tar::Builder::new(Vec::new());
    for (name, mode) in [("run.sh", 0o4755), ("plain.txt", 0o640)] {
        let mut header = tar::Header::new_gnu();
        header.set_size(2);
        header.set_mode(mode);
        header.set_mtime(1_600_000_000);
        builder.append_data(&mut header, name, &b"hi"[..]).unwrap();
    }
    let archive = work.path().join("modes.tar");
    fs::write(&archive, builder.into_inner().unwrap()).unwrap();

    let restored = work.path().join("restored");
    extract(extraction(&archive, &restored)).unwrap();
    let mode =
        |root: &std::path::Path, name: &str| fs::metadata(root.join(name)).unwrap().permissions().mode() & 0o7777;
    // setuid is never granted, whatever the archive says.
    assert_eq!(mode(&restored, "run.sh"), 0o755);
    assert_eq!(mode(&restored, "plain.txt"), 0o640);
    let modified = fs::metadata(restored.join("plain.txt")).unwrap().modified().unwrap();
    assert_eq!(modified, SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000));

    let plain = work.path().join("plain");
    extract(libera_core::ExtractionOptions {
        restore_permissions: Some(false),
        restore_timestamps: Some(false),
        ..extraction(&archive, &plain)
    })
    .unwrap();
    assert_eq!(mode(&plain, "run.sh"), 0o600);
    assert_ne!(fs::metadata(plain.join("plain.txt")).unwrap().modified().unwrap(), modified);
}

#[test]
fn cancels_a_tar_extraction_and_removes_everything_the_job_created() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("large.tar");
    write_tar(&archive, &[TarEntry::File("large.bin", &noise(4 << 20))]);
    let target = work.path().join("nested/tar-output");
    let token = CancelToken::new();

    let result =
        extract_archive_with(extraction(&archive, &target), Recorder::cancelling(&token), token.clone(), roomy());

    assert!(matches!(result, Err(LiberaError::ExtractionCancelled)), "{result:?}");
    assert!(!work.path().join("nested").exists());
}

#[test]
fn cancels_a_gz_extraction_and_removes_its_partial_output() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("large.txt.gz");
    fs::write(&archive, gzip(&noise(4 << 20))).unwrap();
    let target = work.path().join("output");
    fs::create_dir(&target).unwrap();
    let token = CancelToken::new();

    let result =
        extract_archive_with(extraction(&archive, &target), Recorder::cancelling(&token), token.clone(), roomy());

    assert!(matches!(result, Err(LiberaError::ExtractionCancelled)), "{result:?}");
    assert!(tree(&target).is_empty());
}

#[test]
fn enforces_an_injected_streaming_limit_and_removes_partial_gz_output() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("limited.txt.gz");
    fs::write(&archive, gzip(b"more than five bytes")).unwrap();
    let target = work.path().join("output");
    let context = ExtractionContext {
        policy: ExtractionPolicy {
            max_file_bytes: 5,
            max_total_bytes: 5,
            minimum_reserve_bytes: 0,
            reserve_ratio_percent: 0,
            ..ExtractionPolicy::default()
        },
        available_bytes: Some(1024),
    };

    let result = extract_archive_with(extraction(&archive, &target), Recorder::new(), CancelToken::new(), context);

    assert!(matches!(result, Err(LiberaError::FileTooLarge { .. })), "{result:?}");
    assert!(!target.join("limited.txt").exists());
}

#[test]
fn refuses_more_entries_than_the_policy_allows() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("many.tar");
    let names: Vec<String> = (0..5).map(|index| format!("{index}.txt")).collect();
    let entries: Vec<TarEntry> = names.iter().map(|name| TarEntry::File(name, b"x")).collect();
    write_tar(&archive, &entries);
    let context = ExtractionContext {
        policy: ExtractionPolicy { max_entries: 4, ..ExtractionPolicy::default() },
        available_bytes: Some(1 << 40),
    };

    let result = extract_archive_with(
        extraction(&archive, &work.path().join("out")),
        Recorder::new(),
        CancelToken::new(),
        context,
    );

    let Err(LiberaError::TooManyEntries { message }) = result else { panic!("{result:?}") };
    assert_eq!(message, "archive contains more than 4 entries");
}

#[test]
fn rejects_extraction_when_the_configured_disk_reserve_leaves_no_usable_space() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("archive.tar");
    write_tar(&archive, &[TarEntry::File("file.txt", b"content")]);
    let created_parent = work.path().join("new-parent");
    let context = ExtractionContext { available_bytes: Some(1 << 30), ..ExtractionContext::default() };

    let result = extract_archive_with(
        extraction(&archive, &created_parent.join("nested/output")),
        Recorder::new(),
        CancelToken::new(),
        context,
    );

    assert!(matches!(result, Err(LiberaError::InsufficientDiskSpace { .. })), "{result:?}");
    assert!(!created_parent.exists());
}

#[test]
fn renames_clashing_tar_entries_nested_ones_included() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("archive.tar.gz");
    write_tar(
        &archive,
        &[
            TarEntry::File("a.txt", b"archive a"),
            TarEntry::Folder("docs/"),
            TarEntry::File("docs/b.md", b"archive b"),
            TarEntry::File("docs/c.md", b"archive c"),
        ],
    );
    let target = work.path().join("output");
    write_file(&target, "a.txt", "original a");
    write_file(&target, "docs/b.md", "original b");

    let result = extract(libera_core::ExtractionOptions {
        overwrite_policy: Some(OverwritePolicy::Rename),
        ..extraction(&archive, &target)
    })
    .unwrap();

    assert_eq!(result.extracted_count, 3);
    assert_eq!(read(&target, "a.txt"), "original a");
    assert_eq!(read(&target, "a (1).txt"), "archive a");
    assert_eq!(read(&target, "docs/b.md"), "original b");
    assert_eq!(read(&target, "docs/b (1).md"), "archive b");
    assert_eq!(read(&target, "docs/c.md"), "archive c");
}

#[test]
fn steps_past_a_name_the_archive_itself_claims_when_renaming() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("archive.tar");
    write_tar(
        &archive,
        &[
            TarEntry::File("report.txt", b"archive report"),
            TarEntry::File("report (2).txt", b"archive second report"),
            TarEntry::File("notes/.env", b"archive env"),
            TarEntry::File("backup.tar.gz", b"archive backup"),
            TarEntry::File("data", b"archive data"),
        ],
    );
    let target = work.path().join("output");
    write_file(&target, "report.txt", "original report");
    write_file(&target, "report (1).txt", "original first copy");
    write_file(&target, "notes/.env", "original env");
    write_file(&target, "backup.tar.gz", "original backup");
    fs::create_dir(target.join("data")).unwrap();

    let result = extract(libera_core::ExtractionOptions {
        overwrite_policy: Some(OverwritePolicy::Rename),
        ..extraction(&archive, &target)
    })
    .unwrap();

    assert_eq!(result.extracted_count, 5);
    assert_eq!(read(&target, "report.txt"), "original report");
    assert_eq!(read(&target, "report (1).txt"), "original first copy");
    assert_eq!(read(&target, "report (2).txt"), "archive second report");
    assert_eq!(read(&target, "report (3).txt"), "archive report");
    assert_eq!(read(&target, "notes/.env (1)"), "archive env");
    assert_eq!(read(&target, "backup (1).tar.gz"), "archive backup");
    assert_eq!(read(&target, "data (1)"), "archive data");
}

#[cfg(unix)]
#[test]
fn renames_a_clashing_symbolic_link_and_keeps_its_target() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("archive.tar");
    write_tar(&archive, &[TarEntry::File("file.txt", b"archive content"), TarEntry::Symlink("link.txt", "file.txt")]);
    let target = work.path().join("output");
    write_file(&target, "link.txt", "original content");

    extract(libera_core::ExtractionOptions {
        overwrite_policy: Some(OverwritePolicy::Rename),
        ..extraction(&archive, &target)
    })
    .unwrap();

    assert_eq!(read(&target, "link.txt"), "original content");
    assert_eq!(fs::read_link(target.join("link (1).txt")).unwrap().to_str(), Some("file.txt"));
    assert_eq!(read(&target, "link (1).txt"), "archive content");
}

#[test]
fn renames_the_lone_file_a_gz_stream_expands_to() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("existing.txt.gz");
    fs::write(&archive, gzip(b"archive content")).unwrap();
    let target = work.path().join("output");
    write_file(&target, "existing.txt", "original content");

    let result = extract(libera_core::ExtractionOptions {
        overwrite_policy: Some(OverwritePolicy::Rename),
        ..extraction(&archive, &target)
    })
    .unwrap();

    assert_eq!(result.extracted_count, 1);
    assert_eq!(read(&target, "existing.txt"), "original content");
    assert_eq!(read(&target, "existing (1).txt"), "archive content");
}

#[test]
fn leaves_nothing_renamed_behind_when_the_extraction_fails() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("archive.tar");
    write_tar(&archive, &[TarEntry::File("existing.txt", &noise(1 << 20)), TarEntry::File("later.txt", b"later")]);
    let target = work.path().join("output");
    write_file(&target, "existing.txt", "original content");
    let token = CancelToken::new();

    let result = extract_archive_with(
        libera_core::ExtractionOptions {
            overwrite_policy: Some(OverwritePolicy::Rename),
            ..extraction(&archive, &target)
        },
        Recorder::cancelling(&token),
        token.clone(),
        roomy(),
    );

    assert!(matches!(result, Err(LiberaError::ExtractionCancelled)), "{result:?}");
    assert_eq!(tree(&target), ["existing.txt"]);
    assert_eq!(read(&target, "existing.txt"), "original content");
}

#[test]
fn skips_the_lone_file_of_a_stream_the_pattern_leaves_out() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("notes.md.gz");
    fs::write(&archive, gzip(b"# notes")).unwrap();
    let target = work.path().join("output");

    let result = extract(libera_core::ExtractionOptions {
        filter_pattern: Some("*.txt".into()),
        ..extraction(&archive, &target)
    })
    .unwrap();

    assert_eq!(result.extracted_count, 0);
    assert!(tree(&target).is_empty());
}

#[test]
fn restores_the_gzip_modification_time_only_when_asked() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("stamped.txt.gz");
    let mut encoder = flate2::GzBuilder::new().mtime(1_500_000_000).write(Vec::new(), flate2::Compression::default());
    std::io::Write::write_all(&mut encoder, b"stamped").unwrap();
    fs::write(&archive, encoder.finish().unwrap()).unwrap();
    let stamped = SystemTime::UNIX_EPOCH + Duration::from_secs(1_500_000_000);

    let plain = work.path().join("plain");
    extract(extraction(&archive, &plain)).unwrap();
    assert_ne!(fs::metadata(plain.join("stamped.txt")).unwrap().modified().unwrap(), stamped);

    let restored = work.path().join("restored");
    extract(libera_core::ExtractionOptions { restore_timestamps: Some(true), ..extraction(&archive, &restored) })
        .unwrap();
    assert_eq!(fs::metadata(restored.join("stamped.txt")).unwrap().modified().unwrap(), stamped);
}

#[test]
fn reports_a_missing_archive_and_an_unsupported_one_by_name() {
    let work = TempDir::new().unwrap();
    let target = work.path().join("output");

    let missing = extract(extraction(&work.path().join("missing.tar"), &target));
    assert!(matches!(missing, Err(LiberaError::ArchiveMissing { .. })), "{missing:?}");

    let notes = write_file(work.path(), "notes.txt", "not an archive");
    let unsupported = extract(extraction(&notes, &target));
    assert!(matches!(unsupported, Err(LiberaError::UnsupportedArchive { .. })), "{unsupported:?}");

    let folder = work.path().join("folder.tar");
    fs::create_dir(&folder).unwrap();
    assert!(matches!(extract(extraction(&folder, &target)), Err(LiberaError::InvalidInput { .. })));
    assert!(!target.exists());
}

#[cfg(target_os = "macos")]
#[test]
fn carries_the_archive_quarantine_flag_onto_the_top_level_items() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("download.tar");
    write_tar(
        &archive,
        &[TarEntry::Folder("App/"), TarEntry::File("App/run", b"#!/bin/sh"), TarEntry::File("readme.txt", b"hi")],
    );
    let flag = b"0083;6700f000;Safari;";
    xattr::set(&archive, "com.apple.quarantine", flag).unwrap();
    let target = work.path().join("output");

    extract(extraction(&archive, &target)).unwrap();

    for name in ["App", "readme.txt"] {
        assert_eq!(
            xattr::get(target.join(name), "com.apple.quarantine").unwrap().as_deref(),
            Some(&flag[..]),
            "{name}"
        );
    }
    assert_eq!(xattr::get(target.join("App/run"), "com.apple.quarantine").unwrap(), None);
}

/// A folder entry stands for what is below it only as far as the user's own
/// pick goes; the filters still judge each entry, so a link or a `.DS_Store`
/// below a listed folder stays out when the options say so.
#[test]
fn applies_the_filters_below_a_folder_entry_too() {
    let work = TempDir::new().unwrap();
    let archive = work.path().join("folders.tar");
    write_tar(
        &archive,
        &[
            TarEntry::Folder("app/"),
            TarEntry::File("app/readme.txt", b"read me"),
            TarEntry::File("app/notes.md", b"notes"),
            TarEntry::File("app/.DS_Store", b"finder"),
            TarEntry::Symlink("app/link", "readme.txt"),
        ],
    );
    let target = work.path().join("output");

    let result = extract(libera_core::ExtractionOptions {
        restore_symlinks: Some(false),
        exclude_mac_metadata: Some(true),
        filter_pattern: Some("!*.md".into()),
        ..extraction(&archive, &target)
    })
    .unwrap();

    assert_eq!((result.extracted_count, result.symbolic_links_excluded), (1, 1));
    assert_eq!(tree(&target), ["app/", "app/readme.txt"]);
}
