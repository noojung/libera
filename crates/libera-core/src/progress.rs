use std::cell::RefCell;
use std::io::{self, Read};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum ProgressPhase {
    Processing,
    Complete,
}

/// One progress report, shaped like the Electron engine's `ProgressData`.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ProgressData {
    pub processed_bytes: u64,
    /// Unknown for a lone codec stream, which records no expanded size.
    pub total_bytes: Option<u64>,
    pub percent: Option<u8>,
    pub phase: ProgressPhase,
    pub current_file: Option<String>,
}

/// Receives a job's progress, on the thread the job runs on.
#[cfg_attr(feature = "uniffi", uniffi::export(with_foreign))]
pub trait ProgressListener: Send + Sync {
    fn on_progress(&self, progress: ProgressData);
}

/// Asks a running job to stop. The job notices at its next read, removes what
/// it has written, and fails with the cancelled error for its kind.
#[derive(Debug, Default)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct CancelToken {
    cancelled: AtomicBool,
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl CancelToken {
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }
}

impl CancelToken {
    /// The error a cancelled read fails with. It only has to stop the read;
    /// each job turns it into its own cancelled error on the way out.
    pub(crate) fn check(&self) -> io::Result<()> {
        if self.is_cancelled() { Err(io::Error::other("cancelled")) } else { Ok(()) }
    }
}

/// The shortest gap between two `Processing` reports, so a fast job does not
/// cross into the UI once per buffer.
const REPORT_INTERVAL: Duration = Duration::from_millis(50);

struct ReporterState {
    processed: u64,
    current_file: Option<String>,
    last_sent: Option<Instant>,
}

/// Turns byte counts into throttled reports for one job.
pub(crate) struct Reporter {
    listener: Arc<dyn ProgressListener>,
    total: Option<u64>,
    state: RefCell<ReporterState>,
}

impl Reporter {
    pub(crate) fn new(listener: Arc<dyn ProgressListener>, total: Option<u64>) -> Self {
        Self {
            listener,
            total,
            state: RefCell::new(ReporterState { processed: 0, current_file: None, last_sent: None }),
        }
    }

    pub(crate) fn processed(&self) -> u64 {
        self.state.borrow().processed
    }

    pub(crate) fn set_current_file(&self, name: impl Into<String>) {
        self.state.borrow_mut().current_file = Some(name.into());
    }

    pub(crate) fn advance(&self, bytes: u64) {
        let mut state = self.state.borrow_mut();
        state.processed += bytes;
        if state.last_sent.is_none_or(|sent| sent.elapsed() >= REPORT_INTERVAL) {
            state.last_sent = Some(Instant::now());
            let progress = ProgressData {
                processed_bytes: state.processed,
                total_bytes: self.total,
                percent: self.total.map(|total| running_percent(state.processed, total)),
                phase: ProgressPhase::Processing,
                current_file: state.current_file.clone(),
            };
            drop(state);
            self.listener.on_progress(progress);
        }
    }

    /// The closing report, which lands on 100 whatever the count reached.
    pub(crate) fn complete(&self) {
        let processed = self.processed();
        self.listener.on_progress(ProgressData {
            processed_bytes: processed,
            total_bytes: Some(self.total.unwrap_or(processed)),
            percent: Some(100),
            phase: ProgressPhase::Complete,
            current_file: None,
        });
    }
}

/// A running percentage stops at 99: only the closing report says 100, so a
/// job that reaches its total and then fails never showed itself finished.
fn running_percent(processed: u64, total: u64) -> u8 {
    if total == 0 {
        return 100;
    }
    let rounded = (u128::from(processed) * 100 + u128::from(total) / 2) / u128::from(total);
    rounded.min(99) as u8
}

/// A reader that counts what passes through it into a [`Reporter`], and fails
/// its next read once the job is cancelled.
pub(crate) struct Tracked<'a, R> {
    inner: R,
    reporter: &'a Reporter,
    cancel: &'a CancelToken,
}

impl<'a, R> Tracked<'a, R> {
    pub(crate) fn new(inner: R, reporter: &'a Reporter, cancel: &'a CancelToken) -> Self {
        Self { inner, reporter, cancel }
    }
}

impl<R: Read> Read for Tracked<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.cancel.check()?;
        let read = self.inner.read(buf)?;
        self.reporter.advance(read as u64);
        Ok(read)
    }
}

/// A reader that only watches for cancellation, for reads whose bytes are
/// metered somewhere else - an archive read before it expands, say.
pub(crate) struct Cancellable<'a, R> {
    inner: R,
    cancel: &'a CancelToken,
}

impl<'a, R> Cancellable<'a, R> {
    pub(crate) fn new(inner: R, cancel: &'a CancelToken) -> Self {
        Self { inner, cancel }
    }
}

impl<R: Read> Read for Cancellable<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.cancel.check()?;
        self.inner.read(buf)
    }
}
