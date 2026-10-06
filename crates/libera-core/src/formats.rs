//! Which formats are written and read, and what a path's suffix says about
//! the format behind it. The UI asks the same questions through the exported
//! helpers here, so a format offered on screen is always one the engine takes.

use std::path::Path;

use crate::codec::StreamCodec;

/// The formats this engine writes, named after the Electron engine's
/// `ArchiveFormat` values. ZIP and 7Z join as their writers are ported.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum ArchiveFormat {
    Tar,
    Gz,
    Tgz,
    Zst,
    Tzst,
}

impl ArchiveFormat {
    /// GZ and ZST wrap a single file rather than carrying an entry table.
    pub(crate) fn is_single_file(self) -> bool {
        matches!(self, Self::Gz | Self::Zst)
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Tar => "TAR",
            Self::Gz => "GZ",
            Self::Tgz => "TAR.GZ",
            Self::Zst => "ZST",
            Self::Tzst => "TAR.ZST",
        }
    }

    pub(crate) fn uses_deflate(self) -> bool {
        matches!(self, Self::Gz | Self::Tgz)
    }

    pub(crate) fn uses_zstd(self) -> bool {
        matches!(self, Self::Zst | Self::Tzst)
    }
}

const DEFLATE_LEVELS: [u8; 10] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/// The levels a format's writer actually distinguishes, in slider order. TAR
/// only concatenates files, so it has none. Zstandard keeps the same ten steps
/// and the writer maps them onto the codec's own scale.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn compression_levels(format: ArchiveFormat) -> Vec<u8> {
    match format {
        ArchiveFormat::Tar => Vec::new(),
        ArchiveFormat::Gz | ArchiveFormat::Tgz | ArchiveFormat::Zst | ArchiveFormat::Tzst => DEFLATE_LEVELS.to_vec(),
    }
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn supports_level(format: ArchiveFormat) -> bool {
    !compression_levels(format).is_empty()
}

/// The nearest level a format supports, so switching formats keeps the intent.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn nearest_level(level: u8, format: ArchiveFormat) -> u8 {
    compression_levels(format).into_iter().min_by_key(|candidate| candidate.abs_diff(level)).unwrap_or(level)
}

/// How a path is read, decided by its suffix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReadFormat {
    /// A tarball, bare or wrapped in the codec its suffix names.
    Tar(Option<StreamCodec>),
    /// One file inside a codec stream.
    Stream(StreamCodec),
}

/// The suffixes that name a tar inside a codec.
const TAR_WRAPPERS: [(&[&str], StreamCodec); 4] = [
    (&[".tar.xz", ".txz"], StreamCodec::Xz),
    (&[".tar.bz2", ".tbz2", ".tbz"], StreamCodec::Bzip2),
    (&[".tar.zst", ".tzst"], StreamCodec::Zstd),
    (&[".tar.gz", ".tgz"], StreamCodec::Gzip),
];

/// The suffix each codec carries when it wraps a lone file.
const SINGLE_FILE_SUFFIXES: [(&str, StreamCodec); 4] =
    [(".bz2", StreamCodec::Bzip2), (".zst", StreamCodec::Zstd), (".gz", StreamCodec::Gzip), (".xz", StreamCodec::Xz)];

/// Every suffix the extractor accepts, for the open dialog.
pub const SUPPORTED_ARCHIVE_EXTENSIONS: [&str; 14] = [
    ".tar", ".tgz", ".tar.gz", ".tar.xz", ".txz", ".tar.bz2", ".tbz2", ".tbz", ".tar.zst", ".tzst", ".gz", ".xz",
    ".bz2", ".zst",
];

fn lowercase_name(path: &Path) -> String {
    path.to_string_lossy().to_lowercase()
}

/// The format a path is read as. A `.tar.gz` is a tarball before it is a gzip
/// stream, so the tar suffixes are tried first.
pub(crate) fn read_format(path: &Path) -> Option<ReadFormat> {
    let name = lowercase_name(path);
    if let Some((_, codec)) =
        TAR_WRAPPERS.iter().find(|(suffixes, _)| suffixes.iter().any(|suffix| name.ends_with(suffix)))
    {
        return Some(ReadFormat::Tar(Some(*codec)));
    }
    if name.ends_with(".tar") {
        return Some(ReadFormat::Tar(None));
    }
    stream_codec_for(&name).map(ReadFormat::Stream)
}

fn stream_codec_for(lowercase_name: &str) -> Option<StreamCodec> {
    SINGLE_FILE_SUFFIXES.iter().find(|(suffix, _)| lowercase_name.ends_with(suffix)).map(|(_, codec)| *codec)
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn supported_archive_extensions() -> Vec<String> {
    SUPPORTED_ARCHIVE_EXTENSIONS.iter().map(|extension| (*extension).to_owned()).collect()
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn is_supported_archive_path(path: String) -> bool {
    read_format(Path::new(&path)).is_some()
}

/// The name the single file inside a codec stream is stored under: the
/// archive's own name without the codec suffix, whatever its case. A file
/// called nothing but its suffix keeps it, rather than stripping down to a
/// name no file can have.
pub(crate) fn stream_entry_name(path: &Path) -> String {
    let base_name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let lowercase = base_name.to_lowercase();
    match SINGLE_FILE_SUFFIXES.iter().find(|(suffix, _)| lowercase.ends_with(suffix)) {
        Some((suffix, _))
            if base_name.len() > suffix.len() && base_name.is_char_boundary(base_name.len() - suffix.len()) =>
        {
            base_name[..base_name.len() - suffix.len()].to_owned()
        }
        _ => base_name,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_tar_suffixes_before_codec_suffixes() {
        for (name, expected) in [
            ("a.tar", ReadFormat::Tar(None)),
            ("a.TGZ", ReadFormat::Tar(Some(StreamCodec::Gzip))),
            ("a.tar.gz", ReadFormat::Tar(Some(StreamCodec::Gzip))),
            ("a.tar.xz", ReadFormat::Tar(Some(StreamCodec::Xz))),
            ("a.txz", ReadFormat::Tar(Some(StreamCodec::Xz))),
            ("a.tar.bz2", ReadFormat::Tar(Some(StreamCodec::Bzip2))),
            ("a.tbz2", ReadFormat::Tar(Some(StreamCodec::Bzip2))),
            ("a.tbz", ReadFormat::Tar(Some(StreamCodec::Bzip2))),
            ("a.tar.zst", ReadFormat::Tar(Some(StreamCodec::Zstd))),
            ("a.tzst", ReadFormat::Tar(Some(StreamCodec::Zstd))),
            ("a.gz", ReadFormat::Stream(StreamCodec::Gzip)),
            ("a.XZ", ReadFormat::Stream(StreamCodec::Xz)),
            ("a.bz2", ReadFormat::Stream(StreamCodec::Bzip2)),
            ("a.zst", ReadFormat::Stream(StreamCodec::Zstd)),
        ] {
            assert_eq!(read_format(Path::new(name)), Some(expected), "{name}");
        }
        for name in ["a.zipx", "a.txt", "a", "a.tar.lz"] {
            assert_eq!(read_format(Path::new(name)), None, "{name}");
        }
    }

    #[test]
    fn names_the_entry_after_the_file_even_when_the_suffix_is_upper_case() {
        assert_eq!(stream_entry_name(Path::new("/x/Report.TXT.GZ")), "Report.TXT");
        assert_eq!(stream_entry_name(Path::new("notes.md.zst")), "notes.md");
        assert_eq!(stream_entry_name(Path::new(".gz")), ".gz");
    }

    #[test]
    fn moves_a_level_to_the_closest_step_the_new_format_has() {
        assert_eq!(nearest_level(6, ArchiveFormat::Tgz), 6);
        assert_eq!(nearest_level(6, ArchiveFormat::Tar), 6);
        assert!(compression_levels(ArchiveFormat::Tar).is_empty());
        assert!(!supports_level(ArchiveFormat::Tar));
        assert!(supports_level(ArchiveFormat::Zst));
    }
}
