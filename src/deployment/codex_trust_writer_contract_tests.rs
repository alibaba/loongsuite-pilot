//! Historical trust serialization contracts exercised through real public writers.
use super::*;
const KEY: &str = "/abs/hooks.json:session_start:0:0";
const OTHER:&str="[\"hooks\".\"state\".\"third-party:stop:0:0\"]\nenabled = false\ntrusted_hash = \"sha256:OTHER\"\n";
struct Fixture {
    _root: tempfile::TempDir,
    path: String,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let path = root
            .path()
            .join("config.toml")
            .to_string_lossy()
            .into_owned();
        Self { _root: root, path }
    }
    fn write(&self, raw: &str) {
        std::fs::write(&self.path, raw).unwrap();
    }
    fn read(&self) -> String {
        std::fs::read_to_string(&self.path).unwrap()
    }
    fn opts(&self) -> TrustOpts {
        TrustOpts::Installed(InstalledTrustOpts {
            config_path: self.path.clone(),
            hooks_json_abs_path: "/abs/hooks.json".into(),
            locations: HashMap::from([(
                "SessionStart".into(),
                location("SessionStart", "pilot session-start", 0, 0, Some("*")),
            )]),
            retired_keys: vec![],
            marker: "otel-codex-hook".into(),
        })
    }
    fn hash(&self) -> String {
        compute_installed_hook_trust_hash(
            &location("SessionStart", "pilot session-start", 0, 0, Some("*")),
            TrustPlatform::current(),
        )
        .unwrap()
    }
    fn state(&self) -> toml::Table {
        toml::from_str::<toml::Value>(&self.read()).unwrap()["hooks"]["state"]
            .as_table()
            .unwrap()
            .clone()
    }
    async fn valid_and_idempotent(&self, opts: &TrustOpts) {
        assert_eq!(
            verify_trust_hashes(opts).unwrap(),
            VerifyResult {
                valid: true,
                mismatches: vec![]
            }
        );
        let before = self.read();
        assert!(!write_trusted_hashes(opts).await.unwrap());
        assert_eq!(self.read(), before);
    }
}
fn location(
    event: &str,
    command: &str,
    group: usize,
    handler: usize,
    matcher: Option<&str>,
) -> InstalledCodexHookLocation {
    InstalledCodexHookLocation {
        event_name: event.into(),
        event_key: event_key(event).unwrap().into(),
        group_index: group,
        handler_index: handler,
        matcher: matcher.map(str::to_owned),
        handler: InstalledCodexCommandHandler {
            command: command.into(),
            command_windows: None,
            timeout: None,
            r#async: None,
            status_message: None,
            additional_context_limit: None,
        },
    }
}
fn headers() -> Vec<String> {
    vec![
        format!("[\"hooks\".\"state\".\"{KEY}\"]"),
        format!("[hooks.\"state\".'{KEY}']"),
        format!("['hooks'.state.\"{KEY}\"]"),
        format!("[ 'hooks' . 'state' . '{KEY}' ] # preserved comment"),
        r#"["\u0068ooks"."st\u0061te"."/abs/hooks.json:session_start:0:0"]"#.into(),
    ]
}
fn representation(index: usize, hash: &str) -> String {
    match index {
        0 => format!("[\"hooks\".\"state\".\"{KEY}\"]\ntrusted_hash = \"{hash}\"\n"),
        1 => format!("hooks.state.\"{KEY}\".trusted_hash = \"{hash}\"\n"),
        2 => format!("[hooks.state]\n\"{KEY}\".trusted_hash = \"{hash}\"\n"),
        3 => format!("hooks = {{ state = {{ \"{KEY}\" = {{ trusted_hash = \"{hash}\" }} }} }}\n"),
        _ => unreachable!(),
    }
}
fn marked(key: &str, hash: &str, enabled: Option<bool>) -> String {
    format!("# BEGIN otel-codex-hook trust\n[hooks.state.\"{key}\"]\n{}trusted_hash = \"{hash}\"\n# END otel-codex-hook trust\n",enabled.map(|v|format!("enabled = {v}\n")).unwrap_or_default())
}
fn mixed(f: &Fixture, retired: Vec<String>, stop: bool) -> TrustOpts {
    let TrustOpts::Installed(mut opts) = f.opts() else {
        unreachable!()
    };
    opts.retired_keys = retired;
    if stop {
        opts.locations
            .insert("Stop".into(), location("Stop", "pilot stop", 0, 0, None));
    }
    TrustOpts::Installed(opts)
}
#[tokio::test]
async fn stale_unescaped_windows_key_is_repaired_and_decodes_to_exact_native_path() {
    let f = Fixture::new();
    let path = r"C:\Users\Administrator\.codex\hooks.json";
    f.write(&format!("# BEGIN otel-codex-hook trust\n[hooks.state.\"{path}:stop:0:0\"]\ntrusted_hash = \"sha256:STALE\"\n# END otel-codex-hook trust\n"));
    let opts=TrustOpts::Legacy(LegacyTrustOpts{config_path:f.path.clone(),hooks_json_abs_path:path.into(),hook_events:vec!["Stop".into()],event_to_command:HashMap::from([("Stop".into(),r#"powershell.exe -File "C:\Users\Administrator\.loongsuite-pilot\hooks\codex-hook.ps1" stop"#.into())]),event_to_group_index:HashMap::from([("Stop".into(),0)]),retired_keys:vec![],marker:"otel-codex-hook".into()});
    assert!(write_trusted_hashes(&opts).await.unwrap());
    assert!(!f.read().contains("STALE"));
    assert!(f
        .read()
        .contains(r#"[hooks.state."C:\\Users\\Administrator\\.codex\\hooks.json:stop:0:0"]"#));
    assert_eq!(f.read().matches("[hooks.state.").count(), 1);
    assert!(f.state().contains_key(&format!("{path}:stop:0:0")));
    f.valid_and_idempotent(&opts).await;
}
#[tokio::test]
async fn bypass_field_and_bare_stale_owned_entries_are_repaired_with_mismatch_diagnostics() {
    let f = Fixture::new();
    let opts = f.opts();
    assert!(write_trusted_hashes(&opts).await.unwrap());
    f.write(&format!("bypass_hook_trust = true\n{}", f.read()));
    let result = verify_trust_hashes(&opts).unwrap();
    assert!(!result.valid);
    assert_eq!(
        result.mismatches,
        ["unsupported config field bypass_hook_trust"]
    );
    assert!(write_trusted_hashes(&opts).await.unwrap());
    assert!(!f.read().contains("bypass_hook_trust"));
    f.valid_and_idempotent(&opts).await;
    f.write(&format!(
        "[hooks.state.\"{KEY}\"]\ntrusted_hash = \"sha256:STALE\"\n{OTHER}"
    ));
    let result = verify_trust_hashes(&opts).unwrap();
    assert!(!result.valid);
    assert!(result.mismatches[0].contains("hash mismatch"));
    assert!(write_trusted_hashes(&opts).await.unwrap());
    assert!(!f.read().contains("STALE"));
    assert_eq!(f.read().matches("[hooks.state.\"").count(), 1);
    assert!(f.read().contains(OTHER));
    f.valid_and_idempotent(&opts).await;
}
#[tokio::test]
async fn exact_removal_preserves_interleaved_user_tables_and_third_party_disabled_trust() {
    for third in [false, true] {
        let f = Fixture::new();
        let original=format!("# BEGIN otel-codex-hook trust\n[hooks.state.\"{KEY}\"]\ntrusted_hash = \"sha256:PILOT\"\n[marketplaces.openai-bundled]\nsource_type = \"local\"\n{}# END otel-codex-hook trust\n",if third{OTHER}else{""});
        f.write(&original);
        assert!(
            remove_trust_block(&f.path, "otel-codex-hook", &[KEY.into()])
                .await
                .unwrap()
        );
        let after = f.read();
        assert!(!after.contains(KEY));
        assert!(!after.contains("sha256:PILOT"));
        assert!(!after.contains("# BEGIN"));
        assert!(!after.contains("# END"));
        assert!(after.contains("[marketplaces.openai-bundled]\nsource_type = \"local\""));
        if third {
            assert!(after.contains(OTHER));
            assert_eq!(
                f.state()["third-party:stop:0:0"]["enabled"].as_bool(),
                Some(false)
            );
        } else {
            assert!(!after.contains("hooks.state"));
            assert!(!after.contains("trusted_hash"));
        }
    }
}
#[tokio::test]
async fn five_event_reconciliation_uses_real_group_indices_and_preserves_foreign_paths() {
    let f = Fixture::new();
    let events = [
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "Stop",
    ];
    let groups = [1, 1, 2, 2, 0];
    let opts = TrustOpts::Installed(InstalledTrustOpts {
        config_path: f.path.clone(),
        hooks_json_abs_path: "/abs/hooks.json".into(),
        locations: events
            .iter()
            .zip(groups)
            .map(|(event, group)| {
                (
                    event.to_string(),
                    location(event, &format!("pilot {event}"), group, 0, None),
                )
            })
            .collect(),
        retired_keys: vec![],
        marker: "otel-codex-hook".into(),
    });
    let other =
        "[hooks.state.\"/other/hooks.json:session_start:0:0\"]\ntrusted_hash = \"sha256:OTHER\"\n";
    f.write(other);
    assert!(write_trusted_hashes(&opts).await.unwrap());
    let after = f.read();
    assert!(after.contains(other));
    assert!(after.contains("[hooks.state.\"/abs/hooks.json:session_start:1:0\"]"));
    assert!(!after.contains("[hooks.state.\"/abs/hooks.json:session_start:0:0\"]"));
    assert!(after.contains("[hooks.state.\"/abs/hooks.json:pre_tool_use:2:0\"]"));
    assert!(after.contains("[hooks.state.\"/abs/hooks.json:stop:0:0\"]"));
    f.valid_and_idempotent(&opts).await;
}
#[tokio::test]
async fn disabled_state_is_preserved_only_for_same_key_and_same_installed_handler_hash() {
    for same in [false, true] {
        let f = Fixture::new();
        let loc = location(
            "SubagentStart",
            "pilot subagent-start",
            if same { 0 } else { 1 },
            if same { 0 } else { 1 },
            Some("*"),
        );
        let key = installed_hook_state_key("/abs/hooks.json", &loc);
        let hash = compute_installed_hook_trust_hash(&loc, TrustPlatform::current()).unwrap();
        let opts = TrustOpts::Installed(InstalledTrustOpts {
            config_path: f.path.clone(),
            hooks_json_abs_path: "/abs/hooks.json".into(),
            locations: HashMap::from([("SubagentStart".into(), loc)]),
            retired_keys: vec![],
            marker: "otel-codex-hook".into(),
        });
        f.write(&format!("{}{}{}",if same{"bypass_hook_trust = true\n"}else{"[hooks.state.\"/abs/hooks.json:subagent_start:0:0\"]\ntrusted_hash = \"sha256:THIRD_PARTY\"\n"},marked(&key,if same{&hash}else{"sha256:STALE"},Some(false)),if same{""}else{"\n"}));
        assert!(write_trusted_hashes(&opts).await.unwrap());
        let after = f.read();
        assert!(!after.contains("bypass_hook_trust"));
        assert!(!after.contains("STALE"));
        if same {
            assert_eq!(f.state()[&key]["enabled"].as_bool(), Some(false));
            assert!(after.contains(&hash));
        } else {
            assert!(!after.contains("enabled = false"));
            assert!(after.contains("sha256:THIRD_PARTY"));
        }
        f.valid_and_idempotent(&opts).await;
    }
}
#[tokio::test]
async fn all_five_equivalent_toml_headers_keep_valid_bytes_and_repair_stale_without_user_loss() {
    for header in headers() {
        let f = Fixture::new();
        let hash = f.hash();
        let opts = f.opts();
        let original = format!("{header}\n\"trusted_hash\" = '{hash}'\n\"enabled\" = false\n");
        f.write(&original);
        assert!(toml::from_str::<toml::Value>(&original).is_ok());
        f.valid_and_idempotent(&opts).await;
        assert_eq!(f.read(), original);
        f.write(&format!(
            "{header}\ntrusted_hash = 'sha256:STALE'\n\n{OTHER}"
        ));
        assert!(write_trusted_hashes(&opts).await.unwrap());
        assert!(f.read().contains(OTHER));
        assert!(!f.read().contains("STALE"));
        f.valid_and_idempotent(&opts).await;
    }
}
#[tokio::test]
async fn valid_duplicate_headers_collapse_with_explicit_disable_in_both_orders() {
    for reversed in [false, true] {
        let f = Fixture::new();
        let hash = f.hash();
        let opts = f.opts();
        let mut sections = [
            format!(
                "[\"hooks\".\"state\".\"{KEY}\"]\nenabled = false\ntrusted_hash = \"{hash}\"\n"
            ),
            format!("[hooks.state.\"{KEY}\"]\nenabled = true\ntrusted_hash = \"{hash}\"\n"),
        ];
        if reversed {
            sections.reverse();
        }
        f.write(&(sections.join("\n") + OTHER));
        assert!(toml::from_str::<toml::Value>(&f.read()).is_err());
        assert!(!verify_trust_hashes(&opts).unwrap().valid);
        assert!(write_trusted_hashes(&opts).await.unwrap());
        assert_eq!(f.state().len(), 2);
        assert_eq!(f.state()[KEY]["enabled"].as_bool(), Some(false));
        assert_eq!(f.state()[KEY]["trusted_hash"].as_str(), Some(hash.as_str()));
        assert!(f.read().contains(OTHER));
        f.valid_and_idempotent(&opts).await;
    }
}
#[tokio::test]
async fn four_retained_toml_representations_survive_removing_only_the_marked_duplicate() {
    for index in 0..4 {
        let f = Fixture::new();
        let hash = f.hash();
        let opts = f.opts();
        let retained = representation(index, &hash);
        f.write(&(retained.clone() + &marked(KEY, &hash, None)));
        assert!(write_trusted_hashes(&opts).await.unwrap());
        let after = f.read();
        assert!(after.contains(retained.trim()));
        assert!(!after.contains("# BEGIN"));
        assert!(!after.contains(&format!("[hooks.state.\"{KEY}\"]")));
        assert_eq!(f.state()[KEY]["trusted_hash"].as_str(), Some(hash.as_str()));
        f.valid_and_idempotent(&opts).await;
    }
}
#[tokio::test]
async fn stale_or_disabled_uneditable_dotted_duplicates_are_rejected_without_byte_changes() {
    let f = Fixture::new();
    let hash = f.hash();
    let opts = f.opts();
    for original in [format!("hooks.state.\"{KEY}\".trusted_hash = \"sha256:STALE\"\n\n{}",marked(KEY,&hash,None)),format!("hooks.state.\"{KEY}\".enabled = true\nhooks.state.\"{KEY}\".trusted_hash = \"{hash}\"\n\n{}",marked(KEY,&hash,Some(false)))]{f.write(&original);let err=write_trusted_hashes(&opts).await.unwrap_err();assert!(err.to_string().contains("uneditable Codex hook trust entry"));assert_eq!(f.read(),original);}
}

#[tokio::test]
async fn adding_other_current_keys_respects_three_extendable_forms_and_rejects_inline() {
    for index in 0..4 {
        let f = Fixture::new();
        let hash = f.hash();
        let opts = mixed(&f, vec![], true);
        let stop_key = "/abs/hooks.json:stop:0:0";
        let stop_hash = compute_installed_hook_trust_hash(
            &location("Stop", "pilot stop", 0, 0, None),
            TrustPlatform::current(),
        )
        .unwrap();
        let external = representation(index, &hash);
        let original=external.clone()+&format!("# BEGIN otel-codex-hook trust\n[hooks.state.\"{KEY}\"]\ntrusted_hash = \"{hash}\"\n[hooks.state.\"{stop_key}\"]\ntrusted_hash = \"{stop_hash}\"\n# END otel-codex-hook trust\n");
        f.write(&original);
        if index == 3 {
            assert!(write_trusted_hashes(&opts)
                .await
                .unwrap_err()
                .to_string()
                .contains("uneditable Codex hook trust entry"));
            assert_eq!(f.read(), original);
        } else {
            assert!(write_trusted_hashes(&opts).await.unwrap());
            assert!(f.read().contains(external.trim()));
            assert!(f.read().contains(&format!("[hooks.state.\"{stop_key}\"]")));
            assert!(!f.read().contains(&format!("[hooks.state.\"{KEY}\"]")));
            f.valid_and_idempotent(&opts).await;
        }
    }
    let f = Fixture::new();
    let original = representation(3, &f.hash());
    f.write(&original);
    let opts = mixed(&f, vec![], true);
    assert!(write_trusted_hashes(&opts)
        .await
        .unwrap_err()
        .to_string()
        .contains("uneditable Codex hook trust entry"));
    assert_eq!(f.read(), original);
    assert!(!verify_trust_hashes(&opts).unwrap().valid);
}
#[tokio::test]
async fn retired_tables_reconcile_dotted_current_keys_with_optional_duplicate_and_preserve_foreign_state(
) {
    for duplicate in [false, true] {
        let f = Fixture::new();
        let hash = f.hash();
        let retired = "/abs/hooks.json:pre_tool_use:0:0";
        let opts = mixed(&f, vec![retired.into()], false);
        let current = representation(1, &hash);
        let original = current.clone()
            + &format!("[hooks.state.\"{retired}\"]\ntrusted_hash = \"sha256:RETIRED\"\n")
            + &if duplicate {
                marked(KEY, &hash, None)
            } else {
                String::new()
            }
            + OTHER;
        f.write(&original);
        assert!(write_trusted_hashes(&opts).await.unwrap());
        let after = f.read();
        assert!(after.contains(current.trim()));
        assert!(after.contains(OTHER.trim()));
        assert!(!after.contains(retired));
        assert!(!after.contains("# BEGIN"));
        assert_eq!(f.state()[KEY]["trusted_hash"].as_str(), Some(hash.as_str()));
        assert_eq!(
            f.state()["third-party:stop:0:0"]["trusted_hash"].as_str(),
            Some("sha256:OTHER")
        );
        f.valid_and_idempotent(&opts).await;
    }
}
#[tokio::test]
async fn fallback_keeps_valid_dotted_current_but_refuses_uneditable_dotted_retired() {
    let f = Fixture::new();
    let hash = f.hash();
    let current = representation(1, &hash);
    let opts = f.opts();
    f.write(
        &(current.clone()
            + &format!("[hooks.state.\"{KEY}\"]\ntrusted_hash = \"sha256:STALE\"\n")
            + OTHER),
    );
    assert!(write_trusted_hashes(&opts).await.unwrap());
    assert!(f.read().contains(current.trim()));
    assert!(f.read().contains(OTHER.trim()));
    assert!(!f.read().contains("STALE"));
    f.valid_and_idempotent(&opts).await;
    let retired = "/abs/hooks.json:pre_tool_use:0:0";
    let original=format!("hooks.state.\"{retired}\".trusted_hash = \"sha256:RETIRED\"\n[hooks.state.\"{KEY}\"]\ntrusted_hash = \"{hash}\"\n{OTHER}");
    f.write(&original);
    assert!(
        write_trusted_hashes(&mixed(&f, vec![retired.into()], false))
            .await
            .unwrap_err()
            .to_string()
            .contains("uneditable Codex hook trust entry")
    );
    assert_eq!(f.read(), original);
}
#[tokio::test]
async fn unrelated_trust_inside_owned_markers_survives_duplicate_repair() {
    let f = Fixture::new();
    let hash = f.hash();
    let retained = representation(0, &hash);
    f.write(&(retained.clone()+&format!("# BEGIN otel-codex-hook trust\n[hooks.state.\"{KEY}\"]\ntrusted_hash = \"{hash}\"\n[hooks.state.\"third-party:stop:0:0\"]\nenabled = false\ntrusted_hash = \"sha256:OTHER\"\n# END otel-codex-hook trust\n")));
    assert!(write_trusted_hashes(&f.opts()).await.unwrap());
    assert!(f.read().contains(retained.trim()));
    assert!(f.read().contains("[hooks.state.\"third-party:stop:0:0\"]"));
    assert!(f.read().contains("trusted_hash = \"sha256:OTHER\""));
    assert_eq!(
        f.state()["third-party:stop:0:0"]["enabled"].as_bool(),
        Some(false)
    );
}
#[tokio::test]
async fn equivalent_headers_preserve_disable_and_support_both_precise_removal_apis() {
    for header in headers() {
        let f = Fixture::new();
        let hash = f.hash();
        f.write(&format!("bypass_hook_trust = true\n{header}\n'enabled' = false # disabled by user\ntrusted_hash = '{hash}'\n"));
        assert!(write_trusted_hashes(&f.opts()).await.unwrap());
        assert_eq!(f.state()[KEY]["enabled"].as_bool(), Some(false));
        for block in [true, false] {
            f.write(&format!("{header}\ntrusted_hash = '{hash}'\n\n{OTHER}"));
            let removed = if block {
                remove_trust_block(&f.path, "otel-codex-hook", &[KEY.into()]).await
            } else {
                remove_trust_state_keys(&f.path, &[KEY.into()]).await
            };
            assert!(removed.unwrap());
            assert!(!f.read().contains(KEY));
            assert!(f.read().contains(OTHER));
            assert!(toml::from_str::<toml::Value>(&f.read()).is_ok());
            let again = if block {
                remove_trust_block(&f.path, "otel-codex-hook", &[KEY.into()]).await
            } else {
                remove_trust_state_keys(&f.path, &[KEY.into()]).await
            };
            assert!(!again.unwrap());
        }
    }
}
#[tokio::test]
async fn literal_windows_trust_keys_preserve_backslashes_without_rewriting() {
    let f = Fixture::new();
    let hash = f.hash();
    let path = r"C:\Users\测试 User\.codex\hooks.json";
    let original =
        format!("[\"hooks\".'state'.'{path}:session_start:0:0']\ntrusted_hash = '{hash}'\n");
    f.write(&original);
    let TrustOpts::Installed(mut opts) = f.opts() else {
        unreachable!()
    };
    opts.hooks_json_abs_path = path.into();
    f.valid_and_idempotent(&TrustOpts::Installed(opts)).await;
    assert_eq!(f.read(), original);
}
#[tokio::test]
async fn fake_owned_tables_and_markers_inside_both_multiline_string_forms_are_inert() {
    for quote in ["\"\"\"", "\u{27}\u{27}\u{27}"] {
        let f = Fixture::new();
        let hash = f.hash();
        let instructions=format!("instructions = {quote}\n[hooks.state.\"{KEY}\"]\ntrusted_hash = \"{hash}\"\n# BEGIN otel-codex-hook trust\nbypass_hook_trust = true\n\n\n# END otel-codex-hook trust\n{quote}\n");
        f.write(&(instructions.clone() + OTHER));
        assert!(!verify_trust_hashes(&f.opts()).unwrap().valid);
        assert!(write_trusted_hashes(&f.opts()).await.unwrap());
        assert!(f.read().contains(&instructions));
        assert_eq!(f.state()[KEY]["trusted_hash"].as_str(), Some(hash.as_str()));
        assert!(
            remove_trust_block(&f.path, "otel-codex-hook", &[KEY.into()])
                .await
                .unwrap()
        );
        assert!(f.read().contains(&instructions));
        assert!(f.read().contains(OTHER));
    }
}
#[tokio::test]
async fn malformed_unrelated_toml_and_unterminated_owned_values_never_delete_user_configuration() {
    let f = Fixture::new();
    let hash = f.hash();
    for malformed in [
        "model = \"a\"\nmodel = \"b\"\n",
        "[broken\nvalue = 1\n",
        "model = \"unterminated\n",
        "[\"hooks\".\"state\".\"third-party\"]\na = 1\n[hooks.state.\"third-party\"]\na = 1\n",
    ] {
        let original = format!("{malformed}[hooks.state.\"{KEY}\"]\ntrusted_hash = \"{hash}\"\n");
        f.write(&original);
        assert!(!verify_trust_hashes(&f.opts()).unwrap().valid);
        assert!(write_trusted_hashes(&f.opts())
            .await
            .unwrap_err()
            .to_string()
            .contains("invalid Codex config.toml"));
        assert_eq!(f.read(), original);
        let _ = remove_trust_block(&f.path, "otel-codex-hook", &[KEY.into()]).await;
        assert_eq!(f.read(), original);
        assert!(!remove_trust_state_keys(&f.path, &[KEY.into()])
            .await
            .unwrap());
        assert_eq!(f.read(), original);
    }
    let original=format!("[hooks.state.\"{KEY}\"]\ntrusted_hash = \"unterminated\n\n[projects.\"/important\"]\ntrust_level = \"trusted\"\n");
    f.write(&original);
    assert!(write_trusted_hashes(&f.opts())
        .await
        .unwrap_err()
        .to_string()
        .contains("invalid Codex config.toml"));
    assert_eq!(f.read(), original);
    assert!(!remove_trust_state_keys(&f.path, &[KEY.into()])
        .await
        .unwrap());
    assert_eq!(f.read(), original);
}
#[tokio::test]
async fn rewrite_preserves_large_integers_nested_arrays_escaped_keys_and_multiline_hash() {
    let f = Fixture::new();
    let hash = f.hash();
    let prefix="large = 9223372036854775807\nitems = [\n[1, 2],\n{ text = \"[hooks.state] # example\" },\n]\n";
    let escaped = KEY.replace("/abs", r"\u002Fabs");
    f.write(&format!("bypass_hook_trust = true\n{prefix}[\"hooks\".\"state\".\"{escaped}\"]\nenabled = false\ntrusted_hash = \"\"\"\n{hash}\"\"\"\n"));
    assert!(write_trusted_hashes(&f.opts()).await.unwrap());
    assert!(f.read().contains(prefix));
    let parsed = toml::from_str::<toml::Value>(&f.read()).unwrap();
    assert_eq!(parsed["large"].as_integer(), Some(i64::MAX));
    assert_eq!(f.state()[KEY]["enabled"].as_bool(), Some(false));
    assert_eq!(parsed["items"][0][0].as_integer(), Some(1));
    assert_eq!(
        parsed["items"][1]["text"].as_str(),
        Some("[hooks.state] # example")
    );
}
#[tokio::test]
async fn duplicate_current_and_retired_keys_reconcile_together_even_when_current_was_valid() {
    for duplicate in [false, true] {
        let f = Fixture::new();
        let hash = f.hash();
        let retired = "/abs/hooks.json:pre_tool_use:0:0";
        let opts = mixed(&f, vec![retired.into()], false);
        let current = format!("[hooks.state.\"{KEY}\"]\ntrusted_hash = \"{hash}\"\n");
        let extra = if duplicate {
            format!("[\"hooks\".\"state\".\"{retired}\"]\ntrusted_hash = \"sha256:RETIRED\"\n[\"hooks\".\"state\".\"{KEY}\"]\nenabled = false\ntrusted_hash = \"{hash}\"\n")
        } else {
            String::new()
        };
        let original=format!("{current}\n[hooks.state.\"{retired}\"]\ntrusted_hash = \"sha256:RETIRED\"\n{extra}{OTHER}");
        f.write(&original);
        if !duplicate {
            assert!(verify_trust_hashes(&f.opts()).unwrap().valid);
        }
        assert!(write_trusted_hashes(&opts).await.unwrap());
        assert!(!f.state().contains_key(retired));
        assert_eq!(f.state()[KEY]["trusted_hash"].as_str(), Some(hash.as_str()));
        if duplicate {
            assert_eq!(f.state()[KEY]["enabled"].as_bool(), Some(false));
        }
        assert!(f.read().contains(OTHER));
        f.valid_and_idempotent(&opts).await;
    }
}
#[tokio::test]
async fn retired_cleanup_surfaces_actual_filesystem_errors_and_preserves_directory() {
    let f = Fixture::new();
    std::fs::create_dir(&f.path).unwrap();
    assert!(remove_trust_state_keys(&f.path, &[KEY.into()])
        .await
        .is_err());
    assert!(Path::new(&f.path).is_dir());
}

#[tokio::test]
async fn five_bare_legacy_stale_entries_become_one_marked_block_without_duplicates() {
    let f = Fixture::new();
    let events = [
        ("SessionStart", "session_start", "session-start"),
        (
            "UserPromptSubmit",
            "user_prompt_submit",
            "user-prompt-submit",
        ),
        ("PreToolUse", "pre_tool_use", "pre-tool-use"),
        ("PostToolUse", "post_tool_use", "post-tool-use"),
        ("Stop", "stop", "stop"),
    ];
    let before = events
        .iter()
        .map(|(_, key, _)| {
            format!(
                "[hooks.state.\"/abs/hooks.json:{key}:0:0\"]\ntrusted_hash = \"sha256:STALE\"\n"
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    f.write(&before);
    let opts = TrustOpts::Legacy(LegacyTrustOpts {
        config_path: f.path.clone(),
        hooks_json_abs_path: "/abs/hooks.json".into(),
        hook_events: events
            .iter()
            .map(|(event, _, _)| event.to_string())
            .collect(),
        event_to_command: events
            .iter()
            .map(|(event, _, command)| (event.to_string(), format!("/abs/hook.sh {command}")))
            .collect(),
        event_to_group_index: events
            .iter()
            .map(|(event, _, _)| (event.to_string(), 0))
            .collect(),
        retired_keys: vec![],
        marker: "otel-codex-hook".into(),
    });
    assert!(write_trusted_hashes(&opts).await.unwrap());
    let after = f.read();
    assert!(!after.contains("STALE"));
    assert_eq!(after.matches("[hooks.state.\"").count(), 5);
    assert_eq!(after.matches("# BEGIN otel-codex-hook trust").count(), 1);
    assert_eq!(after.matches("# END otel-codex-hook trust").count(), 1);
    assert_eq!(f.state().len(), 5);
    for (_, key, _) in events {
        assert!(f
            .state()
            .contains_key(&format!("/abs/hooks.json:{key}:0:0")));
    }
    f.valid_and_idempotent(&opts).await;
}
