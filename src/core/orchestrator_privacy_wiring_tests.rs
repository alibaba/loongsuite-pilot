//! Real Orchestrator source factory under isolated process environment.
use super::*;
use crate::checkpoints::InputState;
use crate::multimodal::types::{UploadItem, UploadOptions, Uploader};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::process::Stdio;

#[derive(Default)]
struct Uploads(Mutex<Vec<UploadItem>>);
#[async_trait]
impl Uploader for Uploads {
    async fn upload(&self, item: UploadItem, _: UploadOptions) -> bool {
        self.0.lock().unwrap().push(item);
        true
    }
    async fn shutdown(&self) {}
}
fn rows(directory: &Path) -> Vec<Value> {
    let Ok(files) = fs::read_dir(directory) else {
        return Vec::new();
    };
    files
        .filter_map(Result::ok)
        .flat_map(|file| {
            fs::read_to_string(file.path())
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect::<Vec<_>>()
        })
        .collect()
}
fn config(root: &Path, private: &Path) -> AnalyticsConfig {
    let env = HashMap::new();
    let file = json!({
        "dataDir":root,"dashboard":{"enabled":false},"autoUpdate":{"enabled":false},"jsonl":{"enabled":false},
        "privacy":{"excludeWorkspaces":[private]},
        "agents":{"qoder":{"multimodal":{"uploadMode":"input","allowedRootPaths":[root]}}}
    });
    let mut config = super::super::config_loader::assemble_config(
        Some(&file),
        None,
        &super::super::config_loader::ConfigSources {
            env: &env,
            platform: crate::utils::Platform::current(),
            hostname: "isolated-privacy",
            config_path: "isolated-privacy.json",
            global_poll_ms: None,
        },
    )
    .unwrap();
    config.multimodal = Some(crate::types::MultimodalRuntimeConfig {
        storage: crate::types::MultimodalStorage::Sls {
            target: crate::types::MultimodalSlsTarget {
                endpoint: "http://127.0.0.1:1".into(),
                project: "fixture".into(),
                logstore: "privacy".into(),
            },
            auth: crate::types::MultimodalStorageAuth::Anonymous,
        },
        storage_base_path: "sls://fixture/privacy".into(),
    });
    config
}
async fn actual_factory_cases(home: &Path) {
    use base64::Engine;
    let image_bytes=base64::engine::general_purpose::STANDARD.decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1cAAAAASUVORK5CYII="
    ).unwrap();
    let mut failures = Vec::new();
    for variant in ["qoder", "qoder-cli"] {
        for private_case in [true, false] {
            let root = home.join(format!(
                "{variant}-{}",
                if private_case { "private" } else { "public" }
            ));
            let private = root.join("private");
            let public = root.join("public");
            fs::create_dir_all(&private).unwrap();
            fs::create_dir_all(&public).unwrap();
            let cwd = if private_case { &private } else { &public };
            let image = cwd.join("shot.png");
            fs::write(&image, &image_bytes).unwrap();
            let logs = root.join("logs").join("qoder").join("history");
            fs::create_dir_all(&logs).unwrap();
            let name = format!("qoder-{}.jsonl", crate::utils::get_today_date_string());
            let id = if private_case {
                "private-source"
            } else {
                "public-source"
            };
            let entry=json!({
                "event.id":id,"event.name":"tool.result","gen_ai.agent.type":variant,
                "gen_ai.session.id":format!("{id}-session"),"gen_ai.turn.id":format!("{id}-turn"),
                "agent.qoder.cwd":cwd,"workspace.path":cwd,"git.repo":"synthetic/repo","git.branch":"fixture",
                "gen_ai.tool.call.result":format!("Image file: {}",image.display()),
                "time_unix_nano":"1780000000000000000"
            }).to_string()+"\n";
            fs::write(logs.join(&name), &entry).unwrap();
            let store = Arc::new(StateStore::new(root.join("state.json")));
            store.set(
                "qoder-trace",
                InputState::new()
                    .with_last_file(name)
                    .with_last_offset(0.0)
                    .with_extra(json!({"hookHistoryInitialized":true})),
            );
            let config = config(&root, &private);
            assert!(is_agent_multimodal_enabled(
                Some("qoder"),
                config.agents.get("qoder").unwrap()
            ));
            let orchestrator = Arc::new(Orchestrator::new(config));
            orchestrator.inputs.set_state_store(Arc::clone(&store));
            // This is the real configured manager gate used by start(). No
            // source/runtime policy is manually installed by the test.
            orchestrator.inputs.set_workspace_policy(
                WorkspacePolicy::new(
                    &[private.to_string_lossy().into_owned()],
                    Some(
                        root.join("state")
                            .join("workspace-exclusions")
                            .to_string_lossy()
                            .into_owned(),
                    ),
                )
                .unwrap(),
            );
            orchestrator.inputs.set_user_id("synthetic-user");
            let uploader = Arc::new(Uploads::default());
            let processor =
                MultimodalProcessor::new(Some("sls://fixture/privacy"), uploader.clone(), None)
                    .unwrap();
            // Only the initialized global upload boundary is controlled. The
            // production factory constructs the actual Qoder source itself.
            orchestrator
                .inputs
                .set_multimodal_processor(processor.clone());
            *orchestrator.multimodal_ready.lock().unwrap() = true;
            let output = root.join("output");
            let jsonl = Arc::new(JsonlFlusher::new(JsonlFlusherConfig {
                enabled: true,
                output_dir: output.to_string_lossy().into_owned(),
                rotate_daily: false,
                max_file_size_mb: 1.into(),
            }));
            jsonl.start().await.unwrap();
            orchestrator.inputs.set_flusher(jsonl.clone());
            let detections = orchestrator.register_all_inputs(&store).await;
            assert!(detections.iter().any(|d| d.id() == "qoder-trace"));
            orchestrator.inputs.start_input("qoder-trace").await;
            tokio::time::timeout(Duration::from_secs(3), async {
                while store.get_offset("qoder-trace") < entry.len() as f64
                    || store.waiting_for_output()
                {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("source/read and actual manager queue did not settle");
            orchestrator.inputs.stop_all().await;
            processor.shutdown(1500).await;
            jsonl.shutdown().await.unwrap();
            let output = rows(&output);
            let uploads = uploader.0.lock().unwrap();
            eprintln!("FACTORY_PRIVACY variant={variant} private={private_case} uploader_calls={} final_jsonl_rows={}",uploads.len(),output.len());
            if private_case {
                assert!(output.is_empty(), "manager final privacy control failed");
                if !uploads.is_empty() {
                    failures.push(format!("{variant}: excluded workspace reached real uploader {} time(s) before final manager filtering",uploads.len()));
                }
            } else {
                assert_eq!(output.len(), 1, "positive source/export control");
                assert_eq!(output[0]["event.id"], "public-source");
                assert!(
                    output[0]["gen_ai.tool.call.result"].is_array(),
                    "actual image conversion missing"
                );
                assert_eq!(uploads.len(), 1, "positive uploader control");
                assert_eq!(uploads[0].data.as_ref(), Some(&image_bytes));
                assert_eq!(uploads[0].content_type, "image/png");
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn actual_orchestrator_factory_blocks_qoder_upload_before_final_manager_filter() {
    const FLAG: &str = "PILOT_PRIVACY_REAL_FACTORY_CHILD";
    if let Some(home) = std::env::var_os(FLAG) {
        actual_factory_cases(Path::new(&home)).await;
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command.args(["--exact","core::orchestrator::privacy_wiring_contracts::actual_orchestrator_factory_blocks_qoder_upload_before_final_manager_filter","--nocapture"])
        .env_clear().env(FLAG,&home).env("HOME",&home).env("USERPROFILE",&home)
        .env("APPDATA",home.join("appdata")).env("LOCALAPPDATA",home.join("localappdata"))
        .env("XDG_CONFIG_HOME",home.join("config")).env("XDG_CACHE_HOME",home.join("cache"))
        .env("XDG_DATA_HOME",home.join("data")).env("XDG_STATE_HOME",home.join("state"))
        .env("CODEX_HOME",home.join("codex")).env("CLAUDE_CONFIG_DIR",home.join("claude"))
        .env("LOONGSUITE_PILOT_DATA_DIR",home.join("data-root")).env("LOONGSUITE_PILOT_CACHE_DIR",home.join("pilot-cache"))
        .env("GIT_CONFIG_GLOBAL",home.join("no-git-config")).env("GIT_CONFIG_NOSYSTEM","1")
        .env("PATH",home.join("no-runtimes")).current_dir(&home)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    for key in [
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "ComSpec",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "PATHEXT",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let output = tokio::time::timeout(
        Duration::from_secs(15),
        command.spawn().unwrap().wait_with_output(),
    )
    .await
    .expect("isolated real factory process timed out")
    .unwrap();
    assert!(
        output.status.success(),
        "real factory child failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
