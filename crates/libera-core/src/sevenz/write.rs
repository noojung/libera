//! A 7z writer: LZMA2 or Copy streams, solid runs with a substream per file,
//! and 7-Zip's AES-256 for the data and, when asked, the header. The layout
//! follows what the Electron engine's writer laid down, which 7-Zip,
//! libarchive and macOS's Archive Utility all read.

use std::io::{self, Read, Seek, SeekFrom, Write};
use std::time::{SystemTime, UNIX_EPOCH};

use aes::Aes256;
use aes::cipher::{BlockCipherEncrypt, KeyInit};
use sha2::{Digest, Sha256};

use super::plan::Lzma2Settings;
use crate::progress::CancelToken;

pub(crate) const SIGNATURE: [u8; 6] = [b'7', b'z', 0xbc, 0xaf, 0x27, 0x1c];
pub(crate) const SIGNATURE_HEADER_SIZE: u64 = 32;

mod id {
    pub const END: u8 = 0x00;
    pub const HEADER: u8 = 0x01;
    pub const MAIN_STREAMS_INFO: u8 = 0x04;
    pub const FILES_INFO: u8 = 0x05;
    pub const PACK_INFO: u8 = 0x06;
    pub const UNPACK_INFO: u8 = 0x07;
    pub const SUBSTREAMS_INFO: u8 = 0x08;
    pub const SIZE: u8 = 0x09;
    pub const CRC: u8 = 0x0a;
    pub const FOLDER: u8 = 0x0b;
    pub const CODERS_UNPACK_SIZE: u8 = 0x0c;
    pub const NUM_UNPACK_STREAM: u8 = 0x0d;
    pub const EMPTY_STREAM: u8 = 0x0e;
    pub const EMPTY_FILE: u8 = 0x0f;
    pub const NAME: u8 = 0x11;
    pub const MTIME: u8 = 0x14;
    pub const WIN_ATTRIBUTES: u8 = 0x15;
    pub const ENCODED_HEADER: u8 = 0x17;
}

const COPY_METHOD: u8 = 0x00;
const LZMA2_METHOD: u8 = 0x21;
const AES_METHOD: [u8; 4] = [0x06, 0xf1, 0x07, 0x01];
/// 2^19 rounds of SHA-256 turn the password into the key, as 7-Zip does.
const KEY_CYCLES_POWER: u8 = 19;
/// Windows' flag that the high half of the attributes is a Unix mode, which
/// is what p7zip and libarchive look for before reading one.
const UNIX_EXTENSION: u32 = 0x8000;

/// 7z's variable-length numbers: the count of leading one bits in the first
/// byte is how many bytes follow, little-endian.
struct HeaderWriter(Vec<u8>);

impl HeaderWriter {
    fn byte(&mut self, value: u8) -> &mut Self {
        self.0.push(value);
        self
    }

    fn bytes(&mut self, value: &[u8]) -> &mut Self {
        self.0.extend_from_slice(value);
        self
    }

    fn number(&mut self, value: u64) -> &mut Self {
        let mut first = 0u8;
        let mut mask = 0x80u8;
        let mut extra = 0;
        while extra < 8 {
            if value < 1u64 << (7 * (extra + 1)) {
                first |= (value >> (8 * extra)) as u8;
                break;
            }
            first |= mask;
            mask >>= 1;
            extra += 1;
        }
        self.0.push(first);
        self.0.extend_from_slice(&value.to_le_bytes()[..extra]);
        self
    }

    fn u32(&mut self, value: u32) -> &mut Self {
        self.bytes(&value.to_le_bytes())
    }

    fn u64(&mut self, value: u64) -> &mut Self {
        self.bytes(&value.to_le_bytes())
    }

    fn property(&mut self, id: u8, value: &[u8]) -> &mut Self {
        self.byte(id).number(value.len() as u64).bytes(value)
    }
}

fn bit_vector(bits: &[bool]) -> Vec<u8> {
    let mut bytes = vec![0u8; bits.len().div_ceil(8)];
    for (index, _) in bits.iter().enumerate().filter(|(_, bit)| **bit) {
        bytes[index / 8] |= 0x80 >> (index % 8);
    }
    bytes
}

/// NTFS time: 100ns ticks since 1601.
fn file_time(time: SystemTime) -> u64 {
    const UNIX_EPOCH_TICKS: u64 = 116_444_736_000_000_000;
    match time.duration_since(UNIX_EPOCH) {
        Ok(elapsed) => UNIX_EPOCH_TICKS + elapsed.as_secs() * 10_000_000 + u64::from(elapsed.subsec_nanos() / 100),
        Err(before) => UNIX_EPOCH_TICKS.saturating_sub(before.duration().as_nanos() as u64 / 100),
    }
}

/// One entry of the archive, in the order the header lists them.
#[derive(Debug, Clone)]
pub(crate) struct Entry {
    pub path: String,
    pub size: u64,
    pub is_directory: bool,
    pub is_symlink: bool,
    pub modified: Option<SystemTime>,
    /// Permission bits; the file type is added from the flags above.
    pub mode: u32,
}

impl Entry {
    fn attributes(&self) -> u32 {
        let file_type = if self.is_directory {
            0o040_000
        } else if self.is_symlink {
            0o120_000
        } else {
            0o100_000
        };
        let unix_mode = file_type | (self.mode & 0o7777);
        ((unix_mode & 0xffff) << 16) | UNIX_EXTENSION | if self.is_directory { 0x10 } else { 0x20 }
    }
}

/// The key, derived once per archive: the salt is archive-wide and only the
/// IV changes from one folder to the next, as in 7-Zip.
struct Encryption {
    cipher: Aes256,
    salt: [u8; 16],
}

fn random<const N: usize>() -> io::Result<[u8; N]> {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes).map_err(io::Error::other)?;
    Ok(bytes)
}

fn derive_key(password: &str, salt: &[u8], cancel: &CancelToken) -> io::Result<[u8; 32]> {
    let password: Vec<u8> = password.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut block = Vec::with_capacity(salt.len() + password.len() + 8);
    block.extend_from_slice(salt);
    block.extend_from_slice(&password);
    let counter_at = block.len();
    block.extend_from_slice(&[0; 8]);
    let mut hash = Sha256::new();
    for round in 0u64..1 << KEY_CYCLES_POWER {
        if round & 0x3fff == 0 {
            cancel.check()?;
        }
        block[counter_at..].copy_from_slice(&round.to_le_bytes());
        hash.update(&block);
    }
    Ok(hash.finalize().into())
}

/// AES-256 in CBC mode with the last block zero padded; the coder's unpack
/// size tells a reader where the real data ends.
struct CbcWriter<W> {
    inner: W,
    cipher: Aes256,
    previous: [u8; 16],
    pending: Vec<u8>,
    plain_size: u64,
}

impl<W: Write> CbcWriter<W> {
    fn encrypt_block(&mut self, block: &[u8]) -> io::Result<()> {
        let mut chained = [0u8; 16];
        for (index, byte) in chained.iter_mut().enumerate() {
            *byte = block[index] ^ self.previous[index];
        }
        let mut cipher_block = chained.into();
        self.cipher.encrypt_block(&mut cipher_block);
        self.previous = cipher_block.into();
        self.inner.write_all(&self.previous)
    }

    fn finish(mut self) -> io::Result<(W, u64)> {
        if !self.pending.is_empty() {
            let mut last = std::mem::take(&mut self.pending);
            last.resize(16, 0);
            self.encrypt_block(&last)?;
        }
        Ok((self.inner, self.plain_size))
    }
}

impl<W: Write> Write for CbcWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.plain_size += buf.len() as u64;
        self.pending.extend_from_slice(buf);
        let whole = self.pending.len() / 16 * 16;
        let blocks: Vec<u8> = self.pending.drain(..whole).collect();
        for block in blocks.chunks(16) {
            self.encrypt_block(block)?;
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// Counts what reaches the archive, which is a stream's packed size.
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

enum Sealing<W: Write> {
    Plain(W),
    // Boxed: the expanded AES key runs to a kilobyte.
    Aes(Box<CbcWriter<W>>),
}

impl<W: Write> Write for Sealing<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Self::Plain(writer) => writer.write(buf),
            Self::Aes(writer) => writer.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::Plain(writer) => writer.flush(),
            Self::Aes(writer) => writer.flush(),
        }
    }
}

enum Coding<W: Write> {
    Copy(W),
    Lzma2(Box<lzma_rust2::Lzma2Writer<W>>),
}

impl<W: Write> Write for Coding<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Self::Copy(writer) => writer.write(buf),
            Self::Lzma2(writer) => writer.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::Copy(writer) => writer.flush(),
            Self::Lzma2(writer) => writer.flush(),
        }
    }
}

fn lzma2_options(settings: Lzma2Settings) -> lzma_rust2::Lzma2Options {
    let mut options = lzma_rust2::Lzma2Options::with_preset(6);
    options.lzma_options.dict_size = super::plan::dictionary_size_from_property(settings.dictionary_property());
    options.lzma_options.nice_len =
        settings.nice_length.clamp(lzma_rust2::LzmaOptions::NICE_LEN_MIN, lzma_rust2::LzmaOptions::NICE_LEN_MAX);
    options.lzma_options.depth_limit = settings.search_depth as i32;
    options
}

/// A stream as the header describes it.
struct WrittenStream {
    packed_size: u64,
    unpacked_size: u64,
    lzma2_property: Option<u8>,
    /// The AES coder's properties and the size it decrypts to.
    aes: Option<(Vec<u8>, u64)>,
    /// Each file's size and CRC within the stream, in order.
    substreams: Vec<(u64, u32)>,
}

pub(crate) struct SevenZipWriter<W: Write + Seek> {
    sink: W,
    position: u64,
    encryption: Option<Encryption>,
    streams: Vec<WrittenStream>,
}

/// A source of one entry's bytes for [`SevenZipWriter::write_run`].
pub(crate) type Opener<'a> = dyn FnMut(usize) -> io::Result<Box<dyn Read + 'a>> + 'a;

impl<W: Write + Seek> SevenZipWriter<W> {
    pub(crate) fn new(mut sink: W, password: Option<&str>, cancel: &CancelToken) -> io::Result<Self> {
        sink.write_all(&[0; SIGNATURE_HEADER_SIZE as usize])?;
        let encryption = match password {
            Some(password) => {
                let salt = random::<16>()?;
                let key = derive_key(password, &salt, cancel)?;
                Some(Encryption { cipher: Aes256::new_from_slice(&key).expect("a 32 byte key"), salt })
            }
            None => None,
        };
        Ok(Self { sink, position: SIGNATURE_HEADER_SIZE, encryption, streams: Vec::new() })
    }

    fn aes_properties(&self, iv: &[u8; 16]) -> Vec<u8> {
        let salt = &self.encryption.as_ref().expect("encrypting").salt;
        let mut properties = vec![KEY_CYCLES_POWER | 0xc0, ((salt.len() as u8 - 1) << 4) | (iv.len() as u8 - 1)];
        properties.extend_from_slice(salt);
        properties.extend_from_slice(iv);
        properties
    }

    /// Writes one stream holding `sizes.len()` files back to back, each read
    /// from `open(index)` and held to the size it declared. `progress` hears
    /// of every chunk with the index of the file it came from.
    pub(crate) fn write_run(
        &mut self,
        sizes: &[u64],
        lzma2: Option<Lzma2Settings>,
        open: &mut Opener,
        progress: &mut dyn FnMut(usize, u64),
        cancel: &CancelToken,
    ) -> io::Result<()> {
        let iv = random::<16>()?;
        let aes_properties = self.encryption.is_some().then(|| self.aes_properties(&iv));
        let counted = Counted { inner: &mut self.sink, count: 0 };
        let sealing = match &self.encryption {
            Some(encryption) => Sealing::Aes(Box::new(CbcWriter {
                inner: counted,
                cipher: encryption.cipher.clone(),
                previous: iv,
                pending: Vec::new(),
                plain_size: 0,
            })),
            None => Sealing::Plain(counted),
        };
        let mut coding = match lzma2 {
            Some(settings) => Coding::Lzma2(Box::new(lzma_rust2::Lzma2Writer::new(sealing, lzma2_options(settings)))),
            None => Coding::Copy(sealing),
        };

        let mut substreams = Vec::with_capacity(sizes.len());
        let mut buffer = vec![0; 64 * 1024];
        for (index, &declared) in sizes.iter().enumerate() {
            let mut content = open(index)?;
            let mut hasher = crc32fast::Hasher::new();
            let mut size = 0u64;
            loop {
                cancel.check()?;
                let read = match content.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => read,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => return Err(error),
                };
                hasher.update(&buffer[..read]);
                coding.write_all(&buffer[..read])?;
                size += read as u64;
                progress(index, read as u64);
            }
            if size != declared {
                return Err(io::Error::other("a file changed size while it was being archived"));
            }
            substreams.push((size, hasher.finalize()));
        }

        let sealing = match coding {
            Coding::Copy(sealing) => sealing,
            Coding::Lzma2(writer) => writer.finish()?,
        };
        let (packed_size, coded_size) = match sealing {
            Sealing::Plain(counted) => (counted.count, counted.count),
            Sealing::Aes(writer) => {
                let (counted, plain) = writer.finish()?;
                (counted.count, plain)
            }
        };
        self.position += packed_size;
        self.streams.push(WrittenStream {
            packed_size,
            unpacked_size: sizes.iter().sum(),
            lzma2_property: lzma2.map(|settings| settings.dictionary_property()),
            aes: aes_properties.map(|properties| (properties, coded_size)),
            substreams,
        });
        Ok(())
    }

    /// Writes the header - encrypted, which hides the file names, when
    /// `encrypt_header` is set - and the signature header that points at it.
    /// `entries` lists every entry without data first, then the ones with
    /// data in the order their streams were written, as 7-Zip lays them out;
    /// that keeps each block's files together for readers that need it.
    pub(crate) fn finish(mut self, entries: &[Entry], encrypt_header: bool) -> io::Result<W> {
        let header = build_header(entries, &self.streams);
        let next_header = match (&self.encryption, encrypt_header) {
            (Some(_), true) => self.write_encrypted_header(&header)?,
            _ => header,
        };
        let next_header_offset = self.position - SIGNATURE_HEADER_SIZE;
        self.sink.write_all(&next_header)?;

        let mut start_header = HeaderWriter(Vec::with_capacity(20));
        start_header.u64(next_header_offset).u64(next_header.len() as u64).u32(crc32fast::hash(&next_header));
        let mut signature = HeaderWriter(Vec::with_capacity(SIGNATURE_HEADER_SIZE as usize));
        signature.bytes(&SIGNATURE).byte(0).byte(4).u32(crc32fast::hash(&start_header.0)).bytes(&start_header.0);
        self.sink.seek(SeekFrom::Start(0))?;
        self.sink.write_all(&signature.0)?;
        self.sink.flush()?;
        Ok(self.sink)
    }

    /// The header as one more packed stream under a single AES coder, and the
    /// encoded-header record that points at it. The folder CRC lets a reader
    /// tell a wrong password from a damaged header.
    fn write_encrypted_header(&mut self, header: &[u8]) -> io::Result<Vec<u8>> {
        let pack_position = self.position - SIGNATURE_HEADER_SIZE;
        let iv = random::<16>()?;
        let properties = self.aes_properties(&iv);
        let cipher = self.encryption.as_ref().expect("encrypting").cipher.clone();
        let counted = Counted { inner: &mut self.sink, count: 0 };
        let mut writer = CbcWriter { inner: counted, cipher, previous: iv, pending: Vec::new(), plain_size: 0 };
        writer.write_all(header)?;
        let (counted, _) = writer.finish()?;
        let packed_size = counted.count;
        self.position += packed_size;

        let mut record = HeaderWriter(Vec::new());
        record.byte(id::ENCODED_HEADER);
        record.byte(id::PACK_INFO).number(pack_position).number(1).byte(id::SIZE).number(packed_size).byte(id::END);
        record.byte(id::UNPACK_INFO).byte(id::FOLDER).number(1).byte(0).number(1);
        write_aes_coder(&mut record, &properties);
        record.byte(id::CODERS_UNPACK_SIZE).number(header.len() as u64);
        record.byte(id::CRC).byte(1).u32(crc32fast::hash(header));
        record.byte(id::END).byte(id::END);
        Ok(record.0)
    }
}

fn write_aes_coder(writer: &mut HeaderWriter, properties: &[u8]) {
    writer.byte(0x20 | AES_METHOD.len() as u8).bytes(&AES_METHOD).number(properties.len() as u64).bytes(properties);
}

fn write_lzma2_coder(writer: &mut HeaderWriter, property: u8) {
    writer.byte(0x21).byte(LZMA2_METHOD).number(1).byte(property);
}

/// Coders are listed in decode order: an encrypted LZMA2 folder reads
/// `[AES, LZMA2]` with LZMA2's input bound to the AES output. A Copy folder
/// under encryption collapses to the AES coder alone, as 7-Zip writes it.
fn write_folder(writer: &mut HeaderWriter, stream: &WrittenStream) {
    match (&stream.aes, stream.lzma2_property) {
        (None, None) => {
            writer.number(1).byte(0x01).byte(COPY_METHOD);
        }
        (None, Some(property)) => {
            writer.number(1);
            write_lzma2_coder(writer, property);
        }
        (Some((properties, _)), None) => {
            writer.number(1);
            write_aes_coder(writer, properties);
        }
        (Some((properties, _)), Some(property)) => {
            writer.number(2);
            write_aes_coder(writer, properties);
            write_lzma2_coder(writer, property);
            writer.number(1).number(0);
        }
    }
}

fn build_header(entries: &[Entry], streams: &[WrittenStream]) -> Vec<u8> {
    let mut writer = HeaderWriter(Vec::new());
    writer.byte(id::HEADER);

    if !streams.is_empty() {
        writer.byte(id::MAIN_STREAMS_INFO);
        writer.byte(id::PACK_INFO).number(0).number(streams.len() as u64).byte(id::SIZE);
        for stream in streams {
            writer.number(stream.packed_size);
        }
        writer.byte(id::END);

        writer.byte(id::UNPACK_INFO).byte(id::FOLDER).number(streams.len() as u64).byte(0);
        for stream in streams {
            write_folder(&mut writer, stream);
        }
        writer.byte(id::CODERS_UNPACK_SIZE);
        for stream in streams {
            // One size per coder output, in output order.
            if let (Some((_, coded_size)), Some(_)) = (&stream.aes, stream.lzma2_property) {
                writer.number(*coded_size);
            }
            writer.number(stream.unpacked_size);
        }
        writer.byte(id::END);

        // CRCs go in as substream digests rather than folder digests: that is
        // the layout 7-Zip writes, and the one libarchive accepts.
        writer.byte(id::SUBSTREAMS_INFO);
        if streams.iter().any(|stream| stream.substreams.len() > 1) {
            writer.byte(id::NUM_UNPACK_STREAM);
            for stream in streams {
                writer.number(stream.substreams.len() as u64);
            }
            writer.byte(id::SIZE);
            for stream in streams {
                for (size, _) in &stream.substreams[..stream.substreams.len() - 1] {
                    writer.number(*size);
                }
            }
        }
        writer.byte(id::CRC).byte(1);
        for stream in streams {
            for (_, crc) in &stream.substreams {
                writer.u32(*crc);
            }
        }
        writer.byte(id::END).byte(id::END);
    }

    writer.byte(id::FILES_INFO).number(entries.len() as u64);
    let empty_streams: Vec<bool> = entries.iter().map(|entry| entry.is_directory || entry.size == 0).collect();
    if empty_streams.iter().any(|empty| *empty) {
        writer.property(id::EMPTY_STREAM, &bit_vector(&empty_streams));
        let empty_files: Vec<bool> = entries
            .iter()
            .filter(|entry| entry.is_directory || entry.size == 0)
            .map(|entry| !entry.is_directory)
            .collect();
        if empty_files.iter().any(|empty| *empty) {
            writer.property(id::EMPTY_FILE, &bit_vector(&empty_files));
        }
    }

    let mut names = vec![0u8];
    for entry in entries {
        names.extend(entry.path.replace('\\', "/").encode_utf16().chain([0]).flat_map(u16::to_le_bytes));
    }
    writer.property(id::NAME, &names);

    let defined: Vec<bool> = entries.iter().map(|entry| entry.modified.is_some()).collect();
    if defined.iter().any(|defined| *defined) {
        let mut times = HeaderWriter(Vec::new());
        if defined.iter().all(|defined| *defined) {
            times.byte(1);
        } else {
            times.byte(0).bytes(&bit_vector(&defined));
        }
        times.byte(0);
        for modified in entries.iter().filter_map(|entry| entry.modified) {
            times.u64(file_time(modified));
        }
        writer.property(id::MTIME, &times.0);
    }

    let mut attributes = HeaderWriter(Vec::new());
    attributes.byte(1).byte(0);
    for entry in entries {
        attributes.u32(entry.attributes());
    }
    writer.property(id::WIN_ATTRIBUTES, &attributes.0);
    writer.byte(id::END).byte(id::END);
    writer.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_seven_zips_variable_length_numbers() {
        let encode = |value: u64| {
            let mut writer = HeaderWriter(Vec::new());
            writer.number(value);
            writer.0
        };
        assert_eq!(encode(0x7f), [0x7f]);
        assert_eq!(encode(0x80), [0x80, 0x80]);
        assert_eq!(encode(0x3fff), [0xbf, 0xff]);
        assert_eq!(encode(0x4000), [0xc0, 0x00, 0x40]);
        assert_eq!(encode(u64::MAX), [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    }

    #[test]
    fn packs_bits_most_significant_first() {
        assert_eq!(bit_vector(&[true, false, false, false, false, false, false, true, true]), [0x81, 0x80]);
    }

    #[test]
    fn pads_the_last_cbc_block_with_zeros_and_reports_the_plain_size() {
        let cipher = Aes256::new_from_slice(&[7; 32]).unwrap();
        let mut writer = CbcWriter { inner: Vec::new(), cipher, previous: [0; 16], pending: Vec::new(), plain_size: 0 };
        writer.write_all(&[1; 20]).unwrap();
        let (encrypted, plain) = writer.finish().unwrap();
        assert_eq!((encrypted.len(), plain), (32, 20));
    }
}
