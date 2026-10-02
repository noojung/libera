//! Reading 7z through sevenz-rust2, which decodes every coder 7-Zip writes -
//! LZMA, LZMA2, PPMd, BZip2, Deflate, the BCJ family, BCJ2, Delta - and
//! 7-Zip's AES. What it hands back is mapped onto this engine's errors here.

use std::io::{self, Read};
use std::path::Path;
use std::time::SystemTime;

use sevenz_rust2::{Archive, BlockDecoder, Password};

use super::volumes::{discover_seven_zip_volumes, first_volume_path, is_seven_zip_volume_path};
use crate::LiberaError;
use crate::safety::{ExtractionPolicy, format_count};
use crate::zip::volumes::VolumeSet;

const AES_METHOD: [u8; 4] = [0x06, 0xf1, 0x07, 0x01];

/// Maps what sevenz-rust2 reports onto this engine's errors. An error this
/// engine raised itself - the meter, a cancellation - comes back out as
/// itself, from wherever the library wrapped it.
pub(crate) fn map_error(error: sevenz_rust2::Error) -> LiberaError {
    use sevenz_rust2::Error;
    let carried = |error: io::Error| -> Option<LiberaError> {
        error.get_ref().is_some_and(|inner| inner.is::<LiberaError>()).then(|| LiberaError::from(error))
    };
    match error {
        Error::PasswordRequired => LiberaError::PasswordRequired,
        Error::MaybeBadPassword(error) => carried(error).unwrap_or(LiberaError::WrongPassword),
        Error::Io(error, _) | Error::FileOpen(error, _) => carried(error).unwrap_or_else(|| {
            LiberaError::CorruptArchive { message: "The 7z archive is damaged or incomplete.".into() }
        }),
        Error::UnsupportedCompressionMethod(method) => LiberaError::UnsupportedArchive {
            message: format!("The 7z archive uses {method}, which Libera cannot read."),
        },
        Error::Unsupported(what) => LiberaError::UnsupportedArchive {
            message: format!("The 7z archive uses something Libera cannot read: {what}"),
        },
        Error::ExternalUnsupported => {
            LiberaError::UnsupportedArchive { message: "The 7z archive keeps its data outside itself.".into() }
        }
        other => LiberaError::CorruptArchive { message: format!("The 7z archive is damaged: {other:?}") },
    }
}

/// One entry, as the extractor and the inspector see it.
#[derive(Debug, Clone)]
pub(crate) struct SevenZipEntry {
    pub path: String,
    pub size: u64,
    pub is_directory: bool,
    pub is_symlink: bool,
    /// Permission bits from the Unix half of the attributes, if any.
    pub mode: Option<u32>,
    pub modified: Option<SystemTime>,
    /// The block holding the entry's data, if it has any.
    pub block: Option<usize>,
}

pub(crate) struct SevenZipArchive {
    source: VolumeSet,
    archive: Archive,
    password: Password,
    has_password: bool,
    pub entries: Vec<SevenZipEntry>,
}

impl SevenZipArchive {
    /// Opens `path`, or the set it is a volume of. An encrypted header needs
    /// the password before even the names can be read.
    pub(crate) fn open(path: &Path, password: Option<&str>, policy: &ExtractionPolicy) -> Result<Self, LiberaError> {
        let volume_paths = if is_seven_zip_volume_path(path) {
            discover_seven_zip_volumes(&first_volume_path(path))?
        } else {
            vec![path.to_path_buf()]
        };
        let mut source = VolumeSet::open(&volume_paths)?;
        let password = password.filter(|password| !password.is_empty());
        let has_password = password.is_some();
        let password = password.map_or_else(Password::empty, Password::new);
        let archive = Archive::read(&mut source, &password).map_err(|error| match map_error(error) {
            // A header that fails to parse under a password is the password's doing.
            LiberaError::CorruptArchive { .. } if has_password => LiberaError::WrongPassword,
            other => other,
        })?;
        let archive = with_contiguous_blocks(archive);
        if archive.files.len() as u64 > policy.max_entries {
            return Err(LiberaError::TooManyEntries {
                message: format!("archive contains more than {} entries", format_count(policy.max_entries)),
            });
        }

        let entries = archive
            .files
            .iter()
            .enumerate()
            .map(|(index, file)| {
                let unix_mode = (file.has_windows_attributes
                    && (file.windows_attributes & 0x8000 != 0 || file.windows_attributes >> 16 != 0))
                    .then_some(file.windows_attributes >> 16);
                let is_directory = file.is_directory;
                SevenZipEntry {
                    path: file.name.clone(),
                    size: if is_directory { 0 } else { file.size },
                    is_directory,
                    is_symlink: !is_directory && unix_mode.is_some_and(|mode| mode & 0o170_000 == 0o120_000),
                    mode: unix_mode.map(|mode| mode & 0o7777).filter(|mode| *mode != 0),
                    modified: file.has_last_modified_date.then(|| SystemTime::from(file.last_modified_date)),
                    block: archive.stream_map.file_block_index[index],
                }
            })
            .collect();
        Ok(Self { source, archive, password, has_password, entries })
    }

    fn block_is_encrypted(&self, block: usize) -> bool {
        self.archive.blocks[block].coders.iter().any(|coder| coder.encoder_method_id() == AES_METHOD)
    }

    /// Decodes block `block`, handing each of its entries to `each` with a
    /// reader over its contents. `each` has to read an entry to its end before
    /// returning - a block is one stream - and an entry it does not want it
    /// should drain. A failed read is reported as a wrong password when the
    /// block is encrypted and a password was given, and as damage otherwise.
    pub(crate) fn for_each_in_block(
        &mut self,
        block: usize,
        mut each: impl FnMut(usize, &mut dyn Read) -> Result<(), LiberaError>,
    ) -> Result<(), LiberaError> {
        let first = self.archive.stream_map.block_first_file_index[block];
        let wrong_password = self.has_password && self.block_is_encrypted(block);
        let mut index = first;
        let decoder = BlockDecoder::new(1, block, &self.archive, &self.password, &mut self.source);
        let mut failure = None;
        let result = decoder.for_each_entries(&mut |_, reader| {
            let mut classified = Classified { inner: reader, wrong_password };
            let outcome = each(index, &mut classified);
            index += 1;
            match outcome {
                Ok(()) => Ok(true),
                Err(error) => {
                    failure = Some(error);
                    Ok(false)
                }
            }
        });
        if let Some(error) = failure {
            return Err(error);
        }
        result.map(|_| ()).map_err(|error| match map_error(error) {
            LiberaError::CorruptArchive { .. } if wrong_password => LiberaError::WrongPassword,
            other => other,
        })
    }
}

/// The archive with its entries reordered so each block's files sit next to
/// one another, every entry without data after them.
///
/// The format lets folders and empty files sit between the files of one solid
/// block - the Electron engine's writer put them there in walk order - but
/// sevenz-rust2's block decoder walks a block's files as one run of the entry
/// list, and would pair a folder with the next file's data. Files with data
/// keep their order, which is the order they were assigned to blocks in.
fn with_contiguous_blocks(mut archive: Archive) -> Archive {
    let files = std::mem::take(&mut archive.files);
    let blocks = std::mem::take(&mut archive.stream_map.file_block_index);
    let mut with_data = Vec::with_capacity(files.len());
    let mut file_block_index = Vec::with_capacity(files.len());
    let mut without_data = Vec::new();
    for (file, block) in files.into_iter().zip(blocks) {
        if file.has_stream {
            with_data.push(file);
            file_block_index.push(block);
        } else {
            without_data.push(file);
        }
    }

    let mut next_file = 0;
    for block_index in 0..archive.blocks.len() {
        archive.stream_map.block_first_file_index[block_index] = next_file;
        while file_block_index.get(next_file).copied().flatten() == Some(block_index) {
            next_file += 1;
        }
    }
    file_block_index.resize(with_data.len() + without_data.len(), None);
    archive.files = with_data.into_iter().chain(without_data).collect();
    archive.stream_map.file_block_index = file_block_index;
    archive
}

/// Turns a decoder's read error into what it most likely means, before
/// anything that writes the bytes out sees it.
struct Classified<'a> {
    inner: &'a mut dyn Read,
    wrong_password: bool,
}

impl Read for Classified<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.inner.read(buf).map_err(|error| {
            if error.get_ref().is_some_and(|inner| inner.is::<LiberaError>()) {
                error
            } else if self.wrong_password {
                LiberaError::WrongPassword.into()
            } else {
                LiberaError::CorruptArchive { message: format!("The 7z archive is damaged: {error}") }.into()
            }
        })
    }
}
