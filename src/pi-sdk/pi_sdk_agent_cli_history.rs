//! Exercise the actual logger destination without mutating the parent test process.
use super::*;
#[tokio::test]
async fn history_json_mode_redirects_actual_operational_logs_in_an_isolated_process() {
    const CHILD: &str = "PILOT_PI_CLI_HISTORY_ROOT";
    if let Some(directory) = std::env::var_os(CHILD) {
        let directory = std::path::PathBuf::from(directory);
        let data = directory.join("pilot-data");
        let agent = directory.join("json-agent-dir");
        let detected = directory.join("json-detected");
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
        crate::utils::create_logger("PiCliHistory").info("pilot_sdk_before_json_redirect", None);
        println!("PILOT_JSON_BEGIN");
        let args = vec![
            "agent",
            "register",
            "pi-sdk",
            "--id",
            "json-code",
            "--name",
            "JSON Code",
            "--agent-dir",
            agent.to_str().unwrap(),
            "--detect-path",
            detected.to_str().unwrap(),
            "--json",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
        let mut io = PiSdkCliIo::default();
        assert!(
            handle_pi_sdk_agent_cli_with(&args, &mut io, Some(data.to_string_lossy().into_owned()))
                .await
        );
        assert!(io.exit_code.is_none());
        assert!(io.err.is_empty());
        assert_eq!(io.log.len(), 1);
        println!("{}", io.log[0]);
        println!("PILOT_JSON_END");
        crate::utils::create_logger("PiCliHistory").info("pilot_sdk_after_json_redirect", None);
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command.env_clear()
        .args(["--exact", "pi_sdk::pi_sdk_agent_cli::historical_contracts::history_json_mode_redirects_actual_operational_logs_in_an_isolated_process", "--nocapture"])
        .env(CHILD, directory.path())
        .env("HOME", directory.path()).env("USERPROFILE", directory.path());
    for key in ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let output = command.output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{stdout}\n{stderr}");
    assert!(
        stdout.contains("pilot_sdk_before_json_redirect"),
        "{stdout}"
    );
    assert!(
        !stderr.contains("pilot_sdk_before_json_redirect"),
        "{stderr}"
    );
    assert!(
        !stdout.contains("pilot_sdk_after_json_redirect"),
        "{stdout}"
    );
    assert!(stderr.contains("pilot_sdk_after_json_redirect"), "{stderr}");
    let command_stdout = stdout
        .split_once("PILOT_JSON_BEGIN")
        .unwrap()
        .1
        .split_once("PILOT_JSON_END")
        .unwrap()
        .0;
    // Console emits one pretty JSON object. Parse the complete output so a
    // second object or an operational record is rejected, regardless of lines.
    let record: Value = serde_json::from_str(command_stdout).unwrap();
    assert_eq!(record["id"], "json-code");
    assert_eq!(record["name"], "JSON Code");
}
