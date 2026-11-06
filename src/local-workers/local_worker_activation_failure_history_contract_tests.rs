use super::super::instance_store::{connect_local_worker, ConnectLocalWorkerOptions};
use super::*;
struct NeverSupervisor;
#[async_trait]
impl WorkerSupervisor for NeverSupervisor {
    async fn deploy(
        &self,
        _def: &AgentDefinition,
        _instance: &HashMap<String, String>,
        _options: &RuntimeOptions,
    ) -> DeployResult {
        panic!("readonly failure inspection must not deploy")
    }
    async fn stop_worker(
        &self,
        _def: &AgentDefinition,
        _instance: &HashMap<String, String>,
        _options: &RuntimeOptions,
    ) -> Result<(), String> {
        panic!("readonly failure inspection must not stop")
    }
    async fn source_hash(&self, _tarball: Option<&str>) -> Option<String> {
        panic!("readonly failure inspection must not hash")
    }
}
#[tokio::test]
async fn activation_l419_all_six_source_failure_reasons_are_preserved_readonly() {
    let t = tempfile::tempdir().unwrap();
    let data = t.path().to_str().unwrap();
    let i = connect_local_worker(ConnectLocalWorkerOptions {
        data_dir: data,
        runtime: "claude-code",
        bootstrap_token: "opaque-runtime-token",
        work_dir: None,
        runtime_options: None,
    })
    .await
    .unwrap();
    let service = LocalWorkerActivationService::new(data, data, vec![], NeverSupervisor);
    let path = Path::new(&state_dir(data, &i.id)).join("supervisor-status.json");
    for reason in [
        "WorkerManifestPlaceholderInvalid",
        "RuntimeBundlePlatformUnsupported",
        "WorkerProcessIdentityMissing",
        "WorkerProcessIdentityCheckFailed",
        "WorkerProcessTreeStopFailed",
        "WorkerProcessIdentityUnavailable",
    ] {
        let bytes = serde_json::to_vec(&json!({"state":"failed","reason":reason})).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        assert!(
            service.has_supervisor_failure_to_preserve(&i).await,
            "{reason}"
        );
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
}
#[tokio::test]
async fn activation_l446_unrelated_failure_reason_is_not_preserved_or_confused_with_other_states() {
    let t = tempfile::tempdir().unwrap();
    let data = t.path().to_str().unwrap();
    let i = connect_local_worker(ConnectLocalWorkerOptions {
        data_dir: data,
        runtime: "claude-code",
        bootstrap_token: "opaque-runtime-token",
        work_dir: None,
        runtime_options: None,
    })
    .await
    .unwrap();
    let service = LocalWorkerActivationService::new(data, data, vec![], NeverSupervisor);
    let path = Path::new(&state_dir(data, &i.id)).join("supervisor-status.json");
    for value in [
        json!({"state":"failed","reason":"LocalWorkerDeployFailed"}),
        json!({"state":"running","reason":"WorkerProcessIdentityMissing"}),
        json!({"state":"failed"}),
    ] {
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(!service.has_supervisor_failure_to_preserve(&i).await);
    }
}
