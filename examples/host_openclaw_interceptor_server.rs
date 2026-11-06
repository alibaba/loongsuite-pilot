//! Optional host-test fixture: real loopback interceptor and builtin local rules.
use loongsuite_pilot::interceptor::daemon::{create_interceptor_server, InterceptorServerOptions};
use loongsuite_pilot::interceptor::rules::{builtin_rules, RuleEngine};
use serde_json::json;
use std::collections::HashSet;
use std::io::Write;
#[tokio::main(worker_threads = 2)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::var("PILOT_TEST_CLIENT_HANG").as_deref() == Ok("1") {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        return Ok(());
    }
    if std::env::var("PILOT_TEST_CLIENT_EXIT_FAILURE").as_deref() == Ok("1") {
        println!(
            "{}",
            json!({"message":{"content":[{"type":"text","text":"must not block"}]}})
        );
        std::process::exit(7);
    }
    let data = std::path::PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("synthetic data directory required")?,
    );
    if !data.is_absolute() {
        return Err("synthetic data path must be absolute".into());
    }
    let server = create_interceptor_server(InterceptorServerOptions {
        version: "synthetic-native-openclaw".into(),
        engine: RuleEngine::new(
            builtin_rules(),
            HashSet::from(["cloudAccessKey".to_owned()]),
        ),
        write_access_log: None,
        write_tool_verdict: None,
        emit_blocked_prompt: None,
    });
    let port = server.listen(0).await?;
    std::fs::create_dir_all(data.join("interceptor"))?;
    let runtime = json!({"service":"loongsuite-pilot-interceptor","status":"ok","pid":std::process::id(),"version":"synthetic-native-openclaw","daemon_port":port});
    std::fs::write(data.join("interceptor/runtime.json"), runtime.to_string())?;
    println!(
        "{}",
        json!({"ready":true,"port":port,"pid":std::process::id()})
    );
    std::io::stdout().flush()?;
    let eof = tokio::task::spawn_blocking(|| {
        use std::io::Read;
        let mut byte = [0u8; 1];
        let _ = std::io::stdin().read(&mut byte);
    });
    tokio::select! {_=eof=>{},_=tokio::time::sleep(std::time::Duration::from_secs(30))=>{}}
    server.close().await;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_openclaw_content_array_reaches_sensitive_rule() {
        use loongsuite_pilot::interceptor::adapters::parse_openclaw_hook_request;
        use loongsuite_pilot::interceptor::rules::collect_hook_text;
        use loongsuite_pilot::interceptor::VerdictAction;
        let body = json!({"hook_event_name":"PostToolUse","openclaw_hook":"tool_result_persist","tool_name":"read","tool_response":{"toolCallId":"nested-array","content":[{"type":"text","text":"LTAI1234567890ABCD"}]}});
        let request = parse_openclaw_hook_request(body.as_object().unwrap(), None).unwrap();
        let text = collect_hook_text(&request);
        assert!(text.contains("LTAI1234567890ABCD"), "{text:?}");
        assert_eq!(
            RuleEngine::new(builtin_rules(), HashSet::from(["cloudAccessKey".into()]))
                .evaluate(&request)
                .action,
            VerdictAction::Block
        );
    }
}
