use crate::inputs::base::{CommittedInputBatch, InputRuntime};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DoubaoWorkBudgetOptions {
    pub bytes: u64,
    pub milliseconds: u64,
    pub records: u64,
}
impl Default for DoubaoWorkBudgetOptions {
    fn default() -> Self {
        Self {
            bytes: 8 * 1024 * 1024,
            milliseconds: 50,
            records: 4096,
        }
    }
}
#[derive(Debug, thiserror::Error)]
pub enum DoubaoWorkError {
    #[error("{0}")]
    Deferred(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
pub type Result<T> = std::result::Result<T, DoubaoWorkError>;
impl DoubaoWorkError {
    pub fn deferred(reason: impl Into<String>) -> Self {
        Self::Deferred(reason.into())
    }
    pub fn invalid(reason: impl Into<String>) -> Self {
        Self::Invalid(reason.into())
    }
    pub fn reason(&self) -> Option<&str> {
        if let Self::Deferred(reason) = self {
            Some(reason)
        } else {
            None
        }
    }
    pub fn as_io(&self) -> Option<&std::io::Error> {
        if let Self::Io(error) = self {
            Some(error)
        } else {
            None
        }
    }
    pub fn missing(&self) -> bool {
        self.as_io()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    }
}
pub struct DoubaoWorkBudget<'a> {
    runtime: Option<&'a InputRuntime>,
    deadline: Option<Instant>,
    processed: u64,
    since_yield: u64,
    remaining_bytes: u64,
    record_limit: u64,
    #[cfg(test)]
    expire_after_read: Option<usize>,
}
impl<'a> DoubaoWorkBudget<'a> {
    pub fn new(limits: DoubaoWorkBudgetOptions, runtime: Option<&'a InputRuntime>) -> Self {
        Self {
            runtime,
            deadline: Instant::now().checked_add(Duration::from_millis(limits.milliseconds)),
            processed: 0,
            since_yield: 0,
            remaining_bytes: limits.bytes,
            record_limit: limits.records,
            #[cfg(test)]
            expire_after_read: None,
        }
    }
    #[cfg(test)]
    pub(super) fn expire_after_read(&mut self, length: usize) {
        self.expire_after_read = Some(length);
    }
    pub fn exhausted(&self) -> bool {
        self.remaining_bytes == 0
            || self.processed >= self.record_limit
            || self
                .deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
    }
    pub fn remaining_bytes(&self) -> u64 {
        self.remaining_bytes
    }
    pub fn record(&mut self, count: u64, work: u64) {
        self.processed = self.processed.saturating_add(count);
        self.since_yield = self.since_yield.saturating_add(work);
    }
    pub fn parsed(&mut self, bytes: u64) {
        self.record(1, 1);
        if let Some(runtime) = self.runtime {
            runtime.with_accumulator(|a| {
                a.observe_committed_batch(CommittedInputBatch {
                    bytes,
                    records: 1,
                    parse_success_records: 1,
                    parse_failed_records: 0,
                    max_record_bytes: bytes,
                })
            });
        }
    }
    pub async fn yield_if_needed(&mut self) {
        if self.since_yield >= 256 {
            self.since_yield = 0;
            tokio::task::yield_now().await;
        }
    }
    pub async fn read(
        &mut self,
        file: &mut tokio::fs::File,
        buffer: &mut [u8],
        length: usize,
        position: u64,
        finishing: bool,
    ) -> Result<usize> {
        if self.exhausted() && !(finishing && length <= 64 && self.remaining_bytes >= length as u64)
        {
            return Err(DoubaoWorkError::deferred("cycle_budget"));
        }
        let requested = length.min(usize::try_from(self.remaining_bytes).unwrap_or(usize::MAX));
        if requested > buffer.len() {
            return Err(DoubaoWorkError::invalid(
                "Doubao read buffer is shorter than requested range",
            ));
        }
        let started = Instant::now();
        file.seek(std::io::SeekFrom::Start(position)).await?;
        let mut bytes = 0;
        while bytes < requested {
            let count = file.read(&mut buffer[bytes..requested]).await?;
            if count == 0 {
                break;
            }
            bytes += count;
        }
        self.remaining_bytes -= bytes as u64;
        #[cfg(test)]
        if self.expire_after_read == Some(requested) {
            self.deadline = Some(Instant::now());
            self.expire_after_read = None;
        }
        if let Some(runtime) = self.runtime {
            runtime.with_accumulator(|a| {
                a.observe_read(
                    bytes as u64,
                    requested as u64,
                    started.elapsed().as_secs_f64() * 1000.0,
                )
            });
        }
        Ok(bytes)
    }
}
