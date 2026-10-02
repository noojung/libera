use std::io::{self, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use super::crypto::{AesReader, AesStrength, ZipCryptoReader};
use super::format::*;
use super::volumes::{VolumeSet, discover_split_volumes, terminal_volume_path};
use crate::LiberaError;
use crate::safety::ExtractionPolicy;
use crate::safety::format_count;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Encryption {
    None,
    /// PKWARE's traditional cipher.
    ZipCrypto,
    Aes {
        strength: AesStrength,
        vendor_version: u16,
    },
}

/// One central directory record, decoded and checked against its local header.
#[derive(Debug, Clone)]
pub(crate) struct ZipEntry {
    pub name: String,
    pub is_directory: bool,
    /// The method the data was compressed with, under any encryption.
    pub method: u16,
    pub flags: u16,
    pub crc32: u32,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub dos_time: u16,
    pub modified: Option<SystemTime>,
    /// The Unix mode in the high half of the external attributes, if any.
    pub unix_mode: u32,
    pub encryption: Encryption,
    pub version_needed: u16,
    /// Where the local header starts, in the joined address space.
    pub header_offset: u64,
    /// Where the stored bytes start, past the local header.
    pub data_offset: u64,
}

impl ZipEntry {
    pub(crate) fn is_symlink(&self) -> bool {
        !self.is_directory && self.unix_mode & S_IFMT == S_IFLNK
    }

    pub(crate) fn is_encrypted(&self) -> bool {
        self.encryption != Encryption::None
    }
}

pub(crate) struct OpenOptions {
    pub policy: ExtractionPolicy,
    pub encoding: FilenameEncoding,
}

/// An open archive: its entries, and the volumes their bytes are read from.
pub(crate) struct ZipArchive {
    source: VolumeSet,
    pub entries: Vec<ZipEntry>,
    pub volume_paths: Vec<PathBuf>,
    pub volume_sizes: Vec<u64>,
    /// The central directory's place as the end record gives it, relative to
    /// the volume it starts on.
    pub directory_offset: u64,
    pub directory_size: u64,
}

fn corrupt(message: impl Into<String>) -> LiberaError {
    LiberaError::CorruptArchive { message: message.into() }
}

/// Where the end of central directory record sits, and what it says.
struct EndRecord {
    position: u64,
    disk: u32,
    directory_disk: u32,
    total_entries: u64,
    directory_size: u64,
    directory_offset: u64,
    /// Where the Zip64 end record sits, when there is one.
    zip64_position: Option<u64>,
}

/// The last end-of-central-directory record whose comment reaches exactly to
/// the end of the file. Anything appended after it is refused, as the
/// Electron engine's strict reader refuses it.
fn find_end_record(source: &mut (impl Read + Seek), length: u64) -> Result<(u64, Vec<u8>), LiberaError> {
    let tail_length = length.min((END_OF_CENTRAL_DIRECTORY_LENGTH + MAX_COMMENT_LENGTH) as u64);
    if tail_length < END_OF_CENTRAL_DIRECTORY_LENGTH as u64 {
        return Err(corrupt("The file is too short to be a ZIP archive."));
    }
    let tail_start = length - tail_length;
    let mut tail = vec![0; tail_length as usize];
    source.seek(SeekFrom::Start(tail_start))?;
    source.read_exact(&mut tail)?;
    for offset in (0..=tail.len() - END_OF_CENTRAL_DIRECTORY_LENGTH).rev() {
        if u32::from_le_bytes(tail[offset..offset + 4].try_into().unwrap()) != END_OF_CENTRAL_DIRECTORY_SIGNATURE {
            continue;
        }
        let comment_length = usize::from(u16::from_le_bytes(tail[offset + 20..offset + 22].try_into().unwrap()));
        if offset + END_OF_CENTRAL_DIRECTORY_LENGTH + comment_length == tail.len() {
            return Ok((tail_start + offset as u64, tail[offset..].to_vec()));
        }
    }
    Err(corrupt("No ZIP end of central directory record was found."))
}

fn read_at(source: &mut (impl Read + Seek), position: u64, length: usize) -> io::Result<Vec<u8>> {
    let mut bytes = vec![0; length];
    source.seek(SeekFrom::Start(position))?;
    source.read_exact(&mut bytes)?;
    Ok(bytes)
}

/// Reads the end records of the terminal volume, before the rest of a split
/// set is known: everything here is relative to that one file.
fn read_end_record(terminal: &mut std::fs::File) -> Result<EndRecord, LiberaError> {
    let length = terminal.metadata()?.len();
    let (position, record) = find_end_record(terminal, length)?;
    let mut fields = Cursor::new(&record[4..]);
    let disk = u32::from(fields.u16().unwrap());
    let directory_disk = u32::from(fields.u16().unwrap());
    let _entries_on_disk = fields.u16().unwrap();
    let total_entries = u64::from(fields.u16().unwrap());
    let directory_size = u64::from(fields.u32().unwrap());
    let directory_offset = u64::from(fields.u32().unwrap());
    let mut end = EndRecord {
        position,
        disk,
        directory_disk,
        total_entries,
        directory_size,
        directory_offset,
        zip64_position: None,
    };

    let Some(locator_position) = position.checked_sub(ZIP64_LOCATOR_LENGTH as u64) else { return Ok(end) };
    let locator = read_at(terminal, locator_position, ZIP64_LOCATOR_LENGTH)?;
    let mut locator = Cursor::new(&locator);
    if locator.u32() != Some(ZIP64_LOCATOR_SIGNATURE) {
        return Ok(end);
    }
    let _record_disk = locator.u32().unwrap();
    let record_offset = locator.u64().unwrap();
    // The Zip64 end record sits right before its locator; its recorded offset
    // is relative to its own volume, which is checked against that below.
    let record_position = locator_position
        .checked_sub(ZIP64_END_OF_CENTRAL_DIRECTORY_LENGTH as u64)
        .ok_or_else(|| corrupt("The Zip64 end of central directory record is missing."))?;
    let record = read_at(terminal, record_position, ZIP64_END_OF_CENTRAL_DIRECTORY_LENGTH)?;
    let mut record = Cursor::new(&record);
    if record.u32() != Some(ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
        return Err(corrupt("The Zip64 end of central directory record is missing."));
    }
    let _size = record.u64();
    let _versions = record.u32();
    end.disk = record.u32().unwrap();
    end.directory_disk = record.u32().unwrap();
    let _entries_on_disk = record.u64();
    end.total_entries = record.u64().unwrap();
    end.directory_size = record.u64().unwrap();
    end.directory_offset = record.u64().unwrap();
    end.zip64_position = Some(record_position);
    if end.disk == 0 && record_offset != record_position {
        return Err(LiberaError::unsafe_archive("prepended data"));
    }
    Ok(end)
}

impl ZipArchive {
    /// Opens `path` - or the set it belongs to, when it is a split volume or
    /// the terminal volume of one - and checks every entry's layout before
    /// any of them is read.
    pub(crate) fn open(path: &Path, options: &OpenOptions) -> Result<Self, LiberaError> {
        let terminal = terminal_volume_path(path);
        let mut terminal_file = std::fs::File::open(&terminal).map_err(|_| LiberaError::ArchiveMissing {
            message: format!("Archive file does not exist: {}", terminal.display()),
        })?;
        let end = read_end_record(&mut terminal_file)?;
        drop(terminal_file);

        let volume_paths = if end.disk > 0 { discover_split_volumes(&terminal)? } else { vec![terminal.clone()] };
        let mut source = VolumeSet::open(&volume_paths)?;
        let terminal_start = source.len() - std::fs::metadata(volume_paths.last().unwrap())?.len();

        if end.total_entries > options.policy.max_entries {
            return Err(LiberaError::TooManyEntries {
                message: format!("archive contains more than {} entries", format_count(options.policy.max_entries)),
            });
        }
        let directory_start = source
            .absolute(end.directory_disk, end.directory_offset)
            .ok_or_else(|| corrupt("The central directory lies outside the archive."))?;
        // The central directory ends where the end records begin. A gap means
        // bytes were put in front of the archive, which shift every offset.
        let end_records_start = terminal_start + end.zip64_position.unwrap_or(end.position);
        let directory_end = directory_start
            .checked_add(end.directory_size)
            .ok_or_else(|| corrupt("The central directory size is out of range."))?;
        if directory_end < end_records_start {
            return Err(LiberaError::unsafe_archive("prepended data"));
        }
        if directory_end > end_records_start || end.directory_size < end.total_entries * CENTRAL_HEADER_LENGTH as u64 {
            return Err(corrupt("The central directory does not fit where the archive says it is."));
        }

        let directory = read_at(&mut source, directory_start, end.directory_size as usize)?;
        let mut entries = parse_central_directory(&directory, end.total_entries, &source, options.encoding)?;
        check_layout(&mut source, &mut entries, directory_start)?;

        Ok(Self {
            volume_sizes: source.volume_sizes(),
            source,
            entries,
            volume_paths,
            directory_offset: end.directory_offset,
            directory_size: end.directory_size,
        })
    }

    /// A reader over entry `index`'s contents: decrypted with `password`,
    /// decompressed, and checked for length and - unless `verify_crc` is off -
    /// for its CRC as the last byte goes past.
    pub(crate) fn open_entry(
        &mut self,
        index: usize,
        password: Option<&str>,
        verify_crc: bool,
    ) -> Result<Box<dyn Read + '_>, LiberaError> {
        let entry = self.entries[index].clone();
        let password = match (entry.encryption, password) {
            (Encryption::None, _) => None,
            (_, Some(password)) => Some(password.as_bytes()),
            (_, None) => return Err(LiberaError::PasswordRequired),
        };
        self.source.seek(SeekFrom::Start(entry.data_offset))?;
        let stored = BufReader::new((&mut self.source).take(entry.compressed_size));
        let decrypted: Box<dyn Read + '_> = match (entry.encryption, password) {
            (Encryption::ZipCrypto, Some(password)) => {
                // An entry whose CRC follows its data is checked against its time.
                let check_byte = if entry.flags & FLAG_DATA_DESCRIPTOR != 0 {
                    (entry.dos_time >> 8) as u8
                } else {
                    (entry.crc32 >> 24) as u8
                };
                Box::new(ZipCryptoReader::new(stored, password, check_byte)?)
            }
            (Encryption::Aes { strength, .. }, Some(password)) => {
                Box::new(AesReader::new(stored, password, strength, entry.compressed_size)?)
            }
            _ => Box::new(stored),
        };
        let decoded = decoder(&entry, decrypted)?;
        // AE-2 zeroes the CRC and leaves integrity to its authentication code.
        let crc_present = !matches!(entry.encryption, Encryption::Aes { vendor_version: 2, .. });
        Ok(Box::new(Checked {
            inner: decoded,
            hasher: crc32fast::Hasher::new(),
            expected_crc: (verify_crc && crc_present).then_some(entry.crc32),
            expected_length: entry.uncompressed_size,
            length: 0,
            encrypted: entry.is_encrypted(),
        }))
    }
}

fn parse_central_directory(
    directory: &[u8],
    total_entries: u64,
    source: &VolumeSet,
    encoding: FilenameEncoding,
) -> Result<Vec<ZipEntry>, LiberaError> {
    let mut cursor = Cursor::new(directory);
    let mut entries = Vec::with_capacity(total_entries as usize);
    let truncated = || corrupt("A central directory record is truncated.");
    for _ in 0..total_entries {
        if cursor.u32() != Some(CENTRAL_HEADER_SIGNATURE) {
            return Err(corrupt("The central directory holds fewer records than the archive says."));
        }
        let version_made_by = cursor.u16().ok_or_else(truncated)?;
        let version_needed = cursor.u16().ok_or_else(truncated)?;
        let flags = cursor.u16().ok_or_else(truncated)?;
        let stored_method = cursor.u16().ok_or_else(truncated)?;
        let dos_time = cursor.u16().ok_or_else(truncated)?;
        let dos_date = cursor.u16().ok_or_else(truncated)?;
        let crc32 = cursor.u32().ok_or_else(truncated)?;
        let compressed_size = cursor.u32().ok_or_else(truncated)?;
        let uncompressed_size = cursor.u32().ok_or_else(truncated)?;
        let name_length = cursor.u16().ok_or_else(truncated)?;
        let extra_length = cursor.u16().ok_or_else(truncated)?;
        let comment_length = cursor.u16().ok_or_else(truncated)?;
        let disk_start = cursor.u16().ok_or_else(truncated)?;
        let _internal_attributes = cursor.u16().ok_or_else(truncated)?;
        let external_attributes = cursor.u32().ok_or_else(truncated)?;
        let local_offset = cursor.u32().ok_or_else(truncated)?;
        let raw_name = cursor.take(usize::from(name_length)).ok_or_else(truncated)?;
        let extra = ExtraFields::parse(cursor.take(usize::from(extra_length)).ok_or_else(truncated)?);
        cursor.take(usize::from(comment_length)).ok_or_else(truncated)?;

        let mut zip64 = Zip64Values::new(extra.zip64.as_deref());
        let bad_zip64 = || corrupt("A Zip64 extra field is missing a value its record needs.");
        let uncompressed_size = zip64.resolve_u64(uncompressed_size).ok_or_else(bad_zip64)?;
        let compressed_size = zip64.resolve_u64(compressed_size).ok_or_else(bad_zip64)?;
        let local_offset = zip64.resolve_u64(local_offset).ok_or_else(bad_zip64)?;
        let disk = zip64.resolve_disk(disk_start).ok_or_else(bad_zip64)?;
        let header_offset =
            source.absolute(disk, local_offset).ok_or_else(|| corrupt("An entry points outside the archive."))?;

        let encryption = if stored_method == METHOD_AES {
            let aes = extra.aes.ok_or_else(|| corrupt("An AES entry is missing its AES extra field."))?;
            Encryption::Aes {
                strength: AesStrength::from_code(aes.strength).ok_or_else(|| corrupt("Unknown AES strength."))?,
                vendor_version: aes.vendor_version,
            }
        } else if flags & FLAG_ENCRYPTED != 0 {
            Encryption::ZipCrypto
        } else {
            Encryption::None
        };
        let method = match (encryption, extra.aes) {
            (Encryption::Aes { .. }, Some(aes)) => aes.method,
            _ => stored_method,
        };

        let name = decode_name(raw_name, flags, &extra, encoding);
        let unix_mode = external_attributes >> 16;
        // MS-DOS and NTFS hosts flag a folder in the low attribute byte.
        let host = version_made_by >> 8;
        let dos_directory = matches!(host, 0 | 10 | 11 | 14) && external_attributes & 0x10 != 0;
        let is_directory =
            name.ends_with('/') || name.ends_with('\\') || unix_mode & S_IFMT == S_IFDIR || dos_directory;

        entries.push(ZipEntry {
            name,
            is_directory,
            method,
            flags,
            crc32,
            compressed_size,
            uncompressed_size,
            dos_time,
            modified: extra.modified.or_else(|| dos_to_system_time(dos_date, dos_time)),
            unix_mode,
            encryption,
            version_needed,
            header_offset,
            data_offset: 0,
        });
    }
    Ok(entries)
}

/// Reads every local header to find where each entry's data starts, and
/// refuses an archive whose entries overlap one another or the central
/// directory - the shape of a zip bomb that reuses one stretch of compressed
/// data for many entries - or that carries data in front of its first entry.
fn check_layout(source: &mut VolumeSet, entries: &mut [ZipEntry], directory_start: u64) -> Result<(), LiberaError> {
    let mut spans = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter_mut().enumerate() {
        let header = read_at(source, entry.header_offset, LOCAL_HEADER_LENGTH)
            .map_err(|_| corrupt(format!("The local header of {} is cut short.", entry.name)))?;
        let mut header = Cursor::new(&header);
        if header.u32() != Some(LOCAL_HEADER_SIGNATURE) {
            return Err(corrupt(format!("The local header of {} is missing.", entry.name)));
        }
        header.take(22);
        let name_length = u64::from(header.u16().unwrap());
        let extra_length = u64::from(header.u16().unwrap());
        entry.data_offset = entry.header_offset + LOCAL_HEADER_LENGTH as u64 + name_length + extra_length;
        let data_end =
            entry.data_offset.checked_add(entry.compressed_size).filter(|end| *end <= directory_start).ok_or_else(
                || LiberaError::unsafe_archive(format!("entry data runs into the central directory: {}", entry.name)),
            )?;
        spans.push((entry.header_offset, data_end, index));
    }

    spans.sort_unstable();
    for pair in spans.windows(2) {
        if pair[1].0 < pair[0].1 {
            return Err(LiberaError::unsafe_archive(format!(
                "archive entries overlap: {} and {}",
                entries[pair[0].2].name, entries[pair[1].2].name
            )));
        }
    }
    if let Some(&(first, _, _)) = spans.first()
        && first > 0
    {
        // A split set's first volume opens with a 4 byte spanning marker.
        let marker = read_at(source, 0, 4).ok().map(|bytes| u32::from_le_bytes(bytes.try_into().unwrap()));
        if !(first == 4 && marker == Some(SPANNING_SIGNATURE)) {
            return Err(LiberaError::unsafe_archive("prepended data"));
        }
    }
    Ok(())
}

/// The dictionary an LZMA entry is decoded with. The decoder allocates it
/// whole, so it is held to what the entry can use - a match never reaches
/// past what the entry expands to - and to a ceiling past what any encoder
/// writes for a ZIP entry, so a header that lies about both sizes cannot ask
/// for gigabytes. A stream that truly needs more fails rather than allocating.
const LZMA_MAX_DICTIONARY: u64 = 256 << 20;

fn bounded_dictionary(declared: u32, uncompressed: u64) -> u32 {
    u64::from(declared).min(uncompressed).clamp(4096, LZMA_MAX_DICTIONARY) as u32
}

fn decoder<'a>(entry: &ZipEntry, stored: Box<dyn Read + 'a>) -> Result<Box<dyn Read + 'a>, LiberaError> {
    Ok(match entry.method {
        METHOD_STORE => stored,
        METHOD_DEFLATE => Box::new(flate2::read::DeflateDecoder::new(stored)),
        METHOD_DEFLATE64 => Box::new(deflate64::Deflate64Decoder::new(stored)),
        METHOD_BZIP2 => Box::new(bzip2::read::BzDecoder::new(stored)),
        METHOD_ZSTD => Box::new(zstd::stream::read::Decoder::new(stored)?),
        METHOD_LZMA => {
            let mut stored = stored;
            // Two bytes of encoder version, two of property length, then the
            // five property bytes: lc/lp/pb and the dictionary size.
            let mut header = [0; 9];
            stored.read_exact(&mut header)?;
            if u16::from_le_bytes([header[2], header[3]]) != 5 {
                return Err(corrupt(format!("The LZMA properties of {} are malformed.", entry.name)));
            }
            let dictionary = u32::from_le_bytes(header[5..9].try_into().unwrap());
            let reader = lzma_rust2::LzmaReader::new_with_props(
                stored,
                entry.uncompressed_size,
                header[4],
                bounded_dictionary(dictionary, entry.uncompressed_size),
                None,
            )?;
            Box::new(reader)
        }
        other => {
            return Err(LiberaError::UnsupportedArchive {
                message: format!("{} uses compression method {other}, which Libera cannot read.", entry.name),
            });
        }
    })
}

/// Holds an entry to the length and CRC its record declares. Too many bytes
/// fail at once; too few, or the wrong ones, fail at the end.
struct Checked<R> {
    inner: R,
    hasher: crc32fast::Hasher,
    expected_crc: Option<u32>,
    expected_length: u64,
    length: u64,
    encrypted: bool,
}

impl<R: Read> Read for Checked<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buf)?;
        self.length += read as u64;
        if self.length > self.expected_length {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "an entry expands past the size it declares"));
        }
        if self.expected_crc.is_some() {
            self.hasher.update(&buf[..read]);
        }
        if read == 0 && !buf.is_empty() {
            if self.length != self.expected_length {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "an entry ends before the size it declares"));
            }
            if let Some(expected) = self.expected_crc.take() {
                let actual = std::mem::take(&mut self.hasher).finalize();
                if actual != expected {
                    // The traditional cipher lets one wrong password in 256
                    // past its check, and that password then decodes to noise;
                    // with a password in play it is the likelier culprit.
                    return Err(if self.encrypted {
                        LiberaError::WrongPassword.into()
                    } else {
                        io::Error::new(io::ErrorKind::InvalidData, "an entry fails its CRC check")
                    });
                }
            }
        }
        Ok(read)
    }
}
