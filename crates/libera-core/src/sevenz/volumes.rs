//! Split 7z sets: `name.7z.001`, `name.7z.002`, ... The headers sit at the
//! front of the first volume - the mirror image of a ZIP set - so a set is
//! opened from `.001`, and the rest is one byte stream continuing across the
//! volumes in order.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use super::write::{SIGNATURE, SIGNATURE_HEADER_SIZE};
use crate::LiberaError;

/// 7-Zip pads volume numbers to three digits, so a set stops where the
/// padding still holds.
pub const MAX_SEVEN_ZIP_VOLUMES: u32 = 999;

fn digits_suffix(name: &str) -> Option<u32> {
    let (_, digits) = name.rsplit_once('.')?;
    (digits.len() >= 3 && digits.bytes().all(|byte| byte.is_ascii_digit())).then(|| digits.parse().ok()).flatten()
}

/// Whether `path` is one numbered volume of a 7z set.
pub(crate) fn is_seven_zip_volume_path(path: &Path) -> bool {
    let name = path.file_name().map(|name| name.to_string_lossy().to_lowercase()).unwrap_or_default();
    digits_suffix(&name).is_some() && name[..name.rfind('.').unwrap()].ends_with(".7z")
}

/// `name.7z.003` → `name.7z`.
pub(crate) fn seven_zip_volume_base(path: &Path) -> PathBuf {
    if !is_seven_zip_volume_path(path) {
        return path.to_path_buf();
    }
    let text = path.to_string_lossy();
    PathBuf::from(&text[..text.rfind('.').unwrap()])
}

pub(crate) fn seven_zip_volume_path(base: &Path, number: u32) -> PathBuf {
    let mut name = base.as_os_str().to_owned();
    name.push(format!(".{number:03}"));
    PathBuf::from(name)
}

/// Any volume of a set, rewritten to `.001`, where 7-Zip keeps the headers.
pub(crate) fn first_volume_path(path: &Path) -> PathBuf {
    if is_seven_zip_volume_path(path) {
        seven_zip_volume_path(&seven_zip_volume_base(path), 1)
    } else {
        path.to_path_buf()
    }
}

/// Whether `name` is a volume of the set whose base file is named `base_name`.
pub(crate) fn is_volume_of(base_name: &str, name: &str) -> bool {
    let fold = |text: &str| if cfg!(windows) { text.to_lowercase() } else { text.to_owned() };
    let (base_name, name) = (fold(base_name), fold(name));
    name.strip_prefix(&base_name).and_then(|rest| rest.strip_prefix('.')).is_some_and(|rest| {
        let digits = rest.strip_suffix(".partial").unwrap_or(rest);
        digits.len() >= 3 && digits.bytes().all(|byte| byte.is_ascii_digit())
    })
}

fn missing(message: String) -> LiberaError {
    LiberaError::SplitVolumeMissing { message }
}

/// What the signature header says the whole archive measures, when the first
/// bytes of the set hold a valid one.
fn declared_size(header: &[u8]) -> Option<u64> {
    if header.len() < SIGNATURE_HEADER_SIZE as usize || header[..6] != SIGNATURE {
        return None;
    }
    if crc32fast::hash(&header[12..32]) != u32::from_le_bytes(header[8..12].try_into().unwrap()) {
        return None;
    }
    let next_header_offset = u64::from_le_bytes(header[12..20].try_into().unwrap());
    let next_header_size = u64::from_le_bytes(header[20..28].try_into().unwrap());
    SIGNATURE_HEADER_SIZE.checked_add(next_header_offset)?.checked_add(next_header_size)
}

/// Every volume of the set `first` opens, in order, checked for gaps so a
/// missing volume is named as such rather than surfacing later as damage.
pub(crate) fn discover_seven_zip_volumes(first: &Path) -> Result<Vec<PathBuf>, LiberaError> {
    let first = std::path::absolute(first)?;
    let directory = first.parent().unwrap_or(Path::new("/")).to_path_buf();
    let base = seven_zip_volume_base(&first);
    let base_name = base.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let children = fs::read_dir(&directory).map_err(|_| LiberaError::SplitVolumeUnreadable {
        message: format!("Cannot read the archive folder: {}", directory.display()),
    })?;

    let mut by_number = BTreeMap::new();
    for child in children.filter_map(Result::ok) {
        let name = child.file_name().to_string_lossy().into_owned();
        if !is_volume_of(&base_name, &name) || name.ends_with(".partial") {
            continue;
        }
        let Some(number) = digits_suffix(&name).filter(|number| *number >= 1) else { continue };
        if by_number.insert(number, child.path()).is_some() {
            return Err(LiberaError::SplitVolumeMismatch {
                message: format!("The folder holds more than one volume numbered {number}."),
            });
        }
    }

    let first_name = format!("{base_name}.001");
    if !by_number.contains_key(&1) {
        return Err(missing(format!("Missing the first volume: {first_name}")));
    }
    if by_number.len() as u32 > MAX_SEVEN_ZIP_VOLUMES {
        return Err(LiberaError::SplitVolumeMismatch {
            message: format!("The set holds more than {MAX_SEVEN_ZIP_VOLUMES} volumes."),
        });
    }
    let mut volumes = Vec::with_capacity(by_number.len());
    for number in 1..=by_number.len() as u32 {
        let volume =
            by_number.remove(&number).ok_or_else(|| missing(format!("Missing volume: {base_name}.{number:03}")))?;
        volumes.push(volume);
    }

    let mut available = 0u64;
    for volume in &volumes {
        match fs::symlink_metadata(volume) {
            Ok(metadata) if metadata.is_file() => available += metadata.len(),
            _ => {
                return Err(missing(format!(
                    "Volume is not a readable file: {}",
                    volume.file_name().unwrap_or_default().to_string_lossy()
                )));
            }
        }
    }
    let next = format!("{base_name}.{:03}", volumes.len() + 1);
    let mut header = Vec::with_capacity(SIGNATURE_HEADER_SIZE as usize);
    for volume in &volumes {
        File::open(volume)?.take(SIGNATURE_HEADER_SIZE - header.len() as u64).read_to_end(&mut header)?;
        if header.len() as u64 == SIGNATURE_HEADER_SIZE {
            break;
        }
    }
    if header.starts_with(&SIGNATURE) && (header.len() as u64) < SIGNATURE_HEADER_SIZE {
        return Err(missing(format!("The split 7z header is incomplete; missing volume: {next}")));
    }
    if declared_size(&header).is_some_and(|declared| available < declared) {
        return Err(missing(format!("The split 7z set is missing data at or after volume: {next}")));
    }
    Ok(volumes)
}

/// Clears what an earlier run left at this path: higher-numbered volumes of a
/// longer set, the other shape of the same archive, a stray temporary. Run
/// only once the new archive is whole, so a failed run leaves the old one.
/// `keep_base` keeps the file at the base name, which a whole archive is.
pub(crate) fn remove_stale_volumes(output: &Path, keep_base: bool) {
    let directory = output.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let Some(base_name) = output.file_name().map(|name| name.to_string_lossy().into_owned()) else { return };
    let Ok(children) = fs::read_dir(directory) else { return };
    for child in children.filter_map(Result::ok) {
        let name = child.file_name().to_string_lossy().into_owned();
        let is_volume = is_volume_of(&base_name, &name) && !name.ends_with(".partial");
        let is_base = name == base_name;
        let is_temporary = name == format!("{base_name}.tmp");
        if is_volume || is_temporary || (is_base && !keep_base) {
            let _ = fs::remove_file(child.path());
        }
    }
}

fn partial(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".partial");
    PathBuf::from(name)
}

/// A split set being written: one byte stream cut into `.001`, `.002`, ...
/// Volumes are written under `.partial` names and moved into place only once
/// the whole set is on disk, so a cancelled or failed run leaves whatever set
/// was already there untouched.
pub(crate) struct VolumeSink {
    base: PathBuf,
    split_size: u64,
    volumes: Vec<PathBuf>,
    position: u64,
    current: Option<(usize, File)>,
}

impl VolumeSink {
    pub(crate) fn new(base: &Path, split_size: u64) -> Self {
        Self { base: base.to_path_buf(), split_size, volumes: Vec::new(), position: 0, current: None }
    }

    fn file_for(&mut self, index: usize) -> io::Result<&mut File> {
        if self.current.as_ref().is_none_or(|(current, _)| *current != index) {
            if index as u32 >= MAX_SEVEN_ZIP_VOLUMES {
                return Err(LiberaError::SplitTooManyVolumes {
                    message: "The split size produces too many volumes.".into(),
                }
                .into());
            }
            while self.volumes.len() <= index {
                self.volumes.push(seven_zip_volume_path(&self.base, self.volumes.len() as u32 + 1));
            }
            let file =
                OpenOptions::new().write(true).create(true).truncate(false).open(partial(&self.volumes[index]))?;
            self.current = Some((index, file));
        }
        Ok(&mut self.current.as_mut().unwrap().1)
    }

    /// Moves the finished set into place, clearing what an earlier run left.
    pub(crate) fn commit(mut self) -> io::Result<Vec<PathBuf>> {
        self.current = None;
        remove_stale_volumes(&self.base, false);
        for volume in &self.volumes {
            fs::rename(partial(volume), volume)?;
        }
        Ok(self.volumes)
    }

    /// Drops the partial set, leaving whatever was already on disk alone.
    pub(crate) fn discard(mut self) {
        self.current = None;
        for volume in &self.volumes {
            let _ = fs::remove_file(partial(volume));
        }
    }
}

impl Write for VolumeSink {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let index = (self.position / self.split_size) as usize;
        let within = self.position % self.split_size;
        let length = buf.len().min(usize::try_from(self.split_size - within).unwrap_or(usize::MAX));
        let file = self.file_for(index)?;
        file.seek(SeekFrom::Start(within))?;
        let written = file.write(&buf[..length])?;
        self.position += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.current.as_mut().map_or(Ok(()), |(_, file)| file.flush())
    }
}

impl Seek for VolumeSink {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        match position {
            SeekFrom::Start(offset) => self.position = offset,
            _ => return Err(io::Error::new(io::ErrorKind::Unsupported, "a volume set seeks from its start only")),
        }
        Ok(self.position)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_recognizes_the_volumes_of_a_set() {
        assert!(is_seven_zip_volume_path(Path::new("/x/a.7z.001")));
        assert!(is_seven_zip_volume_path(Path::new("a.7Z.1234")));
        assert!(!is_seven_zip_volume_path(Path::new("a.7z")));
        assert!(!is_seven_zip_volume_path(Path::new("a.zip.001")));
        assert!(!is_seven_zip_volume_path(Path::new("a.7z.01")));
        assert_eq!(first_volume_path(Path::new("/x/a.7z.007")), Path::new("/x/a.7z.001"));
        assert_eq!(seven_zip_volume_base(Path::new("/x/a.7z.007")), Path::new("/x/a.7z"));
        assert!(is_volume_of("a.7z", "a.7z.012"));
        assert!(is_volume_of("a.7z", "a.7z.012.partial"));
        assert!(!is_volume_of("a.7z", "a.7z"));
        assert!(!is_volume_of("a.7z", "b.7z.001"));
    }

    #[test]
    fn cuts_one_stream_into_volumes_and_patches_back_into_the_first() {
        let work = tempfile::TempDir::new().unwrap();
        let base = work.path().join("set.7z");
        fs::write(work.path().join("set.7z.009"), "stale").unwrap();
        let mut sink = VolumeSink::new(&base, 4);
        sink.write_all(b"0123456789").unwrap();
        sink.seek(SeekFrom::Start(1)).unwrap();
        sink.write_all(b"AB").unwrap();
        let volumes = sink.commit().unwrap();

        let contents: Vec<String> = volumes.iter().map(|volume| fs::read_to_string(volume).unwrap()).collect();
        assert_eq!(contents, ["0AB3", "4567", "89"]);
        assert!(!work.path().join("set.7z.009").exists());
    }
}
