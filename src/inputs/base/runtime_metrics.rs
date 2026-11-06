//! Port of `src/inputs/base/input-runtime-metrics.ts`.

use std::time::Instant;

pub const PRIMARY_INPUT_SOURCE_KIND: &str = "primary";

#[derive(Debug, Clone, PartialEq)]
pub struct InputRuntimeDelta {
    pub source_kind: &'static str,
    pub raw_read_calls: u64,
    pub raw_read_bytes: u64,
    pub raw_in_records: u64,
    pub raw_in_bytes: u64,
    pub raw_in_max_batch_bytes: u64,
    pub raw_in_max_record_bytes: u64,
    pub raw_backlog_bytes_max: u64,
    pub parse_success_records: u64,
    pub parse_failed_records: u64,
    pub read_duration_ms: f64,
    pub process_duration_ms: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct CommittedInputBatch {
    pub bytes: u64,
    pub records: u64,
    pub parse_success_records: u64,
    pub parse_failed_records: u64,
    pub max_record_bytes: u64,
}

fn finite_non_negative(value: f64) -> f64 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

fn finite_count_u64(value: u64) -> u64 {
    value
}

/// Scalar observations for native collectors.
///
/// Byte and record counts come from integer read lengths, unlike the former
/// JavaScript Number API. Invalid floating counts are rejected by the compiler;
/// elapsed durations remain floating point and are normalized at runtime.
///
/// ```compile_fail,E0308
/// use loongsuite_pilot::inputs::base::InputRuntimeAccumulator;
/// let mut observations = InputRuntimeAccumulator::new();
/// observations.observe_read(f64::NAN, f64::INFINITY, -1.0);
/// ```
///
/// ```compile_fail,E0308,E0600
/// use loongsuite_pilot::inputs::base::{InputRuntimeAccumulator, CommittedInputBatch};
/// let mut observations = InputRuntimeAccumulator::new();
/// observations.observe_committed_batch(CommittedInputBatch {
///     bytes: -1,
///     records: f64::NAN,
///     parse_success_records: -2,
///     parse_failed_records: f64::INFINITY,
///     max_record_bytes: -3,
/// });
/// ```
///
/// ```compile_fail,E0308
/// use loongsuite_pilot::inputs::base::InputRuntimeAccumulator;
/// let mut observations = InputRuntimeAccumulator::new();
/// observations.observe_backlog(f64::NAN);
/// ```
///
/// ```
/// use loongsuite_pilot::inputs::base::{InputRuntimeAccumulator, CommittedInputBatch, InputRuntimeDelta};
/// let mut observations = InputRuntimeAccumulator::new();
/// observations.observe_read(0, 0, -1.0);
/// observations.observe_committed_batch(CommittedInputBatch {
///     bytes: 0, records: 0, parse_success_records: 0,
///     parse_failed_records: 0, max_record_bytes: 0,
/// });
/// observations.observe_backlog(0);
/// assert_eq!(observations.finish(-1.0), InputRuntimeDelta {
///     source_kind: "primary", raw_read_calls: 1, raw_read_bytes: 0,
///     raw_in_records: 0, raw_in_bytes: 0, raw_in_max_batch_bytes: 0,
///     raw_in_max_record_bytes: 0, raw_backlog_bytes_max: 0,
///     parse_success_records: 0, parse_failed_records: 0,
///     read_duration_ms: 0.0, process_duration_ms: 0.0,
/// });
/// ```
#[derive(Debug)]
pub struct InputRuntimeAccumulator {
    raw_read_calls: u64,
    raw_read_bytes: u64,
    raw_in_records: u64,
    raw_in_bytes: u64,
    raw_in_max_batch_bytes: u64,
    raw_in_max_record_bytes: u64,
    raw_backlog_bytes_max: u64,
    parse_success_records: u64,
    parse_failed_records: u64,
    read_duration_ms: f64,
}

impl InputRuntimeAccumulator {
    pub fn new() -> Self {
        Self {
            raw_read_calls: 0,
            raw_read_bytes: 0,
            raw_in_records: 0,
            raw_in_bytes: 0,
            raw_in_max_batch_bytes: 0,
            raw_in_max_record_bytes: 0,
            raw_backlog_bytes_max: 0,
            parse_success_records: 0,
            parse_failed_records: 0,
            read_duration_ms: 0.0,
        }
    }

    pub fn now() -> f64 {
        monotonic_millis()
    }

    pub fn observe_read(&mut self, bytes_read: u64, requested_bytes: u64, duration_ms: f64) {
        self.raw_read_calls += 1;
        self.raw_read_bytes += finite_count_u64(bytes_read);
        self.raw_in_max_batch_bytes = self
            .raw_in_max_batch_bytes
            .max(finite_count_u64(requested_bytes));
        self.read_duration_ms += finite_non_negative(duration_ms);
    }

    pub fn observe_committed_batch(&mut self, batch: CommittedInputBatch) {
        self.raw_in_bytes += finite_count_u64(batch.bytes);
        self.raw_in_records += finite_count_u64(batch.records);
        self.parse_success_records += finite_count_u64(batch.parse_success_records);
        self.parse_failed_records += finite_count_u64(batch.parse_failed_records);
        self.raw_in_max_record_bytes = self
            .raw_in_max_record_bytes
            .max(finite_count_u64(batch.max_record_bytes));
    }

    pub fn observe_backlog(&mut self, bytes: u64) {
        self.raw_backlog_bytes_max = self.raw_backlog_bytes_max.max(finite_count_u64(bytes));
    }

    pub fn finish(&self, collect_duration_ms: f64) -> InputRuntimeDelta {
        let process_duration_ms =
            (finite_non_negative(collect_duration_ms) - self.read_duration_ms).max(0.0);
        InputRuntimeDelta {
            source_kind: PRIMARY_INPUT_SOURCE_KIND,
            raw_read_calls: self.raw_read_calls,
            raw_read_bytes: self.raw_read_bytes,
            raw_in_records: self.raw_in_records,
            raw_in_bytes: self.raw_in_bytes,
            raw_in_max_batch_bytes: self.raw_in_max_batch_bytes,
            raw_in_max_record_bytes: self.raw_in_max_record_bytes,
            raw_backlog_bytes_max: self.raw_backlog_bytes_max,
            parse_success_records: self.parse_success_records,
            parse_failed_records: self.parse_failed_records,
            read_duration_ms: self.read_duration_ms,
            process_duration_ms,
        }
    }
}

impl Default for InputRuntimeAccumulator {
    fn default() -> Self {
        Self::new()
    }
}

fn monotonic_millis() -> f64 {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}
