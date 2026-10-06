//! The codecs that wrap a single stream of bytes rather than carrying entries
//! of their own. Each one shows up twice - around a tarball, and on its own
//! as `name.ext` - so their readers and writers live here.

use std::io::{self, BufReader, Read, Write};

use flate2::read::MultiGzDecoder;

use crate::LiberaError;
use crate::deflate::{DeflateFrame, DeflateStrategy, DeflateTuning, DeflateWriter};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum StreamCodec {
    Gzip,
    Xz,
    Bzip2,
    Zstd,
}

impl StreamCodec {
    /// The codec whose signature `header` starts with, for a tarball whose
    /// suffix says nothing or says something else.
    pub(crate) fn sniff(header: &[u8]) -> Option<Self> {
        if header.starts_with(&[0x1f, 0x8b]) {
            Some(Self::Gzip)
        } else if header.starts_with(&[0xfd, b'7', b'z', b'X', b'Z', 0x00]) {
            Some(Self::Xz)
        } else if header.starts_with(b"BZh") {
            Some(Self::Bzip2)
        } else if header.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]) {
            Some(Self::Zstd)
        } else {
            None
        }
    }
}

/// Decodes one stream of `codec` as it is read. Each decoder carries on into
/// a stream concatenated after the first, as every reference tool does, and
/// fails on a stream cut short instead of handing back what decoded before it.
///
/// bzip2 gives no way to find where a block ends without decoding it, but its
/// decoder works through the input a block at a time all the same, so the
/// expansion - where a bzip2 bomb does its damage - reaches the caller's meter
/// as it lands.
pub(crate) fn decoder<'a, R: Read + 'a>(codec: StreamCodec, reader: R) -> io::Result<Box<dyn Read + 'a>> {
    Ok(match codec {
        StreamCodec::Gzip => Box::new(MultiGzDecoder::new(reader)),
        StreamCodec::Xz => Box::new(lzma_rust2::XzReader::new(BufReader::new(reader), true)),
        StreamCodec::Bzip2 => Box::new(bzip2::read::MultiBzDecoder::new(reader)),
        StreamCodec::Zstd => Box::new(zstd::stream::read::Decoder::new(reader)?),
    })
}

/// The search strategies Zstandard offers, weakest and fastest first, under
/// the codec's own names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum ZstdStrategy {
    Fast,
    Dfast,
    Greedy,
    Lazy,
    Lazy2,
    Btlazy2,
    Btopt,
    Btultra,
    Btultra2,
}

impl ZstdStrategy {
    fn codec_value(self) -> zstd::zstd_safe::Strategy {
        use zstd::zstd_safe::Strategy;
        match self {
            Self::Fast => Strategy::ZSTD_fast,
            Self::Dfast => Strategy::ZSTD_dfast,
            Self::Greedy => Strategy::ZSTD_greedy,
            Self::Lazy => Strategy::ZSTD_lazy,
            Self::Lazy2 => Strategy::ZSTD_lazy2,
            Self::Btlazy2 => Strategy::ZSTD_btlazy2,
            Self::Btopt => Strategy::ZSTD_btopt,
            Self::Btultra => Strategy::ZSTD_btultra,
            Self::Btultra2 => Strategy::ZSTD_btultra2,
        }
    }
}

/// The reach of the match window, as bytes rather than the log the codec
/// takes. The ceiling is what a reader will accept rather than what the
/// encoder can do: a decoder allocates the whole window up front and refuses
/// a frame asking for more than its own limit, which is 128 MiB by default
/// everywhere.
pub const ZSTD_MIN_WINDOW_SIZE: u32 = 1 << 20;
pub const ZSTD_MAX_WINDOW_SIZE: u32 = 128 << 20;
/// Threads the encoder may hand work to; zero keeps it on the calling thread.
pub const ZSTD_MAX_WORKERS: u8 = 16;

/// What expert mode can say about a Zstandard stream beyond its level.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ZstdTuning {
    pub strategy: Option<ZstdStrategy>,
    pub window_size: Option<u32>,
    /// Finds repeats further apart than the window reaches, cheaply, by
    /// indexing the input coarsely alongside the ordinary match search.
    pub long_distance_matching: bool,
    pub workers: u8,
}

impl ZstdTuning {
    pub(crate) fn validate(&self) -> Result<(), LiberaError> {
        if self.workers > ZSTD_MAX_WORKERS {
            return Err(LiberaError::invalid_input(format!(
                "Zstandard worker count must be between 0 and {ZSTD_MAX_WORKERS}."
            )));
        }
        if let Some(window_size) = self.window_size
            && (!window_size.is_power_of_two() || !(ZSTD_MIN_WINDOW_SIZE..=ZSTD_MAX_WINDOW_SIZE).contains(&window_size))
        {
            return Err(LiberaError::invalid_input(format!(
                "Zstandard window size must be a power of two between {ZSTD_MIN_WINDOW_SIZE} and {ZSTD_MAX_WINDOW_SIZE} bytes."
            )));
        }
        Ok(())
    }
}

/// Maps the archive levels 0-9 onto Zstandard's 1-19, so a level means the
/// same strength here as it does anywhere else in the app: 6, the default,
/// lands on 13.
pub(crate) fn zstd_level(level: u8) -> i32 {
    let rounded = (i32::from(level) * 19 * 2 + 9) / 18;
    rounded.clamp(1, 19)
}

/// A writer for one of the codecs this engine encodes, finished explicitly so
/// the trailer is written and any error in writing it is seen.
pub(crate) enum Encoder<W: Write> {
    Gzip(DeflateWriter<W>),
    Zstd(zstd::stream::write::Encoder<'static, W>),
    Plain(W),
}

impl<W: Write> Encoder<W> {
    pub(crate) fn gzip(
        inner: W,
        level: u8,
        strategy: Option<DeflateStrategy>,
        mem_level: Option<u8>,
    ) -> io::Result<Self> {
        Ok(Self::Gzip(DeflateWriter::new(inner, DeflateFrame::Gzip, DeflateTuning::new(level, strategy, mem_level))?))
    }

    pub(crate) fn zstd(inner: W, level: u8, tuning: ZstdTuning) -> io::Result<Self> {
        use zstd::stream::raw::CParameter;
        // The level goes in first and the rest after, because each one set
        // here replaces what the level implied.
        let mut encoder = zstd::stream::write::Encoder::new(inner, zstd_level(level))?;
        if let Some(strategy) = tuning.strategy {
            encoder.set_parameter(CParameter::Strategy(strategy.codec_value()))?;
        }
        if let Some(window_size) = tuning.window_size {
            encoder.set_parameter(CParameter::WindowLog(window_size.trailing_zeros()))?;
        }
        if tuning.long_distance_matching {
            encoder.set_parameter(CParameter::EnableLongDistanceMatching(true))?;
        }
        if tuning.workers > 0 {
            encoder.multithread(u32::from(tuning.workers))?;
        }
        Ok(Self::Zstd(encoder))
    }

    pub(crate) fn finish(self) -> io::Result<W> {
        match self {
            Self::Gzip(writer) => writer.finish(),
            Self::Zstd(writer) => writer.finish(),
            Self::Plain(mut writer) => {
                writer.flush()?;
                Ok(writer)
            }
        }
    }
}

impl<W: Write> Write for Encoder<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Self::Gzip(writer) => writer.write(buf),
            Self::Zstd(writer) => writer.write(buf),
            Self::Plain(writer) => writer.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::Gzip(writer) => writer.flush(),
            Self::Zstd(writer) => writer.flush(),
            Self::Plain(writer) => writer.flush(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turns_the_level_slider_into_the_zstandard_scale() {
        let mapped: Vec<i32> = (0..=9).map(zstd_level).collect();
        assert_eq!(mapped, [1, 2, 4, 6, 8, 11, 13, 15, 17, 19]);
    }

    #[test]
    fn knows_each_codec_by_its_signature() {
        assert_eq!(StreamCodec::sniff(&[0x1f, 0x8b, 8]), Some(StreamCodec::Gzip));
        assert_eq!(StreamCodec::sniff(b"\xfd7zXZ\x00\x00"), Some(StreamCodec::Xz));
        assert_eq!(StreamCodec::sniff(b"BZh9"), Some(StreamCodec::Bzip2));
        assert_eq!(StreamCodec::sniff(&[0x28, 0xb5, 0x2f, 0xfd]), Some(StreamCodec::Zstd));
        assert_eq!(StreamCodec::sniff(b"ustar"), None);
    }

    #[test]
    fn refuses_a_window_or_thread_count_the_codec_would_not_take() {
        for tuning in [
            ZstdTuning { workers: 17, ..ZstdTuning::default() },
            ZstdTuning { window_size: Some(3 << 20), ..ZstdTuning::default() },
            ZstdTuning { window_size: Some(1 << 19), ..ZstdTuning::default() },
            ZstdTuning { window_size: Some(256 << 20), ..ZstdTuning::default() },
        ] {
            assert!(tuning.validate().is_err(), "{tuning:?}");
        }
        assert!(ZstdTuning { window_size: Some(1 << 27), workers: 16, ..ZstdTuning::default() }.validate().is_ok());
    }
}
