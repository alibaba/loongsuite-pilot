use super::*;
use crate::utils::{resolve_home_with, EnvSource, HomeResolutionOptions};
#[tokio::test]
async fn isolated_l21_all_builtin_targets_stay_under_effective_home_and_inherited_overrides_remain_unchanged(
) {
    // A filtered native child isolates the original global-environment oracle
    // from other concurrently running Rust tests without mutating parent env.
    if std::env::var_os("PILOT_HISTORY_ISOLATED_HOME_CHILD").is_none() {
        let run_root = tempfile::tempdir().unwrap();
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command.args(["--exact","deployment::agent_def_loader::isolated_home_history_contract_tests::isolated_l21_all_builtin_targets_stay_under_effective_home_and_inherited_overrides_remain_unchanged","--nocapture"])
            .env_clear().env("PILOT_HISTORY_ISOLATED_HOME_CHILD","1").env("HOME",run_root.path()).env("USERPROFILE",run_root.path())
            .kill_on_drop(true);
        for key in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let output = tokio::time::timeout(std::time::Duration::from_secs(5), command.output())
            .await
            .unwrap()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("sandbox");
    let keys = [
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "XDG_CONFIG_HOME",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "GROK_HOME",
        "HERMES_HOME",
        "PI_CODING_AGENT_DIR",
        "DSH_HOME",
        "OPENCLAW_CONFIG_PATH",
        "OPENCLAW_STATE_DIR",
    ];
    let process_before: Vec<_> = keys
        .iter()
        .map(|k| ((*k).to_owned(), std::env::var_os(k)))
        .collect();
    let inherited: HashMap<String, String> = keys
        .iter()
        .map(|k| {
            (
                (*k).into(),
                root.path()
                    .join("outside")
                    .join(k)
                    .to_string_lossy()
                    .into_owned(),
            )
        })
        .collect();
    let before = inherited.clone();
    let mut isolated = inherited.clone();
    for (key, relative) in [
        ("HOME", ""),
        ("USERPROFILE", ""),
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
        isolated.insert(
            key.into(),
            if relative.is_empty() {
                home.to_string_lossy().into_owned()
            } else {
                home.join(relative).to_string_lossy().into_owned()
            },
        );
    }
    isolated.insert("OPENCLAW_CONFIG_PATH".into(), String::new());
    isolated.insert("OPENCLAW_STATE_DIR".into(), String::new());
    let opts = HomeResolutionOptions {
        env: EnvSource::Isolated(&isolated),
        platform: None,
        homedir: None,
    };
    assert_eq!(resolve_home_with("~", &opts), home.to_string_lossy());
    assert_eq!(isolated["DSH_HOME"], home.join(".dsh").to_string_lossy());
    assert_eq!(isolated["OPENCLAW_CONFIG_PATH"], "");
    assert_eq!(isolated["OPENCLAW_STATE_DIR"], "");
    let definitions = AgentDefLoader::new(AgentDefLoaderOptions {
        builtin_dir: Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("agents.d")
            .to_string_lossy()
            .into_owned(),
        local_dir: home.join("agents.d.local").to_string_lossy().into_owned(),
        pilot_dir: env!("CARGO_MANIFEST_DIR").into(),
        data_dir: home.to_string_lossy().into_owned(),
    })
    .with_env(isolated)
    .load()
    .await;
    assert!(!definitions.is_empty());
    for def in definitions {
        let mut targets = Vec::new();
        if let Some(hook) = def.hook {
            targets.push(hook.settings_path);
            if let Some(trust) = hook.trust_toml {
                targets.push(trust.config_path);
            }
        }
        if let Some(plugin) = def.plugin_inject {
            targets.extend(plugin.config_paths);
        }
        if let Some(directory) = def.directory_plugin {
            targets.push(directory.target_dir);
        }
        for target in targets {
            let path = Path::new(&target);
            assert!(path.is_absolute(), "{} {target}", def.id);
            assert!(
                path.starts_with(&home),
                "{} {target} escaped {}",
                def.id,
                home.display()
            );
        }
    }
    assert_eq!(inherited, before);
    assert_eq!(
        keys.iter()
            .map(|k| ((*k).to_owned(), std::env::var_os(k)))
            .collect::<Vec<_>>(),
        process_before
    );
}
