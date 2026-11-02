//! Historical PI SDK registry contracts using temporary native files and locks.
use super::*;

async fn fixture() -> (tempfile::TempDir, PiSdkAgentRegistrationRequest) {
    let directory = tempfile::tempdir().unwrap();
    let data = directory.path().join("pilot-data");
    let agent = directory.path().join("acme-agent");
    let detected = directory.path().join("acme-installed");
    std::fs::create_dir_all(&detected).unwrap();
    for (name, bytes) in [
        (
            "plugins/pi-coding-agent/index.mjs",
            include_bytes!("../../assets/plugins/pi-coding-agent/index.mjs").as_slice(),
        ),
        (
            "plugins/shared/resource-context.mjs",
            include_bytes!("../../assets/plugins/shared/resource-context.mjs").as_slice(),
        ),
    ] {
        let path = data.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }
    let request = PiSdkAgentRegistrationRequest {
        data_dir: data.to_string_lossy().into_owned(),
        id: "acme-code".into(),
        name: "Acme Code Agent".into(),
        agent_dir: agent.to_string_lossy().into_owned(),
        detection_paths: vec![detected.to_string_lossy().into_owned()],
        detection_commands: Vec::new(),
    };
    (directory, request)
}
#[tokio::test]
async fn history_restore_busy_preserves_a_typed_error_after_bounded_retries() {
    let (_directory, request) = fixture().await;
    let path = Path::new(&request.data_dir).join(PI_SDK_REGISTRY_LOCK_FILE);
    let blocker = acquire_single_instance_lock(path.to_str().unwrap(), None)
        .lock
        .unwrap();
    let start = std::time::Instant::now();
    let error = ensure_registered_pi_sdk_wrappers(&request.data_dir)
        .await
        .unwrap_err();
    blocker.release();
    let erased = &error as &dyn std::any::Any;
    let busy = erased.downcast_ref::<PiSdkRegistryBusyError>().or_else(|| {
        erased
            .downcast_ref::<anyhow::Error>()
            .and_then(|error| error.downcast_ref::<PiSdkRegistryBusyError>())
    });
    assert!(
        busy.is_some(),
        "native public restore lost typed busy cause: {error}"
    );
    assert!(start.elapsed() >= std::time::Duration::from_millis(400));
    assert!(start.elapsed() < std::time::Duration::from_secs(5));
    assert!(!path.exists());
}
#[tokio::test]
async fn history_registry_critical_section_releases_lock_when_cancelled() {
    let (_directory, request) = fixture().await;
    let data = request.data_dir.clone();
    let path = Path::new(&data).join(PI_SDK_REGISTRY_LOCK_FILE);
    let (entered, ready) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        with_lock(&data, || async move {
            entered.send(()).unwrap();
            std::future::pending::<Result<(), String>>().await
        })
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), ready)
        .await
        .unwrap()
        .unwrap();
    assert!(path.exists());
    assert!(acquire_single_instance_lock(path.to_str().unwrap(), None)
        .lock
        .is_none());
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(
        !path.exists(),
        "cancelled native registry operation retained its lock"
    );
    let acquired = acquire_single_instance_lock(path.to_str().unwrap(), None)
        .lock
        .unwrap();
    acquired.release();
}

fn settings(request: &PiSdkAgentRegistrationRequest) -> Value {
    serde_json::from_slice(
        &std::fs::read(Path::new(&request.agent_dir).join("settings.json")).unwrap(),
    )
    .unwrap()
}
#[tokio::test]
async fn history_complete_lifecycle_retains_exact_settings_and_negative_doctor() {
    let (_directory, request) = fixture().await;
    let first = register_pi_sdk_agent(request.clone()).await.unwrap();
    register_pi_sdk_agent(request.clone()).await.unwrap();
    assert_eq!(
        settings(&request)["extensions"],
        json!([first.wrapper_path])
    );
    let definitions = list_registered_pi_sdk_agents(&request.data_dir).await;
    assert_eq!(
        definitions
            .iter()
            .map(|d| d.id.as_str())
            .collect::<Vec<_>>(),
        vec!["acme-code"]
    );
    let healthy = doctor_pi_sdk_agent(&request.data_dir, "acme-code")
        .await
        .unwrap();
    assert!(
        healthy.detected
            && healthy.runtime_present
            && healthy.wrapper_present
            && healthy.injection_present
            && healthy.healthy
    );
    std::fs::remove_dir_all(&request.detection_paths[0]).unwrap();
    let unavailable = doctor_pi_sdk_agent(&request.data_dir, "acme-code")
        .await
        .unwrap();
    assert!(!unavailable.detected && !unavailable.healthy);
    let removed = unregister_pi_sdk_agent(&request.data_dir, "acme-code")
        .await
        .unwrap();
    assert!(removed.injection_removed && removed.definition_removed);
    assert_eq!(settings(&request)["extensions"], json!([]));
    assert!(!Path::new(&first.wrapper_path).exists());
    assert!(!Path::new(&first.definition_path).exists());
}
#[tokio::test]
async fn history_registration_move_removes_old_settings_entry() {
    let (directory, request) = fixture().await;
    register_pi_sdk_agent(request.clone()).await.unwrap();
    let mut next = request.clone();
    next.agent_dir = directory
        .path()
        .join("acme-agent-v2")
        .to_string_lossy()
        .into_owned();
    register_pi_sdk_agent(next.clone()).await.unwrap();
    assert_eq!(settings(&request)["extensions"], json!([]));
    assert_eq!(settings(&next)["extensions"].as_array().unwrap().len(), 1);
}
#[tokio::test]
async fn history_failed_extension_cleanup_preserves_registration_wrapper_and_health() {
    let (_directory, request) = fixture().await;
    let registered = register_pi_sdk_agent(request.clone()).await.unwrap();
    let original_settings = std::fs::read(&registered.settings_path).unwrap();
    let original_definition = std::fs::read(&registered.definition_path).unwrap();
    let original_wrapper = std::fs::read(&registered.wrapper_path).unwrap();
    // Same extension-removal boundary mocked by the original PluginInjectStrategy
    // test. Disk registration, lock, wrapper and doctor remain actual components.
    let error = with_lock(&request.data_dir, || {
        unregister_locked_with_cleanup(request.data_dir.clone(), "acme-code".into(), |_, _| async {
            false
        })
    })
    .await
    .unwrap_err();
    assert!(error
        .to_string()
        .contains("registration preserved for retry"));
    assert_eq!(
        std::fs::read(&registered.settings_path).unwrap(),
        original_settings
    );
    assert_eq!(
        std::fs::read(&registered.definition_path).unwrap(),
        original_definition
    );
    assert_eq!(
        std::fs::read(&registered.wrapper_path).unwrap(),
        original_wrapper
    );
    let doctor = doctor_pi_sdk_agent(&request.data_dir, "acme-code")
        .await
        .unwrap();
    assert!(doctor.injection_present && doctor.wrapper_present && doctor.healthy);
    assert!(!Path::new(&request.data_dir)
        .join(PI_SDK_REGISTRY_LOCK_FILE)
        .exists());
}
#[tokio::test]
async fn history_restores_exact_missing_wrapper_and_then_is_idempotent() {
    let (_directory, request) = fixture().await;
    let registered = register_pi_sdk_agent(request.clone()).await.unwrap();
    let original = std::fs::read(&registered.wrapper_path).unwrap();
    std::fs::remove_file(&registered.wrapper_path).unwrap();
    assert_eq!(
        ensure_registered_pi_sdk_wrappers(&request.data_dir)
            .await
            .unwrap(),
        1
    );
    assert_eq!(std::fs::read(&registered.wrapper_path).unwrap(), original);
    assert_eq!(
        ensure_registered_pi_sdk_wrappers(&request.data_dir)
            .await
            .unwrap(),
        0
    );
}
#[tokio::test]
async fn history_retries_real_transient_lock_before_restoring_wrapper() {
    let (_directory, request) = fixture().await;
    let registered = register_pi_sdk_agent(request.clone()).await.unwrap();
    std::fs::remove_file(&registered.wrapper_path).unwrap();
    let lock = Path::new(&request.data_dir).join(PI_SDK_REGISTRY_LOCK_FILE);
    let blocker = acquire_single_instance_lock(lock.to_str().unwrap(), None)
        .lock
        .unwrap();
    let (restored, ()) = tokio::join!(
        ensure_registered_pi_sdk_wrappers(&request.data_dir),
        async {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            blocker.release();
        },
    );
    assert_eq!(restored.unwrap(), 1);
    assert!(std::fs::read_to_string(&registered.wrapper_path)
        .unwrap()
        .contains("createPiTelemetryExtension"));
    assert!(!lock.exists());
}
#[test]
fn history_process_owner_patterns_cover_all_four_source_commands() {
    for (command,expected) in [
        ("/usr/bin/node /opt/loongsuite-pilot/bin/collector-daemon.js",true),
        ("/usr/bin/node /opt/loongsuite-pilot/versions/v1/dist/index.js agent register pi-sdk --id acme",true),
        ("powershell.exe loongsuite-pilot.ps1 agent unregister acme-code",true),
        ("/Applications/Example IDE.app/Contents/MacOS/Example IDE",false),
        ("/opt/loongsuite-pilot/loongsuite-pilot agent register pi-sdk --id acme",true),
    ] { assert_eq!(command_matches_registry(command),expected,"{command}"); }
}
#[tokio::test]
async fn history_rejects_reserved_unsafe_and_under_specified_registration() {
    let (_directory, request) = fixture().await;
    for (id, reason) in [("pi-coding-agent", "reserved"), ("../escape", "agent id")] {
        let mut invalid = request.clone();
        invalid.id = id.into();
        assert!(build_pi_sdk_agent_definition(&invalid)
            .unwrap_err()
            .contains(reason));
    }
    let mut invalid = request;
    invalid.detection_paths.clear();
    invalid.detection_commands.clear();
    assert!(build_pi_sdk_agent_definition(&invalid)
        .unwrap_err()
        .contains("at least one"));
}
#[tokio::test]
async fn history_unrelated_definition_is_not_overwritten() {
    let (_directory, request) = fixture().await;
    let path = Path::new(&request.data_dir).join("agents.d.local/acme-code.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let body=json!({"id":"acme-code","displayName":"Unrelated","deployMode":"detection-only","detection":{"paths":request.detection_paths,"commands":[]}}).to_string();
    std::fs::write(&path, &body).unwrap();
    assert!(register_pi_sdk_agent(request)
        .await
        .unwrap_err()
        .contains("not managed as PI SDK"));
    assert_eq!(std::fs::read_to_string(path).unwrap(), body);
}
#[tokio::test]
async fn history_missing_pi_runtime_never_injects_settings() {
    let (_directory, request) = fixture().await;
    std::fs::remove_file(Path::new(&request.data_dir).join("plugins/pi-coding-agent/index.mjs"))
        .unwrap();
    let settings = Path::new(&request.agent_dir).join("settings.json");
    assert!(register_pi_sdk_agent(request)
        .await
        .unwrap_err()
        .contains("runtime is missing"));
    assert!(!settings.exists());
}
#[tokio::test]
async fn history_dedicated_agent_dir_checks_duplicate_default_and_override() {
    if let Ok(mode) = std::env::var("PILOT_SDK_HISTORY_CHILD") {
        let (_directory, request) = fixture().await;
        register_pi_sdk_agent(request.clone()).await.unwrap();
        let mut duplicate = request.clone();
        duplicate.id = "other-code".into();
        duplicate.name = "Other".into();
        assert!(register_pi_sdk_agent(duplicate)
            .await
            .unwrap_err()
            .contains("already registered to PI SDK Agent acme-code"));
        let mut reserved = request;
        reserved.id = "reserved-dir-code".into();
        reserved.agent_dir = if mode == "default" {
            resolve_home("~/.pi/agent")
        } else {
            std::env::var("PI_CODING_AGENT_DIR").unwrap()
        };
        assert!(register_pi_sdk_agent(reserved)
            .await
            .unwrap_err()
            .contains("must be dedicated"));
        return;
    }
    for mode in ["default", "override"] {
        let home = tempfile::tempdir().unwrap();
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command.env_clear().arg("--exact").arg("pi_sdk::pi_sdk_agent_registry::historical_contracts::history_dedicated_agent_dir_checks_duplicate_default_and_override").arg("--nocapture")
            .env("HOME",home.path()).env("USERPROFILE",home.path()).env("PILOT_SDK_HISTORY_CHILD",mode);
        for key in ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        if mode == "override" {
            command.env("PI_CODING_AGENT_DIR", home.path().join("pi-override"));
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{mode}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
#[tokio::test]
async fn history_concurrent_registrations_preserve_one_identity_and_one_extension() {
    let (_directory, request) = fixture().await;
    let mut first = request.clone();
    first.id = "first-code".into();
    first.name = "first-code".into();
    let mut second = request.clone();
    second.id = "second-code".into();
    second.name = "second-code".into();
    let (a, b) = tokio::join!(register_pi_sdk_agent(first), register_pi_sdk_agent(second));
    let results = [a, b];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert!(results
        .iter()
        .find_map(|result| result.as_ref().err())
        .unwrap()
        .contains("registry is busy"));
    assert_eq!(
        list_registered_pi_sdk_agents(&request.data_dir).await.len(),
        1
    );
    assert_eq!(
        settings(&request)["extensions"].as_array().unwrap().len(),
        1
    );
    assert!(!Path::new(&request.data_dir)
        .join(PI_SDK_REGISTRY_LOCK_FILE)
        .exists());
}

#[tokio::test]
async fn history_legacy_equivalent_wrapper_paths_repair_without_touching_foreign_extensions() {
    let (_directory, request) = fixture().await;
    let registered = register_pi_sdk_agent(request.clone()).await.unwrap();
    // Both aliases point at the actual published file. The repeated separator
    // also exercises normalization on Unix; old Windows substitution mixed
    // native dataDir separators with the forward-slash SDK suffix.
    let legacy = format!(
        "{}/plugins//pi-coding-agent/agents/acme-code.mjs",
        request.data_dir
    );
    let mixed = format!(
        "{}/plugins/pi-coding-agent/agents/acme-code.mjs",
        request.data_dir
    );
    assert!(Path::new(&legacy).is_file());
    let foreign = json!("../foreign-extension.mjs");
    let object = json!({"package":"keep-unknown-shape"});
    let body = json!({"keepMe":true,"extensions":[foreign,legacy,object,mixed]});
    std::fs::write(&registered.settings_path, body.to_string()).unwrap();
    assert!(
        doctor_pi_sdk_agent(&request.data_dir, "acme-code")
            .await
            .unwrap()
            .healthy
    );
    register_pi_sdk_agent(request.clone()).await.unwrap();
    assert_eq!(
        settings(&request),
        json!({"keepMe":true,"extensions":[foreign,registered.wrapper_path,object]})
    );
    unregister_pi_sdk_agent(&request.data_dir, "acme-code")
        .await
        .unwrap();
    assert_eq!(
        settings(&request),
        json!({"keepMe":true,"extensions":[foreign,object]})
    );
}
