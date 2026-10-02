use std::io::{self, Read, Write};
use std::time::SystemTime;

use super::crypto::{AesStrength, AesWriter, ZipCryptoWriter};
use super::format::*;
use super::volumes::{Position, Sink};
use crate::codec::{ZstdTuning, zstd_encoder};
use crate::deflate::{DeflateFrame, DeflateTuning, DeflateWriter};
use crate::progress::CancelToken;

/// How one entry's data is compressed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum EntryMethod {
    Store,
    Deflate(DeflateTuning),
    /// The archive level 1-9, spent on how hard the match finder looks.
    Lzma(u8),
    Zstd(u8, ZstdTuning),
}

impl EntryMethod {
    fn number(self) -> u16 {
        match self {
            Self::Store => METHOD_STORE,
            Self::Deflate(_) => METHOD_DEFLATE,
            Self::Lzma(_) => METHOD_LZMA,
            Self::Zstd(..) => METHOD_ZSTD,
        }
    }

    fn version_needed(self) -> u16 {
        match self {
            Self::Store => 10,
            Self::Deflate(_) => 20,
            Self::Lzma(_) | Self::Zstd(..) => 63,
        }
    }
}

/// How every entry with data is encrypted, the password included.
#[derive(Clone)]
pub(crate) enum EntryEncryption {
    None,
    ZipCrypto(String),
    Aes(AesStrength, String),
}

struct CentralRecord {
    name: Vec<u8>,
    flags: u16,
    method: u16,
    version_needed: u16,
    dos_time: u16,
    dos_date: u16,
    crc32: u32,
    compressed_size: u64,
    uncompressed_size: u64,
    position: Position,
    external_attributes: u32,
    /// Fields the record carries besides Zip64, which is worked out at the end.
    extra: Vec<u8>,
}

/// LZMA dictionaries stop at 16 MiB: a decoder allocates the whole of the one
/// an entry declares, so a larger one would ask every reader for as much.
const LZMA_MAX_DICTIONARY_SIZE: u64 = 16 << 20;
const LZMA_MIN_DICTIONARY_SIZE: u64 = 4096;

/// A dictionary just large enough for `input_size`, rounded up to a power of
/// two so it is one every LZMA decoder accepts.
fn lzma_dictionary_size(input_size: u64) -> u32 {
    input_size.clamp(LZMA_MIN_DICTIONARY_SIZE, LZMA_MAX_DICTIONARY_SIZE).next_power_of_two() as u32
}

/// Counts what passes into the sink, which is the entry's stored size.
struct Counted<'a, W> {
    inner: &'a mut W,
    count: u64,
}

impl<W: Write> Write for Counted<'_, W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let written = self.inner.write(buf)?;
        self.count += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// The encryption layer an entry's compressed bytes pass through.
enum Encrypting<W: Write> {
    Plain(W),
    ZipCrypto(ZipCryptoWriter<W>),
    Aes(AesWriter<W>),
}

impl<W: Write> Encrypting<W> {
    fn finish(self) -> io::Result<W> {
        match self {
            Self::Plain(writer) => Ok(writer),
            Self::ZipCrypto(writer) => writer.finish(),
            Self::Aes(writer) => writer.finish(),
        }
    }
}

impl<W: Write> Write for Encrypting<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Self::Plain(writer) => writer.write(buf),
            Self::ZipCrypto(writer) => writer.write(buf),
            Self::Aes(writer) => writer.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::Plain(writer) => writer.flush(),
            Self::ZipCrypto(writer) => writer.flush(),
            Self::Aes(writer) => writer.flush(),
        }
    }
}

/// The compression layer, over the encryption layer.
enum Compressing<W: Write> {
    Store(W),
    Deflate(DeflateWriter<W>),
    // Boxed: the LZMA encoder's state runs to kilobytes.
    Lzma(Box<lzma_rust2::LzmaWriter<W>>),
    Zstd(zstd::stream::write::Encoder<'static, W>),
}

impl<W: Write> Compressing<W> {
    fn new(mut inner: W, method: EntryMethod, size: u64) -> io::Result<Self> {
        Ok(match method {
            EntryMethod::Store => Self::Store(inner),
            EntryMethod::Deflate(tuning) => Self::Deflate(DeflateWriter::new(inner, DeflateFrame::Raw, tuning)?),
            EntryMethod::Lzma(level) => {
                let effort = u32::from(level.clamp(1, 9));
                let mut options = lzma_rust2::LzmaOptions::with_preset(6);
                options.dict_size = lzma_dictionary_size(size);
                options.nice_len =
                    (effort * 32).clamp(lzma_rust2::LzmaOptions::NICE_LEN_MIN, lzma_rust2::LzmaOptions::NICE_LEN_MAX);
                options.depth_limit = (effort * 32) as i32;
                // Version 9.20 of the LZMA SDK, five property bytes, then the
                // properties; no end marker, so readers stop at the size.
                let dictionary = options.dict_size.to_le_bytes();
                inner.write_all(&[9, 20, 5, 0, options.get_props()])?;
                inner.write_all(&dictionary)?;
                Self::Lzma(Box::new(lzma_rust2::LzmaWriter::new(inner, &options, false, false, Some(size))?))
            }
            EntryMethod::Zstd(level, tuning) => {
                let mut encoder = zstd_encoder(inner, level, tuning)?;
                // The frame records its size, and fails if the file changes it.
                encoder.include_contentsize(true)?;
                encoder.set_pledged_src_size(Some(size))?;
                Self::Zstd(encoder)
            }
        })
    }

    fn finish(self) -> io::Result<W> {
        match self {
            Self::Store(writer) => Ok(writer),
            Self::Deflate(writer) => writer.finish(),
            Self::Lzma(writer) => Ok(writer.finish()?),
            Self::Zstd(writer) => writer.finish(),
        }
    }
}

impl<W: Write> Write for Compressing<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Self::Store(writer) => writer.write(buf),
            Self::Deflate(writer) => writer.write(buf),
            Self::Lzma(writer) => writer.write(buf),
            Self::Zstd(writer) => writer.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::Store(writer) => writer.flush(),
            Self::Deflate(writer) => writer.flush(),
            Self::Lzma(writer) => writer.flush(),
            Self::Zstd(writer) => writer.flush(),
        }
    }
}

/// Writes a ZIP archive into a [`Sink`], one entry at a time. Every entry's
/// sizes and CRC follow its data in a descriptor, so the writer never seeks,
/// which is what lets it write a split set volume by volume.
pub(crate) struct ZipWriter<S: Sink> {
    sink: S,
    records: Vec<CentralRecord>,
}

/// Entries this large or larger are written with Zip64 sizes from the start,
/// since compression can leave incompressible data a little larger still.
const ZIP64_THRESHOLD: u64 = 0xffff_0000;

fn name_bytes(name: &str) -> (Vec<u8>, u16) {
    let flags = if name.is_ascii() { 0 } else { FLAG_UTF8 };
    (name.as_bytes().to_vec(), flags)
}

/// The extended timestamp field, which carries the modification time in UTC
/// to the second, where the DOS fields are local time to two seconds.
fn timestamp_extra(modified: SystemTime) -> Vec<u8> {
    let seconds = modified.duration_since(SystemTime::UNIX_EPOCH).map(|elapsed| elapsed.as_secs()).unwrap_or(0);
    let Ok(seconds) = u32::try_from(seconds) else { return Vec::new() };
    let mut extra = Vec::with_capacity(9);
    extra.extend(EXTRA_EXTENDED_TIMESTAMP.to_le_bytes());
    extra.extend(5u16.to_le_bytes());
    extra.push(1);
    extra.extend(seconds.to_le_bytes());
    extra
}

fn aes_extra(strength: AesStrength, method: u16) -> Vec<u8> {
    let mut extra = Vec::with_capacity(11);
    extra.extend(EXTRA_AES.to_le_bytes());
    extra.extend(7u16.to_le_bytes());
    // AE-2: the CRC is left out, so it cannot give away anything about the
    // plain data; the authentication code covers integrity instead.
    extra.extend(2u16.to_le_bytes());
    extra.extend(b"AE");
    extra.push(strength as u8);
    extra.extend(method.to_le_bytes());
    extra
}

impl<S: Sink> ZipWriter<S> {
    /// `spanning` opens the archive with the marker a split set's first volume
    /// carries.
    pub(crate) fn new(mut sink: S, spanning: bool) -> io::Result<Self> {
        if spanning {
            sink.write_all(&SPANNING_SIGNATURE.to_le_bytes())?;
        }
        Ok(Self { sink, records: Vec::new() })
    }

    #[allow(clippy::too_many_arguments)]
    fn write_local_header(
        &mut self,
        name: &[u8],
        version_needed: u16,
        flags: u16,
        method: u16,
        (dos_date, dos_time): (u16, u16),
        crc32: u32,
        sizes: Option<(u32, u32)>,
        extra: &[u8],
    ) -> io::Result<Position> {
        self.sink.keep_whole((LOCAL_HEADER_LENGTH + name.len() + extra.len()) as u64)?;
        let position = self.sink.position();
        let (compressed, uncompressed) = sizes.unwrap_or((0, 0));
        let mut header = Vec::with_capacity(LOCAL_HEADER_LENGTH + name.len() + extra.len());
        header.extend(LOCAL_HEADER_SIGNATURE.to_le_bytes());
        header.extend(version_needed.to_le_bytes());
        header.extend(flags.to_le_bytes());
        header.extend(method.to_le_bytes());
        header.extend(dos_time.to_le_bytes());
        header.extend(dos_date.to_le_bytes());
        header.extend(crc32.to_le_bytes());
        header.extend(compressed.to_le_bytes());
        header.extend(uncompressed.to_le_bytes());
        header.extend((name.len() as u16).to_le_bytes());
        header.extend((extra.len() as u16).to_le_bytes());
        header.extend(name);
        header.extend(extra);
        self.sink.write_all(&header)?;
        Ok(position)
    }

    pub(crate) fn add_directory(&mut self, name: &str, modified: SystemTime, mode: u32) -> io::Result<()> {
        let (name, flags) = name_bytes(&format!("{}/", name.trim_end_matches('/')));
        let dos = system_time_to_dos(modified);
        let extra = timestamp_extra(modified);
        let position = self.write_local_header(&name, 20, flags, METHOD_STORE, dos, 0, Some((0, 0)), &extra)?;
        self.records.push(CentralRecord {
            name,
            flags,
            method: METHOD_STORE,
            version_needed: 20,
            dos_time: dos.1,
            dos_date: dos.0,
            crc32: 0,
            compressed_size: 0,
            uncompressed_size: 0,
            position,
            external_attributes: ((S_IFDIR | (mode & 0o7777)) << 16) | 0x10,
            extra,
        });
        Ok(())
    }

    /// Writes one entry with data. `size` is the length `content` is expected
    /// to have, which sizes the LZMA dictionary and decides Zip64 up front.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn add_file(
        &mut self,
        name: &str,
        modified: SystemTime,
        unix_mode: u32,
        method: EntryMethod,
        encryption: &EntryEncryption,
        content: &mut dyn Read,
        size: u64,
        cancel: &CancelToken,
    ) -> io::Result<()> {
        let (name, mut flags) = name_bytes(name);
        flags |= FLAG_DATA_DESCRIPTOR;
        let dos = system_time_to_dos(modified);
        let zip64 = size >= ZIP64_THRESHOLD;
        let mut version_needed = method.version_needed().max(if zip64 { 45 } else { 0 });
        let mut extra = timestamp_extra(modified);
        let stored_method = match encryption {
            EntryEncryption::None => method.number(),
            EntryEncryption::ZipCrypto(_) => {
                flags |= FLAG_ENCRYPTED;
                version_needed = version_needed.max(20);
                method.number()
            }
            EntryEncryption::Aes(strength, _) => {
                flags |= FLAG_ENCRYPTED;
                version_needed = version_needed.max(51);
                extra.extend(aes_extra(*strength, method.number()));
                METHOD_AES
            }
        };
        let mut local_extra = extra.clone();
        if zip64 {
            local_extra.extend(EXTRA_ZIP64.to_le_bytes());
            local_extra.extend(16u16.to_le_bytes());
            local_extra.extend([0; 16]);
        }
        let sizes = zip64.then_some((ZIP64_MARKER_32, ZIP64_MARKER_32));
        let position =
            self.write_local_header(&name, version_needed, flags, stored_method, dos, 0, sizes, &local_extra)?;

        let counted = Counted { inner: &mut self.sink, count: 0 };
        let encrypting = match encryption {
            EntryEncryption::None => Encrypting::Plain(counted),
            // With the CRC still unknown, the check byte comes from the time.
            EntryEncryption::ZipCrypto(password) => {
                Encrypting::ZipCrypto(ZipCryptoWriter::new(counted, password.as_bytes(), (dos.1 >> 8) as u8)?)
            }
            EntryEncryption::Aes(strength, password) => {
                Encrypting::Aes(AesWriter::new(counted, password.as_bytes(), *strength)?)
            }
        };
        let mut compressing = Compressing::new(encrypting, method, size)?;
        let mut hasher = crc32fast::Hasher::new();
        let mut buffer = vec![0; 64 * 1024];
        let mut uncompressed_size = 0u64;
        loop {
            cancel.check()?;
            let read = match content.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => read,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            };
            hasher.update(&buffer[..read]);
            compressing.write_all(&buffer[..read])?;
            uncompressed_size += read as u64;
        }
        let compressed_size = compressing.finish()?.finish()?.count;
        let crc32 = if matches!(encryption, EntryEncryption::Aes(..)) { 0 } else { hasher.finalize() };

        let mut descriptor = Vec::with_capacity(24);
        descriptor.extend(DATA_DESCRIPTOR_SIGNATURE.to_le_bytes());
        descriptor.extend(crc32.to_le_bytes());
        if zip64 {
            descriptor.extend(compressed_size.to_le_bytes());
            descriptor.extend(uncompressed_size.to_le_bytes());
        } else {
            if compressed_size > u64::from(u32::MAX) || uncompressed_size > u64::from(u32::MAX) {
                return Err(io::Error::other("a file grew past 4 GiB while it was being archived"));
            }
            descriptor.extend((compressed_size as u32).to_le_bytes());
            descriptor.extend((uncompressed_size as u32).to_le_bytes());
        }
        self.sink.write_all(&descriptor)?;

        self.records.push(CentralRecord {
            name,
            flags,
            method: stored_method,
            version_needed,
            dos_time: dos.1,
            dos_date: dos.0,
            crc32,
            compressed_size,
            uncompressed_size,
            position,
            external_attributes: unix_mode << 16,
            extra,
        });
        Ok(())
    }

    /// Writes a symbolic link the way Info-ZIP does: the target as the entry's
    /// stored content, with the link type in the Unix mode.
    pub(crate) fn add_symlink(
        &mut self,
        name: &str,
        modified: SystemTime,
        unix_mode: u32,
        target: &[u8],
        encryption: &EntryEncryption,
        cancel: &CancelToken,
    ) -> io::Result<()> {
        let mut content = target;
        self.add_file(
            name,
            modified,
            unix_mode,
            EntryMethod::Store,
            encryption,
            &mut content,
            target.len() as u64,
            cancel,
        )
    }

    /// Writes the central directory and the records that point at it, and
    /// hands the sink back to be closed.
    pub(crate) fn finish(mut self) -> io::Result<S> {
        let mut directory_start = None;
        let mut entries_on_last_disk = 0u64;
        let mut directory_size = 0u64;
        let mut last_disk = None;
        for record in &self.records {
            let mut zip64 = Vec::new();
            let uncompressed_field = if record.uncompressed_size >= u64::from(ZIP64_MARKER_32) {
                zip64.extend(record.uncompressed_size.to_le_bytes());
                ZIP64_MARKER_32
            } else {
                record.uncompressed_size as u32
            };
            let compressed_field = if record.compressed_size >= u64::from(ZIP64_MARKER_32) {
                zip64.extend(record.compressed_size.to_le_bytes());
                ZIP64_MARKER_32
            } else {
                record.compressed_size as u32
            };
            let offset_field = if record.position.offset >= u64::from(ZIP64_MARKER_32) {
                zip64.extend(record.position.offset.to_le_bytes());
                ZIP64_MARKER_32
            } else {
                record.position.offset as u32
            };
            let disk_field = if record.position.disk >= u32::from(ZIP64_MARKER_16) {
                zip64.extend(record.position.disk.to_le_bytes());
                ZIP64_MARKER_16
            } else {
                record.position.disk as u16
            };
            let mut extra = Vec::new();
            let mut version_needed = record.version_needed;
            if !zip64.is_empty() {
                extra.extend(EXTRA_ZIP64.to_le_bytes());
                extra.extend((zip64.len() as u16).to_le_bytes());
                extra.extend(&zip64);
                version_needed = version_needed.max(45);
            }
            extra.extend(&record.extra);

            let mut header = Vec::with_capacity(CENTRAL_HEADER_LENGTH + record.name.len() + extra.len());
            header.extend(CENTRAL_HEADER_SIGNATURE.to_le_bytes());
            header.extend((MADE_BY_UNIX | 63).to_le_bytes());
            header.extend(version_needed.to_le_bytes());
            header.extend(record.flags.to_le_bytes());
            header.extend(record.method.to_le_bytes());
            header.extend(record.dos_time.to_le_bytes());
            header.extend(record.dos_date.to_le_bytes());
            header.extend(record.crc32.to_le_bytes());
            header.extend(compressed_field.to_le_bytes());
            header.extend(uncompressed_field.to_le_bytes());
            header.extend((record.name.len() as u16).to_le_bytes());
            header.extend((extra.len() as u16).to_le_bytes());
            header.extend(0u16.to_le_bytes());
            header.extend(disk_field.to_le_bytes());
            header.extend(0u16.to_le_bytes());
            header.extend(record.external_attributes.to_le_bytes());
            header.extend(offset_field.to_le_bytes());
            header.extend(&record.name);
            header.extend(&extra);

            self.sink.keep_whole(header.len() as u64)?;
            let position = self.sink.position();
            directory_start.get_or_insert(position);
            if last_disk != Some(position.disk) {
                last_disk = Some(position.disk);
                entries_on_last_disk = 0;
            }
            entries_on_last_disk += 1;
            directory_size += header.len() as u64;
            self.sink.write_all(&header)?;
        }

        let directory_start = directory_start.unwrap_or_else(|| self.sink.position());
        let count = self.records.len() as u64;
        // Records that are on the end record's disk; every one counts as on it
        // when the directory never moved off the disk it started on.
        let needs_zip64 = count >= u64::from(ZIP64_MARKER_16)
            || directory_size >= u64::from(ZIP64_MARKER_32)
            || directory_start.offset >= u64::from(ZIP64_MARKER_32)
            || directory_start.disk >= u32::from(ZIP64_MARKER_16);
        if needs_zip64 {
            self.sink.keep_whole((ZIP64_END_OF_CENTRAL_DIRECTORY_LENGTH + ZIP64_LOCATOR_LENGTH) as u64)?;
            let record_position = self.sink.position();
            let on_disk = if last_disk == Some(record_position.disk) { entries_on_last_disk } else { 0 };
            let mut record = Vec::with_capacity(ZIP64_END_OF_CENTRAL_DIRECTORY_LENGTH + ZIP64_LOCATOR_LENGTH);
            record.extend(ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE.to_le_bytes());
            record.extend(((ZIP64_END_OF_CENTRAL_DIRECTORY_LENGTH - 12) as u64).to_le_bytes());
            record.extend((MADE_BY_UNIX | 63).to_le_bytes());
            record.extend(45u16.to_le_bytes());
            record.extend(record_position.disk.to_le_bytes());
            record.extend(directory_start.disk.to_le_bytes());
            record.extend(on_disk.to_le_bytes());
            record.extend(count.to_le_bytes());
            record.extend(directory_size.to_le_bytes());
            record.extend(directory_start.offset.to_le_bytes());
            record.extend(ZIP64_LOCATOR_SIGNATURE.to_le_bytes());
            record.extend(record_position.disk.to_le_bytes());
            record.extend(record_position.offset.to_le_bytes());
            record.extend((record_position.disk + 1).to_le_bytes());
            self.sink.write_all(&record)?;
        }

        self.sink.keep_whole(END_OF_CENTRAL_DIRECTORY_LENGTH as u64)?;
        let end_position = self.sink.position();
        let on_disk =
            if last_disk == Some(end_position.disk) || last_disk.is_none() { entries_on_last_disk } else { 0 };
        let clamp16 = |value: u64| {
            if needs_zip64 || value >= u64::from(ZIP64_MARKER_16) { ZIP64_MARKER_16 } else { value as u16 }
        };
        let clamp32 = |value: u64| {
            if needs_zip64 || value >= u64::from(ZIP64_MARKER_32) { ZIP64_MARKER_32 } else { value as u32 }
        };
        let mut end = Vec::with_capacity(END_OF_CENTRAL_DIRECTORY_LENGTH);
        end.extend(END_OF_CENTRAL_DIRECTORY_SIGNATURE.to_le_bytes());
        end.extend(clamp16(u64::from(end_position.disk)).to_le_bytes());
        end.extend(clamp16(u64::from(directory_start.disk)).to_le_bytes());
        end.extend(clamp16(on_disk).to_le_bytes());
        end.extend(clamp16(count).to_le_bytes());
        end.extend(clamp32(directory_size).to_le_bytes());
        end.extend(clamp32(directory_start.offset).to_le_bytes());
        end.extend(0u16.to_le_bytes());
        self.sink.write_all(&end)?;
        self.sink.flush()?;
        Ok(self.sink)
    }
}
