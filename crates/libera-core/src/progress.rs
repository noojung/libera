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

    pub(crate) fn set_current_file(&self, name: impl Into<String>) {
        self.state.borrow_mut().current_file = Some(name.into());
    }

    fn advance(&self, bytes: u64) {
        let mut state = self.state.borrow_mut();
        state.processed += bytes;
        if state.last_sent.is_none_or(|sent| sent.elapsed() >= REPORT_INTERVAL) {
            state.last_sent = Some(Instant::now());
            let progress = ProgressData {
                processed_bytes: state.processed,
                total_bytes: self.total,
                percent: self.total.map(|total| percent(state.processed, total)),
                phase: ProgressPhase::Processing,
                current_file: state.current_file.clone(),
            };
            drop(state);
            self.listener.on_progress(progress);
        }
    }

    /// The closing report, which lands on 100 whatever the count reached.
    pub(crate) fn complete(&self) {
        let processed = self.total.unwrap_or(self.state.borrow().processed);
        self.listener.on_progress(ProgressData {
            processed_bytes: processed,
            total_bytes: self.total,
            percent: Some(100),
            phase: ProgressPhase::Complete,
            current_file: None,
        });
    }
}

fn percent(processed: u64, total: u64) -> u8 {
    if total == 0 {
        return 0;
    }
    let rounded = (u128::from(processed) * 100 + u128::from(total) / 2) / u128::from(total);
    rounded.min(100) as u8
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
        if self.cancel.is_cancelled() {
            return Err(io::Error::other("cancelled"));
        }
        let read = self.inner.read(buf)?;
        self.reporter.advance(read as u64);
        Ok(read)
    }
}
