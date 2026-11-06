//! Pipeline config shapes. JSON names match `src/pipeline/types.ts`.

use std::sync::Arc;

use serde_json::Value;

pub use super::sleep_detector::WakeEvent;
use super::workspace_policy::WorkspacePolicy;

#[async_trait::async_trait]
pub trait Pipeline: Send + Sync {
    async fn start(&self);
    async fn stop(&self);
    async fn handle_wake(&self, event: WakeEvent) {
        let _ = event;
    }
}

#[derive(Clone, Debug)]
pub struct FileInputConfig {
    pub file_paths: Vec<String>,
    pub file_encoding: Option<String>,
    pub max_dir_search_depth: Option<u32>,
    pub allowing_included_by_multi_configs: Option<bool>,
}

#[derive(Clone, Debug)]
pub struct QoderApiInputConfig {
    pub api_key: String,
    pub org_id: String,
    pub api_base: Option<String>,
    pub interval: Option<u64>,
    pub backfill_days: Option<u64>,
}

#[derive(Clone, Debug)]
pub enum PipelineInputConfig {
    File(FileInputConfig),
    QoderApi(QoderApiInputConfig),
}

impl PipelineInputConfig {
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::File(_) => "input_file",
            Self::QoderApi(_) => "input_qoder_api",
        }
    }
}

#[derive(Clone, Debug)]
pub struct PipelineSlsFlusherConfig {
    pub endpoint: String,
    pub project: String,
    pub logstore: String,
    pub region: Option<String>,
    pub aliuid: Option<String>,
    pub telemetry_type: Option<String>,
}

#[derive(Clone, Debug)]
pub struct PipelineConfig {
    pub config_name: String,
    pub inputs: Vec<PipelineInputConfig>,
    pub flushers: Vec<PipelineSlsFlusherConfig>,
    pub raw: Value,
}

#[derive(Clone, Debug)]
pub struct PipelineToggle {
    pub enabled: bool,
    pub file_enabled: bool,
    pub qoder_api_enabled: bool,
}

pub struct PipelineManagerOptions {
    pub workspace_policy: Option<Arc<std::sync::Mutex<WorkspacePolicy>>>,
    pub config_dir: String,
    pub state_dir: String,
    pub failed_log_dir: String,
    pub data_dir: String,
    pub pipeline_config: PipelineToggle,
}

pub struct FilePipelineOptions {
    pub workspace_policy: Option<Arc<std::sync::Mutex<WorkspacePolicy>>>,
    pub config: PipelineConfig,
    pub state_dir: String,
    pub failed_log_dir: String,
    pub data_dir: String,
    pub sink: Option<Arc<dyn super::sls_transport::SlsSink>>,
}

pub struct QoderApiPipelineOptions {
    pub workspace_policy: Option<Arc<std::sync::Mutex<WorkspacePolicy>>>,
    pub config: PipelineConfig,
    pub state_dir: String,
    pub failed_log_dir: String,
    pub data_dir: String,
    pub sink: Option<Arc<dyn super::sls_transport::SlsSink>>,
}

#[derive(Clone, Debug)]
pub struct DevInode {
    pub dev: u64,
    pub ino: u64,
}

#[derive(Clone, Debug)]
pub struct FileCheckpoint {
    pub offset: u64,
    pub inode: u64,
    pub dev: u64,
    pub signature_hash: String,
    pub signature_size: u64,
    pub last_update_time: i64,
    pub cache: String,
}

#[derive(Clone, Debug)]
pub struct FileReaderState {
    pub file_path: String,
    pub dev_inode: DevInode,
    pub offset: u64,
    pub signature_hash: String,
    pub last_update_time: i64,
    pub cache: String,
    pub deleted: bool,
    pub deleted_time: i64,
}
