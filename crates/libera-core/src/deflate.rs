//! A Deflate encoder with every knob zlib has. flate2 exposes the level and
//! nothing else, while expert mode also picks the strategy and the memory
//! level, so this drives zlib-rs - the same implementation flate2 runs on -
//! through its zlib API.

use std::io::{self, Write};
use std::mem::{MaybeUninit, size_of};

use libz_rs_sys::{
    Z_BUF_ERROR, Z_FINISH, Z_NO_FLUSH, Z_OK, Z_STREAM_END, deflate, deflateEnd, deflateInit2_, z_stream, zlibVersion,
};

/// How zlib searches for matches, under the names its own constants carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum DeflateStrategy {
    #[default]
    Default,
    Filtered,
    HuffmanOnly,
    Rle,
    Fixed,
}

impl DeflateStrategy {
    fn zlib_value(self) -> i32 {
        match self {
            Self::Default => 0,
            Self::Filtered => 1,
            Self::HuffmanOnly => 2,
            Self::Rle => 3,
            Self::Fixed => 4,
        }
    }
}

/// The frame around the Deflate data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeflateFrame {
    /// A gzip member, header and trailer included.
    Gzip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DeflateTuning {
    pub level: u8,
    pub strategy: DeflateStrategy,
    /// 1 to 9; zlib's default is 8.
    pub mem_level: u8,
}

impl DeflateTuning {
    pub(crate) fn new(level: u8, strategy: Option<DeflateStrategy>, mem_level: Option<u8>) -> Self {
        Self { level, strategy: strategy.unwrap_or_default(), mem_level: mem_level.unwrap_or(8) }
    }
}

const OUTPUT_CHUNK: usize = 64 * 1024;

pub(crate) struct DeflateWriter<W: Write> {
    // zlib keeps a pointer back to the stream, so it lives on the heap where
    // moving the writer cannot move it.
    stream: Box<z_stream>,
    inner: Option<W>,
    output: Vec<u8>,
}

impl<W: Write> DeflateWriter<W> {
    pub(crate) fn new(inner: W, frame: DeflateFrame, tuning: DeflateTuning) -> io::Result<Self> {
        let window_bits = match frame {
            DeflateFrame::Gzip => 31,
        };
        let mut stream: Box<MaybeUninit<z_stream>> = Box::new(MaybeUninit::zeroed());
        // SAFETY: a zeroed z_stream leaves the allocator fields null, which
        // tells zlib to use its own, and the version and size are its own.
        let status = unsafe {
            deflateInit2_(
                stream.as_mut_ptr(),
                i32::from(tuning.level),
                8,
                window_bits,
                i32::from(tuning.mem_level),
                tuning.strategy.zlib_value(),
                zlibVersion(),
                size_of::<z_stream>() as i32,
            )
        };
        if status != Z_OK {
            return Err(io::Error::other(format!("Deflate rejected its settings ({status})")));
        }
        // SAFETY: deflateInit2_ returned Z_OK, so every field is initialized.
        let stream = unsafe { Box::from_raw(Box::into_raw(stream).cast::<z_stream>()) };
        Ok(Self { stream, inner: Some(inner), output: vec![0; OUTPUT_CHUNK] })
    }

    /// Runs zlib over `input` and writes what it produces, until it has taken
    /// all of the input, or until it reports the end when finishing.
    fn run(&mut self, input: &[u8], flush: i32) -> io::Result<()> {
        self.stream.next_in = input.as_ptr().cast_mut();
        self.stream.avail_in = input.len() as u32;
        loop {
            self.stream.next_out = self.output.as_mut_ptr();
            self.stream.avail_out = self.output.len() as u32;
            // SAFETY: the stream was initialized in `new`, and both buffers
            // outlive this call.
            let status = unsafe { deflate(&mut *self.stream, flush) };
            let produced = self.output.len() - self.stream.avail_out as usize;
            if produced > 0 {
                self.inner.as_mut().expect("used after finish").write_all(&self.output[..produced])?;
            }
            match status {
                Z_STREAM_END => return Ok(()),
                // Room left over means zlib took all the input it was given;
                // a full buffer, or finishing, means it has more to say.
                // Z_BUF_ERROR only says there was nothing to do this round.
                Z_OK | Z_BUF_ERROR if flush == Z_NO_FLUSH && self.stream.avail_out > 0 => return Ok(()),
                Z_OK | Z_BUF_ERROR => {}
                status => return Err(io::Error::other(format!("Deflate failed ({status})"))),
            }
        }
    }

    pub(crate) fn finish(mut self) -> io::Result<W> {
        self.run(&[], Z_FINISH)?;
        let mut inner = self.inner.take().expect("finished twice");
        inner.flush()?;
        Ok(inner)
    }
}

impl<W: Write> Write for DeflateWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // zlib counts its input in 32 bits.
        let taken = buf.len().min(u32::MAX as usize);
        self.run(&buf[..taken], Z_NO_FLUSH)?;
        Ok(taken)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.as_mut().map_or(Ok(()), Write::flush)
    }
}

impl<W: Write> Drop for DeflateWriter<W> {
    fn drop(&mut self) {
        // SAFETY: the stream was initialized in `new` and is ended only here.
        unsafe { deflateEnd(&mut *self.stream) };
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use flate2::read::GzDecoder;

    use super::*;

    fn sample() -> Vec<u8> {
        (0..200_000u32).flat_map(|value| (value % 251).to_le_bytes()).collect()
    }

    #[test]
    fn writes_gzip_any_reader_takes_back_under_every_strategy() {
        for strategy in [
            DeflateStrategy::Default,
            DeflateStrategy::Filtered,
            DeflateStrategy::HuffmanOnly,
            DeflateStrategy::Rle,
            DeflateStrategy::Fixed,
        ] {
            let mut writer =
                DeflateWriter::new(Vec::new(), DeflateFrame::Gzip, DeflateTuning::new(6, Some(strategy), Some(3)))
                    .unwrap();
            for chunk in sample().chunks(7_919) {
                writer.write_all(chunk).unwrap();
            }
            let compressed = writer.finish().unwrap();
            let mut decoded = Vec::new();
            GzDecoder::new(compressed.as_slice()).read_to_end(&mut decoded).unwrap();
            assert_eq!(decoded, sample(), "{strategy:?}");
        }
    }

    #[test]
    fn stores_at_level_zero() {
        let mut writer = DeflateWriter::new(Vec::new(), DeflateFrame::Gzip, DeflateTuning::new(0, None, None)).unwrap();
        writer.write_all(&sample()).unwrap();
        let compressed = writer.finish().unwrap();
        assert!(compressed.len() >= sample().len());
        let mut decoded = Vec::new();
        GzDecoder::new(compressed.as_slice()).read_to_end(&mut decoded).unwrap();
        assert_eq!(decoded, sample());
    }

    #[test]
    fn refuses_a_memory_level_zlib_would_not_take() {
        assert!(DeflateWriter::new(Vec::new(), DeflateFrame::Gzip, DeflateTuning::new(6, None, Some(10))).is_err());
    }
}
