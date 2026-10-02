//! The on-disk vocabulary of a ZIP archive: record signatures, method and flag
//! numbers, the extra fields this engine reads and writes, DOS timestamps,
//! and the encodings an entry name may be written in.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(crate) const LOCAL_HEADER_SIGNATURE: u32 = 0x0403_4b50;
pub(crate) const CENTRAL_HEADER_SIGNATURE: u32 = 0x0201_4b50;
pub(crate) const END_OF_CENTRAL_DIRECTORY_SIGNATURE: u32 = 0x0605_4b50;
pub(crate) const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE: u32 = 0x0606_4b50;
pub(crate) const ZIP64_LOCATOR_SIGNATURE: u32 = 0x0706_4b50;
/// Opens a data descriptor, and also marks the first volume of a split set.
pub(crate) const DATA_DESCRIPTOR_SIGNATURE: u32 = 0x0807_4b50;
pub(crate) const SPANNING_SIGNATURE: u32 = DATA_DESCRIPTOR_SIGNATURE;

pub(crate) const LOCAL_HEADER_LENGTH: usize = 30;
pub(crate) const CENTRAL_HEADER_LENGTH: usize = 46;
pub(crate) const END_OF_CENTRAL_DIRECTORY_LENGTH: usize = 22;
pub(crate) const ZIP64_END_OF_CENTRAL_DIRECTORY_LENGTH: usize = 56;
pub(crate) const ZIP64_LOCATOR_LENGTH: usize = 20;
pub(crate) const MAX_COMMENT_LENGTH: usize = 0xffff;

pub(crate) const FLAG_ENCRYPTED: u16 = 1 << 0;
pub(crate) const FLAG_DATA_DESCRIPTOR: u16 = 1 << 3;
pub(crate) const FLAG_UTF8: u16 = 1 << 11;

pub(crate) const METHOD_STORE: u16 = 0;
pub(crate) const METHOD_DEFLATE: u16 = 8;
pub(crate) const METHOD_DEFLATE64: u16 = 9;
pub(crate) const METHOD_BZIP2: u16 = 12;
pub(crate) const METHOD_LZMA: u16 = 14;
pub(crate) const METHOD_ZSTD: u16 = 93;
/// Stands in for the real method on an entry WinZip AES encrypted.
pub(crate) const METHOD_AES: u16 = 99;

pub(crate) const EXTRA_ZIP64: u16 = 0x0001;
pub(crate) const EXTRA_NTFS: u16 = 0x000a;
pub(crate) const EXTRA_EXTENDED_TIMESTAMP: u16 = 0x5455;
pub(crate) const EXTRA_UNICODE_PATH: u16 = 0x7075;
pub(crate) const EXTRA_AES: u16 = 0x9901;

/// The 32-bit fields that say "the real value is in the Zip64 extra field".
pub(crate) const ZIP64_MARKER_32: u32 = 0xffff_ffff;
pub(crate) const ZIP64_MARKER_16: u16 = 0xffff;

/// Unix in the high byte of "version made by", which tells a reader the high
/// half of the external attributes holds a Unix mode.
pub(crate) const MADE_BY_UNIX: u16 = 3 << 8;

pub(crate) const S_IFMT: u32 = 0o170_000;
pub(crate) const S_IFDIR: u32 = 0o040_000;
pub(crate) const S_IFLNK: u32 = 0o120_000;

/// Little-endian reads from a record already in memory, failing rather than
/// panicking when the record is shorter than its fields claim.
pub(crate) struct Cursor<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Cursor<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    pub(crate) fn remaining(&self) -> usize {
        self.bytes.len() - self.position
    }

    pub(crate) fn take(&mut self, length: usize) -> Option<&'a [u8]> {
        let end = self.position.checked_add(length)?;
        let slice = self.bytes.get(self.position..end)?;
        self.position = end;
        Some(slice)
    }

    pub(crate) fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|bytes| bytes[0])
    }

    pub(crate) fn u16(&mut self) -> Option<u16> {
        self.take(2).map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    pub(crate) fn u32(&mut self) -> Option<u32> {
        self.take(4).map(|bytes| u32::from_le_bytes(bytes.try_into().unwrap()))
    }

    pub(crate) fn u64(&mut self) -> Option<u64> {
        self.take(8).map(|bytes| u64::from_le_bytes(bytes.try_into().unwrap()))
    }
}

/// The fields in an entry's extra data that this engine reads. Unknown ones
/// are skipped, and a malformed one is ignored rather than trusted.
#[derive(Debug, Default, Clone)]
pub(crate) struct ExtraFields {
    pub zip64: Option<Vec<u8>>,
    pub aes: Option<AesExtra>,
    pub modified: Option<SystemTime>,
    pub unicode_path: Option<(u32, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AesExtra {
    /// 1 (AE-1, CRC kept) or 2 (AE-2, CRC zeroed).
    pub vendor_version: u16,
    /// 1, 2 or 3 for 128, 192 or 256-bit keys.
    pub strength: u8,
    /// The method the data was compressed with before it was encrypted.
    pub method: u16,
}

impl ExtraFields {
    pub(crate) fn parse(bytes: &[u8]) -> Self {
        let mut fields = Self::default();
        let mut cursor = Cursor::new(bytes);
        while cursor.remaining() >= 4 {
            let (Some(id), Some(length)) = (cursor.u16(), cursor.u16()) else { break };
            let Some(body) = cursor.take(usize::from(length)) else { break };
            match id {
                EXTRA_ZIP64 => fields.zip64 = Some(body.to_vec()),
                EXTRA_AES => fields.aes = parse_aes(body),
                EXTRA_EXTENDED_TIMESTAMP => {
                    let mut body = Cursor::new(body);
                    if body.u8().is_some_and(|flags| flags & 1 != 0)
                        && let Some(seconds) = body.u32()
                    {
                        fields.modified = Some(UNIX_EPOCH + Duration::from_secs(u64::from(seconds)));
                    }
                }
                EXTRA_NTFS if fields.modified.is_none() => fields.modified = parse_ntfs_modified(body),
                EXTRA_UNICODE_PATH => {
                    let mut body = Cursor::new(body);
                    if body.u8() == Some(1)
                        && let Some(crc) = body.u32()
                        && let Ok(name) = String::from_utf8(body.take(body.remaining()).unwrap_or_default().to_vec())
                    {
                        fields.unicode_path = Some((crc, name));
                    }
                }
                _ => {}
            }
        }
        fields
    }
}

fn parse_aes(body: &[u8]) -> Option<AesExtra> {
    let mut cursor = Cursor::new(body);
    let vendor_version = cursor.u16()?;
    let vendor = cursor.take(2)?;
    let strength = cursor.u8()?;
    let method = cursor.u16()?;
    (vendor == b"AE" && (1..=3).contains(&strength)).then_some(AesExtra { vendor_version, strength, method })
}

/// NTFS times count 100ns ticks from 1601.
fn parse_ntfs_modified(body: &[u8]) -> Option<SystemTime> {
    let mut cursor = Cursor::new(body);
    cursor.take(4)?;
    while cursor.remaining() >= 4 {
        let tag = cursor.u16()?;
        let length = cursor.u16()?;
        let attribute = cursor.take(usize::from(length))?;
        if tag == 1 && length >= 8 {
            let ticks = u64::from_le_bytes(attribute[..8].try_into().ok()?);
            const TICKS_TO_UNIX_EPOCH: u64 = 116_444_736_000_000_000;
            let since_epoch = ticks.checked_sub(TICKS_TO_UNIX_EPOCH)?;
            return Some(UNIX_EPOCH + Duration::from_nanos(since_epoch.saturating_mul(100)));
        }
    }
    None
}

/// Reads the values a Zip64 extra field carries, in the order the format
/// gives them, for whichever of the 32-bit fields were maxed out.
pub(crate) struct Zip64Values<'a> {
    cursor: Cursor<'a>,
}

impl<'a> Zip64Values<'a> {
    pub(crate) fn new(field: Option<&'a [u8]>) -> Self {
        Self { cursor: Cursor::new(field.unwrap_or_default()) }
    }

    /// The real value when `value` is the marker, and `value` otherwise.
    pub(crate) fn resolve_u64(&mut self, value: u32) -> Option<u64> {
        if value == ZIP64_MARKER_32 { self.cursor.u64() } else { Some(u64::from(value)) }
    }

    pub(crate) fn resolve_disk(&mut self, value: u16) -> Option<u32> {
        if value == ZIP64_MARKER_16 { self.cursor.u32() } else { Some(u32::from(value)) }
    }
}

/// A broken-down civil time, in whatever zone the conversion chose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Civil {
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
}

/// DOS timestamps are local wall-clock time with two-second precision, so
/// they go through the machine's time zone both ways.
pub(crate) fn dos_to_system_time(date: u16, time: u16) -> Option<SystemTime> {
    let civil = Civil {
        year: 1980 + i32::from(date >> 9),
        month: u32::from((date >> 5) & 0x0f),
        day: u32::from(date & 0x1f),
        hour: u32::from(time >> 11),
        minute: u32::from((time >> 5) & 0x3f),
        second: u32::from(time & 0x1f) * 2,
    };
    if !(1..=12).contains(&civil.month) || civil.day == 0 || civil.hour > 23 || civil.minute > 59 {
        return None;
    }
    local_to_system_time(civil)
}

/// The DOS date and time for `time`, clamped to the range DOS can hold.
pub(crate) fn system_time_to_dos(time: SystemTime) -> (u16, u16) {
    let Some(civil) = system_time_to_local(time) else { return (0x21, 0) };
    if civil.year < 1980 {
        return (0x21, 0);
    }
    if civil.year > 2107 {
        return ((127 << 9) | (12 << 5) | 31, (23 << 11) | (59 << 5) | 29);
    }
    let date = (((civil.year - 1980) as u16) << 9) | ((civil.month as u16) << 5) | civil.day as u16;
    let time = ((civil.hour as u16) << 11) | ((civil.minute as u16) << 5) | (civil.second as u16 / 2);
    (date, time)
}

#[cfg(unix)]
fn local_to_system_time(civil: Civil) -> Option<SystemTime> {
    // SAFETY: tm is plain data, and mktime only reads and normalizes it.
    let seconds = unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        tm.tm_year = civil.year - 1900;
        tm.tm_mon = civil.month as i32 - 1;
        tm.tm_mday = civil.day as i32;
        tm.tm_hour = civil.hour as i32;
        tm.tm_min = civil.minute as i32;
        tm.tm_sec = civil.second as i32;
        tm.tm_isdst = -1;
        libc::mktime(&mut tm)
    };
    (seconds >= 0).then(|| UNIX_EPOCH + Duration::from_secs(seconds as u64))
}

#[cfg(unix)]
fn system_time_to_local(time: SystemTime) -> Option<Civil> {
    let seconds = libc::time_t::try_from(time.duration_since(UNIX_EPOCH).ok()?.as_secs()).ok()?;
    // SAFETY: localtime_r writes only into the tm it is handed.
    let tm = unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&seconds, &mut tm).is_null() {
            return None;
        }
        tm
    };
    Some(Civil {
        year: tm.tm_year + 1900,
        month: (tm.tm_mon + 1) as u32,
        day: tm.tm_mday as u32,
        hour: tm.tm_hour as u32,
        minute: tm.tm_min as u32,
        second: tm.tm_sec as u32,
    })
}

// Without the C library's zone tables, DOS times are read and written as UTC.
#[cfg(not(unix))]
fn local_to_system_time(civil: Civil) -> Option<SystemTime> {
    let days = days_from_civil(civil.year, civil.month, civil.day);
    let seconds = days * 86_400 + i64::from(civil.hour * 3600 + civil.minute * 60 + civil.second);
    (seconds >= 0).then(|| UNIX_EPOCH + Duration::from_secs(seconds as u64))
}

#[cfg(not(unix))]
fn system_time_to_local(time: SystemTime) -> Option<Civil> {
    let seconds = time.duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;
    let (days, rest) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400) as u32);
    let (year, month, day) = civil_from_days(days);
    Some(Civil { year, month, day, hour: rest / 3600, minute: rest / 60 % 60, second: rest % 60 })
}

#[cfg(not(unix))]
fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let year = i64::from(year) - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month = i64::from(month);
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(not(unix))]
fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_index + 2) / 5 + 1) as u32;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 } as u32;
    ((year_of_era + era * 400 + i64::from(month <= 2)) as i32, month, day)
}

/// The encoding entry names are read in, picked in expert mode. `Auto`
/// trusts the UTF-8 flag and the Info-ZIP Unicode path field, then reads
/// names that are valid UTF-8 as UTF-8 - macOS writes them that way without
/// setting the flag - and falls back to the IBM PC code page the format
/// names as its default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum FilenameEncoding {
    #[default]
    Auto,
    Utf8,
    Cp949,
    ShiftJis,
    Gbk,
    Big5,
    Cp437,
    Windows1252,
}

pub(crate) fn decode_name(raw: &[u8], flags: u16, extra: &ExtraFields, encoding: FilenameEncoding) -> String {
    let lossy_utf8 = || String::from_utf8_lossy(raw).into_owned();
    let with = |encoding: &'static encoding_rs::Encoding| encoding.decode_without_bom_handling(raw).0.into_owned();
    match encoding {
        FilenameEncoding::Auto => {
            if flags & FLAG_UTF8 != 0 {
                return lossy_utf8();
            }
            if let Some((crc, name)) = &extra.unicode_path
                && *crc == crc32fast::hash(raw)
            {
                return name.clone();
            }
            match std::str::from_utf8(raw) {
                Ok(name) => name.to_owned(),
                Err(_) => decode_cp437(raw),
            }
        }
        FilenameEncoding::Utf8 => lossy_utf8(),
        FilenameEncoding::Cp949 => with(encoding_rs::EUC_KR),
        FilenameEncoding::ShiftJis => with(encoding_rs::SHIFT_JIS),
        FilenameEncoding::Gbk => with(encoding_rs::GBK),
        FilenameEncoding::Big5 => with(encoding_rs::BIG5),
        FilenameEncoding::Cp437 => decode_cp437(raw),
        FilenameEncoding::Windows1252 => with(encoding_rs::WINDOWS_1252),
    }
}

/// Code page 437's upper half, which the WHATWG encodings leave out.
const CP437_HIGH: [char; 128] = [
    'Ç', 'ü', 'é', 'â', 'ä', 'à', 'å', 'ç', 'ê', 'ë', 'è', 'ï', 'î', 'ì', 'Ä', 'Å', 'É', 'æ', 'Æ', 'ô', 'ö', 'ò', 'û',
    'ù', 'ÿ', 'Ö', 'Ü', '¢', '£', '¥', '₧', 'ƒ', 'á', 'í', 'ó', 'ú', 'ñ', 'Ñ', 'ª', 'º', '¿', '⌐', '¬', '½', '¼', '¡',
    '«', '»', '░', '▒', '▓', '│', '┤', '╡', '╢', '╖', '╕', '╣', '║', '╗', '╝', '╜', '╛', '┐', '└', '┴', '┬', '├', '─',
    '┼', '╞', '╟', '╚', '╔', '╩', '╦', '╠', '═', '╬', '╧', '╨', '╤', '╥', '╙', '╘', '╒', '╓', '╫', '╪', '┘', '┌', '█',
    '▄', '▌', '▐', '▀', 'α', 'ß', 'Γ', 'π', 'Σ', 'σ', 'µ', 'τ', 'Φ', 'Θ', 'Ω', 'δ', '∞', 'φ', 'ε', '∩', '≡', '±', '≥',
    '≤', '⌠', '⌡', '÷', '≈', '°', '∙', '·', '√', 'ⁿ', '²', '■', '\u{a0}',
];

fn decode_cp437(raw: &[u8]) -> String {
    raw.iter().map(|&byte| if byte < 0x80 { char::from(byte) } else { CP437_HIGH[usize::from(byte - 0x80)] }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_timestamp_through_dos_fields_to_two_seconds() {
        let time = UNIX_EPOCH + Duration::from_secs(1_700_000_001);
        let (date, dos_time) = system_time_to_dos(time);
        let back = dos_to_system_time(date, dos_time).unwrap();
        assert_eq!(back, UNIX_EPOCH + Duration::from_secs(1_700_000_000));
    }

    #[test]
    fn clamps_times_dos_cannot_hold() {
        assert_eq!(system_time_to_dos(UNIX_EPOCH), (0x21, 0));
        assert_eq!(dos_to_system_time(0, 0), None);
    }

    #[test]
    fn decodes_names_in_the_encoding_asked_for() {
        let extra = ExtraFields::default();
        let korean_cp949 = [0xc7, 0xd1, 0xb1, 0xdb];
        assert_eq!(decode_name(&korean_cp949, 0, &extra, FilenameEncoding::Cp949), "한글");
        assert_eq!(decode_name("한글".as_bytes(), 0, &extra, FilenameEncoding::Auto), "한글");
        assert_eq!(decode_name(&[0x82, 0xa0], 0, &extra, FilenameEncoding::ShiftJis), "あ");
        assert_eq!(decode_name(&[0x80, 0x9a, 0xe1], 0, &extra, FilenameEncoding::Cp437), "ÇÜß");
        // Not valid UTF-8, so auto falls back to the format's default code page.
        assert_eq!(decode_name(&korean_cp949, 0, &extra, FilenameEncoding::Auto), "╟╤▒█");
        assert_eq!(decode_name(&[0x80], 0, &extra, FilenameEncoding::Windows1252), "€");
    }

    #[test]
    fn trusts_a_unicode_path_field_only_while_it_matches_the_raw_name() {
        let raw = b"caf\x82";
        let matching =
            ExtraFields { unicode_path: Some((crc32fast::hash(raw), "café".into())), ..ExtraFields::default() };
        let stale = ExtraFields { unicode_path: Some((0, "other".into())), ..ExtraFields::default() };
        assert_eq!(decode_name(raw, 0, &matching, FilenameEncoding::Auto), "café");
        assert_eq!(decode_name(raw, 0, &stale, FilenameEncoding::Auto), "café");
    }

    #[test]
    fn reads_the_extra_fields_it_knows() {
        let mut bytes = Vec::new();
        bytes.extend(EXTRA_EXTENDED_TIMESTAMP.to_le_bytes());
        bytes.extend(5u16.to_le_bytes());
        bytes.push(1);
        bytes.extend(1_600_000_000u32.to_le_bytes());
        bytes.extend(EXTRA_AES.to_le_bytes());
        bytes.extend(7u16.to_le_bytes());
        bytes.extend([2, 0, b'A', b'E', 3, 8, 0]);
        let fields = ExtraFields::parse(&bytes);
        assert_eq!(fields.modified, Some(UNIX_EPOCH + Duration::from_secs(1_600_000_000)));
        assert_eq!(fields.aes, Some(AesExtra { vendor_version: 2, strength: 3, method: METHOD_DEFLATE }));
    }
}
