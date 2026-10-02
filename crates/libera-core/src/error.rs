use std::io;

/// Why a job ended without a result. The variants mirror the Electron
/// engine's error codes - `COMPRESSION_CANCELLED`, `DESTINATION_EXISTS` and so
/// on - so a UI maps them onto the messages it already has.
///
/// The five that describe an archive the safety checks refused carry the same
/// `Unsafe archive:` prefix the Electron engine puts on them.
#[derive(Debug, thiserror::Error)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Error))]
pub enum LiberaError {
    #[error("Compression cancelled")]
    CompressionCancelled,
    #[error("Extraction cancelled")]
    ExtractionCancelled,
    #[error("{message}")]
    InsufficientDiskSpace { message: String },
    #[error("{message}")]
    DestinationFileTooLarge { message: String },
    #[error("Unsafe archive: {message}")]
    TooManyEntries { message: String },
    #[error("Unsafe archive: {message}")]
    ArchiveTooLarge { message: String },
    #[error("Unsafe archive: {message}")]
    FileTooLarge { message: String },
    #[error("Unsafe archive: {message}")]
    DestinationExists { message: String },
    #[error("Unsafe archive: {message}")]
    UnsafeArchive { message: String },
    /// The archive path names no format this engine reads.
    #[error("{message}")]
    UnsupportedArchive { message: String },
    #[error("{message}")]
    ArchiveMissing { message: String },
    /// GZ and ZST wrap exactly one file, and were handed a folder or nothing.
    #[error("{message}")]
    InvalidSingleFileInput { message: String },
    /// Options that contradict each other or fall outside what a codec takes.
    #[error("{message}")]
    InvalidInput { message: String },
    /// Bytes that do not decode as the format they claim to be.
    #[error("{message}")]
    CorruptArchive { message: String },
    #[error("{message}")]
    Io { message: String },
}

impl LiberaError {
    pub(crate) fn invalid_input(message: impl Into<String>) -> Self {
        Self::InvalidInput { message: message.into() }
    }

    pub(crate) fn unsafe_archive(message: impl Into<String>) -> Self {
        Self::UnsafeArchive { message: message.into() }
    }
}

impl From<io::Error> for LiberaError {
    fn from(error: io::Error) -> Self {
        // A job wraps its own errors in io::Error to pass them through a codec
        // stream; those come back out here as themselves.
        if error.get_ref().is_some_and(|inner| inner.is::<LiberaError>()) {
            return *error.into_inner().unwrap().downcast::<LiberaError>().unwrap();
        }
        match error.raw_os_error() {
            Some(code) if is_out_of_space(code) => {
                Self::InsufficientDiskSpace { message: "Not enough disk space to finish the job".into() }
            }
            Some(code) if is_file_too_large(code) => Self::DestinationFileTooLarge {
                message: "The destination filesystem cannot store a file this large".into(),
            },
            _ => match error.kind() {
                io::ErrorKind::InvalidData | io::ErrorKind::UnexpectedEof => {
                    Self::CorruptArchive { message: error.to_string() }
                }
                _ => Self::Io { message: error.to_string() },
            },
        }
    }
}

impl From<LiberaError> for io::Error {
    fn from(error: LiberaError) -> Self {
        io::Error::other(error)
    }
}

// ENOSPC and EDQUOT, and EFBIG, by number: the values are the same on every
// Unix this builds for, and std exposes no names for them.
#[cfg(unix)]
fn is_out_of_space(code: i32) -> bool {
    code == 28 || code == if cfg!(target_os = "linux") { 122 } else { 69 }
}

#[cfg(unix)]
fn is_file_too_large(code: i32) -> bool {
    code == 27
}

#[cfg(windows)]
fn is_out_of_space(code: i32) -> bool {
    // ERROR_HANDLE_DISK_FULL and ERROR_DISK_FULL.
    code == 39 || code == 112
}

#[cfg(windows)]
fn is_file_too_large(code: i32) -> bool {
    // ERROR_FILE_TOO_LARGE.
    code == 223
}
