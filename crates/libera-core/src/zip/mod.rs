//! The ZIP container, read and written here rather than through a library:
//! the app needs split sets, per-entry Deflate tuning, the LZMA and Zstandard
//! methods with their own settings, both encryption schemes, and a reader
//! strict enough to refuse overlapping entries - more than any one crate
//! offers together. The codecs and ciphers themselves come from crates.

pub(crate) mod crypto;
pub(crate) mod format;
pub(crate) mod methods;
pub(crate) mod read;
pub(crate) mod volumes;
pub(crate) mod write;

pub use format::FilenameEncoding;
pub use methods::{OverrideScope, ZipMethod, ZipMethodOverride};
pub use volumes::{MAX_SPLIT_VOLUMES, MIN_SPLIT_SIZE};

/// How a password-protected ZIP is encrypted. The traditional cipher is what
/// every reader opens; AES is what is actually secure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum ZipEncryptionMethod {
    #[default]
    ZipCrypto,
    Aes128,
    Aes256,
}

#[cfg(test)]
mod tests {
    use std::io::Read;
    use std::time::UNIX_EPOCH;

    use super::read::{OpenOptions, ZipArchive};
    use super::volumes::FileSink;
    use super::write::{EntryEncryption, EntryMethod, ZipWriter};
    use crate::progress::CancelToken;
    use crate::safety::ExtractionPolicy;

    /// More entries than the 16-bit count holds, so the end records have to
    /// go through Zip64 - which `unzip` has to agree with too.
    #[test]
    fn writes_and_reads_zip64_end_records_past_65535_entries() {
        let work = tempfile::TempDir::new().unwrap();
        let path = work.path().join("many.zip");
        let mut writer = ZipWriter::new(FileSink::create(&path).unwrap(), false).unwrap();
        for index in 0..70_000 {
            writer.add_directory(&format!("d{index}"), UNIX_EPOCH, 0o755).unwrap();
        }
        let mut content = &b"last"[..];
        writer
            .add_file(
                "last.txt",
                UNIX_EPOCH,
                0o100_644,
                EntryMethod::Store,
                &EntryEncryption::None,
                &mut content,
                4,
                &CancelToken::default(),
            )
            .unwrap();
        writer.finish().unwrap().finish().unwrap();

        let options = OpenOptions {
            policy: ExtractionPolicy { max_entries: 100_000, ..ExtractionPolicy::default() },
            encoding: Default::default(),
        };
        let mut archive = ZipArchive::open(&path, &options).unwrap();
        assert_eq!(archive.entries.len(), 70_001);
        let mut last = String::new();
        archive.open_entry(70_000, None, true).unwrap().read_to_string(&mut last).unwrap();
        assert_eq!(last, "last");

        let listed = std::process::Command::new("unzip").arg("-l").arg(&path).output().unwrap();
        assert!(listed.status.success());
        assert!(String::from_utf8_lossy(&listed.stdout).contains("70001 files"));
    }
}
