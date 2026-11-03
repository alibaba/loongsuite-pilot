use super::*;
use serde_json::json;
fn token(worker: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&json!({"workerUuid":worker,
        "matrixUrl":"https://matrix.example.com","controllerUrl":"https://controller.example.com","modelGatewayUrl":"https://model.example.com"})).unwrap())
}
struct World {
    _temp: tempfile::TempDir,
    root: PathBuf,
    data: String,
}
impl World {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_owned();
        let data = root.join("data").to_string_lossy().into_owned();
        Self {
            _temp: temp,
            root,
            data,
        }
    }
    async fn connect(&self, project: &str, options: Option<RuntimeOptions>) -> LocalWorkerInstance {
        connect_local_worker(ConnectLocalWorkerOptions {
            data_dir: &self.data,
            runtime: "claude-code",
            bootstrap_token: &token("550e8400-e29b-41d4-a716-446655440000"),
            work_dir: Some(self.root.join(project).to_str().unwrap()),
            runtime_options: options,
        })
        .await
        .unwrap()
    }
    fn write(&self, instance: &LocalWorkerInstance, name: &str, value: serde_json::Value) {
        std::fs::write(
            Path::new(&state_dir(&self.data, &instance.id)).join(name),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
    }
}
#[tokio::test]
async fn store_l77_every_connect_allocates_independent_identity_and_exact_workdir_options() {
    let f = World::new();
    let first = f.connect("project-a", None).await;
    let options = RuntimeOptions::from_iter([
        (
            "plugin-install-scope".into(),
            RuntimeOptionValue::Text("global".into()),
        ),
        (
            "model-config-mode".into(),
            RuntimeOptionValue::Text("managed-global".into()),
        ),
    ]);
    let second = f.connect("project-b", Some(options.clone())).await;
    assert_ne!(first.id, second.id);
    let a = read_local_worker_instance(&f.data, &first.id)
        .await
        .unwrap()
        .unwrap();
    let b = read_local_worker_instance(&f.data, &second.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(a.work_dir, f.root.join("project-a").to_string_lossy());
    assert!(a.runtime_options.is_empty());
    assert_eq!(b.work_dir, f.root.join("project-b").to_string_lossy());
    assert_eq!(b.runtime_options, options);
}
#[tokio::test]
async fn store_l103_l119_disabled_live_stopping_and_failed_disconnect_prioritize_supervisor_evidence(
) {
    let f = World::new();
    let i = f.connect("project", None).await;
    set_local_worker_enabled(&f.data, &i.id, false)
        .await
        .unwrap();
    let views = list_local_worker_views(&f.data).await.unwrap();
    assert_eq!(views.len(), 1);
    assert_eq!(views[0].id, i.id);
    assert_eq!(views[0].state, "disabled");
    f.write(
        &i,
        "supervisor-status.json",
        json!({"state":"running","pid":std::process::id()}),
    );
    assert_eq!(
        list_local_worker_views(&f.data).await.unwrap()[0].state,
        "stopping"
    );
    f.write(&i,"supervisor-status.json",json!({"state":"failed","pid":std::process::id(),"reason":"WorkerProcessTreeStopFailed","error":"worker process remained alive"}));
    f.write(&i,"status.json",json!({"phase":"Waiting","reason":"RuntimeCommandNotFound","message":"stale worker status"}));
    let view = &list_local_worker_views(&f.data).await.unwrap()[0];
    assert_eq!(view.state, "failed");
    assert_eq!(view.reason.as_deref(), Some("WorkerProcessTreeStopFailed"));
    assert_eq!(
        view.message.as_deref(),
        Some("worker process remained alive")
    );
}
#[tokio::test]
async fn store_l165_l186_reconnect_retains_id_created_time_and_workdir_while_rotating_only_requested_fields(
) {
    let f = World::new();
    let i = f.connect("project-a", None).await;
    set_local_worker_enabled(&f.data, &i.id, false)
        .await
        .unwrap();
    let work = f.root.join("project-b").to_string_lossy().into_owned();
    let resumed = reconnect_local_worker(ReconnectLocalWorkerOptions {
        data_dir: &f.data,
        instance_id: &i.id,
        bootstrap_token: None,
        work_dir: Some(&work),
        runtime_options: None,
    })
    .await
    .unwrap();
    assert_eq!(resumed.id, i.id);
    assert_eq!(resumed.created_at, i.created_at);
    assert!(resumed.enabled);
    assert_eq!(resumed.work_dir, work);
    assert_eq!(
        std::fs::read_to_string(bootstrap_token_path(&f.data, &resumed)).unwrap(),
        token("550e8400-e29b-41d4-a716-446655440000")
    );
    let rotated = token("rotated-worker-uuid");
    let options = RuntimeOptions::from_iter([(
        "model-config-mode".into(),
        RuntimeOptionValue::Text("managed-global".into()),
    )]);
    let updated = reconnect_local_worker(ReconnectLocalWorkerOptions {
        data_dir: &f.data,
        instance_id: &i.id,
        bootstrap_token: Some(&rotated),
        work_dir: None,
        runtime_options: Some(options.clone()),
    })
    .await
    .unwrap();
    assert_eq!(updated.id, i.id);
    assert_eq!(updated.work_dir, work);
    assert_eq!(updated.runtime_options, options);
    assert_eq!(
        std::fs::read_to_string(bootstrap_token_path(&f.data, &updated)).unwrap(),
        rotated
    );
    // Original L186 independently rotates a newly connected, never redirected instance.
    let g = World::new();
    let original = g.connect("project-a", None).await;
    let updated = reconnect_local_worker(ReconnectLocalWorkerOptions {
        data_dir: &g.data,
        instance_id: &original.id,
        bootstrap_token: Some(&rotated),
        work_dir: None,
        runtime_options: Some(options),
    })
    .await
    .unwrap();
    assert_eq!(updated.work_dir, g.root.join("project-a").to_string_lossy());
}
#[tokio::test]
async fn store_l208_delete_requires_disconnect_and_removes_only_the_exact_instance() {
    let f = World::new();
    let i = f.connect("project", None).await;
    assert!(delete_local_worker_instance(&f.data, &i.id)
        .await
        .unwrap_err()
        .contains("must be disconnected"));
    set_local_worker_enabled(&f.data, &i.id, false)
        .await
        .unwrap();
    delete_local_worker_instance(&f.data, &i.id).await.unwrap();
    assert!(read_local_worker_instance(&f.data, &i.id)
        .await
        .unwrap()
        .is_none());
    assert!(!Path::new(&instance_dir(&f.data, &i.id)).exists());
    assert!(list_local_worker_views(&f.data).await.unwrap().is_empty());
}
#[tokio::test]
async fn store_l226_l254_l287_stale_heartbeat_waiting_reason_and_all_runtime_matrix_display_fields_are_preserved(
) {
    let f = World::new();
    let i = f.connect("project", None).await;
    f.write(
        &i,
        "supervisor-status.json",
        json!({"state":"running","pid":std::process::id()}),
    );
    let stale = (chrono::Utc::now() - chrono::Duration::milliseconds(300_000))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    f.write(
        &i,
        "status.json",
        json!({"phase":"Running","updatedAt":stale}),
    );
    let views = list_local_worker_views(&f.data).await.unwrap();
    assert_eq!(views.len(), 1);
    assert_eq!(views[0].state, "degraded");
    let fresh = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    f.write(&i,"status.json",json!({"phase":"Waiting","reason":"RuntimeCommandNotFound","message":"runtime command is not installed","updatedAt":fresh}));
    let view = &list_local_worker_views(&f.data).await.unwrap()[0];
    assert_eq!(view.state, "waiting");
    assert_eq!(view.reason.as_deref(), Some("RuntimeCommandNotFound"));
    assert_eq!(
        view.message.as_deref(),
        Some("runtime command is not installed")
    );
    f.write(&i,"status.json",json!({"runtime":"claude-code","phase":"Running","workerName":"worker3","workerResourceName":"example-worker-worker3","updatedAt":fresh}));
    f.write(&i,"runtime-state.json",json!({"member":{"name":"example-worker-worker3","runtimeName":"worker3","personalRoomId":"!personal-room:example.com"},"storage":{"teamPrefix":"teams/test-team"}}));
    f.write(
        &i,
        "matrix-state.json",
        json!({"matrixSyncToken":"42","matrixCursors":{"!team-room:example.com":"$event"}}),
    );
    let view = &list_local_worker_views(&f.data).await.unwrap()[0];
    assert_eq!(view.state, "running");
    assert_eq!(view.worker_name.as_deref(), Some("worker3"));
    assert_eq!(view.team_name.as_deref(), Some("test-team"));
    assert_eq!(view.matrix.as_deref(), Some("connected"));
    assert_eq!(view.room_id.as_deref(), Some("!team-room:example.com"));
}
