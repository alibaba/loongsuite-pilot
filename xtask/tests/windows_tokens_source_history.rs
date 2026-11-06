//! Original Windows tokens advertisement/dispatcher source policy. Actual
//! Windows whole-file invocation is separately gated in windows_services.rs.
#[test]
fn tokens_l12_both_public_aliases_dispatch_native_tokens_with_config_environment() {
    let source = include_str!("../../scripts/loongsuite-pilot.ps1");
    assert!(source.contains("function Cmd-TokenUsage {"));
    assert!(source.contains("\"token-usage\"        { Cmd-TokenUsage }"));
    assert!(source.contains("\"tokens\"             { Cmd-TokenUsage }"));
    let body = source
        .split_once("function Cmd-TokenUsage {")
        .unwrap()
        .1
        .split_once("\n}")
        .unwrap()
        .0;
    assert!(body.contains("Invoke-Pilot -Arguments (@(\"tokens\") + $SubArgs)"));
    assert!(body.contains("exit $script:PilotExitCode"));
    assert!(source.contains("$env:AGENT_DATA_COLLECTION_CONFIG = $CONFIG_FILE"));
    for old in [
        "resolve_node",
        "Resolve-Node",
        "node-bin",
        "token-usage.mjs",
    ] {
        assert!(!body.contains(old), "{old}");
    }
}
