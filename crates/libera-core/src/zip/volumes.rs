//! Split ZIP sets: `base.z01`, `base.z02`, ... and a terminal `base.zip` that
//! holds the central directory. Offsets inside a set are relative to the
//! volume they point into, so the set is read through one address space laid
//! over every volume in order.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use super::format::{END_OF_CENTRAL_DIRECTORY_LENGTH, END_OF_CENTRAL_DIRECTORY_SIGNATURE, MAX_COMMENT_LENGTH};
use crate::LiberaError;

pub const MAX_SPLIT_VOLUMES: u32 = 65_535;
pub const MIN_SPLIT_SIZE: u64 = 1 << 20;

fn same_name(left: &str, right: &str) -> bool {
    if cfg!(windows) { left.eq_ignore_ascii_case(right) } else { left == right }
}

/// `report.zip` → `report`, the stem every volume of the set shares.
pub(crate) fn split_volume_base(output_path: &Path) -> PathBuf {
    let text = output_path.to_string_lossy();
    match text.len().checked_sub(4) {
        Some(stem) if text.is_char_boundary(stem) && text[stem..].eq_ignore_ascii_case(".zip") => {
            PathBuf::from(&text[..stem])
        }
        _ => output_path.to_path_buf(),
    }
}

/// The volume that holds disk `disk` of a set, numbered from zero.
pub(crate) fn volume_path_for_disk(base: &Path, disk: u32) -> PathBuf {
    let mut name = base.as_os_str().to_owned();
    name.push(format!(".z{:02}", disk + 1));
    PathBuf::from(name)
}

/// `NN` from a `.zNN` suffix of two or more digits.
fn numbered_suffix(suffix: &str) -> Option<u32> {
    let digits = suffix.strip_prefix(['z', 'Z'])?;
    (digits.len() >= 2 && digits.bytes().all(|byte| byte.is_ascii_digit())).then(|| digits.parse().ok()).flatten()
}

/// Whether `candidate` is a volume of the set named `base`: the terminal
/// `.zip`, or any `.zNN`.
pub(crate) fn is_split_volume_name(base: &str, candidate: &str) -> bool {
    let Some(prefix) = candidate.get(..base.len() + 1) else { return false };
    if !same_name(prefix, &format!("{base}.")) {
        return false;
    }
    let suffix = &candidate[base.len() + 1..];
    suffix.eq_ignore_ascii_case("zip") || numbered_suffix(suffix).is_some()
}

pub(crate) fn is_numbered_volume_path(path: &Path) -> bool {
    path.extension().and_then(|extension| extension.to_str()).and_then(numbered_suffix).is_some()
}

/// Any volume of a set, rewritten to the terminal `.zip`. Only the last
/// volume carries the central directory, so every read starts there.
pub(crate) fn terminal_volume_path(path: &Path) -> PathBuf {
    if is_numbered_volume_path(path) { path.with_extension("zip") } else { path.to_path_buf() }
}

/// Removes the volumes an earlier run left beside `output_path`. A shorter
/// run would otherwise leave higher-numbered volumes next to the new ones,
/// and the mixed set reads as a corrupt archive.
pub(crate) fn remove_stale_volumes(output_path: &Path) {
    let directory = output_path.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let base = split_volume_base(output_path);
    let Some(base_name) = base.file_name().map(|name| name.to_string_lossy().into_owned()) else { return };
    let Ok(children) = fs::read_dir(directory) else { return };
    for child in children.filter_map(Result::ok) {
        if is_split_volume_name(&base_name, &child.file_name().to_string_lossy()) {
            let _ = fs::remove_file(child.path());
        }
    }
}

/// The zero-based number of the last disk, read from the terminal volume's
/// end-of-central-directory record, or `None` when there is no such record.
pub(crate) fn terminal_disk_number(terminal: &Path) -> io::Result<Option<u16>> {
    let mut file = File::open(terminal)?;
    let length = file.metadata()?.len();
    let tail_length = length.min((END_OF_CENTRAL_DIRECTORY_LENGTH + MAX_COMMENT_LENGTH) as u64);
    if tail_length < END_OF_CENTRAL_DIRECTORY_LENGTH as u64 {
        return Ok(None);
    }
    let mut tail = vec![0; tail_length as usize];
    file.seek(SeekFrom::Start(length - tail_length))?;
    file.read_exact(&mut tail)?;
    for offset in (0..=tail.len() - END_OF_CENTRAL_DIRECTORY_LENGTH).rev() {
        let field = |at: usize, width: usize| &tail[offset + at..offset + at + width];
        if u32::from_le_bytes(field(0, 4).try_into().unwrap()) != END_OF_CENTRAL_DIRECTORY_SIGNATURE {
            continue;
        }
        let comment = usize::from(u16::from_le_bytes(field(20, 2).try_into().unwrap()));
        if offset + END_OF_CENTRAL_DIRECTORY_LENGTH + comment == tail.len() {
            return Ok(Some(u16::from_le_bytes(field(4, 2).try_into().unwrap())));
        }
    }
    Ok(None)
}

fn missing(message: String) -> LiberaError {
    LiberaError::SplitVolumeMissing { message }
}

fn mismatch(message: String) -> LiberaError {
    LiberaError::SplitVolumeMismatch { message }
}

/// Every volume of the set `terminal` closes, in disk order with the terminal
/// `.zip` last, after checking that the folder holds exactly the volumes the
/// terminal one says the set has.
pub(crate) fn discover_split_volumes(terminal: &Path) -> Result<Vec<PathBuf>, LiberaError> {
    let terminal = std::path::absolute(terminal)?;
    let directory = terminal.parent().unwrap_or(Path::new("/")).to_path_buf();
    let base = split_volume_base(&terminal);
    let base_name = base.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let terminal_name = terminal.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();

    let children = fs::read_dir(&directory).map_err(|_| LiberaError::SplitVolumeUnreadable {
        message: format!("Cannot read the archive folder: {}", directory.display()),
    })?;
    let mut by_disk = BTreeMap::new();
    let mut terminal_found = None;
    for child in children.filter_map(Result::ok) {
        let name = child.file_name().to_string_lossy().into_owned();
        if !is_split_volume_name(&base_name, &name) {
            continue;
        }
        let suffix = &name[base_name.len() + 1..];
        match numbered_suffix(suffix) {
            None => terminal_found = Some(child.path()),
            Some(0) => {}
            Some(disk) => {
                if by_disk.insert(disk, child.path()).is_some() {
                    return Err(mismatch(format!("The folder holds more than one volume numbered {disk}.")));
                }
            }
        }
    }

    let terminal = terminal_found.ok_or_else(|| missing(format!("Missing the final volume: {terminal_name}")))?;
    let numbered = terminal_disk_number(&terminal)
        .map_err(|_| LiberaError::SplitVolumeUnreadable {
            message: format!("Cannot read the final volume: {terminal_name}"),
        })?
        .ok_or_else(|| missing(format!("The final volume is missing or incomplete: {terminal_name}")))?;
    let numbered = u32::from(numbered);

    let mut volumes = Vec::with_capacity(numbered as usize + 1);
    for disk in 1..=numbered {
        let volume = by_disk.remove(&disk).ok_or_else(|| {
            let expected = volume_path_for_disk(Path::new(&base_name), disk - 1);
            missing(format!("Missing volume: {}", expected.display()))
        })?;
        volumes.push(volume);
    }
    if let Some((_, unexpected)) = by_disk.into_iter().next() {
        return Err(mismatch(format!(
            "Unexpected volume: {}",
            unexpected.file_name().unwrap_or_default().to_string_lossy()
        )));
    }
    volumes.push(terminal);

    for volume in &volumes {
        if !fs::symlink_metadata(volume).is_ok_and(|metadata| metadata.is_file()) {
            return Err(missing(format!(
                "Volume is not a readable file: {}",
                volume.file_name().unwrap_or_default().to_string_lossy()
            )));
        }
    }
    Ok(volumes)
}

/// Every volume of a set read as one stream of bytes, the first volume's
/// first byte at offset zero.
pub(crate) struct VolumeSet {
    files: Vec<File>,
    /// Where each volume starts in the joined address space.
    starts: Vec<u64>,
    length: u64,
    position: u64,
}

impl VolumeSet {
    pub(crate) fn open(paths: &[PathBuf]) -> io::Result<Self> {
        let mut files = Vec::with_capacity(paths.len());
        let mut starts = Vec::with_capacity(paths.len());
        let mut length = 0;
        for path in paths {
            let file = File::open(path)?;
            starts.push(length);
            length += file.metadata()?.len();
            files.push(file);
        }
        Ok(Self { files, starts, length, position: 0 })
    }

    pub(crate) fn len(&self) -> u64 {
        self.length
    }

    pub(crate) fn volume_sizes(&self) -> Vec<u64> {
        let mut sizes: Vec<u64> = self.starts.windows(2).map(|pair| pair[1] - pair[0]).collect();
        if let Some(last) = self.starts.last() {
            sizes.push(self.length - last);
        }
        sizes
    }

    /// Where offset `offset` of disk `disk` lands in the joined address space.
    pub(crate) fn absolute(&self, disk: u32, offset: u64) -> Option<u64> {
        let start = *self.starts.get(disk as usize)?;
        start.checked_add(offset).filter(|absolute| *absolute <= self.length)
    }
}

impl Read for VolumeSet {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.position >= self.length || buf.is_empty() {
            return Ok(0);
        }
        let volume = self.starts.partition_point(|start| *start <= self.position) - 1;
        let volume_end = self.starts.get(volume + 1).copied().unwrap_or(self.length);
        let within = self.position - self.starts[volume];
        let limit = buf.len().min(usize::try_from(volume_end - self.position).unwrap_or(usize::MAX));
        let file = &mut self.files[volume];
        file.seek(SeekFrom::Start(within))?;
        let read = file.read(&mut buf[..limit])?;
        self.position += read as u64;
        Ok(read)
    }
}

impl Seek for VolumeSet {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        let target = match position {
            SeekFrom::Start(offset) => Some(offset),
            SeekFrom::End(delta) => self.length.checked_add_signed(delta),
            SeekFrom::Current(delta) => self.position.checked_add_signed(delta),
        };
        self.position = target.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "seek before the start"))?;
        Ok(self.position)
    }
}

/// Where a writer stands in the set it is writing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Position {
    pub disk: u32,
    pub offset: u64,
}

/// What the ZIP writer writes into: one file, or a split set it opens volume
/// by volume as the bytes arrive.
pub(crate) trait Sink: Write {
    fn position(&self) -> Position;
    /// Moves to a fresh volume first when a record of `length` bytes would
    /// not fit in the current one, so no header is ever cut in two.
    fn keep_whole(&mut self, length: u64) -> io::Result<()>;
}

impl<T: Sink + ?Sized> Sink for &mut T {
    fn position(&self) -> Position {
        (**self).position()
    }

    fn keep_whole(&mut self, length: u64) -> io::Result<()> {
        (**self).keep_whole(length)
    }
}

/// A single archive file.
pub(crate) struct FileSink {
    file: BufWriter<File>,
    written: u64,
}

impl FileSink {
    pub(crate) fn create(path: &Path) -> io::Result<Self> {
        Ok(Self { file: BufWriter::new(File::create(path)?), written: 0 })
    }

    pub(crate) fn finish(self) -> io::Result<()> {
        self.file.into_inner().map_err(io::IntoInnerError::into_error)?;
        Ok(())
    }
}

impl Write for FileSink {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let written = self.file.write(buf)?;
        self.written += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

impl Sink for FileSink {
    fn position(&self) -> Position {
        Position { disk: 0, offset: self.written }
    }

    fn keep_whole(&mut self, _length: u64) -> io::Result<()> {
        Ok(())
    }
}

/// A split set being written. Volumes are numbered `.z01` upward as they fill,
/// and the last one is renamed to `.zip` once the set is complete.
pub(crate) struct SplitSink {
    base: PathBuf,
    split_size: u64,
    volumes: Vec<PathBuf>,
    current: Option<BufWriter<File>>,
    /// Bytes in the current volume, which is volume `volumes.len() - 1`.
    in_volume: u64,
}

impl SplitSink {
    pub(crate) fn new(output_path: &Path, split_size: u64) -> Self {
        Self { base: split_volume_base(output_path), split_size, volumes: Vec::new(), current: None, in_volume: 0 }
    }

    fn next_volume(&mut self) -> io::Result<()> {
        if let Some(current) = self.current.take() {
            current.into_inner().map_err(io::IntoInnerError::into_error)?;
        }
        let disk = self.volumes.len() as u32;
        if disk >= MAX_SPLIT_VOLUMES {
            return Err(LiberaError::SplitTooManyVolumes {
                message: "The split size produces too many volumes.".into(),
            }
            .into());
        }
        let path = volume_path_for_disk(&self.base, disk);
        self.current = Some(BufWriter::new(File::create(&path)?));
        self.volumes.push(path);
        self.in_volume = 0;
        Ok(())
    }

    /// Every volume written so far, so a failed job can remove them.
    pub(crate) fn volumes(&self) -> &[PathBuf] {
        &self.volumes
    }

    /// Closes the last volume and renames it to `.zip`, as the format asks.
    pub(crate) fn finish(mut self) -> io::Result<Vec<PathBuf>> {
        if let Some(current) = self.current.take() {
            current.into_inner().map_err(io::IntoInnerError::into_error)?;
        }
        let last = self.volumes.last_mut().ok_or_else(|| io::Error::other("No split volume was written."))?;
        let mut terminal = self.base.clone().into_os_string();
        terminal.push(".zip");
        fs::rename(&*last, &terminal)?;
        *last = PathBuf::from(terminal);
        Ok(self.volumes)
    }
}

impl Write for SplitSink {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        if self.current.is_none() || self.in_volume >= self.split_size {
            self.next_volume()?;
        }
        let room = usize::try_from(self.split_size - self.in_volume).unwrap_or(usize::MAX);
        let written = self.current.as_mut().expect("a volume is open").write(&buf[..buf.len().min(room)])?;
        self.in_volume += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.current.as_mut().map_or(Ok(()), Write::flush)
    }
}

impl Sink for SplitSink {
    fn position(&self) -> Position {
        // A full volume is left behind at the next write, so the next byte
        // lands at the start of the volume after it.
        match self.volumes.len() {
            0 => Position { disk: 0, offset: 0 },
            count if self.in_volume >= self.split_size => Position { disk: count as u32, offset: 0 },
            count => Position { disk: count as u32 - 1, offset: self.in_volume },
        }
    }

    fn keep_whole(&mut self, length: u64) -> io::Result<()> {
        if self.current.is_some() && self.in_volume > 0 && self.in_volume + length > self.split_size {
            self.next_volume()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_volumes_after_the_terminal_zip() {
        assert_eq!(split_volume_base(Path::new("/x/Report.ZIP")), Path::new("/x/Report"));
        assert_eq!(volume_path_for_disk(Path::new("/x/report"), 0), Path::new("/x/report.z01"));
        assert_eq!(volume_path_for_disk(Path::new("/x/report"), 99), Path::new("/x/report.z100"));
        assert_eq!(terminal_volume_path(Path::new("/x/report.z07")), Path::new("/x/report.zip"));
        assert_eq!(terminal_volume_path(Path::new("/x/report.zip")), Path::new("/x/report.zip"));
        assert!(is_numbered_volume_path(Path::new("a.Z123")));
        assert!(!is_numbered_volume_path(Path::new("a.z1")));
        assert!(!is_numbered_volume_path(Path::new("a.zip")));
    }

    #[test]
    fn recognizes_only_the_volumes_of_its_own_set() {
        for name in ["report.zip", "report.z01", "report.Z123", "report.ZIP"] {
            assert!(is_split_volume_name("report", name), "{name}");
        }
        for name in ["report", "report.z1", "report.zipx", "reports.z01", "other.zip", "report.z0a"] {
            assert!(!is_split_volume_name("report", name), "{name}");
        }
    }

    #[test]
    fn reads_volumes_as_one_address_space() {
        let work = tempfile::TempDir::new().unwrap();
        let paths: Vec<PathBuf> = ["a", "b", "c"].iter().map(|name| work.path().join(name)).collect();
        fs::write(&paths[0], b"0123").unwrap();
        fs::write(&paths[1], b"").unwrap();
        fs::write(&paths[2], b"456789").unwrap();
        let mut set = VolumeSet::open(&paths).unwrap();

        let mut all = Vec::new();
        set.read_to_end(&mut all).unwrap();
        assert_eq!(all, b"0123456789");
        set.seek(SeekFrom::Start(3)).unwrap();
        let mut middle = [0; 3];
        set.read_exact(&mut middle).unwrap();
        assert_eq!(&middle, b"345");
        assert_eq!(set.absolute(2, 1), Some(5));
        assert_eq!(set.volume_sizes(), [4, 0, 6]);
    }

    #[test]
    fn fills_volumes_in_turn_and_keeps_a_record_whole() {
        let work = tempfile::TempDir::new().unwrap();
        let output = work.path().join("set.zip");
        let mut sink = SplitSink::new(&output, 10);
        sink.write_all(b"0123456").unwrap();
        assert_eq!(sink.position(), Position { disk: 0, offset: 7 });
        sink.keep_whole(5).unwrap();
        assert_eq!(sink.position(), Position { disk: 1, offset: 0 });
        sink.write_all(b"abcdefghijkl").unwrap();
        assert_eq!(sink.position(), Position { disk: 2, offset: 2 });
        let volumes = sink.finish().unwrap();

        let names: Vec<String> =
            volumes.iter().map(|volume| volume.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["set.z01", "set.z02", "set.zip"]);
        assert_eq!(fs::read(&volumes[0]).unwrap(), b"0123456");
        assert_eq!(fs::read(&volumes[1]).unwrap(), b"abcdefghij");
        assert_eq!(fs::read(&volumes[2]).unwrap(), b"kl");
    }
}
