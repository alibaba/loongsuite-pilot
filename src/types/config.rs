use super::AgentEventName;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fmt;
use std::str::FromStr;

macro_rules! str_enum {
    ($name:ident { $($var:ident = $s:literal),* $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $s)] $var,)*
        }

        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$var),*];

            pub fn as_str(self) -> &'static str {
                match self {
                    $($name::$var => $s,)*
                }
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl FromStr for $name {
            type Err = String;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                match s {
                    $($s => Ok($name::$var),)*
                    other => Err(format!("unknown {}: {other}", stringify!($name))),
                }
            }
        }
    };
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListenerConfig {
    pub enabled: bool,
    pub poll_interval: u64,
    /// Only the Doubao Work listener accepts a log-directory override.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_dir: Option<String>,
}

str_enum!(CanaryPolicy {
    Auto = "auto",
    Latest = "latest",
    Off = "off",
});

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutoUpdateConfig {
    pub enabled: bool,
    pub check_interval_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canary_policy: Option<CanaryPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canary_hotfix_version: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CmsConfig {
    pub enabled: bool,
    pub license_key: String,
    pub endpoint: String,
    pub workspace: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub debug: Option<bool>,
}

str_enum!(MaskMode {
    None = "none",
    All = "all",
    Custom = "custom",
});

str_enum!(MaskReplacementMode {
    Placeholder = "placeholder",
    Preview = "preview",
});

str_enum!(MaskType {
    CloudAccessKey = "cloudAccessKey",
    ApiKey = "apiKey",
    PrivateKey = "privateKey",
    DatabaseUrl = "databaseUrl",
    IdCard = "idCard",
    Phone = "phone",
    Email = "email",
    IpAddress = "ipAddress",
    BankCard = "bankCard",
});

impl MaskType {
    pub const PII: &'static [MaskType] = &[
        MaskType::IdCard,
        MaskType::Phone,
        MaskType::Email,
        MaskType::IpAddress,
        MaskType::BankCard,
    ];

    pub const INTERCEPTOR: &'static [MaskType] = &[
        MaskType::CloudAccessKey,
        MaskType::ApiKey,
        MaskType::PrivateKey,
        MaskType::DatabaseUrl,
    ];

    pub fn is_pii(self) -> bool {
        Self::PII.contains(&self)
    }

    pub fn is_interceptor(self) -> bool {
        Self::INTERCEPTOR.contains(&self)
    }
}

pub const PII_MASK_TYPES: &[&str] = &["idCard", "phone", "email", "ipAddress", "bankCard"];
pub const SUPPORTED_MASK_TYPES: &[&str] = &[
    "cloudAccessKey",
    "apiKey",
    "privateKey",
    "databaseUrl",
    "idCard",
    "phone",
    "email",
    "ipAddress",
    "bankCard",
];
pub const SUPPORTED_INTERCEPTOR_TYPES: &[&str] =
    &["cloudAccessKey", "apiKey", "privateKey", "databaseUrl"];

pub type PiiMaskType = MaskType;
pub type InterceptorType = MaskType;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MaskConfig {
    pub mode: MaskMode,
    pub types: Vec<MaskType>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "replacementMode"
    )]
    pub replacement_mode: Option<MaskReplacementMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InterceptorConfig {
    pub mode: MaskMode,
    pub types: Vec<InterceptorType>,
}

str_enum!(OtlpCompression {
    None = "none",
    Gzip = "gzip",
});

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct OtlpTraceRawConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span_enrichers: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_attributes: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub debug: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_message_content: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_idle_timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_attribute_keys: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span_attribute_passthrough_prefixes: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_export_batch_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compression: Option<OtlpCompression>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OtlpEndpointEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub endpoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compression: Option<OtlpCompression>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CmsEndpointEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub endpoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct InnerTraceConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub otlp: Option<Vec<OtlpEndpointEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cms: Option<Vec<CmsEndpointEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_name_prefix: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamLinkConfig {
    pub enabled: bool,
    pub propagate_to_tools: bool,
    pub propagate_to_llm: bool,
    pub generate_trace_when_missing: bool,
    pub ttl_ms: u64,
}

str_enum!(MultimodalUploadMode {
    None = "none",
    Input = "input",
    Output = "output",
    All = "all",
});

pub fn multimodal_upload_includes_input(mode: MultimodalUploadMode) -> bool {
    matches!(
        mode,
        MultimodalUploadMode::Input | MultimodalUploadMode::All
    )
}

pub fn multimodal_upload_includes_output(mode: MultimodalUploadMode) -> bool {
    matches!(
        mode,
        MultimodalUploadMode::Output | MultimodalUploadMode::All
    )
}

pub const MULTIMODAL_UPLOAD_MODES: &[&str] = &["none", "input", "output", "all"];

str_enum!(MultimodalStorageType {
    Sls = "sls",
    DelegatedOss = "delegatedOss",
    Oss = "oss",
});

pub const MULTIMODAL_STORAGE_TYPES: &[&str] = &["sls", "delegatedOss", "oss"];

str_enum!(MultimodalSlsAuthMode {
    Ak = "ak",
    ApiKey = "apiKey",
    Anonymous = "anonymous",
});

pub const MULTIMODAL_SLS_AUTH_MODES: &[&str] = &["ak", "apiKey", "anonymous"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MultimodalAkAuth {
    pub access_key_id: String,
    pub access_key_secret: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub security_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MultimodalApiKeyAuth {
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode")]
pub enum MultimodalCredentialAuth {
    #[serde(rename = "ak")]
    Ak(MultimodalAkAuth),
    #[serde(rename = "apiKey")]
    ApiKey(MultimodalApiKeyAuth),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode")]
pub enum MultimodalStorageAuth {
    #[serde(rename = "ak")]
    Ak(MultimodalAkAuth),
    #[serde(rename = "apiKey")]
    ApiKey(MultimodalApiKeyAuth),
    #[serde(rename = "anonymous")]
    Anonymous,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MultimodalSlsTarget {
    pub endpoint: String,
    pub project: String,
    pub logstore: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MultimodalOssTarget {
    pub endpoint: String,
    pub storage_base_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MultimodalStorage {
    #[serde(rename = "sls")]
    Sls {
        target: MultimodalSlsTarget,
        auth: MultimodalStorageAuth,
    },
    #[serde(rename = "delegatedOss")]
    DelegatedOss {
        target: MultimodalSlsTarget,
        auth: MultimodalCredentialAuth,
    },
    #[serde(rename = "oss")]
    Oss {
        target: MultimodalOssTarget,
        auth: MultimodalAkAuth,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MultimodalRuntimeConfig {
    pub storage: MultimodalStorage,
    pub storage_base_path: String,
}

pub const MULTIMODAL_SUPPORTED_AGENT_IDS: &[&str] = &["codex", "qoder", "qwen-work-cn"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentMultimodalConfig {
    pub upload_mode: MultimodalUploadMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_root_paths: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_message_content: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multimodal: Option<AgentMultimodalConfig>,
}

pub type AgentsConfig = HashMap<String, AgentConfig>;

str_enum!(SlsMode {
    Ak = "ak",
    Webtracking = "webtracking",
    ApiKey = "apiKey",
});

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SlsTimeoutConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connect_timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers_timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SlsRetryConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_max_attempts: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_base_delay_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_jitter: Option<bool>,
}

str_enum!(SlsEndpointKind {
    AgentActivity = "agentActivity",
    AgentTelemetry = "agentTelemetry",
    Mcp = "mcp",
    Trace = "trace",
});

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SlsEndpoint {
    pub name: String,
    pub endpoint: String,
    pub project: String,
    pub logstore: String,
    pub kind: SlsEndpointKind,
    pub mode: SlsMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_key_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_key_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redact: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SlsFlusherConfig {
    pub enabled: bool,
    pub mode: SlsMode,
    pub access_key_id: String,
    pub access_key_secret: String,
    pub api_key: String,
    pub endpoint: String,
    pub endpoints: Vec<SlsEndpoint>,
    pub batch_max_size: usize,
    pub flush_interval_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_name: Option<String>,
    pub service_name_prefix: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<SlsTimeoutConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<SlsRetryConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flush_concurrency: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JsonlFlusherConfig {
    pub enabled: bool,
    pub output_dir: String,
    pub rotate_daily: bool,
    pub max_file_size_mb: serde_json::Number,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HttpFlusherConfig {
    pub enabled: bool,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
    pub batch_max_size: usize,
    pub flush_interval_ms: u64,
    pub request_timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct FlusherConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sls: Option<SlsFlusherConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jsonl: Option<JsonlFlusherConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http: Option<HttpFlusherConfig>,
}

str_enum!(OtlpProtocol {
    HttpProtobuf = "http/protobuf",
});

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OtlpEndpoint {
    pub name: String,
    pub endpoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compression: Option<OtlpCompression>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OtlpTraceFlusherConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span_enricher_paths: Option<Vec<String>>,
    pub enabled: bool,
    pub endpoints: Vec<OtlpEndpoint>,
    pub protocol: OtlpProtocol,
    pub service_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub append_agent_type_to_service_name: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_attributes: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_message_content: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub debug: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_idle_timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_attribute_keys: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span_attribute_passthrough_prefixes: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_export_batch_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsConfig {
    /// Source identity used for resolving relative runtime assets; never user config.
    #[serde(skip)]
    pub source_config_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub privacy: Option<PrivacyConfig>,
    pub enabled: bool,
    pub auto_start: bool,
    pub data_dir: String,
    pub user_id: String,
    pub collect_log: bool,
    pub collect_trace: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_name: Option<String>,
    pub service_name_prefix: String,
    pub cms: CmsConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub otlp_trace: Option<OtlpTraceRawConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inner_trace: Option<InnerTraceConfig>,
    pub listeners: HashMap<String, ListenerConfig>,
    pub flushers: FlusherConfig,
    pub retention: LogRetentionConfig,
    pub agents: AgentsConfig,
    pub mask: MaskConfig,
    pub hook_watchdog: HookWatchdogConfig,
    pub file_collection: FileCollectionToggle,
    pub pipeline: PipelineToggle,
    pub status_bar: StatusBarConfig,
    pub dashboard: DashboardConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_update: Option<AutoUpdateConfig>,
    pub upstream_link: UpstreamLinkConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multimodal: Option<MultimodalRuntimeConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub global_span_attributes: Option<HashMap<String, String>>,
    pub interceptor: InterceptorConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyConfig {
    #[serde(default)]
    pub exclude_workspaces: Vec<String>,
}

#[async_trait::async_trait]
pub trait AgentDetection: Send + Sync {
    fn id(&self) -> &str;
    fn type_name(&self) -> &str;
    async fn is_available(&self) -> bool;
    /// Recoverable detection failures are distinct from an unavailable Agent.
    /// Existing bool-only detectors retain their behavior through this adapter.
    async fn availability_result(&self) -> anyhow::Result<bool> {
        Ok(self.is_available().await)
    }
    fn watch_paths(&self) -> &[String];
    fn enabled(&self) -> bool;
    async fn start(&self) -> anyhow::Result<()>;
    async fn stop(&self) -> anyhow::Result<()>;
    fn poll_interval_ms(&self) -> u64;
    fn run_on_active(&self) -> bool {
        false
    }
    fn unavailable_threshold(&self) -> u32 {
        1
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogRetentionConfig {
    pub enabled: bool,
    pub interval_ms: u64,
    pub hook_history_days: u32,
    pub hook_error_days: u32,
    pub hook_debug_days: u32,
    pub output_days: u32,
    pub sls_failed_days: u32,
    pub otlp_failed_days: u32,
    pub metric_alarm_days: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HookWatchdogConfig {
    pub enabled: bool,
    pub interval_ms: u64,
    pub repair_cooldown_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PipelineSectionToggle {
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PipelineToggle {
    pub enabled: bool,
    pub file: PipelineSectionToggle,
    #[serde(rename = "qoderApi")]
    pub qoder_api: PipelineSectionToggle,
}

pub type FileCollectionToggle = PipelineToggle;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatusBarConfig {
    pub enabled: bool,
    pub metrics_summary_interval_ms: u64,
    pub runtime_refresh_interval_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DashboardConfig {
    #[serde(default)]
    pub enabled: bool,
    pub port: u16,
}

str_enum!(AgentControlMode {
    On = "on",
    Off = "off",
    Auto = "auto",
});

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentControlConfig {
    pub version: u32,
    pub tools: HashMap<String, AgentControlMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct InputState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_offset: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_row_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_timestamp: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub high_watermark: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra: Option<Map<String, Value>>,
}

str_enum!(AgentStopReason {
    Unavailable = "unavailable",
    Disabled = "disabled",
    Shutdown = "shutdown",
    Unexpected = "unexpected",
});

str_enum!(EntryState {
    Idle = "idle",
    Starting = "starting",
    Running = "running",
    Stopping = "stopping",
});

/// Alias kept so call sites can name the event the same way the TypeScript union does.
pub type EventName = AgentEventName;
