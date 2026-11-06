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

str_enum!(DeployMode {
    Hook = "hook",
    PluginProbe = "plugin-probe",
    PluginInject = "plugin-inject",
    DirectoryPlugin = "directory-plugin",
    CopilotPlugin = "copilot-plugin",
    DetectionOnly = "detection-only",
    DshYamlPatch = "dsh-yaml-patch",
});

str_enum!(MountType {
    Wrapper = "wrapper",
    RcInject = "rc-inject",
    EnvInject = "env-inject",
});

str_enum!(HookFormat {
    Flat = "flat",
    Nested = "nested",
});

str_enum!(SettingsSyntax {
    Json = "json",
    Jsonc = "jsonc",
});

str_enum!(PluginSourceType {
    Oss = "oss",
    Tar = "tar",
});

str_enum!(EventSubcommand {
    KebabCase = "kebab-case",
    AsIs = "as-is",
});

str_enum!(HookInsert {
    Head = "head",
    Tail = "tail",
});

str_enum!(TrustAlgo {
    V1 = "v1",
});

str_enum!(PluginConfigShape {
    OpenclawNested = "openclaw-nested",
});

str_enum!(DeploySkipReason {
    NotDetected = "not-detected",
    UpToDate = "up-to-date",
    Disabled = "disabled",
});

str_enum!(InstalledBy {
    HookInstall = "hook-install",
    Daemon = "daemon",
    Build = "build",
});

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct AgentDetectionConfig {
    pub paths: Vec<String>,
    pub commands: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrustTomlConfig {
    pub config_path: String,
    pub trust_algo: TrustAlgo,
    pub marker: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InterceptorHookConfig {
    pub hook_command: String,
    pub events: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matcher: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_matchers: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub insert: Option<HookInsert>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace_hook_commands: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KiroAgentSeed {
    pub name: String,
    pub tools: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentHookConfig {
    pub settings_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_syntax: Option<SettingsSyntax>,
    pub events: Vec<String>,
    pub hook_command: String,
    pub format: HookFormat,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matcher: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_matchers: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace_hook_commands: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retired_events: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust_toml: Option<TrustTomlConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_subcommand: Option<EventSubcommand>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_command: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub win_shell: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kiro_agent: Option<KiroAgentSeed>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interceptor: Option<InterceptorHookConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginSourceConfig {
    #[serde(rename = "type")]
    pub source_type: PluginSourceType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tarball: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub dest_dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginInstallConfig {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginProbeConfig {
    pub source: PluginSourceConfig,
    pub mount_type: MountType,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentInputConfig {
    #[serde(rename = "type")]
    pub input_type: String,
    #[serde(default, rename = "logDir", skip_serializing_if = "Option::is_none")]
    pub log_dir: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginInjectConfig {
    pub config_paths: Vec<String>,
    pub plugin_spec: String,
    pub plugin_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace_specs: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_shape: Option<PluginConfigShape>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_config: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_if_missing: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_sqlite: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_sqlite_since: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PiSdkIntegrationConfig {
    pub schema_version: u8,
    pub agent_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryPluginActivationConfig {
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe_args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    pub enable_args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub optional_enable_args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disable_args: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryPluginConfig {
    pub source_dir: String,
    pub target_dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marker_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activation: Option<DirectoryPluginActivationConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DshYamlPatchConfig {
    pub plugin_source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch_path: Option<String>,
    pub entry_id: String,
    pub marker: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CopilotPluginHookConfig {
    pub plugin_root: String,
    pub plugin_id: String,
    pub settings_path: String,
    pub config_path: String,
    pub events: Vec<String>,
    pub hook_command: String,
    pub format: HookFormat,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_subcommand: Option<EventSubcommand>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_sec: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    pub id: String,
    pub display_name: String,
    pub deploy_mode: DeployMode,
    pub detection: AgentDetectionConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_worker_runtime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hook: Option<AgentHookConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_probe: Option<PluginProbeConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_inject: Option<PluginInjectConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pi_sdk: Option<PiSdkIntegrationConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copilot_plugin: Option<CopilotPluginHookConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory_plugin: Option<DirectoryPluginConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dsh_yaml_patch: Option<DshYamlPatchConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<AgentInputConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<AgentRuntimeConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeployResult {
    pub success: bool,
    pub agent_id: String,
    pub deploy_mode: DeployMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skipped: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<DeploySkipReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_inject_config_path: Option<String>,
}

#[async_trait::async_trait]
pub trait DeployStrategy: Send + Sync {
    async fn detect(&self, def: &AgentDefinition) -> bool;
    async fn needs_deploy(
        &self,
        def: &AgentDefinition,
        record: Option<&DeployedAgentRecord>,
    ) -> bool;
    async fn deploy(&self, def: &AgentDefinition) -> DeployResult;
    async fn undeploy(&self, def: &AgentDefinition) -> bool;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeployedAgentRecord {
    pub deploy_mode: DeployMode,
    pub deployed_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_remote_checked_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dsh_patch_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hook_settings_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hook_settings_paths: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_by: Option<InstalledBy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_inject_config_path: Option<String>,
}

pub type DeployedAgentsState = HashMap<String, DeployedAgentRecord>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deploy_mode_includes_dsh_yaml_patch() {
        let modes = [
            DeployMode::Hook,
            DeployMode::PluginProbe,
            DeployMode::PluginInject,
            DeployMode::DirectoryPlugin,
            DeployMode::DetectionOnly,
            DeployMode::DshYamlPatch,
        ];
        assert!(modes.contains(&DeployMode::DshYamlPatch));
        assert_eq!(DeployMode::DshYamlPatch.as_str(), "dsh-yaml-patch");
    }

    #[test]
    fn dsh_yaml_patch_config_required_and_optional_path() {
        let cfg = DshYamlPatchConfig {
            plugin_source: "file:///x/plugin.mjs".into(),
            patch_path: None,
            entry_id: "loongsuite-pilot-observability".into(),
            marker: "PILOT-OBSERVABILITY-MANAGED".into(),
        };
        assert_eq!(cfg.entry_id, "loongsuite-pilot-observability");
        assert_eq!(cfg.marker, "PILOT-OBSERVABILITY-MANAGED");

        let with_path = DshYamlPatchConfig {
            patch_path: Some("/tmp/cordis.patch.yml".into()),
            ..cfg
        };
        assert_eq!(
            with_path.patch_path.as_deref(),
            Some("/tmp/cordis.patch.yml")
        );
    }

    #[test]
    fn agent_definition_dsh_field_is_optional() {
        let def = AgentDefinition {
            id: "dsh".into(),
            display_name: "DeepSeek Harness".into(),
            deploy_mode: DeployMode::DshYamlPatch,
            detection: AgentDetectionConfig {
                paths: vec!["~/.dsh".into()],
                commands: vec!["dsh".into()],
            },
            local_worker_runtime: None,
            hook: None,
            plugin_probe: None,
            plugin_inject: None,
            pi_sdk: None,
            copilot_plugin: None,
            directory_plugin: None,
            dsh_yaml_patch: Some(DshYamlPatchConfig {
                plugin_source: "file:///x/plugin.mjs".into(),
                patch_path: None,
                entry_id: "loongsuite-pilot-observability".into(),
                marker: "PILOT-OBSERVABILITY-MANAGED".into(),
            }),
            input: None,
            runtime: None,
        };
        assert_eq!(def.deploy_mode, DeployMode::DshYamlPatch);
        assert_eq!(
            def.dsh_yaml_patch.as_ref().map(|c| c.entry_id.as_str()),
            Some("loongsuite-pilot-observability")
        );

        let other = AgentDefinition {
            id: "other".into(),
            display_name: "Other".into(),
            deploy_mode: DeployMode::Hook,
            dsh_yaml_patch: None,
            ..def
        };
        assert!(other.dsh_yaml_patch.is_none());
    }
}
