use serde_json::json;
use std::{collections::HashMap, path::Path};
#[tokio::test]
async fn scope_l31_actual_build_and_eager_never_create_or_overwrite_hook_install_report_or_signal()
{
    const CHILD: &str = "PILOT_BUILD_SCOPE_HISTORY_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let run = tempfile::tempdir().unwrap();
        let home = run.path().join("home");
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command.args(["--exact","deployment::deployment_scope::history_contract_tests::scope_l31_actual_build_and_eager_never_create_or_overwrite_hook_install_report_or_signal","--nocapture"])
            .env_clear().env(CHILD,"1").env("HOME",&home).env("USERPROFILE",&home).env("PATH",run.path().join("no-runtimes"))
            .kill_on_drop(true);
        for (key, relative) in [
            ("APPDATA", "AppData/Roaming"),
            ("LOCALAPPDATA", "AppData/Local"),
            ("XDG_CONFIG_HOME", ".config"),
            ("CLAUDE_CONFIG_DIR", ".claude"),
            ("CODEX_HOME", ".codex"),
            ("GROK_HOME", ".grok"),
            ("HERMES_HOME", ".hermes"),
            ("PI_CODING_AGENT_DIR", ".pi/agent"),
            ("DSH_HOME", ".dsh"),
        ] {
            command.env(key, home.join(relative));
        }
        command
            .env("OPENCLAW_CONFIG_PATH", "")
            .env("OPENCLAW_STATE_DIR", "");
        for key in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let out = tokio::time::timeout(std::time::Duration::from_secs(5), command.output())
            .await
            .unwrap()
            .unwrap();
        assert!(
            out.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        return;
    }
    for report_exists in [false, true] {
        let t = tempfile::tempdir().unwrap();
        let data = t.path().join("data");
        let home = t.path().join("cursor-home");
        std::fs::create_dir_all(data.join("agents.d.local")).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let pilot = super::super::deploy_command::resolve_pilot_dir(
            data.to_str().unwrap(),
            &[env!("CARGO_MANIFEST_DIR")],
        )
        .unwrap();
        let loader = super::super::AgentDefLoader::new(super::super::AgentDefLoaderOptions {
            builtin_dir: Path::new(&pilot)
                .join("agents.d")
                .to_string_lossy()
                .into_owned(),
            local_dir: data.join("agents.d.local").to_string_lossy().into_owned(),
            pilot_dir: pilot.clone(),
            data_dir: data.to_string_lossy().into_owned(),
        });
        let definitions = loader.load().await;
        assert!(!definitions.is_empty());
        let mut agents = serde_json::Map::new();
        for def in &definitions {
            agents.insert(def.id.clone(), json!({"enabled":false}));
        }
        agents.insert("cursor".into(), json!({"enabled":true}));
        let mut cursor: crate::types::AgentDefinition = serde_json::from_slice(
            &std::fs::read(Path::new(&pilot).join("agents.d/cursor.json")).unwrap(),
        )
        .unwrap();
        cursor.detection.paths = vec![home.to_string_lossy().into_owned()];
        cursor.detection.commands.clear();
        let settings = home.join("hooks.json");
        cursor.hook.as_mut().unwrap().settings_path = settings.to_string_lossy().into_owned();
        std::fs::write(
            data.join("agents.d.local/cursor.json"),
            serde_json::to_vec(&cursor).unwrap(),
        )
        .unwrap();
        let file = json!({"dataDir":data,"agents":agents,"dashboard":{"enabled":false},"autoUpdate":{"enabled":false}});
        std::fs::write(data.join("config.json"), serde_json::to_vec(&file).unwrap()).unwrap();
        let env = HashMap::new();
        let config = crate::core::assemble_config(
            Some(&file),
            None,
            &crate::core::ConfigSources {
                env: &env,
                platform: crate::utils::Platform::current(),
                hostname: "history",
                config_path: "history.json",
                global_poll_ms: None,
            },
        )
        .unwrap();
        let report = std::path::PathBuf::from(super::super::hook_install_result_path(
            data.to_str().unwrap(),
        ));
        let signal = std::path::PathBuf::from(super::super::hook_install_signal_path(
            data.to_str().unwrap(),
        ));
        let report_bytes=b"{\"schema\":1,\"identity\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"scope\":\"named\",\"ts\":\"2026-01-01T00:00:00Z\",\"agents\":[],\"alarmSent\":false}\n";
        let signal_bytes = b"preserve existing named scope signal\n";
        if report_exists {
            std::fs::write(&report, report_bytes).unwrap();
            std::fs::write(&signal, signal_bytes).unwrap();
        }
        let before = report_exists.then(|| {
            (
                std::fs::metadata(&report).unwrap().modified().unwrap(),
                std::fs::metadata(&signal).unwrap().modified().unwrap(),
            )
        });
        for _ in 0..2 {
            let (code, results, unmet) = super::super::deploy_loaded_config(
                &config,
                &["--require=cursor".into(), "--json".into()],
                &[&pilot],
            )
            .await
            .unwrap();
            assert_eq!(code, 0, "{results:?} {unmet:?}");
            assert!(unmet.is_empty());
            assert!(results.iter().any(|r| r.agent_id == "cursor" && r.success));
            assert!(settings.is_file());
        }
        let code = super::super::eager_injection::run_cli(&[
            "--agents=cursor".into(),
            format!("--data-dir={}", data.display()),
            format!("--pilot-dir={pilot}"),
        ])
        .await;
        assert_eq!(code, 0);
        assert_eq!(report.exists(), report_exists);
        assert_eq!(signal.exists(), report_exists);
        if let Some((report_time, signal_time)) = before {
            assert_eq!(std::fs::read(&report).unwrap(), report_bytes);
            assert_eq!(std::fs::read(&signal).unwrap(), signal_bytes);
            assert_eq!(
                std::fs::metadata(&report).unwrap().modified().unwrap(),
                report_time
            );
            assert_eq!(
                std::fs::metadata(&signal).unwrap().modified().unwrap(),
                signal_time
            );
        }
    }
}
