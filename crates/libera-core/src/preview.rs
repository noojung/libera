//! Previews of one archive entry, read straight out of the archive without
//! writing anything: up to 1 MiB of text, or a PNG, JPEG, WebP or GIF image of
//! up to 10 MiB whose dimensions stay inside safe limits. The kind is decided
//! from the bytes rather than the name.

use std::fs::File;
use std::io::{self, BufReader, Read};
use std::path::Path;
use std::sync::Arc;

use tar::EntryType;

use crate::LiberaError;
use crate::codec::{StreamCodec, decoder};
use crate::extract::tar::{is_entry, open_tar};
use crate::formats::{ReadFormat, read_format};
use crate::progress::{CancelToken, Cancellable};
use crate::resolve::canonical_archive_path;
use crate::safety::ExtractionPolicy;
use crate::sevenz::read::SevenZipArchive;
use crate::zip::read::{OpenOptions, ZipArchive};

pub const MAX_TEXT_PREVIEW_BYTES: u64 = 1 << 20;
pub const MAX_IMAGE_PREVIEW_BYTES: u64 = 10 << 20;
pub const MAX_IMAGE_PREVIEW_DIMENSION: u32 = 16_384;
pub const MAX_IMAGE_PREVIEW_PIXELS: u64 = 25_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum TextEncoding {
    Utf8,
    Utf16Le,
    Utf16Be,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum ImageType {
    Png,
    Jpeg,
    Webp,
    Gif,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum ArchivePreview {
    Text {
        text: String,
        encoding: TextEncoding,
        /// Whether the entry goes on past what was read.
        truncated: bool,
        previewed_bytes: u64,
        total_bytes: Option<u64>,
        /// The bytes the text was decoded from, when asked for.
        raw_bytes: Option<Vec<u8>>,
    },
    Image {
        data: Vec<u8>,
        media_type: ImageType,
        width: u32,
        height: u32,
        previewed_bytes: u64,
        total_bytes: Option<u64>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Text,
    Image(ImageType),
    /// An image in a format the preview does not render.
    UnsupportedImage,
}

fn starts_with_at(data: &[u8], offset: usize, expected: &[u8]) -> bool {
    data.get(offset..offset + expected.len()) == Some(expected)
}

/// What the leading bytes say the entry is.
fn sniff(data: &[u8]) -> Option<Kind> {
    if data.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some(Kind::Image(ImageType::Png));
    }
    if data.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some(Kind::Image(ImageType::Jpeg));
    }
    if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        return Some(Kind::Image(ImageType::Gif));
    }
    if data.starts_with(b"RIFF") && starts_with_at(data, 8, b"WEBP") {
        return Some(Kind::Image(ImageType::Webp));
    }
    let bmp = data.starts_with(b"BM");
    let ico = data.starts_with(&[0, 0, 1, 0]);
    let tiff = data.starts_with(&[0x49, 0x49, 0x2a, 0]) || data.starts_with(&[0x4d, 0x4d, 0, 0x2a]);
    let iso_image = starts_with_at(data, 4, b"ftyp")
        && data.get(8..12).is_some_and(|brand| {
            [b"avif", b"avis", b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1"].iter().any(|known| brand == *known)
        });
    (bmp || ico || tiff || iso_image).then_some(Kind::UnsupportedImage)
}

struct Collected {
    data: Vec<u8>,
    kind: Kind,
    truncated: bool,
}

fn read_some(reader: &mut dyn Read, buffer: &mut Vec<u8>, limit: u64, cancel: &CancelToken) -> Result<(), LiberaError> {
    let mut chunk = [0u8; 64 * 1024];
    while (buffer.len() as u64) < limit {
        if cancel.is_cancelled() {
            return Err(LiberaError::PreviewCancelled);
        }
        let wanted = chunk.len().min(usize::try_from(limit - buffer.len() as u64).unwrap_or(usize::MAX));
        match reader.read(&mut chunk[..wanted]) {
            Ok(0) => break,
            Ok(read) => buffer.extend_from_slice(&chunk[..read]),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

/// Reads up to the limit the entry's kind allows, and one byte past it to
/// tell a cut-off entry from one that just fits.
fn collect(reader: &mut dyn Read, cancel: &CancelToken) -> Result<Collected, LiberaError> {
    let mut data = Vec::new();
    read_some(reader, &mut data, 12, cancel)?;
    let kind = sniff(&data).unwrap_or(Kind::Text);
    let limit = if matches!(kind, Kind::Image(_)) { MAX_IMAGE_PREVIEW_BYTES } else { MAX_TEXT_PREVIEW_BYTES };
    read_some(reader, &mut data, limit + 1, cancel)?;
    let truncated = data.len() as u64 > limit;
    data.truncate(limit as usize);
    Ok(Collected { data, kind, truncated })
}

/// Previews entry `entry_index` - its position in the inspector's listing -
/// of `archive_path`. An encrypted entry needs `password`, and so does every
/// entry of a 7z whose header is encrypted.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn preview_archive_entry(
    archive_path: String,
    entry_index: u64,
    password: Option<String>,
    include_raw_bytes: bool,
    cancel: Arc<CancelToken>,
) -> Result<ArchivePreview, LiberaError> {
    if cancel.is_cancelled() {
        return Err(LiberaError::PreviewCancelled);
    }
    let path = canonical_archive_path(Path::new(&archive_path));
    if !path.is_file() {
        return Err(LiberaError::ArchiveMissing { message: format!("File does not exist: {}", path.display()) });
    }
    let index = usize::try_from(entry_index).map_err(|_| LiberaError::EntryNotFound)?;
    let password = password.as_deref();
    let (collected, total) = match read_format(&path) {
        Some(ReadFormat::Zip) => read_zip_entry(&path, index, password, &cancel)?,
        Some(ReadFormat::SevenZip) => read_seven_zip_entry(&path, index, password, &cancel)?,
        Some(ReadFormat::Tar(_)) => read_tar_entry(&path, index, &cancel)?,
        Some(ReadFormat::Stream(codec)) => read_stream_entry(&path, codec, index, &cancel)?,
        None => {
            return Err(LiberaError::UnsupportedArchive {
                message: format!("Unsupported archive format: {}", path.display()),
            });
        }
    };

    let truncated = collected.truncated || total.is_some_and(|total| total > collected.data.len() as u64);
    let previewed_bytes = collected.data.len() as u64;
    match collected.kind {
        Kind::UnsupportedImage => Err(LiberaError::UnsupportedImage),
        Kind::Image(media_type) => {
            if truncated {
                return Err(LiberaError::ImageTooLarge);
            }
            let (width, height) = image_dimensions(&collected.data, media_type)?;
            validate_dimensions(width, height)?;
            Ok(ArchivePreview::Image {
                data: collected.data,
                media_type,
                width,
                height,
                previewed_bytes,
                total_bytes: total,
            })
        }
        Kind::Text => {
            let (text, encoding) = decode_text(&collected.data, truncated)?;
            Ok(ArchivePreview::Text {
                text,
                encoding,
                truncated,
                previewed_bytes,
                total_bytes: total,
                raw_bytes: include_raw_bytes.then_some(collected.data),
            })
        }
    }
}

fn not_previewable(message: &str) -> LiberaError {
    LiberaError::EntryNotPreviewable { message: message.into() }
}

fn read_zip_entry(
    path: &Path,
    index: usize,
    password: Option<&str>,
    cancel: &CancelToken,
) -> Result<(Collected, Option<u64>), LiberaError> {
    let mut archive =
        ZipArchive::open(path, &OpenOptions { policy: ExtractionPolicy::default(), encoding: Default::default() })?;
    let entry = archive.entries.get(index).cloned().ok_or(LiberaError::EntryNotFound)?;
    if entry.is_directory {
        return Err(not_previewable("Directories cannot be previewed"));
    }
    // The central directory lists without a password, so the prompt comes
    // only once an encrypted entry is opened.
    let mut content = archive.open_entry(index, password, true)?;
    Ok((collect(&mut content, cancel)?, Some(entry.uncompressed_size)))
}

fn read_tar_entry(path: &Path, index: usize, cancel: &CancelToken) -> Result<(Collected, Option<u64>), LiberaError> {
    let mut archive = open_tar(path, cancel)?;
    let mut position = 0;
    for entry in archive.entries()? {
        if cancel.is_cancelled() {
            return Err(LiberaError::PreviewCancelled);
        }
        let mut entry = entry?;
        let entry_type = entry.header().entry_type();
        if !is_entry(entry_type) {
            continue;
        }
        if position as u64 >= ExtractionPolicy::default().max_entries {
            return Err(not_previewable("Archive contains too many entries to preview safely"));
        }
        if position == index {
            if !matches!(entry_type, EntryType::Regular | EntryType::Continuous | EntryType::GNUSparse) {
                return Err(not_previewable("Only regular files can be previewed"));
            }
            let size = entry.size();
            return Ok((collect(&mut entry, cancel)?, Some(size)));
        }
        position += 1;
    }
    Err(LiberaError::EntryNotFound)
}

fn read_seven_zip_entry(
    path: &Path,
    index: usize,
    password: Option<&str>,
    cancel: &CancelToken,
) -> Result<(Collected, Option<u64>), LiberaError> {
    let mut archive = SevenZipArchive::open(path, password, &ExtractionPolicy::default())?;
    let entry = archive.entries.get(index).cloned().ok_or(LiberaError::EntryNotFound)?;
    if entry.is_directory {
        return Err(not_previewable("Directories cannot be previewed"));
    }
    if entry.is_symlink {
        return Err(not_previewable("Symbolic links cannot be previewed"));
    }
    if archive.entries.iter().filter(|other| other.path == entry.path).count() > 1 {
        return Err(not_previewable("Archive contains duplicate entry paths"));
    }
    let Some(block) = entry.block else {
        return Ok((Collected { data: Vec::new(), kind: Kind::Text, truncated: false }, Some(0)));
    };
    let mut collected = None;
    archive.until_in_block(block, |current, reader| {
        if current != index {
            io::copy(reader, &mut io::sink())?;
            return Ok(true);
        }
        collected = Some(collect(reader, cancel)?);
        Ok(false)
    })?;
    Ok((collected.ok_or(LiberaError::EntryNotFound)?, Some(entry.size)))
}

/// The lone file a codec stream holds; there is only ever entry zero.
fn read_stream_entry(
    path: &Path,
    codec: StreamCodec,
    index: usize,
    cancel: &CancelToken,
) -> Result<(Collected, Option<u64>), LiberaError> {
    if index != 0 {
        return Err(LiberaError::EntryNotFound);
    }
    let source = BufReader::new(Cancellable::new(File::open(path)?, cancel));
    let mut decoded = decoder(codec, source)?;
    Ok((collect(&mut decoded, cancel)?, None))
}

/// Decodes UTF-8, or UTF-16 behind a byte order mark, and refuses binary
/// data. A preview cut off at the byte limit may end inside a character, so
/// up to one character's worth of trailing bytes may be dropped.
fn decode_text(data: &[u8], truncated: bool) -> Result<(String, TextEncoding), LiberaError> {
    let (bytes, encoding) = if let Some(rest) = data.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        (rest, TextEncoding::Utf8)
    } else if let Some(rest) = data.strip_prefix(&[0xff, 0xfe]) {
        (rest, TextEncoding::Utf16Le)
    } else if let Some(rest) = data.strip_prefix(&[0xfe, 0xff]) {
        (rest, TextEncoding::Utf16Be)
    } else {
        (data, TextEncoding::Utf8)
    };
    if encoding == TextEncoding::Utf8 && bytes.contains(&0) {
        return Err(LiberaError::NotText);
    }

    let decode = |bytes: &[u8]| -> Option<String> {
        match encoding {
            TextEncoding::Utf8 => std::str::from_utf8(bytes).ok().map(str::to_owned),
            TextEncoding::Utf16Le | TextEncoding::Utf16Be => {
                if !bytes.len().is_multiple_of(2) {
                    return None;
                }
                let units: Vec<u16> = bytes
                    .chunks(2)
                    .map(|pair| {
                        let pair = [pair[0], pair[1]];
                        if encoding == TextEncoding::Utf16Le {
                            u16::from_le_bytes(pair)
                        } else {
                            u16::from_be_bytes(pair)
                        }
                    })
                    .collect();
                String::from_utf16(&units).ok()
            }
        }
    };
    let trailing_allowed = if !truncated {
        0
    } else if encoding == TextEncoding::Utf8 {
        3
    } else {
        1
    };
    let text = (0..=trailing_allowed.min(bytes.len()))
        .find_map(|trailing| decode(&bytes[..bytes.len() - trailing]))
        .ok_or(LiberaError::NotText)?;

    let mut characters = 0usize;
    let mut suspicious = 0usize;
    for character in text.chars() {
        characters += 1;
        if (character as u32) < 32 && !matches!(character, '\t' | '\n' | '\r' | '\x0c') {
            suspicious += 1;
        }
    }
    if characters > 0 && suspicious * 100 > characters {
        return Err(LiberaError::NotText);
    }
    Ok((text, encoding))
}

fn invalid(message: &str) -> LiberaError {
    LiberaError::InvalidImage { message: message.into() }
}

fn u16_be(data: &[u8], at: usize) -> Option<u32> {
    data.get(at..at + 2).map(|bytes| u32::from(u16::from_be_bytes([bytes[0], bytes[1]])))
}

fn u16_le(data: &[u8], at: usize) -> Option<u32> {
    data.get(at..at + 2).map(|bytes| u32::from(u16::from_le_bytes([bytes[0], bytes[1]])))
}

fn u24_le(data: &[u8], at: usize) -> Option<u32> {
    data.get(at..at + 3).map(|bytes| u32::from(bytes[0]) | u32::from(bytes[1]) << 8 | u32::from(bytes[2]) << 16)
}

fn u32_at(data: &[u8], at: usize, big_endian: bool) -> Option<u32> {
    let bytes: [u8; 4] = data.get(at..at + 4)?.try_into().ok()?;
    Some(if big_endian { u32::from_be_bytes(bytes) } else { u32::from_le_bytes(bytes) })
}

fn png_dimensions(data: &[u8]) -> Result<(u32, u32), LiberaError> {
    if data.len() < 24 || !starts_with_at(data, 12, b"IHDR") {
        return Err(invalid("PNG image has an invalid header"));
    }
    Ok((u32_at(data, 16, true).unwrap(), u32_at(data, 20, true).unwrap()))
}

fn gif_dimensions(data: &[u8]) -> Result<(u32, u32), LiberaError> {
    match (u16_le(data, 6), u16_le(data, 8)) {
        (Some(width), Some(height)) => Ok((width, height)),
        _ => Err(invalid("GIF image has an invalid header")),
    }
}

fn jpeg_dimensions(data: &[u8]) -> Result<(u32, u32), LiberaError> {
    const START_OF_FRAME: [u8; 13] = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf];
    if data.len() < 4 {
        return Err(invalid("JPEG image has an invalid header"));
    }
    let mut offset = 2;
    while offset < data.len() {
        while offset < data.len() && data[offset] == 0xff {
            offset += 1;
        }
        if offset >= data.len() {
            break;
        }
        let marker = data[offset];
        offset += 1;
        if marker == 0xd9 || marker == 0xda {
            break;
        }
        if marker == 0x01 || (0xd0..=0xd8).contains(&marker) {
            continue;
        }
        let Some(length) = u16_be(data, offset).map(|length| length as usize) else { break };
        if length < 2 || offset + length > data.len() {
            return Err(invalid("JPEG image contains an invalid segment"));
        }
        if START_OF_FRAME.contains(&marker) {
            if length < 7 {
                return Err(invalid("JPEG image has an invalid frame header"));
            }
            return Ok((u16_be(data, offset + 5).unwrap(), u16_be(data, offset + 3).unwrap()));
        }
        offset += length;
    }
    Err(invalid("JPEG image dimensions could not be read"))
}

fn webp_dimensions(data: &[u8]) -> Result<(u32, u32), LiberaError> {
    if data.len() < 20 {
        return Err(invalid("WebP image has an invalid header"));
    }
    let mut offset = 12;
    while offset + 8 <= data.len() {
        let chunk_type = &data[offset..offset + 4];
        let chunk_size = u32_at(data, offset + 4, false).unwrap() as usize;
        let start = offset + 8;
        let end = start
            .checked_add(chunk_size)
            .filter(|end| *end <= data.len())
            .ok_or_else(|| invalid("WebP image contains an invalid chunk"))?;
        match chunk_type {
            b"VP8X" if chunk_size >= 10 => {
                return Ok((u24_le(data, start + 4).unwrap() + 1, u24_le(data, start + 7).unwrap() + 1));
            }
            b"VP8L" if chunk_size >= 5 && data[start] == 0x2f => {
                let bits = u32_at(data, start + 1, false).unwrap();
                return Ok(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1));
            }
            b"VP8 " if chunk_size >= 10 && starts_with_at(data, start + 3, &[0x9d, 0x01, 0x2a]) => {
                return Ok((u16_le(data, start + 6).unwrap() & 0x3fff, u16_le(data, start + 8).unwrap() & 0x3fff));
            }
            _ => {}
        }
        offset = end + chunk_size % 2;
    }
    Err(invalid("WebP image dimensions could not be read"))
}

fn image_dimensions(data: &[u8], media_type: ImageType) -> Result<(u32, u32), LiberaError> {
    match media_type {
        ImageType::Png => png_dimensions(data),
        ImageType::Jpeg => jpeg_dimensions(data),
        ImageType::Gif => gif_dimensions(data),
        ImageType::Webp => webp_dimensions(data),
    }
}

fn validate_dimensions(width: u32, height: u32) -> Result<(), LiberaError> {
    if width == 0 || height == 0 {
        return Err(invalid("Image dimensions are invalid"));
    }
    if width > MAX_IMAGE_PREVIEW_DIMENSION
        || height > MAX_IMAGE_PREVIEW_DIMENSION
        || u64::from(width) * u64::from(height) > MAX_IMAGE_PREVIEW_PIXELS
    {
        return Err(LiberaError::ImageDimensionsTooLarge);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_text_in_utf8_and_utf16_behind_a_byte_order_mark() {
        assert_eq!(decode_text("héllo".as_bytes(), false).unwrap(), ("héllo".into(), TextEncoding::Utf8));
        assert_eq!(decode_text(b"\xef\xbb\xbfhi", false).unwrap(), ("hi".into(), TextEncoding::Utf8));
        assert_eq!(decode_text(b"\xff\xfeh\x00i\x00", false).unwrap(), ("hi".into(), TextEncoding::Utf16Le));
        assert_eq!(decode_text(b"\xfe\xff\x00h\x00i", false).unwrap(), ("hi".into(), TextEncoding::Utf16Be));
    }

    #[test]
    fn drops_a_character_cut_in_half_only_when_the_preview_was_cut_off() {
        let cut = &"가나".as_bytes()[..5];
        assert_eq!(decode_text(cut, true).unwrap().0, "가");
        assert!(matches!(decode_text(cut, false), Err(LiberaError::NotText)));
    }

    #[test]
    fn refuses_binary_data() {
        assert!(matches!(decode_text(b"abc\0def", false), Err(LiberaError::NotText)));
        let control: Vec<u8> = (0..100).map(|index| if index % 10 == 0 { 0x01 } else { b'a' }).collect();
        assert!(matches!(decode_text(&control, false), Err(LiberaError::NotText)));
        assert!(decode_text(b"tabs\tand\nnewlines\r\n", false).is_ok());
    }

    #[test]
    fn knows_images_by_their_signatures() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n...."), Some(Kind::Image(ImageType::Png)));
        assert_eq!(sniff(b"\xff\xd8\xff\xe0"), Some(Kind::Image(ImageType::Jpeg)));
        assert_eq!(sniff(b"GIF89a......"), Some(Kind::Image(ImageType::Gif)));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some(Kind::Image(ImageType::Webp)));
        assert_eq!(sniff(b"BM\0\0"), Some(Kind::UnsupportedImage));
        assert_eq!(sniff(b"\0\0\0\x18ftypheic"), Some(Kind::UnsupportedImage));
        assert_eq!(sniff(b"plain text"), None);
    }

    #[test]
    fn reads_image_dimensions_from_each_header() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        png.extend(640u32.to_be_bytes());
        png.extend(480u32.to_be_bytes());
        assert_eq!(png_dimensions(&png).unwrap(), (640, 480));

        let mut gif = b"GIF89a".to_vec();
        gif.extend(32u16.to_le_bytes());
        gif.extend(16u16.to_le_bytes());
        assert_eq!(gif_dimensions(&gif).unwrap(), (32, 16));

        let jpeg = [0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 200, 1, 44, 3, 0, 0, 0, 0];
        assert_eq!(jpeg_dimensions(&jpeg).unwrap(), (300, 200));

        let mut webp = b"RIFF\0\0\0\0WEBPVP8X".to_vec();
        webp.extend(10u32.to_le_bytes());
        webp.extend([0; 4]);
        webp.extend([99, 0, 0, 49, 0, 0]);
        assert_eq!(webp_dimensions(&webp).unwrap(), (100, 50));
    }

    #[test]
    fn holds_images_to_safe_dimensions() {
        assert!(validate_dimensions(16_384, 1_000).is_ok());
        assert!(matches!(validate_dimensions(16_385, 1), Err(LiberaError::ImageDimensionsTooLarge)));
        assert!(matches!(validate_dimensions(10_000, 10_000), Err(LiberaError::ImageDimensionsTooLarge)));
        assert!(matches!(validate_dimensions(0, 10), Err(LiberaError::InvalidImage { .. })));
    }
}
