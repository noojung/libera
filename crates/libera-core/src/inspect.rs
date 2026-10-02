//! What the inspector shows about an archive: every entry with its sizes,
//! codec and protection, and what the container's own header says.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use crate::LiberaError;
use crate::codec::StreamCodec;
use crate::extract::tar::{is_entry, open_tar};
use crate::formats::{ReadFormat, read_format, stream_entry_name};
use crate::progress::CancelToken;
use crate::resolve::{ArchiveVolume, canonical_archive_path};
use crate::safety::{ExtractionPolicy, format_count};
use crate::sevenz::read::SevenZipArchive;
use crate::zip::format::{METHOD_BZIP2, METHOD_DEFLATE, METHOD_DEFLATE64, METHOD_LZMA, METHOD_STORE, METHOD_ZSTD};
use crate::zip::read::{Encryption, OpenOptions, ZipArchive};

/// The packed totals of the solid block an entry shares, since a solid block
/// has one packed size rather than one per file.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct SolidBlockInfo {
    /// Numbered from one, in archive order.
    pub id: u32,
    pub file_count: u64,
    pub uncompressed_size: u64,
    pub compressed_size: u64,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct InspectedEntry {
    /// The entry's position, which is what a preview asks for.
    pub index: u64,
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    /// Unknown for a lone codec stream until it is decoded.
    pub size: Option<u64>,
    pub compressed_size: Option<u64>,
    pub solid_block: Option<SolidBlockInfo>,
    /// The space saved, in percent.
    pub ratio: Option<f64>,
    pub modified: Option<SystemTime>,
    pub codec: Option<String>,
    pub crc32: Option<u32>,
    pub encrypted: bool,
    pub encryption_method: String,
    pub mode: Option<u32>,
    /// `drwxr-xr-x`, when a mode is known.
    pub mode_string: Option<String>,
    pub offset: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ArchiveHeaderInfo {
    pub signature: Option<String>,
    pub format_version: Option<String>,
    pub codec_summary: Option<String>,
    pub encryption_algorithm: Option<String>,
    pub solid: bool,
    pub central_directory_offset: Option<u64>,
    pub central_directory_size: Option<u64>,
    pub next_header_offset: Option<u64>,
    pub next_header_size: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ArchiveInspection {
    pub archive_path: String,
    /// `ZIP`, `TAR.GZ`, `7Z` and so on.
    pub format: String,
    /// Every volume, for a set of more than one.
    pub volumes: Option<Vec<ArchiveVolume>>,
    pub password_protected: bool,
    pub total_files: u64,
    pub total_uncompressed_size: Option<u64>,
    pub total_compressed_size: u64,
    pub overall_ratio: Option<f64>,
    pub entries: Vec<InspectedEntry>,
    pub header: ArchiveHeaderInfo,
}

/// `drwxr-xr-x` for a mode, the way `ls` writes it.
pub(crate) fn format_unix_mode(mode: u32, is_directory: bool) -> String {
    let file_type = mode & 0o170_000;
    let kind = if file_type == 0o120_000 {
        'l'
    } else if is_directory || file_type == 0o040_000 {
        'd'
    } else {
        '-'
    };
    let triple = |bits: u32| {
        [(4, 'r'), (2, 'w'), (1, 'x')]
            .iter()
            .map(|&(bit, letter)| if bits & bit != 0 { letter } else { '-' })
            .collect::<String>()
    };
    format!("{kind}{}{}{}", triple((mode >> 6) & 7), triple((mode >> 3) & 7), triple(mode & 7))
}

fn base_name(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    trimmed.rsplit(['/', '\\']).next().filter(|name| !name.is_empty()).unwrap_or(path).to_owned()
}

fn signature(bytes: &[u8], label: &str) -> String {
    let hex: Vec<String> = bytes.iter().map(|byte| format!("{byte:02X}")).collect();
    format!("{} ({label})", hex.join(" "))
}

/// Every distinct value in order of first appearance, or `fallback`.
fn summary<'a>(values: impl Iterator<Item = &'a str>, fallback: &str) -> String {
    let mut seen: Vec<&str> = Vec::new();
    for value in values.filter(|value| !value.is_empty()) {
        if !seen.contains(&value) {
            seen.push(value);
        }
    }
    if seen.is_empty() { fallback.to_owned() } else { seen.join(", ") }
}

fn entry_ratio(compressed: u64, size: u64) -> f64 {
    if size == 0 { 0.0 } else { ((1.0 - compressed as f64 / size as f64) * 100.0).round() }
}

fn overall_ratio(compressed: u64, uncompressed: u64) -> f64 {
    if uncompressed == 0 { 0.0 } else { ((1.0 - compressed as f64 / uncompressed as f64) * 1000.0).round() / 10.0 }
}

fn volumes_of(paths: &[std::path::PathBuf], sizes: &[u64]) -> Option<Vec<ArchiveVolume>> {
    (paths.len() > 1).then(|| {
        paths
            .iter()
            .zip(sizes)
            .map(|(path, size)| ArchiveVolume {
                path: path.to_string_lossy().into_owned(),
                name: base_name(&path.to_string_lossy()),
                size: *size,
            })
            .collect()
    })
}

/// Lists `archive_path` - or the set it belongs to - for the inspector. A 7z
/// whose header is encrypted needs `password` before even its names can be
/// listed; every other archive lists without one.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn inspect_archive(
    archive_path: String,
    password: Option<String>,
    cancel: Arc<CancelToken>,
) -> Result<ArchiveInspection, LiberaError> {
    let path = canonical_archive_path(Path::new(&archive_path));
    let metadata = fs::metadata(&path)
        .map_err(|_| LiberaError::ArchiveMissing { message: format!("File does not exist: {}", path.display()) })?;
    if !metadata.is_file() {
        return Err(LiberaError::invalid_input("Archive inspection requires a file"));
    }
    match read_format(&path) {
        Some(ReadFormat::Zip) => inspect_zip(&path),
        Some(ReadFormat::SevenZip) => inspect_seven_zip(&path, password.as_deref()),
        Some(ReadFormat::Tar(wrapper)) => inspect_tar(&path, wrapper, metadata.len(), &cancel),
        Some(ReadFormat::Stream(codec)) => Ok(inspect_stream(&path, codec, metadata.len())),
        None => {
            Err(LiberaError::UnsupportedArchive { message: format!("Unsupported archive format: {}", path.display()) })
        }
    }
}

fn zip_codec_name(method: u16) -> String {
    match method {
        METHOD_STORE => "Store".into(),
        METHOD_DEFLATE => "Deflate".into(),
        METHOD_DEFLATE64 => "Deflate64".into(),
        METHOD_BZIP2 => "BZip2".into(),
        METHOD_LZMA => "LZMA".into(),
        METHOD_ZSTD => "Zstd".into(),
        98 => "PPMd".into(),
        other => format!("Method {other}"),
    }
}

fn zip_encryption_name(encryption: Encryption) -> &'static str {
    match encryption {
        Encryption::None => "None",
        Encryption::ZipCrypto => "ZipCrypto",
        Encryption::Aes { strength, .. } => match strength {
            crate::zip::crypto::AesStrength::Aes128 => "AES-128",
            crate::zip::crypto::AesStrength::Aes192 => "AES-192",
            crate::zip::crypto::AesStrength::Aes256 => "AES-256",
        },
    }
}

fn zip_format_label(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("jar") => "JAR",
        Some("war") => "WAR",
        _ => "ZIP",
    }
}

fn inspect_zip(path: &Path) -> Result<ArchiveInspection, LiberaError> {
    let archive =
        ZipArchive::open(path, &OpenOptions { policy: ExtractionPolicy::default(), encoding: Default::default() })?;
    let total_compressed_size = archive.volume_sizes.iter().sum();
    let entries: Vec<InspectedEntry> = archive
        .entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let size = if entry.is_directory { 0 } else { entry.uncompressed_size };
            let compressed = if entry.is_directory { 0 } else { entry.compressed_size };
            let mode = (entry.unix_mode != 0).then_some(entry.unix_mode);
            InspectedEntry {
                index: index as u64,
                name: base_name(&entry.name),
                path: entry.name.clone(),
                is_directory: entry.is_directory,
                size: Some(size),
                compressed_size: Some(compressed),
                solid_block: None,
                ratio: Some(entry_ratio(compressed, size)),
                modified: entry.modified,
                codec: Some(zip_codec_name(entry.method)),
                crc32: Some(entry.crc32),
                encrypted: entry.is_encrypted(),
                encryption_method: zip_encryption_name(entry.encryption).to_owned(),
                mode,
                mode_string: mode.map(|mode| format_unix_mode(mode, entry.is_directory)),
                offset: Some(entry.header_offset),
            }
        })
        .collect();
    let total_uncompressed_size = entries.iter().filter_map(|entry| entry.size).sum();
    let mut first_bytes = [0u8; 4];
    File::open(&archive.volume_paths[0])?.read_exact(&mut first_bytes).ok();
    let versions: Vec<String> = archive
        .entries
        .iter()
        .map(|entry| format!("{}.{}", entry.version_needed / 10, entry.version_needed % 10))
        .collect();
    let split = archive.volume_paths.len() > 1;
    Ok(ArchiveInspection {
        archive_path: path.to_string_lossy().into_owned(),
        format: zip_format_label(path).to_owned(),
        volumes: volumes_of(&archive.volume_paths, &archive.volume_sizes),
        password_protected: archive.entries.iter().any(|entry| entry.is_encrypted()),
        total_files: entries.iter().filter(|entry| !entry.is_directory).count() as u64,
        total_uncompressed_size: Some(total_uncompressed_size),
        total_compressed_size,
        overall_ratio: Some(overall_ratio(total_compressed_size, total_uncompressed_size)),
        header: ArchiveHeaderInfo {
            signature: Some(signature(&first_bytes, if split { "Split ZIP" } else { "ZIP" })),
            format_version: Some(summary(versions.iter().map(String::as_str), "2.0")),
            codec_summary: Some(summary(entries.iter().filter_map(|entry| entry.codec.as_deref()), "Store")),
            encryption_algorithm: Some(summary(
                entries.iter().filter(|entry| entry.encrypted).map(|entry| entry.encryption_method.as_str()),
                "None",
            )),
            solid: false,
            central_directory_offset: Some(archive.directory_offset),
            central_directory_size: Some(archive.directory_size),
            ..ArchiveHeaderInfo::default()
        },
        entries,
    })
}

/// How the inspector names a codec and the stream it heads.
struct CodecDescription {
    /// What a single entry compressed with it is labelled.
    entry: &'static str,
    /// How the whole stream is summarized in the header panel.
    summary: &'static str,
    signature: &'static str,
    version: &'static str,
}

fn codec_description(codec: StreamCodec) -> CodecDescription {
    match codec {
        StreamCodec::Gzip => CodecDescription {
            entry: "Gzip (Deflate)",
            summary: "Gzip / Deflate Stream",
            signature: "1F 8B (GZIP)",
            version: "RFC 1952",
        },
        StreamCodec::Xz => CodecDescription {
            entry: "XZ (LZMA2)",
            summary: "XZ / LZMA2 Stream",
            signature: "FD 37 7A 58 5A 00 (XZ)",
            version: "XZ 1.0.4",
        },
        StreamCodec::Bzip2 => CodecDescription {
            entry: "BZip2",
            summary: "BZip2 Stream",
            signature: "42 5A 68 (BZh)",
            version: "BZip2 0.9.0",
        },
        StreamCodec::Zstd => CodecDescription {
            entry: "Zstandard",
            summary: "Zstandard Stream",
            signature: "28 B5 2F FD (ZSTD)",
            version: "RFC 8878",
        },
    }
}

fn stream_label(codec: StreamCodec) -> &'static str {
    match codec {
        StreamCodec::Gzip => "GZ",
        StreamCodec::Xz => "XZ",
        StreamCodec::Bzip2 => "BZ2",
        StreamCodec::Zstd => "ZST",
    }
}

fn inspect_tar(
    path: &Path,
    wrapper: Option<StreamCodec>,
    total_compressed_size: u64,
    cancel: &CancelToken,
) -> Result<ArchiveInspection, LiberaError> {
    let (format, codec_entry, codec_summary, header_signature, version) = match wrapper {
        Some(codec) => {
            let description = codec_description(codec);
            let format = format!("TAR.{}", stream_label(codec));
            (
                format,
                description.entry,
                description.summary,
                Some(description.signature.to_owned()),
                description.version.to_owned(),
            )
        }
        None => {
            // A bare tarball has no codec to name; its first header says
            // which flavor of tar it is.
            let mut magic = [0u8; 8];
            let mut file = File::open(path)?;
            let ustar = file.seek(SeekFrom::Start(257)).is_ok()
                && file.read_exact(&mut magic).is_ok()
                && &magic[..5] == b"ustar";
            let (header_signature, version) = if ustar {
                (signature(&magic[..6], "ustar"), "POSIX ustar")
            } else {
                ("TAR (legacy header)".to_owned(), "V7 / legacy TAR")
            };
            ("TAR".to_owned(), "None (Store)", "POSIX Tarball", Some(header_signature), version.to_owned())
        }
    };

    let mut archive = open_tar(path, cancel)?;
    let mut entries = Vec::new();
    let policy = ExtractionPolicy::default();
    for entry in archive.entries()? {
        if cancel.is_cancelled() {
            return Err(LiberaError::PreviewCancelled);
        }
        let entry = entry?;
        let header = entry.header();
        if !is_entry(header.entry_type()) {
            continue;
        }
        if entries.len() as u64 >= policy.max_entries {
            return Err(LiberaError::TooManyEntries {
                message: format!("archive contains more than {} entries", format_count(policy.max_entries)),
            });
        }
        let path_text = String::from_utf8_lossy(&entry.path_bytes()).into_owned();
        let is_directory = header.entry_type().is_dir();
        let size = entry.size();
        let mode = header.mode().ok();
        entries.push(InspectedEntry {
            index: entries.len() as u64,
            name: base_name(&path_text),
            path: path_text,
            is_directory,
            size: Some(size),
            compressed_size: None,
            solid_block: None,
            ratio: None,
            modified: header.mtime().ok().map(|seconds| SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)),
            codec: Some(codec_entry.to_owned()),
            crc32: None,
            encrypted: false,
            encryption_method: "None".into(),
            mode,
            mode_string: mode.map(|mode| format_unix_mode(mode, is_directory)),
            offset: None,
        });
    }
    let total_uncompressed_size = entries.iter().filter_map(|entry| entry.size).sum();
    Ok(ArchiveInspection {
        archive_path: path.to_string_lossy().into_owned(),
        format,
        volumes: None,
        password_protected: false,
        total_files: entries.iter().filter(|entry| !entry.is_directory).count() as u64,
        total_uncompressed_size: Some(total_uncompressed_size),
        total_compressed_size,
        overall_ratio: Some(overall_ratio(total_compressed_size, total_uncompressed_size)),
        entries,
        header: ArchiveHeaderInfo {
            signature: header_signature,
            format_version: Some(version),
            codec_summary: Some(codec_summary.to_owned()),
            encryption_algorithm: Some("None".into()),
            ..ArchiveHeaderInfo::default()
        },
    })
}

/// A dictionary as the codec column shows it: ` [16 MB]`.
fn dictionary_label(size: Option<u32>) -> String {
    match size {
        None => String::new(),
        Some(size) if size >= 1 << 20 && size % (1 << 20) == 0 => format!(" [{} MB]", size >> 20),
        Some(size) if size >= 1 << 10 && size % (1 << 10) == 0 => format!(" [{} KB]", size >> 10),
        Some(size) => format!(" [{size} B]"),
    }
}

fn inspect_seven_zip(path: &Path, password: Option<&str>) -> Result<ArchiveInspection, LiberaError> {
    let archive = SevenZipArchive::open(path, password, &ExtractionPolicy::default())?;
    let mut solid_ids = Vec::new();
    for (index, block) in archive.blocks.iter().enumerate() {
        if block.file_count > 1 {
            solid_ids.push(index);
        }
    }
    let entries: Vec<InspectedEntry> = archive
        .entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let block = entry.block.map(|block| (block, &archive.blocks[block]));
            let solid_block = block.filter(|(_, info)| info.file_count > 1).map(|(block, info)| SolidBlockInfo {
                id: solid_ids.iter().position(|&solid| solid == block).unwrap_or(0) as u32 + 1,
                file_count: info.file_count as u64,
                uncompressed_size: info.unpacked_size,
                compressed_size: info.packed_size,
            });
            // A solid block has one packed size for all its files, so a file
            // in one shows none of its own.
            let compressed_size = block.filter(|(_, info)| info.file_count == 1).map(|(_, info)| info.packed_size);
            let ratio = match (&solid_block, compressed_size) {
                (Some(solid), _) if solid.uncompressed_size > 0 => Some(
                    ((1.0 - solid.compressed_size as f64 / solid.uncompressed_size as f64) * 10_000.0).round() / 100.0,
                ),
                (_, Some(compressed)) => Some(entry_ratio(compressed, entry.size)),
                _ => None,
            };
            let encrypted = block.is_some_and(|(_, info)| info.encrypted);
            let codec = match block {
                Some((_, info)) => format!("{}{}", info.codec, dictionary_label(info.dictionary_size)),
                None => "Copy".into(),
            };
            InspectedEntry {
                index: index as u64,
                name: base_name(&entry.path),
                path: entry.path.clone(),
                is_directory: entry.is_directory,
                size: Some(entry.size),
                compressed_size,
                solid_block,
                ratio,
                modified: entry.modified,
                codec: Some(codec),
                crc32: entry.crc,
                encrypted,
                encryption_method: if encrypted { "AES-256 (SHA-256 KDF)".into() } else { "None".into() },
                mode: entry.unix_mode,
                mode_string: entry.unix_mode.map(|mode| format_unix_mode(mode, entry.is_directory)),
                offset: None,
            }
        })
        .collect();
    let total_uncompressed_size = entries.iter().filter_map(|entry| entry.size).sum();
    let total_compressed_size = archive.volume_sizes.iter().sum();
    let any_encrypted =
        entries.iter().any(|entry| entry.encrypted) || archive.blocks.iter().any(|block| block.encrypted);
    Ok(ArchiveInspection {
        archive_path: path.to_string_lossy().into_owned(),
        format: "7Z".into(),
        volumes: volumes_of(&archive.volume_paths, &archive.volume_sizes),
        password_protected: any_encrypted,
        total_files: entries.iter().filter(|entry| !entry.is_directory).count() as u64,
        total_uncompressed_size: Some(total_uncompressed_size),
        total_compressed_size,
        overall_ratio: Some(overall_ratio(total_compressed_size, total_uncompressed_size)),
        header: ArchiveHeaderInfo {
            signature: Some("37 7A BC AF 27 1C (7-Zip)".into()),
            format_version: Some(archive.version.clone()),
            codec_summary: Some(summary(entries.iter().filter_map(|entry| entry.codec.as_deref()), "Copy")),
            encryption_algorithm: Some(if any_encrypted { "AES-256 (SHA-256)".into() } else { "None".into() }),
            solid: !solid_ids.is_empty(),
            next_header_offset: Some(archive.next_header_offset),
            next_header_size: Some(archive.next_header_size),
            ..ArchiveHeaderInfo::default()
        },
        entries,
    })
}

/// A lone codec stream has no entry table: it holds one file, whose size is
/// only knowable by decoding all of it, so the listing says so rather than
/// paying for a decode nobody asked for.
fn inspect_stream(path: &Path, codec: StreamCodec, total_compressed_size: u64) -> ArchiveInspection {
    let description = codec_description(codec);
    let name = stream_entry_name(path);
    ArchiveInspection {
        archive_path: path.to_string_lossy().into_owned(),
        format: stream_label(codec).into(),
        volumes: None,
        password_protected: false,
        total_files: 1,
        total_uncompressed_size: None,
        total_compressed_size,
        overall_ratio: None,
        entries: vec![InspectedEntry {
            index: 0,
            name: name.clone(),
            path: name,
            is_directory: false,
            size: None,
            compressed_size: Some(total_compressed_size),
            solid_block: None,
            ratio: None,
            modified: None,
            codec: Some(description.entry.into()),
            crc32: None,
            encrypted: false,
            encryption_method: "None".into(),
            mode: None,
            mode_string: None,
            offset: None,
        }],
        header: ArchiveHeaderInfo {
            signature: Some(description.signature.into()),
            format_version: Some(description.version.into()),
            codec_summary: Some(description.summary.into()),
            encryption_algorithm: Some("None".into()),
            ..ArchiveHeaderInfo::default()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_modes_the_way_ls_does() {
        assert_eq!(format_unix_mode(0o100_644, false), "-rw-r--r--");
        assert_eq!(format_unix_mode(0o755, true), "drwxr-xr-x");
        assert_eq!(format_unix_mode(0o120_777, false), "lrwxrwxrwx");
        assert_eq!(format_unix_mode(0o040_700, false), "drwx------");
    }

    #[test]
    fn names_entries_by_their_last_segment() {
        assert_eq!(base_name("docs/readme.md"), "readme.md");
        assert_eq!(base_name("docs/"), "docs");
        assert_eq!(base_name("top"), "top");
        assert_eq!(base_name("win\\path.txt"), "path.txt");
    }

    #[test]
    fn labels_dictionaries_in_the_largest_whole_unit() {
        assert_eq!(dictionary_label(Some(16 << 20)), " [16 MB]");
        assert_eq!(dictionary_label(Some(64 << 10)), " [64 KB]");
        assert_eq!(dictionary_label(Some(1000)), " [1000 B]");
        assert_eq!(dictionary_label(None), "");
    }

    #[test]
    fn summarizes_distinct_values_in_order() {
        assert_eq!(summary(["Deflate", "Store", "Deflate"].into_iter(), "x"), "Deflate, Store");
        assert_eq!(summary(std::iter::empty(), "None"), "None");
    }
}
