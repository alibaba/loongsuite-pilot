//! Frozen installer merge contracts; all transformations call production helpers.
use super::*;
fn apply(old: Value, options: Value) -> Result<Value> {
    let mut options = options.as_object().unwrap().clone();
    options.insert("dataDir".into(), json!(std::env::temp_dir()));
    merge(&old, &Options::new(json!(options))?)
}
#[test]
fn interceptor_original_modes_and_all_mask_union_shapes() {
    let cases = [
        (
            json!({"interceptor":{"mode":"custom","types":["apiKey"]}}),
            json!({"interceptorMode":"all"}),
            json!({"mode":"all"}),
            json!({"mode":"custom","types":["cloudAccessKey","apiKey","privateKey","databaseUrl"]}),
        ),
        (
            json!({}),
            json!({"interceptorMode":"custom","interceptorTypes":"apiKey, cloudAccessKey,idCard"}),
            json!({"mode":"custom","types":["apiKey","cloudAccessKey","idCard"]}),
            json!({"mode":"custom","types":["apiKey","cloudAccessKey"]}),
        ),
        (
            json!({"interceptor":{"mode":"custom","types":["privateKey"]},"logLevel":"debug"}),
            json!({}),
            json!({"mode":"custom","types":["privateKey"]}),
            json!({"mode":"custom","types":["privateKey"]}),
        ),
        (
            json!({"interceptor":{"mode":"custom","types":["apiKey"]}}),
            json!({"interceptorMode":"all","interceptorTypes":"apiKey"}),
            json!({"mode":"all"}),
            json!({"mode":"custom","types":["cloudAccessKey","apiKey","privateKey","databaseUrl"]}),
        ),
        (
            json!({}),
            json!({"interceptorMode":"custom","interceptorTypes":"apiKey, privateKey"}),
            json!({"mode":"custom","types":["apiKey","privateKey"]}),
            json!({"mode":"custom","types":["apiKey","privateKey"]}),
        ),
        (
            json!({}),
            json!({"interceptorMode":"custom","interceptorTypes":"apiKey","maskMode":"custom","maskTypes":"idCard,phone"}),
            json!({"mode":"custom","types":["apiKey"]}),
            json!({"mode":"custom","types":["idCard","phone","apiKey"]}),
        ),
        (
            json!({}),
            json!({"interceptorMode":"all","maskMode":"custom","maskTypes":"idCard"}),
            json!({"mode":"all"}),
            json!({"mode":"custom","types":["idCard","cloudAccessKey","apiKey","privateKey","databaseUrl"]}),
        ),
        (
            json!({}),
            json!({"interceptorMode":"custom","interceptorTypes":"apiKey","maskMode":"none"}),
            json!({"mode":"custom","types":["apiKey"]}),
            json!({"mode":"custom","types":["apiKey"]}),
        ),
        (
            json!({}),
            json!({"interceptorMode":"all","maskMode":"all"}),
            json!({"mode":"all"}),
            json!({"mode":"all"}),
        ),
        (
            json!({}),
            json!({"interceptorMode":"custom","interceptorTypes":"apiKey","maskMode":"custom","maskTypes":"apiKey,idCard"}),
            json!({"mode":"custom","types":["apiKey"]}),
            json!({"mode":"custom","types":["apiKey","idCard"]}),
        ),
    ];
    for (old, options, interceptor, mask) in cases {
        let got = apply(old.clone(), options).unwrap();
        assert_eq!(got["interceptor"], interceptor);
        assert_eq!(got["mask"], mask);
        if let Some(level) = old.get("logLevel") {
            assert_eq!(&got["logLevel"], level);
        }
    }
}
#[test]
fn interceptor_overwrite_diff_preserves_safe_original_mode_and_expanded_types() {
    let old = json!({"interceptor":{"mode":"none"}});
    let got = apply(old.clone(), json!({"interceptorMode":"all"})).unwrap();
    assert!(changed_fields(&old, &got)
        .lines()
        .any(|x| x == "interceptor.mode: none -> all"));
    let old = json!({"mask":{"mode":"custom","types":["idCard"]}});
    let got = apply(
        old.clone(),
        json!({"interceptorMode":"all","maskMode":"custom","maskTypes":"idCard"}),
    )
    .unwrap();
    assert!(changed_fields(&old, &got)
        .lines()
        .any(|x| x == "mask.types: idCard -> idCard,cloudAccessKey,apiKey,privateKey,databaseUrl"));
}
#[test]
fn interceptor_invalid_mode_leaves_the_existing_configuration_untouched() {
    let old = json!({"interceptor":{"mode":"none"}});
    assert!(apply(old.clone(), json!({"interceptorMode":"audit"})).is_err());
    assert_eq!(old, json!({"interceptor":{"mode":"none"}}));
}
#[test]
fn mask_preview_and_placeholder_are_the_only_nonempty_replacement_modes() {
    for mode in ["placeholder", "preview"] {
        let got = apply(json!({}), json!({"maskReplacementMode":mode})).unwrap();
        assert_eq!(got["mask"]["replacementMode"], mode);
    }
    assert!(apply(json!({}), json!({"maskReplacementMode":"unsafe"})).is_err());
}
#[test]
fn sls_api_key_and_access_key_modes_clear_old_auth_and_hide_all_secret_values() {
    let old =
        json!({"sls":{"mode":"ak","accessKeyId":"old-id-secret","accessKeySecret":"old-secret"}});
    let got = apply(
        old.clone(),
        json!({"slsApiKey":"synthetic-new-private-key"}),
    )
    .unwrap();
    assert_eq!(
        got["sls"],
        json!({"mode":"apiKey","apiKey":"synthetic-new-private-key"})
    );
    let diff = changed_fields(&old, &got);
    for secret in ["old-id-secret", "old-secret", "synthetic-new-private-key"] {
        assert!(!diff.contains(secret));
    }
    let back = apply(got, json!({"slsAkId":"new-id","slsAkSecret":"new-secret"})).unwrap();
    assert_eq!(
        back["sls"],
        json!({"mode":"ak","accessKeyId":"new-id","accessKeySecret":"new-secret"})
    );
}
#[test]
fn all_agents_removes_only_enabled_overrides_and_preserves_every_other_field() {
    let got=apply(json!({"agents":{"qoder":{"enabled":false,"custom":7},"cursor":{"enabled":true,"extra":true}}}),json!({"allAgentsMode":"1"})).unwrap();
    assert_eq!(
        got["agents"],
        json!({"qoder":{"custom":7},"cursor":{"extra":true}})
    );
}
#[test]
fn privacy_paths_roundtrip_through_json_without_evaluation() {
    let root = std::env::temp_dir();
    let paths = [
        "my project",
        "it's-secret",
        "$(exit 9)",
        "\u{60}exit 9\u{60}",
        "中文\nfolder",
    ]
    .map(|p| root.join(p));
    let got=apply(json!({"privacy":{"excludeWorkspaces":[root.join("old")],"custom":true},"userId":"existing"}),json!({"excludeWorkspaces":paths})).unwrap();
    assert_eq!(
        got["privacy"],
        json!({"excludeWorkspaces":paths,"custom":true})
    );
    assert_eq!(got["userId"], "existing");
}
#[test]
fn privacy_omitted_paths_preserve_exclusions_and_explicit_paths_replace_only_the_array() {
    let root = std::env::temp_dir();
    let old = json!({"privacy":{"excludeWorkspaces":[root.join("old")],"custom":true}});
    assert_eq!(
        apply(old.clone(), json!({})).unwrap()["privacy"],
        old["privacy"]
    );
    let paths = json!([root.join("private space"), root.join("中文")]);
    let got = apply(old, json!({"excludeWorkspaces":paths})).unwrap();
    assert_eq!(
        got["privacy"],
        json!({"excludeWorkspaces":paths,"custom":true})
    );
}
#[test]
fn config_diff_never_displays_unknown_modes_types_credentials_or_control_characters() {
    for (old, next, secrets) in [
        (
            json!({"mask":{"mode":"unknown-private-secret\nx"}}),
            json!({"mask":{"mode":"all"}}),
            vec!["unknown-private-secret", "x\n"],
        ),
        (
            json!({"mask":{"types":["apiKey","malicious-private-secret"]}}),
            json!({"mask":{"types":["apiKey"]}}),
            vec!["malicious-private-secret"],
        ),
        (
            json!({"sls":{"apiKey":"old-private-secret","endpoint":"https://old-private-secret.invalid"}}),
            json!({"sls":{"apiKey":"new-private-secret","endpoint":"https://new-private-secret.invalid"}}),
            vec!["old-private-secret", "new-private-secret"],
        ),
    ] {
        let diff = changed_fields(&old, &next);
        assert!(!diff.is_empty());
        for secret in secrets {
            assert!(!diff.contains(secret));
        }
        assert!(!diff.contains(" -> "));
    }
}
#[test]
fn config_diff_shows_safe_storage_type_without_disclosing_other_storage_fields() {
    let old = json!({"multimodal":{"storage":{"type":"oss","auth":{"accessKeySecret":"synthetic-old-secret"}}}});
    let next = json!({"multimodal":{"storage":{"type":"sls","target":{"endpoint":"synthetic-private-endpoint"}}}});
    let diff = changed_fields(&old, &next);
    assert!(diff
        .lines()
        .any(|s| s == "multimodal.storage.type: oss -> sls"));
    assert!(!diff.contains("synthetic-old-secret"));
    assert!(!diff.contains("synthetic-private-endpoint"));
}
