//! The 7z format: read through sevenz-rust2, written here. Its writer takes
//! one compression level for everything and cannot tune LZMA2's search
//! depth, while expert mode sets the method, dictionary, word size and search
//! cycles per file; the container itself is small enough to write directly.

pub(crate) mod plan;
pub(crate) mod read;
pub(crate) mod volumes;
pub(crate) mod write;

pub use plan::{MAX_DICTIONARY_SIZE, MIN_DICTIONARY_SIZE, SevenZipDictionary, SevenZipMethod, SevenZipMethodOverride};
pub use volumes::MAX_SEVEN_ZIP_VOLUMES;
