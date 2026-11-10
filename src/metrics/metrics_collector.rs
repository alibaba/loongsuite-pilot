//! L1 host metrics and L2 agent / input / flusher rows.
//!
//! Reported flow values are per-window deltas. L1 and L2 keep separate baselines.
//! Metric names match the TypeScript collector.

use crate::metrics::runtime_health::{check_runtime, read_init_type, RuntimeProbe};
use crate::types::{AgentsConfig, SlsEndpoint};
use crate::utils::{
    check_process_liveness, format_time, resolve_local_ip, ProcessLivenessProbe,
    UPDATER_PROCESS_PATTERNS,
};
use base64::Engine;
use indexmap::IndexMap;
use serde::Serialize;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq)]
pub struct InputSnapshot {
    pub source_kind: String,
    pub raw_read_calls: i64,
    pub raw_read_bytes: i64,
    pub raw_in_records: i64,
    pub raw_in_bytes: i64,
    pub raw_in_max_batch_bytes: i64,
    pub raw_in_max_record_bytes: i64,
    pub raw_backlog_bytes_max: i64,
    pub parse_success_records: i64,
    pub parse_failed_records: i64,
    pub read_duration_ms: f64,
    pub process_duration_ms: f64,
    pub in_events: i64,
    pub in_bytes: i64,
    pub out_failed: i64,
    pub last_poll_time: String,
    pub start_time: String,
    pub collection_method: String,
    pub agent: String,
    pub running: bool,
}

impl Default for InputSnapshot {
    fn default() -> Self {
        Self {
            source_kind: "primary".to_string(),
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
            process_duration_ms: 0.0,
            in_events: 0,
            in_bytes: 0,
            out_failed: 0,
            last_poll_time: String::new(),
            start_time: String::new(),
            collection_method: "polling".to_string(),
            agent: String::new(),
            running: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FlusherEndpointStats {
    pub kind: String,
    pub project: String,
    pub logstore: String,
    pub mode: String,
    pub bytes_basis: String,
    pub in_entries: i64,
    pub in_bytes: i64,
    pub out_entries: i64,
    pub out_bytes: i64,
    pub out_failed: i64,
    pub total_delay_ms: i64,
    pub last_flush_time: String,
    pub start_time: String,
}

impl Default for FlusherEndpointStats {
    fn default() -> Self {
        Self {
            kind: "sls".to_string(),
            project: String::new(),
            logstore: String::new(),
            mode: String::new(),
            bytes_basis: "measured".to_string(),
            in_entries: 0,
            in_bytes: 0,
            out_entries: 0,
            out_bytes: 0,
            out_failed: 0,
            total_delay_ms: 0,
            last_flush_time: String::new(),
            start_time: String::new(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct DataflowSnapshot {
    pub in_events_total: i64,
    pub in_bytes_total: i64,
    pub inputs: IndexMap<String, InputSnapshot>,
    pub flushers: IndexMap<String, FlusherEndpointStats>,
    pub input_idle_minutes: IndexMap<String, i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MetricJson {
    pub agent_count: String,
    pub active_agent_count: String,
    pub open_fd: String,
    pub window_ms: String,
    pub in_events: String,
    pub in_bytes: String,
    pub out_events: String,
    pub out_bytes: String,
    pub in_events_ps: String,
    pub in_bytes_ps: String,
    pub out_events_ps: String,
    pub out_bytes_ps: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_dir_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_dir_scan_ms: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_data_bytes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_logs_bytes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_dir_sampled_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_available: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mem_available: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mem_heap_available: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_resource_metrics_basis: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct L1Metrics {
    pub version: String,
    pub os_detail: String,
    pub hostname: String,
    pub ip: String,
    pub instance_id: String,
    pub run_id: String,
    pub user_id: String,
    pub pid: u64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub cpu: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub mem: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub mem_heap: String,
    pub start_time: String,
    pub capture_message_disabled_agents: String,
    pub projects: String,
    pub cms_workspace: String,
    pub metric_json: MetricJson,
    pub init_type: String,
    pub rollback_available: String,
    pub canary_policy: String,
    pub version_count: String,
    pub updater_pid_alive: String,
    /// 兼容旧指标字段；原生运行时不再检查 Node，固定为 not-applicable。
    pub node_bin_valid: String,
    pub runtime_bin_valid: String,
    pub current_version_valid: String,
    #[serde(rename = "__time__")]
    pub time: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct L2Identity {
    pub hostname: String,
    pub ip: String,
    pub instance_id: String,
    pub run_id: String,
    pub user_id: String,
    pub window_ms: String,
    #[serde(rename = "__time__")]
    pub time: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentFlowMetrics {
    #[serde(rename = "type")]
    pub row_type: String,
    #[serde(flatten)]
    pub identity: L2Identity,
    pub agent: String,
    pub in_events: String,
    pub in_bytes: String,
    pub failed_events: String,
    pub idle_minutes: String,
    pub last_poll_time: String,
    pub start_time: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct InputFlowMetrics {
    #[serde(rename = "type")]
    pub row_type: String,
    #[serde(flatten)]
    pub identity: L2Identity,
    pub agent: String,
    pub input_name: String,
    pub source_kind: String,
    pub collection_method: String,
    pub raw_read_calls: String,
    pub raw_read_bytes: String,
    pub raw_in_records: String,
    pub raw_in_bytes: String,
    pub raw_in_max_batch_bytes: String,
    pub raw_in_max_record_bytes: String,
    pub raw_backlog_bytes_max: String,
    pub parse_success_records: String,
    pub parse_failed_records: String,
    pub read_duration_ms: String,
    pub process_duration_ms: String,
    pub in_events: String,
    pub in_bytes: String,
    pub failed_events: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FlusherFlowMetrics {
    #[serde(rename = "type")]
    pub row_type: String,
    #[serde(flatten)]
    pub identity: L2Identity,
    pub flusher: String,
    pub project: String,
    pub logstore: String,
    pub mode: String,
    pub bytes_basis: String,
    pub in_entries: String,
    pub in_bytes: String,
    pub out_entries: String,
    pub out_bytes: String,
    pub failed_entries: String,
    pub total_delay_ms: String,
    pub last_flush_time: String,
    pub start_time: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HookFlowMetrics {
    #[serde(rename = "type")]
    pub row_type: String,
    #[serde(flatten)]
    pub identity: L2Identity,
    pub agent: String,
    pub hook_event: String,
    pub calls: String,
    pub total_duration_ms: String,
    pub max_duration_ms: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct L2Metrics {
    pub agents: Vec<AgentFlowMetrics>,
    pub inputs: Vec<InputFlowMetrics>,
    pub flushers: Vec<FlusherFlowMetrics>,
    pub hooks: Vec<HookFlowMetrics>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InfraHealthSnapshot {
    pub updater_pid_alive: bool,
    pub current_version_valid: bool,
    pub runtime_bin_valid: bool,
    pub runtime_diagnostic: Option<String>,
    pub rollback_available: bool,
    pub version_count: u64,
    pub canary_policy: String,
    pub updater_consecutive_failures: u32,
}

#[derive(Clone)]
struct InstanceFlow {
    in_events: i64,
    in_bytes: i64,
    out_events: i64,
    out_bytes: i64,
}

#[derive(Clone, Default)]
struct FlowTotals {
    in_events: i64,
    in_bytes: i64,
    out_failed: i64,
}

#[derive(Clone, Default)]
struct InputRuntimeTotals {
    flow: FlowTotals,
    raw_read_calls: i64,
    raw_read_bytes: i64,
    raw_in_records: i64,
    raw_in_bytes: i64,
    parse_success_records: i64,
    parse_failed_records: i64,
    read_duration_ms: f64,
    process_duration_ms: f64,
}

#[derive(Clone, Default)]
struct FlusherTotals {
    in_entries: i64,
    in_bytes: i64,
    out_entries: i64,
    out_bytes: i64,
    out_failed: i64,
    total_delay_ms: i64,
}

pub struct MetricsCollector {
    version: String,
    user_id: String,
    data_dir: String,
    canary_policy: String,
    sls_endpoints: Vec<SlsEndpoint>,
    cms_workspace: String,
    auto_update_enabled: bool,
    updater_liveness: ProcessLivenessProbe,
    now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    cpu_usage: Arc<dyn Fn() -> (i64, i64) + Send + Sync>,
    runtime_probe: RuntimeProbe,
    #[allow(dead_code)]
    agents_config: AgentsConfig,
    start_time: String,
    start_timestamp: i64,
    instance_id: String,
    run_id: String,
    local_ip: String,
    init_type: String,
    last_cpu: Option<(i64, i64)>,
    last_cpu_time: i64,
    first_cpu_sample: bool,
    last_collect_time: i64,
    l1_baseline: InstanceFlow,
    l2_input_baseline: IndexMap<String, FlowTotals>,
    l2_input_detail_baseline: IndexMap<String, InputRuntimeTotals>,
    l2_flusher_baseline: IndexMap<String, FlusherTotals>,
    l2_last_collect_time: i64,
    l1_cycle_count: u32,
    updater_consecutive_failures: u32,
    last_infra_health: Option<InfraHealthSnapshot>,
    #[cfg(not(target_os = "linux"))]
    process: super::self_process::SelfProcess,
    #[cfg(not(target_os = "linux"))]
    custom_cpu: bool,
}

pub struct MetricsCollectorOptions {
    pub version: String,
    pub user_id: String,
    pub data_dir: String,
    pub canary_policy: String,
    pub sls_endpoints: Vec<SlsEndpoint>,
    pub cms_workspace: String,
    pub auto_update_enabled: bool,
    pub updater_liveness: Option<ProcessLivenessProbe>,
    pub now_ms: Option<Arc<dyn Fn() -> i64 + Send + Sync>>,
    pub cpu_usage: Option<Arc<dyn Fn() -> (i64, i64) + Send + Sync>>,
    pub runtime_probe: Option<RuntimeProbe>,
    pub agents_config: AgentsConfig,
}

impl MetricsCollectorOptions {
    pub fn new(
        version: impl Into<String>,
        user_id: impl Into<String>,
        data_dir: impl Into<String>,
    ) -> Self {
        Self {
            version: version.into(),
            user_id: user_id.into(),
            data_dir: data_dir.into(),
            canary_policy: String::new(),
            sls_endpoints: Vec::new(),
            cms_workspace: String::new(),
            auto_update_enabled: true,
            updater_liveness: None,
            now_ms: None,
            cpu_usage: None,
            runtime_probe: None,
            agents_config: AgentsConfig::new(),
        }
    }
}

impl MetricsCollector {
    pub fn new(
        version: impl Into<String>,
        user_id: impl Into<String>,
        data_dir: impl Into<String>,
    ) -> Self {
        Self::from_options(MetricsCollectorOptions::new(version, user_id, data_dir))
    }

    pub fn from_options(opts: MetricsCollectorOptions) -> Self {
        let now_ms = opts.now_ms.unwrap_or_else(|| Arc::new(current_time_millis));
        let now = now_ms();
        let start_timestamp = now / 1000;
        let hostname = host_name();
        let encoded =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(opts.data_dir.as_bytes());
        let instance_id = format!("{hostname}_{}_{encoded}", opts.user_id);
        let run_id = format!("{instance_id}_{start_timestamp}");
        let init_type = read_init_type(&opts.data_dir);
        Self {
            version: opts.version,
            user_id: opts.user_id,
            data_dir: opts.data_dir,
            canary_policy: opts.canary_policy,
            sls_endpoints: opts.sls_endpoints,
            cms_workspace: opts.cms_workspace,
            auto_update_enabled: opts.auto_update_enabled,
            updater_liveness: opts.updater_liveness.unwrap_or_else(|| {
                Arc::new(|pid_file| check_process_liveness(pid_file, UPDATER_PROCESS_PATTERNS))
            }),
            #[cfg(not(target_os = "linux"))]
            process: super::self_process::SelfProcess::new(),
            #[cfg(not(target_os = "linux"))]
            custom_cpu: opts.cpu_usage.is_some(),
            cpu_usage: opts.cpu_usage.unwrap_or_else(|| Arc::new(read_proc_cpu)),
            runtime_probe: opts.runtime_probe.unwrap_or_else(RuntimeProbe::system),
            agents_config: opts.agents_config,
            now_ms,
            start_time: format_time(chrono::Local::now()),
            start_timestamp,
            instance_id,
            run_id,
            local_ip: resolve_local_ip(),
            init_type,
            last_cpu: None,
            last_cpu_time: 0,
            first_cpu_sample: true,
            last_collect_time: 0,
            l1_baseline: InstanceFlow {
                in_events: 0,
                in_bytes: 0,
                out_events: 0,
                out_bytes: 0,
            },
            l2_input_baseline: IndexMap::new(),
            l2_input_detail_baseline: IndexMap::new(),
            l2_flusher_baseline: IndexMap::new(),
            l2_last_collect_time: 0,
            l1_cycle_count: 0,
            updater_consecutive_failures: 0,
            last_infra_health: None,
        }
    }

    pub fn user_id(&self) -> &str {
        &self.user_id
    }

    pub fn data_dir(&self) -> &str {
        &self.data_dir
    }

    pub fn collect_l1(&mut self, snapshot: &DataflowSnapshot) -> L1Metrics {
        let now = (self.now_ms)();
        #[cfg(target_os = "linux")]
        let (cpu, (mem, heap)) = (self.calc_cpu_percent(now), read_mem_mb());
        #[cfg(not(target_os = "linux"))]
        let (cpu, mem, heap) = (
            if self.custom_cpu {
                self.calc_cpu_percent(now)
            } else {
                0.0
            },
            0,
            0,
        );
        let egress = sum_flusher_egress(snapshot);
        let cumulative = InstanceFlow {
            in_events: snapshot.in_events_total,
            in_bytes: snapshot.in_bytes_total,
            out_events: egress.0,
            out_bytes: egress.1,
        };
        let flow = InstanceFlow {
            in_events: delta(cumulative.in_events, self.l1_baseline.in_events),
            in_bytes: delta(cumulative.in_bytes, self.l1_baseline.in_bytes),
            out_events: delta(cumulative.out_events, self.l1_baseline.out_events),
            out_bytes: delta(cumulative.out_bytes, self.l1_baseline.out_bytes),
        };
        self.l1_baseline = cumulative;
        let has_prior = self.last_collect_time != 0;
        let window_ms = (now
            - if self.last_collect_time == 0 {
                self.start_timestamp * 1000
            } else {
                self.last_collect_time
            })
        .max(0);
        let elapsed_sec = (window_ms as f64 / 1000.0).max(0.001);
        self.last_collect_time = now;
        let rate = |value: i64| -> String {
            if has_prior {
                format!("{:.1}", value as f64 / elapsed_sec)
            } else {
                "0.0".to_string()
            }
        };
        let agents = count_agents(snapshot);
        let health = self.collect_infra_health();
        let row = L1Metrics {
            version: self.version.clone(),
            os_detail: os_detail(),
            hostname: host_name(),
            ip: self.local_ip.clone(),
            instance_id: self.instance_id.clone(),
            run_id: self.run_id.clone(),
            user_id: self.user_id.clone(),
            pid: u64::from(std::process::id()),
            cpu: js_number(cpu),
            mem: mem.to_string(),
            mem_heap: heap.to_string(),
            start_time: self.start_time.clone(),
            capture_message_disabled_agents: String::new(),
            projects: self.build_projects(),
            cms_workspace: self.cms_workspace.clone(),
            metric_json: MetricJson {
                agent_count: agents.0.to_string(),
                active_agent_count: agents.1.to_string(),
                open_fd: open_fd_count().to_string(),
                window_ms: window_ms.to_string(),
                in_events: flow.in_events.to_string(),
                in_bytes: flow.in_bytes.to_string(),
                out_events: flow.out_events.to_string(),
                out_bytes: flow.out_bytes.to_string(),
                in_events_ps: rate(flow.in_events),
                in_bytes_ps: rate(flow.in_bytes),
                out_events_ps: rate(flow.out_events),
                out_bytes_ps: rate(flow.out_bytes),
                disk_dir_status: None,
                disk_dir_scan_ms: None,
                disk_data_bytes: None,
                disk_logs_bytes: None,
                disk_dir_sampled_at: None,
                cpu_available: None,
                mem_available: None,
                mem_heap_available: None,
                process_resource_metrics_basis: None,
            },
            init_type: self.init_type.clone(),
            rollback_available: health.rollback_available.to_string(),
            canary_policy: health.canary_policy.clone(),
            version_count: health.version_count.to_string(),
            updater_pid_alive: health.updater_pid_alive.to_string(),
            node_bin_valid: "not-applicable".into(),
            runtime_bin_valid: health.runtime_bin_valid.to_string(),
            current_version_valid: health.current_version_valid.to_string(),
            time: now / 1000,
        };
        #[cfg(not(target_os = "linux"))]
        let row = {
            let mut row = row;
            self.process.apply(&mut row, self.custom_cpu);
            row
        };
        row
    }

    pub fn collect_l2(&mut self, snapshot: &DataflowSnapshot) -> Option<L2Metrics> {
        self.collect_l2_with_hook_timings(snapshot, &[])
    }

    pub fn collect_l2_with_hook_timings(
        &mut self,
        snapshot: &DataflowSnapshot,
        timings: &[super::HookTimingStats],
    ) -> Option<L2Metrics> {
        let now = (self.now_ms)();
        let window_ms = (now
            - if self.l2_last_collect_time == 0 {
                self.start_timestamp * 1000
            } else {
                self.l2_last_collect_time
            })
        .max(0);
        let identity = L2Identity {
            hostname: host_name(),
            ip: self.local_ip.clone(),
            instance_id: self.instance_id.clone(),
            run_id: self.run_id.clone(),
            user_id: self.user_id.clone(),
            window_ms: window_ms.to_string(),
            time: now / 1000,
        };
        let agents = self.collect_agent_rows(snapshot, &identity);
        let inputs = self.collect_input_rows(snapshot, &identity);
        let flushers = self.collect_flusher_rows(snapshot, &identity);
        let hooks: Vec<_> = timings
            .iter()
            .filter(|row| row.calls > 0)
            .map(|row| HookFlowMetrics {
                row_type: "hook".into(),
                identity: identity.clone(),
                agent: row.agent.clone(),
                hook_event: row.hook_event.clone(),
                calls: row.calls.to_string(),
                total_duration_ms: js_round(row.total_duration_ms).to_string(),
                max_duration_ms: js_round(row.max_duration_ms).to_string(),
            })
            .collect();
        self.l2_last_collect_time = now;
        if agents.is_empty() && inputs.is_empty() && flushers.is_empty() && hooks.is_empty() {
            None
        } else {
            Some(L2Metrics {
                agents,
                inputs,
                flushers,
                hooks,
            })
        }
    }

    pub fn last_infra_health(&self) -> Option<&InfraHealthSnapshot> {
        self.last_infra_health.as_ref()
    }

    fn collect_input_rows(
        &mut self,
        snapshot: &DataflowSnapshot,
        identity: &L2Identity,
    ) -> Vec<InputFlowMetrics> {
        let mut rows = Vec::new();
        for (input_id, stats) in &snapshot.inputs {
            let base = self
                .l2_input_detail_baseline
                .get(input_id)
                .cloned()
                .unwrap_or_default();
            let flow = InputRuntimeTotals {
                flow: FlowTotals {
                    in_events: delta(stats.in_events, base.flow.in_events),
                    in_bytes: delta(stats.in_bytes, base.flow.in_bytes),
                    out_failed: delta(stats.out_failed, base.flow.out_failed),
                },
                raw_read_calls: delta(stats.raw_read_calls, base.raw_read_calls),
                raw_read_bytes: delta(stats.raw_read_bytes, base.raw_read_bytes),
                raw_in_records: delta(stats.raw_in_records, base.raw_in_records),
                raw_in_bytes: delta(stats.raw_in_bytes, base.raw_in_bytes),
                parse_success_records: delta(
                    stats.parse_success_records,
                    base.parse_success_records,
                ),
                parse_failed_records: delta(stats.parse_failed_records, base.parse_failed_records),
                read_duration_ms: delta_f(stats.read_duration_ms, base.read_duration_ms),
                process_duration_ms: delta_f(stats.process_duration_ms, base.process_duration_ms),
            };
            self.l2_input_detail_baseline.insert(
                input_id.clone(),
                InputRuntimeTotals {
                    flow: FlowTotals {
                        in_events: stats.in_events,
                        in_bytes: stats.in_bytes,
                        out_failed: stats.out_failed,
                    },
                    raw_read_calls: stats.raw_read_calls,
                    raw_read_bytes: stats.raw_read_bytes,
                    raw_in_records: stats.raw_in_records,
                    raw_in_bytes: stats.raw_in_bytes,
                    parse_success_records: stats.parse_success_records,
                    parse_failed_records: stats.parse_failed_records,
                    read_duration_ms: stats.read_duration_ms,
                    process_duration_ms: stats.process_duration_ms,
                },
            );
            let carried = flow.flow.in_events > 0
                || flow.flow.in_bytes > 0
                || flow.flow.out_failed > 0
                || flow.raw_read_calls > 0
                || flow.raw_read_bytes > 0
                || flow.raw_in_records > 0
                || flow.raw_in_bytes > 0
                || flow.parse_success_records > 0
                || flow.parse_failed_records > 0
                || flow.read_duration_ms > 0.0
                || flow.process_duration_ms > 0.0
                || stats.raw_in_max_batch_bytes > 0
                || stats.raw_in_max_record_bytes > 0
                || stats.raw_backlog_bytes_max > 0;
            if !stats.running && !carried {
                continue;
            }
            rows.push(InputFlowMetrics {
                row_type: "input".to_string(),
                identity: identity.clone(),
                agent: agent_key(input_id, stats),
                input_name: input_id.clone(),
                source_kind: stats.source_kind.clone(),
                collection_method: stats.collection_method.clone(),
                raw_read_calls: flow.raw_read_calls.to_string(),
                raw_read_bytes: flow.raw_read_bytes.to_string(),
                raw_in_records: flow.raw_in_records.to_string(),
                raw_in_bytes: flow.raw_in_bytes.to_string(),
                raw_in_max_batch_bytes: stats.raw_in_max_batch_bytes.to_string(),
                raw_in_max_record_bytes: stats.raw_in_max_record_bytes.to_string(),
                raw_backlog_bytes_max: stats.raw_backlog_bytes_max.to_string(),
                parse_success_records: flow.parse_success_records.to_string(),
                parse_failed_records: flow.parse_failed_records.to_string(),
                read_duration_ms: js_round(flow.read_duration_ms).to_string(),
                process_duration_ms: js_round(flow.process_duration_ms).to_string(),
                in_events: flow.flow.in_events.to_string(),
                in_bytes: flow.flow.in_bytes.to_string(),
                failed_events: flow.flow.out_failed.to_string(),
            });
        }
        rows
    }

    fn collect_agent_rows(
        &mut self,
        snapshot: &DataflowSnapshot,
        identity: &L2Identity,
    ) -> Vec<AgentFlowMetrics> {
        #[derive(Clone)]
        struct Acc {
            events: i64,
            bytes: i64,
            failed: i64,
            idle: i64,
            last_poll: String,
            start: String,
        }
        let mut by_agent: IndexMap<String, Acc> = IndexMap::new();
        for (input_id, stats) in &snapshot.inputs {
            let base = self
                .l2_input_baseline
                .get(input_id)
                .cloned()
                .unwrap_or_default();
            let events = delta(stats.in_events, base.in_events);
            let bytes = delta(stats.in_bytes, base.in_bytes);
            let failed = delta(stats.out_failed, base.out_failed);
            self.l2_input_baseline.insert(
                input_id.clone(),
                FlowTotals {
                    in_events: stats.in_events,
                    in_bytes: stats.in_bytes,
                    out_failed: stats.out_failed,
                },
            );
            if events == 0 && failed == 0 && !stats.running {
                continue;
            }
            let agent = agent_key(input_id, stats);
            let acc = by_agent.entry(agent).or_insert(Acc {
                events: 0,
                bytes: 0,
                failed: 0,
                idle: -1,
                last_poll: String::new(),
                start: String::new(),
            });
            acc.events += events;
            acc.bytes += bytes;
            acc.failed += failed;
            let idle = snapshot
                .input_idle_minutes
                .get(input_id)
                .copied()
                .unwrap_or(-1);
            if idle >= 0 && (acc.idle < 0 || idle < acc.idle) {
                acc.idle = idle;
            }
            if stats.last_poll_time > acc.last_poll {
                acc.last_poll = stats.last_poll_time.clone();
            }
            if acc.start.is_empty()
                || (!stats.start_time.is_empty() && stats.start_time < acc.start)
            {
                acc.start = stats.start_time.clone();
            }
        }
        by_agent
            .into_iter()
            .map(|(agent, acc)| AgentFlowMetrics {
                row_type: "agent".to_string(),
                identity: identity.clone(),
                agent,
                in_events: acc.events.to_string(),
                in_bytes: acc.bytes.to_string(),
                failed_events: acc.failed.to_string(),
                idle_minutes: acc.idle.to_string(),
                last_poll_time: acc.last_poll,
                start_time: acc.start,
            })
            .collect()
    }

    fn collect_flusher_rows(
        &mut self,
        snapshot: &DataflowSnapshot,
        identity: &L2Identity,
    ) -> Vec<FlusherFlowMetrics> {
        let mut rows = Vec::new();
        for (id, stats) in &snapshot.flushers {
            let base = self
                .l2_flusher_baseline
                .get(id)
                .cloned()
                .unwrap_or_default();
            rows.push(FlusherFlowMetrics {
                row_type: "flusher".to_string(),
                identity: identity.clone(),
                flusher: stats.kind.clone(),
                project: stats.project.clone(),
                logstore: stats.logstore.clone(),
                mode: stats.mode.clone(),
                bytes_basis: stats.bytes_basis.clone(),
                in_entries: delta(stats.in_entries, base.in_entries).to_string(),
                in_bytes: delta(stats.in_bytes, base.in_bytes).to_string(),
                out_entries: delta(stats.out_entries, base.out_entries).to_string(),
                out_bytes: delta(stats.out_bytes, base.out_bytes).to_string(),
                failed_entries: delta(stats.out_failed, base.out_failed).to_string(),
                total_delay_ms: delta(stats.total_delay_ms, base.total_delay_ms).to_string(),
                last_flush_time: stats.last_flush_time.clone(),
                start_time: stats.start_time.clone(),
            });
            self.l2_flusher_baseline.insert(
                id.clone(),
                FlusherTotals {
                    in_entries: stats.in_entries,
                    in_bytes: stats.in_bytes,
                    out_entries: stats.out_entries,
                    out_bytes: stats.out_bytes,
                    out_failed: stats.out_failed,
                    total_delay_ms: stats.total_delay_ms,
                },
            );
        }
        rows
    }

    fn build_projects(&self) -> String {
        let mut seen = std::collections::BTreeSet::new();
        for endpoint in &self.sls_endpoints {
            if !endpoint.project.is_empty() {
                seen.insert(endpoint.project.clone());
            }
        }
        seen.into_iter().collect::<Vec<_>>().join(" ")
    }

    fn collect_infra_health(&mut self) -> InfraHealthSnapshot {
        self.l1_cycle_count += 1;
        let mut updater_pid_alive = true;
        if self.auto_update_enabled && self.l1_cycle_count > 2 {
            let pid_file = std::path::Path::new(&self.data_dir)
                .join("loongsuite-pilot-updater.pid")
                .to_string_lossy()
                .to_string();
            updater_pid_alive = (self.updater_liveness)(&pid_file).running;
            if updater_pid_alive {
                self.updater_consecutive_failures = 0;
            } else {
                self.updater_consecutive_failures += 1;
            }
        }
        let runtime = check_runtime(std::path::Path::new(&self.data_dir), &self.runtime_probe);
        let health = InfraHealthSnapshot {
            updater_pid_alive,
            current_version_valid: runtime.current_version_valid,
            runtime_bin_valid: runtime.binary_valid,
            runtime_diagnostic: runtime.diagnostic,
            rollback_available: runtime.rollback_available,
            version_count: runtime.version_count,
            canary_policy: self.canary_policy.clone(),
            updater_consecutive_failures: self.updater_consecutive_failures,
        };
        self.last_infra_health = Some(health.clone());
        health
    }

    fn calc_cpu_percent(&mut self, now: i64) -> f64 {
        let usage = (self.cpu_usage)();
        if self.first_cpu_sample {
            self.first_cpu_sample = false;
            self.last_cpu = Some(usage);
            self.last_cpu_time = now;
            return 0.0;
        }
        let mut percent = 0.0;
        if let Some(last) = self.last_cpu {
            let elapsed = now - self.last_cpu_time;
            if elapsed > 0 {
                let user_delta = usage.0 - last.0;
                let system_delta = usage.1 - last.1;
                percent = ((user_delta + system_delta) as f64 / 1000.0 / elapsed as f64) * 100.0;
            }
        }
        self.last_cpu = Some(usage);
        self.last_cpu_time = now;
        (percent * 100.0).round() / 100.0
    }
}

fn sum_flusher_egress(snapshot: &DataflowSnapshot) -> (i64, i64) {
    let mut events = 0;
    let mut bytes = 0;
    for stats in snapshot.flushers.values() {
        events += stats.out_entries;
        bytes += stats.out_bytes;
    }
    (events, bytes)
}

fn delta(current: i64, baseline: i64) -> i64 {
    (current - baseline).max(0)
}

fn delta_f(current: f64, baseline: f64) -> f64 {
    (current - baseline).max(0.0)
}

fn js_round(value: f64) -> i64 {
    value.round() as i64
}

fn js_number(value: f64) -> String {
    if value.fract() == 0.0 && value.is_finite() {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

fn agent_key(input_id: &str, stats: &InputSnapshot) -> String {
    if stats.agent.is_empty() {
        input_id.to_string()
    } else {
        stats.agent.clone()
    }
}

fn count_agents(snapshot: &DataflowSnapshot) -> (usize, usize) {
    let mut installed = std::collections::BTreeSet::new();
    let mut active = std::collections::BTreeSet::new();
    for (input_id, stats) in &snapshot.inputs {
        if !stats.running {
            continue;
        }
        let agent = agent_key(input_id, stats);
        installed.insert(agent.clone());
        if snapshot
            .input_idle_minutes
            .get(input_id)
            .copied()
            .unwrap_or(-1)
            >= 0
        {
            active.insert(agent);
        }
    }
    (installed.len(), active.len())
}

fn current_time_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn host_name() -> String {
    hostname::get()
        .ok()
        .and_then(|value| value.into_string().ok())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "localhost".to_string())
}

fn os_detail() -> String {
    let kind = match std::env::consts::OS {
        "linux" => "Linux",
        "macos" => "Darwin",
        "windows" => "Windows_NT",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    };
    #[cfg(target_os = "linux")]
    let release = std::fs::read_to_string("/proc/sys/kernel/osrelease")
        .unwrap_or_else(|_| "unknown".to_string());
    #[cfg(not(target_os = "linux"))]
    let release = sysinfo::System::kernel_version().unwrap_or_else(|| "unknown".to_string());
    format!("{kind}; {}; {arch}", release.trim())
}

#[cfg(target_os = "linux")]
fn read_mem_mb() -> (i64, i64) {
    let text = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let rss = status_kb(&text, "VmRSS:") / 1024;
    let heap = status_kb(&text, "VmData:") / 1024;
    (rss.max(1), heap.max(0))
}

#[cfg(target_os = "linux")]
fn status_kb(text: &str, key: &str) -> i64 {
    text.lines()
        .find_map(|line| line.strip_prefix(key))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

fn open_fd_count() -> i64 {
    match std::fs::read_dir("/proc/self/fd") {
        Ok(entries) => entries.flatten().count() as i64,
        Err(_) => -1,
    }
}

fn read_proc_cpu() -> (i64, i64) {
    let text = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
    let Some(close) = text.rfind(')') else {
        return (0, 0);
    };
    let fields: Vec<_> = text[close + 2..].split_whitespace().collect();
    let utime = fields
        .get(11)
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let stime = fields
        .get(12)
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    (utime * 10_000, stime * 10_000)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{SlsEndpoint, SlsEndpointKind, SlsMode};
    use crate::utils::ProcessLiveness;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::Arc;

    fn input(agent: &str) -> InputSnapshot {
        InputSnapshot {
            agent: agent.to_string(),
            ..InputSnapshot::default()
        }
    }

    fn flusher(kind: &str) -> FlusherEndpointStats {
        FlusherEndpointStats {
            kind: kind.to_string(),
            bytes_basis: if kind == "sls" {
                "measured"
            } else {
                "estimated"
            }
            .to_string(),
            ..FlusherEndpointStats::default()
        }
    }

    fn collector(dir: &std::path::Path) -> MetricsCollector {
        MetricsCollector::new("1.0.0", "test-user", dir.to_string_lossy())
    }

    #[test]
    fn hook_rows_use_shared_identity_without_baseline_subtraction_or_empty_rows() {
        let dir = tempfile::tempdir().unwrap();
        let mut collector = collector(dir.path());
        let snapshot = DataflowSnapshot::default();
        assert!(collector.collect_l2(&snapshot).is_none());
        let timing = super::super::HookTimingStats {
            agent: "codex".into(),
            hook_event: "stop".into(),
            calls: 2,
            total_duration_ms: 0.0,
            max_duration_ms: 0.0,
        };
        for _ in 0..2 {
            let rows = collector
                .collect_l2_with_hook_timings(&snapshot, std::slice::from_ref(&timing))
                .unwrap();
            assert!(rows.agents.is_empty() && rows.inputs.is_empty() && rows.flushers.is_empty());
            let row = &rows.hooks[0];
            let json = serde_json::to_value(row).unwrap();
            assert_eq!(json["type"], "hook");
            assert_eq!(json["agent"], "codex");
            assert_eq!(json["hook_event"], "stop");
            assert_eq!(json["calls"], "2");
            assert_eq!(json["total_duration_ms"], "0");
            assert_eq!(json["max_duration_ms"], "0");
            assert_eq!(json["user_id"], "test-user");
            assert!(!row.identity.run_id.is_empty());
            assert!(json["__time__"].as_i64().unwrap() > 1_700_000_000);
        }
        assert!(collector.collect_l2(&snapshot).is_none());
    }

    #[test]
    fn l1_reports_agent_counts_and_flusher_egress() {
        let dir = tempfile::tempdir().unwrap();
        let mut collector = collector(dir.path());
        let mut snapshot = DataflowSnapshot {
            in_events_total: 110,
            in_bytes_total: 5000,
            ..DataflowSnapshot::default()
        };
        let mut sls = flusher("sls");
        sls.out_entries = 70;
        sls.out_bytes = 3000;
        let mut cms = flusher("cms");
        cms.out_entries = 30;
        cms.out_bytes = 1800;
        snapshot.flushers.insert("sls:main".into(), sls);
        snapshot.flushers.insert("cms:arms".into(), cms);
        snapshot
            .inputs
            .insert("qoder-sqlite".into(), input("qoder"));
        snapshot.inputs.insert("qoder-trace".into(), input("qoder"));
        snapshot
            .inputs
            .insert("cursor-hook".into(), input("cursor"));
        snapshot.inputs.insert(
            "kiro-cli".into(),
            InputSnapshot {
                running: false,
                ..input("kiro-cli")
            },
        );
        snapshot.input_idle_minutes.insert("qoder-sqlite".into(), 4);
        let result = collector.collect_l1(&snapshot);
        assert_eq!(result.version, "1.0.0");
        assert_eq!(result.user_id, "test-user");
        assert_eq!(result.hostname, host_name());
        assert_eq!(result.pid, u64::from(std::process::id()));
        assert!(
            result.os_detail.contains("Linux")
                || result.os_detail.contains("Darwin")
                || result.os_detail.contains("Windows")
        );
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(dir.path().to_string_lossy().as_bytes());
        assert_eq!(
            result.instance_id,
            format!("{}_{}_{encoded}", host_name(), "test-user")
        );
        assert!(!result
            .instance_id
            .contains(dir.path().to_string_lossy().as_ref()));
        assert!(result
            .run_id
            .starts_with(&format!("{}_", result.instance_id)));
        assert!(result.mem.parse::<i64>().unwrap() > 0);
        assert_eq!(result.metric_json.agent_count, "2");
        assert_eq!(result.metric_json.active_agent_count, "1");
        assert_eq!(result.metric_json.in_events, "110");
        assert_eq!(result.metric_json.in_bytes, "5000");
        assert_eq!(result.metric_json.out_events, "100");
        assert_eq!(result.metric_json.out_bytes, "4800");
        assert_eq!(result.capture_message_disabled_agents, "");
        assert!(result.time > 1_700_000_000);
        assert_eq!(result.metric_json.in_events_ps, "0.0");
    }

    #[test]
    fn drains_l1_and_clamps_backwards_counters() {
        let dir = tempfile::tempdir().unwrap();
        let mut collector = collector(dir.path());
        let mut snapshot = DataflowSnapshot {
            in_events_total: 110,
            in_bytes_total: 5000,
            ..DataflowSnapshot::default()
        };
        let mut sls = flusher("sls");
        sls.out_entries = 100;
        sls.out_bytes = 4800;
        snapshot.flushers.insert("sls:main".into(), sls);
        let first = collector.collect_l1(&snapshot);
        assert_eq!(first.metric_json.in_events, "110");
        let second = collector.collect_l1(&snapshot);
        assert_eq!(second.metric_json.in_events, "0");
        assert_eq!(second.metric_json.out_bytes, "0");
        snapshot.in_events_total = 10;
        snapshot.in_bytes_total = 400;
        let third = collector.collect_l1(&snapshot);
        assert_eq!(third.metric_json.in_events, "0");
        assert_eq!(third.metric_json.in_bytes, "0");
        assert_eq!(first.start_time, third.start_time);
    }

    #[test]
    fn computes_cpu_from_injected_deltas() {
        let dir = tempfile::tempdir().unwrap();
        let clock = Arc::new(AtomicI64::new(1_000_000));
        let samples = Arc::new(std::sync::Mutex::new(vec![
            (0_i64, 0_i64),
            (100_000, 50_000),
        ]));
        let clock_fn = clock.clone();
        let samples_fn = samples.clone();
        let mut collector = MetricsCollector::from_options(MetricsCollectorOptions {
            now_ms: Some(Arc::new(move || clock_fn.load(Ordering::SeqCst))),
            cpu_usage: Some(Arc::new(move || samples_fn.lock().unwrap().remove(0))),
            ..MetricsCollectorOptions::new("1.0.0", "test-user", dir.path().to_string_lossy())
        });
        assert_eq!(collector.collect_l1(&DataflowSnapshot::default()).cpu, "0");
        clock.store(1_001_000, Ordering::SeqCst);
        assert_eq!(collector.collect_l1(&DataflowSnapshot::default()).cpu, "15");
    }

    #[test]
    fn l2_rolls_inputs_up_by_agent_and_drains() {
        let dir = tempfile::tempdir().unwrap();
        let mut collector = collector(dir.path());
        let mut qoder_sqlite = input("qoder");
        qoder_sqlite.raw_in_records = 50;
        qoder_sqlite.raw_in_bytes = 2048;
        qoder_sqlite.raw_in_max_batch_bytes = 1600;
        qoder_sqlite.in_events = 42;
        qoder_sqlite.in_bytes = 1024;
        qoder_sqlite.out_failed = 2;
        qoder_sqlite.last_poll_time = "2026-05-19 10:01:00".into();
        qoder_sqlite.start_time = "2026-05-19 09:00:00".into();
        let mut qoder_trace = input("qoder");
        qoder_trace.collection_method = "trace".into();
        qoder_trace.raw_read_calls = 4;
        qoder_trace.raw_read_bytes = 1024;
        qoder_trace.raw_in_records = 10;
        qoder_trace.raw_in_bytes = 512;
        qoder_trace.raw_in_max_batch_bytes = 4096;
        qoder_trace.raw_in_max_record_bytes = 128;
        qoder_trace.raw_backlog_bytes_max = 2048;
        qoder_trace.parse_success_records = 9;
        qoder_trace.parse_failed_records = 1;
        qoder_trace.read_duration_ms = 12.4;
        qoder_trace.process_duration_ms = 21.6;
        qoder_trace.in_events = 8;
        qoder_trace.in_bytes = 256;
        qoder_trace.last_poll_time = "2026-05-19 10:03:00".into();
        qoder_trace.start_time = "2026-05-19 08:30:00".into();
        let mut cursor = input("cursor");
        cursor.collection_method = "hook".into();
        cursor.raw_in_records = 12;
        cursor.raw_in_bytes = 700;
        cursor.in_events = 10;
        cursor.in_bytes = 500;
        cursor.last_poll_time = "2026-05-19 10:02:00".into();
        cursor.start_time = "2026-05-19 09:30:00".into();
        let mut snapshot = DataflowSnapshot {
            in_events_total: 60,
            in_bytes_total: 1780,
            ..DataflowSnapshot::default()
        };
        snapshot.inputs.insert("qoder-sqlite".into(), qoder_sqlite);
        snapshot.inputs.insert("qoder-trace".into(), qoder_trace);
        snapshot.inputs.insert("cursor-hook".into(), cursor);
        snapshot.input_idle_minutes.insert("qoder-sqlite".into(), 3);
        snapshot.input_idle_minutes.insert("qoder-trace".into(), 7);
        let mut sls = flusher("sls");
        sls.project = "proj-a".into();
        sls.logstore = "store-a".into();
        sls.mode = "sls".into();
        sls.in_entries = 200;
        sls.in_bytes = 50000;
        sls.out_entries = 195;
        sls.out_bytes = 48000;
        sls.out_failed = 5;
        sls.total_delay_ms = 3500;
        sls.last_flush_time = "2026-05-19 10:05:00".into();
        sls.start_time = "2026-05-19 09:00:00".into();
        let mut cms = flusher("cms");
        cms.out_entries = 60;
        cms.out_bytes = 8800;
        cms.in_entries = 60;
        cms.in_bytes = 9000;
        cms.total_delay_ms = 900;
        snapshot.flushers.insert("sls:main".into(), sls);
        snapshot.flushers.insert("cms:arms".into(), cms);
        let l2 = collector.collect_l2(&snapshot).unwrap();
        assert_eq!(
            l2.inputs
                .iter()
                .map(|row| row.raw_in_records.parse::<i64>().unwrap())
                .sum::<i64>(),
            72
        );
        let qoder = l2.agents.iter().find(|row| row.agent == "qoder").unwrap();
        assert_eq!(qoder.in_events, "50");
        assert_eq!(qoder.in_bytes, "1280");
        assert_eq!(qoder.failed_events, "2");
        assert_eq!(qoder.last_poll_time, "2026-05-19 10:03:00");
        assert_eq!(qoder.start_time, "2026-05-19 08:30:00");
        assert_eq!(qoder.idle_minutes, "3");
        assert_eq!(
            l2.agents
                .iter()
                .find(|row| row.agent == "cursor")
                .unwrap()
                .idle_minutes,
            "-1"
        );
        let trace = l2
            .inputs
            .iter()
            .find(|row| row.input_name == "qoder-trace")
            .unwrap();
        assert_eq!(trace.read_duration_ms, "12");
        assert_eq!(trace.process_duration_ms, "22");
        assert_eq!(trace.collection_method, "trace");
        let sls_row = l2.flushers.iter().find(|row| row.flusher == "sls").unwrap();
        assert_eq!(sls_row.project, "proj-a");
        assert_eq!(sls_row.out_entries, "195");
        assert_eq!(sls_row.bytes_basis, "measured");
        let second = collector.collect_l2(&snapshot).unwrap();
        assert!(second.agents.iter().all(|row| row.in_events == "0"));
        assert_eq!(
            second
                .flushers
                .iter()
                .find(|row| row.flusher == "sls")
                .unwrap()
                .out_entries,
            "0"
        );
        assert_eq!(
            second
                .flushers
                .iter()
                .find(|row| row.flusher == "sls")
                .unwrap()
                .project,
            "proj-a"
        );
    }

    #[test]
    fn keeps_a_silent_running_agent_and_drops_one_that_is_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        let mut collector = collector(dir.path());
        let mut snapshot = DataflowSnapshot::default();
        snapshot
            .inputs
            .insert("cursor-hook".into(), input("cursor"));
        snapshot.inputs.insert(
            "wukong-hook".into(),
            InputSnapshot {
                running: false,
                ..input("wukong")
            },
        );
        snapshot
            .inputs
            .insert("idle-hook".into(), input("idle-agent"));
        snapshot.inputs.insert(
            "stopped-file".into(),
            InputSnapshot {
                running: false,
                raw_in_max_batch_bytes: 4096,
                ..input("stopped-agent")
            },
        );
        let l2 = collector.collect_l2(&snapshot).unwrap();
        let mut agents: Vec<_> = l2.agents.iter().map(|row| row.agent.as_str()).collect();
        agents.sort();
        assert_eq!(agents, vec!["cursor", "idle-agent"]);
        assert_eq!(collector.collect_l1(&snapshot).metric_json.agent_count, "2");
    }

    #[test]
    fn returns_null_without_inputs_or_flushers_and_reports_flushers_alone() {
        let dir = tempfile::tempdir().unwrap();
        let mut collector = collector(dir.path());
        assert!(collector.collect_l2(&DataflowSnapshot::default()).is_none());
        let mut snapshot = DataflowSnapshot::default();
        let mut sls = flusher("sls");
        sls.out_entries = 1;
        snapshot.flushers.insert("sls:main".into(), sls);
        let l2 = collector.collect_l2(&snapshot).unwrap();
        assert!(l2.agents.is_empty());
        assert_eq!(l2.flushers[0].out_entries, "1");
    }

    #[test]
    fn reads_init_type_projects_and_infra_grace() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("init-type"), "launchd").unwrap();
        let mut collector = MetricsCollector::from_options(MetricsCollectorOptions {
            updater_liveness: Some(Arc::new(|_| down())),
            ..MetricsCollectorOptions::new("1.0.0", "test-user", dir.path().to_string_lossy())
        });
        let first = collector.collect_l1(&DataflowSnapshot::default());
        assert_eq!(first.init_type, "launchd");
        assert_eq!(first.updater_pid_alive, "true");
        assert_eq!(
            collector
                .collect_l1(&DataflowSnapshot::default())
                .updater_pid_alive,
            "true"
        );
        assert_eq!(
            collector
                .collect_l1(&DataflowSnapshot::default())
                .updater_pid_alive,
            "false"
        );
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls_cb = calls.clone();
        let mut gated = MetricsCollector::from_options(MetricsCollectorOptions {
            auto_update_enabled: false,
            updater_liveness: Some(Arc::new(move |_| {
                calls_cb.fetch_add(1, Ordering::SeqCst);
                down()
            })),
            ..MetricsCollectorOptions::new("1.0.0", "test-user", dir.path().to_string_lossy())
        });
        for _ in 0..5 {
            gated.collect_l1(&DataflowSnapshot::default());
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(gated.last_infra_health().unwrap().updater_pid_alive);
        let endpoint = SlsEndpoint {
            name: "a".into(),
            endpoint: "https://x".into(),
            project: "bbb".into(),
            logstore: "l1".into(),
            kind: SlsEndpointKind::AgentActivity,
            mode: SlsMode::Ak,
            access_key_id: None,
            access_key_secret: None,
            api_key: None,
            redact: None,
            service_name: None,
        };
        let mut other = endpoint.clone();
        other.name = "b".into();
        other.project = "aaa".into();
        let mut dup = endpoint.clone();
        dup.name = "c".into();
        dup.project = "aaa".into();
        let mut with_projects = MetricsCollector::from_options(MetricsCollectorOptions {
            sls_endpoints: vec![endpoint, other, dup],
            cms_workspace: "ws-abc".into(),
            ..MetricsCollectorOptions::new("1.0.0", "test-user", dir.path().to_string_lossy())
        });
        let row = with_projects.collect_l1(&DataflowSnapshot::default());
        assert_eq!(row.projects, "aaa bbb");
        assert_eq!(row.cms_workspace, "ws-abc");
    }

    #[test]
    fn updater_failures_increment_after_the_grace_period() {
        let dir = tempfile::tempdir().unwrap();
        let mut collector = MetricsCollector::from_options(MetricsCollectorOptions {
            updater_liveness: Some(Arc::new(|_| down())),
            ..MetricsCollectorOptions::new("1.0.0", "test-user", dir.path().to_string_lossy())
        });
        collector.collect_l1(&DataflowSnapshot::default());
        collector.collect_l1(&DataflowSnapshot::default());
        let third = collector.collect_l1(&DataflowSnapshot::default());
        assert_eq!(third.updater_pid_alive, "false");
        assert_eq!(
            collector
                .last_infra_health()
                .unwrap()
                .updater_consecutive_failures,
            1
        );
    }

    #[test]
    fn incomplete_version_directories_are_not_valid_rust_releases() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("versions").join("1.0.0_abc")).unwrap();
        std::fs::write(dir.path().join("current"), "1.0.0_abc").unwrap();
        std::fs::create_dir_all(dir.path().join("versions").join("v2")).unwrap();
        std::fs::write(dir.path().join("versions").join(".DS_Store"), "").unwrap();
        std::fs::create_dir_all(dir.path().join("versions").join("0.9.0_def")).unwrap();
        std::fs::write(dir.path().join("previous"), "0.9.0_def").unwrap();
        let mut collector = collector(dir.path());
        let row = collector.collect_l1(&DataflowSnapshot::default());
        assert_eq!(row.current_version_valid, "false");
        assert_eq!(row.rollback_available, "false");
        assert_eq!(row.version_count, "3");
    }

    #[test]
    fn native_health_never_heals_or_executes_legacy_node() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = dir
            .path()
            .join("runtime")
            .join("node-v24.1.0-test")
            .join("bin");
        std::fs::create_dir_all(&runtime).unwrap();
        let node = runtime.join("node");
        let marker = dir.path().join("unexpected-node-execution");
        std::fs::write(
            &node,
            format!(
                "#!/bin/sh\nprintf invoked > '{}'\necho v24.1.0\n",
                marker.display()
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&node).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&node, perms).unwrap();
        }
        std::fs::write(dir.path().join("node-bin"), "/nonexistent/node\n").unwrap();
        let probe = RuntimeProbe {
            exec_path: dir.path().join("missing-native-binary"),
            cache_dir: Some(dir.path().to_path_buf()),
        };
        let mut collector = MetricsCollector::from_options(MetricsCollectorOptions {
            runtime_probe: Some(probe),
            ..MetricsCollectorOptions::new("1.0.0", "test-user", dir.path().to_string_lossy())
        });
        let row = collector.collect_l1(&DataflowSnapshot::default());
        assert_eq!(row.node_bin_valid, "not-applicable");
        assert_eq!(row.runtime_bin_valid, "false");
        assert!(!marker.exists());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("node-bin")).unwrap(),
            "/nonexistent/node\n"
        );
    }

    fn down() -> ProcessLiveness {
        ProcessLiveness {
            running: false,
            pid: None,
            source: crate::utils::ProcessLivenessSource::None,
            reason: "no matching updater command found".into(),
            pid_file_state: Some(crate::utils::PidFileState::Missing),
            pid_file_process_alive: None,
            pid_file_command: None,
            pid_file_command_matched: None,
        }
    }
}
