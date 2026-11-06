use super::*;
use crate::types::DeployMode;
fn item(success: bool, skipped: Option<bool>, reason: Option<DeploySkipReason>) -> DeployResult {
    DeployResult {
        success,
        agent_id: "hermes-agent".into(),
        deploy_mode: DeployMode::Hook,
        skipped,
        reason,
        error: (!success).then(|| "plugin extract failed".into()),
        plugin_inject_config_path: None,
    }
}
fn known() -> HashSet<String> {
    HashSet::from([
        "hermes-agent".into(),
        "claude-code".into(),
        "qoder-jetbrains".into(),
    ])
}
fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| (*v).into()).collect()
}
fn exit(results: &[DeployResult], required: &[String]) -> i32 {
    deploy_exit_code(results, &collect_unmet(required, &known(), results), false)
}
#[test]
fn deploy_l36_l40_l47_l51_l55_required_fresh_uptodate_absent_disabled_and_missing_results_have_exact_codes(
) {
    let required = strings(&["hermes-agent"]);
    for (value, code) in [
        (item(true, None, None), 0),
        (item(true, Some(true), Some(DeploySkipReason::UpToDate)), 0),
        (
            item(true, Some(true), Some(DeploySkipReason::NotDetected)),
            1,
        ),
        (item(true, Some(true), Some(DeploySkipReason::Disabled)), 1),
    ] {
        assert_eq!(exit(&[value], &required), code);
    }
    assert_eq!(exit(&[], &required), 1);
}
#[test]
fn deploy_l59_l66_unknown_ids_and_hard_errors_keep_the_exact_machine_report() {
    let deployed = item(true, None, None);
    let unknown = strings(&["hermez-agent"]);
    assert_eq!(exit(std::slice::from_ref(&deployed), &unknown), 1);
    assert_eq!(
        serde_json::to_value(collect_unmet(&unknown, &known(), &[deployed])).unwrap(),
        serde_json::json!([{"agentId":"hermez-agent","reason":"unknown-id"}])
    );
    assert_eq!(
        serde_json::to_value(collect_unmet(
            &strings(&["hermes-agent"]),
            &known(),
            &[item(false, None, None)]
        ))
        .unwrap(),
        serde_json::json!([{"agentId":"hermes-agent","reason":"failed","error":"plugin extract failed"}])
    );
}
#[test]
fn deploy_l72_l78_l82_unrequired_skips_pass_but_actual_failure_and_worker_stop_failure_never_pass()
{
    assert_eq!(exit(&[item(false, None, None)], &[]), 1);
    assert_eq!(
        exit(
            &[
                item(true, Some(true), Some(DeploySkipReason::NotDetected)),
                item(true, Some(true), Some(DeploySkipReason::Disabled))
            ],
            &[]
        ),
        0
    );
    assert_eq!(deploy_exit_code(&[item(true, None, None)], &[], true), 1);
}
#[test]
fn deploy_l90_l95_split_inline_deduplicate_and_no_requirement_json_are_exact() {
    for input in [
        strings(&["--require", "a, b ,a"]),
        strings(&["--require=a,b"]),
    ] {
        assert_eq!(parse_args(&input).unwrap().required, strings(&["a", "b"]));
    }
    assert_eq!(parse_args(&[]).unwrap().required, Vec::<String>::new());
    assert_eq!(
        parse_args(&strings(&["--json"])).unwrap(),
        DeployCommandOptions {
            required: vec![],
            json: true
        }
    );
}
#[test]
fn deploy_l100_l108_empty_and_missing_require_keep_distinct_original_errors() {
    for input in [
        strings(&["--require", ""]),
        strings(&["--require", " , "]),
        strings(&["--require="]),
    ] {
        assert!(parse_args(&input).unwrap_err().contains("empty value"));
    }
    for input in [strings(&["--require"]), strings(&["--require", "--json"])] {
        assert!(parse_args(&input).unwrap_err().contains("requires a value"));
    }
}
#[test]
fn deploy_l113_unknown_option_is_rejected_by_the_actual_parser() {
    assert!(parse_args(&strings(&["--force"]))
        .unwrap_err()
        .contains("unknown option"));
}
