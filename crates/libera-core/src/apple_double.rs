//! AppleDouble `._name` sidecars: the form macOS archivers use to carry a
//! file's extended attributes and resource fork through formats that have no
//! place for them. Left as plain files they clutter a folder and break a
//! `.app` bundle's sealed signature, so on macOS they are folded back onto
//! the file they describe instead of being written out.

const MAGIC: u32 = 0x0005_1607;
const VERSION: u32 = 0x0002_0000;
const HEADER_LENGTH: usize = 26;
const DESCRIPTOR_LENGTH: usize = 12;
const ENTRY_RESOURCE_FORK: u32 = 2;
const ENTRY_FINDER_INFO: u32 = 9;
const FINDER_INFO_LENGTH: usize = 32;
/// The extended attributes macOS stores after the Finder info block.
const ATTRIBUTE_MAGIC: u32 = 0x4154_5452;
const ATTRIBUTE_HEADER_LENGTH: usize = 36;
const ATTRIBUTE_ENTRY_HEADER_LENGTH: usize = 11;

pub(crate) const PREFIX: &str = "._";
/// Sidecars are metadata; anything larger is treated as an ordinary file.
pub(crate) const MAX_SIDECAR_BYTES: u64 = 8 << 20;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct Metadata {
    pub finder_info: Option<Vec<u8>>,
    pub resource_fork: Option<Vec<u8>>,
    pub attributes: Vec<(String, Vec<u8>)>,
}

/// The path a sidecar describes, or `None` when the name is not a sidecar's.
pub(crate) fn subject_path(entry_path: &str) -> Option<String> {
    let normalized = entry_path.replace('\\', "/");
    let (directory, base) = match normalized.rfind('/') {
        Some(index) => normalized.split_at(index + 1),
        None => ("", normalized.as_str()),
    };
    let subject = base.strip_prefix(PREFIX).filter(|subject| !subject.is_empty())?;
    Some(format!("{directory}{subject}"))
}

fn u16_at(bytes: &[u8], offset: usize) -> Option<u16> {
    bytes.get(offset..offset + 2).map(|field| u16::from_be_bytes([field[0], field[1]]))
}

fn u32_at(bytes: &[u8], offset: usize) -> Option<u32> {
    bytes.get(offset..offset + 4).map(|field| u32::from_be_bytes(field.try_into().unwrap()))
}

/// macOS pads the Finder info block to a 4 byte boundary before the attribute
/// header, so the header does not reliably start right after it.
fn find_attribute_section(bytes: &[u8], search_start: usize) -> Option<usize> {
    (search_start..=search_start + 3).find(|&offset| u32_at(bytes, offset) == Some(ATTRIBUTE_MAGIC))
}

fn read_attributes(bytes: &[u8], search_start: usize) -> Vec<(String, Vec<u8>)> {
    let Some(start) = find_attribute_section(bytes, search_start) else { return Vec::new() };
    if start + ATTRIBUTE_HEADER_LENGTH > bytes.len() {
        return Vec::new();
    }
    let count = u16_at(bytes, start + 34).unwrap_or(0);
    let mut attributes = Vec::new();
    let mut cursor = start + ATTRIBUTE_HEADER_LENGTH;
    for _ in 0..count {
        let (Some(value_offset), Some(value_length), Some(&name_length)) =
            (u32_at(bytes, cursor), u32_at(bytes, cursor + 4), bytes.get(cursor + 10))
        else {
            break;
        };
        let name_start = cursor + ATTRIBUTE_ENTRY_HEADER_LENGTH;
        let name_length = usize::from(name_length);
        if name_length == 0 || name_start + name_length > bytes.len() {
            break;
        }
        // The recorded length counts the terminating NUL byte.
        let name = String::from_utf8_lossy(&bytes[name_start..name_start + name_length - 1]).into_owned();
        let (value_offset, value_length) = (value_offset as usize, value_length as usize);
        let printable = !name.is_empty() && name.len() <= 127 && name.bytes().all(|byte| (0x21..=0x7e).contains(&byte));
        if value_length > 0 && value_offset + value_length <= bytes.len() && printable {
            attributes.push((name, bytes[value_offset..value_offset + value_length].to_vec()));
        }
        // Each entry is padded so the next one starts on a 4 byte boundary.
        cursor = (name_start + name_length).next_multiple_of(4);
    }
    attributes
}

/// A sidecar's contents, or `None` when the bytes are not AppleDouble at all -
/// the entry is then an ordinary file. A well formed sidecar that carries
/// nothing still parses, so it is dropped rather than written out.
pub(crate) fn parse(bytes: &[u8]) -> Option<Metadata> {
    if bytes.len() < HEADER_LENGTH || u32_at(bytes, 0)? != MAGIC || u32_at(bytes, 4)? != VERSION {
        return None;
    }
    let count = usize::from(u16_at(bytes, 24)?);
    if HEADER_LENGTH + count * DESCRIPTOR_LENGTH > bytes.len() {
        return None;
    }
    let mut metadata = Metadata::default();
    for index in 0..count {
        let descriptor = HEADER_LENGTH + index * DESCRIPTOR_LENGTH;
        let id = u32_at(bytes, descriptor)?;
        let offset = u32_at(bytes, descriptor + 4)? as usize;
        let length = u32_at(bytes, descriptor + 8)? as usize;
        if length == 0 || offset + length > bytes.len() {
            continue;
        }
        if id == ENTRY_RESOURCE_FORK {
            metadata.resource_fork = Some(bytes[offset..offset + length].to_vec());
            continue;
        }
        if id != ENTRY_FINDER_INFO || length < FINDER_INFO_LENGTH {
            continue;
        }
        let finder_info = &bytes[offset..offset + FINDER_INFO_LENGTH];
        // An all zero Finder info block carries nothing worth restoring.
        if finder_info.iter().any(|&byte| byte != 0) {
            metadata.finder_info = Some(finder_info.to_vec());
        }
        if length > FINDER_INFO_LENGTH {
            metadata.attributes = read_attributes(bytes, offset + FINDER_INFO_LENGTH);
        }
    }
    Some(metadata)
}

/// Folds a parsed sidecar onto the file it describes. Metadata is best
/// effort: a rejected attribute must not fail an extraction whose contents
/// are already right, which is also how `ditto` treats them.
#[cfg(target_os = "macos")]
pub(crate) fn apply(path: &std::path::Path, metadata: &Metadata) {
    if let Some(fork) = &metadata.resource_fork {
        // macOS exposes the resource fork as a path of its own.
        let _ = std::fs::write(path.join("..namedfork/rsrc"), fork);
    }
    if let Some(finder_info) = &metadata.finder_info {
        let _ = xattr::set(path, "com.apple.FinderInfo", finder_info);
    }
    for (name, value) in &metadata.attributes {
        let _ = xattr::set(path, name, value);
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn apply(_path: &std::path::Path, _metadata: &Metadata) {}

/// Only macOS has anywhere to put what a sidecar carries; elsewhere sidecars
/// stay ordinary files, which is what every other unzip tool does.
pub(crate) const MERGES_SIDECARS: bool = cfg!(target_os = "macos");

#[cfg(test)]
mod tests {
    use super::*;

    /// A sidecar as macOS writes one: Finder info, two bytes of padding, the
    /// attribute section with at most one attribute, then a resource fork.
    fn sidecar(finder_info: [u8; 32], attribute: Option<(&str, &[u8])>, fork: Option<&[u8]>) -> Vec<u8> {
        let fork = fork.unwrap_or_default();
        let finder_offset = HEADER_LENGTH + 2 * DESCRIPTOR_LENGTH;
        let mut section = Vec::new();
        if let Some((name, value)) = attribute {
            let section_start = finder_offset + FINDER_INFO_LENGTH + 2;
            let entry_length = (ATTRIBUTE_ENTRY_HEADER_LENGTH + name.len() + 1).next_multiple_of(4);
            let value_offset = section_start + ATTRIBUTE_HEADER_LENGTH + entry_length;
            section.extend(ATTRIBUTE_MAGIC.to_be_bytes());
            section.extend([0; 30]);
            section.extend(1u16.to_be_bytes());
            section.extend((value_offset as u32).to_be_bytes());
            section.extend((value.len() as u32).to_be_bytes());
            section.extend([0, 0]);
            section.push((name.len() + 1) as u8);
            section.extend(name.as_bytes());
            section.push(0);
            section.resize(ATTRIBUTE_HEADER_LENGTH + entry_length, 0);
            section.extend(value);
        }
        let finder_length = FINDER_INFO_LENGTH + if section.is_empty() { 0 } else { 2 + section.len() };
        let fork_offset = finder_offset + finder_length;

        let mut bytes = Vec::new();
        bytes.extend(MAGIC.to_be_bytes());
        bytes.extend(VERSION.to_be_bytes());
        bytes.extend([0; 16]);
        bytes.extend(2u16.to_be_bytes());
        for (id, offset, length) in
            [(ENTRY_FINDER_INFO, finder_offset, finder_length), (ENTRY_RESOURCE_FORK, fork_offset, fork.len())]
        {
            bytes.extend(id.to_be_bytes());
            bytes.extend((offset as u32).to_be_bytes());
            bytes.extend((length as u32).to_be_bytes());
        }
        bytes.extend(finder_info);
        if !section.is_empty() {
            bytes.extend([0, 0]);
            bytes.extend(section);
        }
        bytes.extend(fork);
        bytes
    }

    #[test]
    fn names_the_file_a_sidecar_describes() {
        assert_eq!(subject_path("dir/._photo.jpg").as_deref(), Some("dir/photo.jpg"));
        assert_eq!(subject_path("._top").as_deref(), Some("top"));
        assert_eq!(subject_path("dir\\._x").as_deref(), Some("dir/x"));
        for path in ["._", "dir/photo.jpg", "dir/_.x", "dir._x/y"] {
            assert_eq!(subject_path(path), None, "{path}");
        }
    }

    #[test]
    fn reads_attributes_written_after_the_padded_finder_info_block() {
        let bytes = sidecar([0; 32], Some(("com.apple.quarantine", b"0083;abc")), None);
        let metadata = parse(&bytes).unwrap();
        assert_eq!(metadata.attributes, [("com.apple.quarantine".to_owned(), b"0083;abc".to_vec())]);
        assert_eq!(metadata.finder_info, None);
    }

    #[test]
    fn reads_the_resource_fork_and_a_non_empty_finder_info_block() {
        let mut finder_info = [0; 32];
        finder_info[..8].copy_from_slice(b"TEXTttxt");
        let metadata = parse(&sidecar(finder_info, None, Some(b"fork bytes"))).unwrap();
        assert_eq!(metadata.finder_info.as_deref(), Some(&finder_info[..]));
        assert_eq!(metadata.resource_fork.as_deref(), Some(&b"fork bytes"[..]));
    }

    #[test]
    fn rejects_bytes_that_are_not_appledouble_so_they_stay_ordinary_files() {
        assert_eq!(parse(b"just some file contents that are long enough"), None);
        assert_eq!(parse(&[0; 10]), None);
    }

    #[test]
    fn ignores_an_attribute_whose_value_runs_past_the_end_of_the_sidecar() {
        let mut bytes = sidecar([0; 32], Some(("user.note", b"value")), None);
        bytes.truncate(bytes.len() - 3);
        assert!(parse(&bytes).unwrap().attributes.is_empty());
    }
}
