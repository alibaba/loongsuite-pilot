//! Host, pipeline, and alarm metrics.
//!
//! JSONL file names and on-the-wire metric names match `src/metrics/*.ts`.
//! Alarm and running-status delivery goes through [`crate::internal`], which
//! stays a no-op unless the `proprietary` feature is enabled.

mod alarm_manager;
mod disk_usage_sampler;
mod hook_metrics_spool;
mod metrics_collector;
mod metrics_writer;
mod runtime_health;
mod trace_runtime;

pub use alarm_manager::{AlarmContext, AlarmEntry, AlarmManager};
pub use disk_usage_sampler::{
    backoff_multiplier, DiskUsageSampler, DiskUsageSamplerOptions, DiskUsageSnapshot,
    DiskUsageStatus, DISK_USAGE_STALE_MS,
};
pub use hook_metrics_spool::{record_hook_timing, HookMetricsSpool, HookTimingStats};
pub use metrics_collector::{
    AgentFlowMetrics, DataflowSnapshot, FlusherEndpointStats, FlusherFlowMetrics, HookFlowMetrics,
    InfraHealthSnapshot, InputFlowMetrics, InputSnapshot, L1Metrics, L2Metrics, MetricJson,
    MetricsCollector, MetricsCollectorOptions,
};
pub use metrics_writer::{MetricsWriter, MetricsWriterOptions};
pub use runtime_health::RuntimeProbe;
pub use trace_runtime::{TraceRuntimeCounters, TraceRuntimeSnapshot};
