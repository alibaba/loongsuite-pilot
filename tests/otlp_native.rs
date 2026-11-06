//! 验证生产默认转换器与 HTTP exporter，不注入成功替身，不访问外部接收端。

use std::io::Read;
use std::time::Duration;

use flate2::read::GzDecoder;
use loongsuite_pilot::flushers::{BaseFlusher, OtlpTraceFlusher};
use loongsuite_pilot::types::{AgentActivityEntry, OtlpTraceFlusherConfig};
use opentelemetry_proto::tonic::collector::trace::v1::{
    ExportTracePartialSuccess, ExportTraceServiceRequest, ExportTraceServiceResponse,
};
use opentelemetry_proto::tonic::common::v1::{any_value, KeyValue};
use prost::Message;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn receiver(
    status: u16,
    response_body: Vec<u8>,
) -> (
    String,
    tokio::task::JoinHandle<(String, ExportTraceServiceRequest)>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let handle = tokio::spawn(async move {
        tokio::time::timeout(Duration::from_secs(10), async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 4096];
            let header_end = loop {
                let n = stream.read(&mut chunk).await.unwrap();
                assert_ne!(n, 0);
                bytes.extend_from_slice(&chunk[..n]);
                assert!(bytes.len() < 1_000_000);
                if let Some(index) = bytes.windows(4).position(|value| value == b"\r\n\r\n") { break index + 4; }
            };
            let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
            let lower = headers.to_lowercase();
            let length: usize = lower.lines().find_map(|line| line.strip_prefix("content-length:")).unwrap().trim().parse().unwrap();
            assert!(length < 1_000_000);
            while bytes.len() < header_end + length {
                let n = stream.read(&mut chunk).await.unwrap();
                assert_ne!(n, 0);
                bytes.extend_from_slice(&chunk[..n]);
            }
            let mut body = bytes[header_end..header_end + length].to_vec();
            if lower.contains("content-encoding: gzip") {
                let mut decoded = Vec::new();
                GzDecoder::new(body.as_slice()).read_to_end(&mut decoded).unwrap();
                body = decoded;
            }
            let request = ExportTraceServiceRequest::decode(body.as_slice()).unwrap();
            let response = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/x-protobuf\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", response_body.len());
            stream.write_all(response.as_bytes()).await.unwrap();
            stream.write_all(&response_body).await.unwrap();
            (headers, request)
        }).await.expect("默认 OTLP 路径未发送请求或请求未结束")
    });
    (url, handle)
}

fn config(url: &str, data: &std::path::Path, compression: &str) -> OtlpTraceFlusherConfig {
    serde_json::from_value(json!({
        "enabled": true, "protocol": "http/protobuf", "serviceName": "native-test",
        "endpoints": [{"name": "local", "endpoint": url, "compression": compression,
            "headers": {"x-test": "native"}}],
        "dataDir": data, "turnIdleTimeoutMs": 0,
        "resourceAttributes": {"deployment.environment.name": "fixture"},
        "resourceAttributeKeys": ["team.name"],
        "spanAttributePassthroughPrefixes": ["fixture."]
    }))
    .unwrap()
}

fn records() -> Vec<AgentActivityEntry> {
    [
        ("llm.request", "1700000000000000001"),
        ("llm.response", "1700000000000000023"),
    ]
    .into_iter()
    .map(|(name, time)| {
        serde_json::from_value(json!({
            "event.name": name, "time_unix_nano": time, "gen_ai.agent.type": "claude-code",
            "gen_ai.session.id": "session", "gen_ai.turn.id": "turn", "gen_ai.step.id": "step:1",
            "gen_ai.response.id": "response", "gen_ai.request.model": "fixture-model",
            "trace_id": "0123456789abcdef0123456789abcdef", "span_id": "1234567890abcdef",
            "gen_ai.usage.output_tokens": if name == "llm.response" { 42 } else { 0 },
            "team.name": "测试团队", "fixture.path": "中文/😀"
        }))
        .unwrap()
    })
    .collect()
}

fn attr<'a>(attrs: &'a [KeyValue], key: &str) -> &'a any_value::Value {
    attrs
        .iter()
        .find(|attr| attr.key == key)
        .unwrap()
        .value
        .as_ref()
        .unwrap()
        .value
        .as_ref()
        .unwrap()
}

#[tokio::test]
async fn default_path_sends_nonempty_protobuf_with_resources_and_exact_nanos() {
    for compression in ["none", "gzip"] {
        let data = tempfile::tempdir().unwrap();
        let (url, received) = receiver(200, vec![]).await;
        let flusher = OtlpTraceFlusher::new(config(&url, data.path(), compression)).unwrap();
        flusher.send_batch(records(), None).await.unwrap();
        flusher.flush().await.unwrap();
        let (headers, request) = received.await.unwrap();
        assert!(headers.starts_with("POST /v1/traces HTTP/1.1"));
        assert!(headers
            .to_lowercase()
            .contains("content-type: application/x-protobuf"));
        assert!(headers.to_lowercase().contains("x-test: native"));
        assert_eq!(
            headers.to_lowercase().contains("content-encoding: gzip"),
            compression == "gzip"
        );
        assert_eq!(request.resource_spans.len(), 1);
        let resource = request.resource_spans[0].resource.as_ref().unwrap();
        assert_eq!(
            attr(&resource.attributes, "service.name"),
            &any_value::Value::StringValue("native-test-claude-code".into())
        );
        assert_eq!(
            attr(&resource.attributes, "team.name"),
            &any_value::Value::StringValue("测试团队".into())
        );
        let spans = &request.resource_spans[0].scope_spans[0].spans;
        assert_eq!(spans.len(), 4);
        let llm = spans
            .iter()
            .find(|span| span.span_id == hex::decode("1234567890abcdef").unwrap())
            .unwrap();
        assert_eq!(llm.start_time_unix_nano, 1_700_000_000_000_000_001);
        assert_eq!(llm.end_time_unix_nano, 1_700_000_000_000_000_023);
        assert_eq!(
            attr(&llm.attributes, "gen_ai.usage.output_tokens"),
            &any_value::Value::IntValue(42)
        );
        assert_eq!(
            attr(&llm.attributes, "fixture.path"),
            &any_value::Value::StringValue("中文/😀".into())
        );
        assert!(spans
            .iter()
            .all(|span| span.trace_id == hex::decode("0123456789abcdef0123456789abcdef").unwrap()));
        for span in spans.iter().filter(|span| !span.parent_span_id.is_empty()) {
            assert!(spans
                .iter()
                .any(|parent| parent.span_id == span.parent_span_id));
        }
        assert_eq!(flusher.endpoint_counters()["local"].out_spans, 4);
        assert_eq!(flusher.endpoint_counters()["local"].out_failed, 0);
        flusher.flush().await.unwrap();
        assert_eq!(flusher.endpoint_counters()["local"].in_spans, 4);
        flusher.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn rejected_exports_are_counted_and_persisted_without_server_secrets() {
    let partial = ExportTraceServiceResponse {
        partial_success: Some(ExportTracePartialSuccess {
            rejected_spans: 1,
            error_message: "secret-from-server".into(),
        }),
    }
    .encode_to_vec();
    for (status, response) in [
        (500, vec![]),
        (200, partial),
        (200, b"invalid protobuf".to_vec()),
        (302, vec![]),
    ] {
        let data = tempfile::tempdir().unwrap();
        let (url, received) = receiver(status, response).await;
        let flusher = OtlpTraceFlusher::new(config(&url, data.path(), "gzip")).unwrap();
        flusher.send_batch(records(), None).await.unwrap();
        flusher.shutdown().await.unwrap();
        received.await.unwrap();
        assert_eq!(flusher.endpoint_counters()["local"].out_spans, 0);
        assert_eq!(flusher.endpoint_counters()["local"].out_failed, 4);
        let files: Vec<_> = std::fs::read_dir(data.path().join("logs/otlp-failed"))
            .unwrap()
            .collect();
        assert_eq!(files.len(), 1);
        let text = std::fs::read_to_string(files[0].as_ref().unwrap().path()).unwrap();
        assert_eq!(text.lines().count(), 4);
        assert!(!text.contains("secret-from-server"));
        for line in text.lines() {
            let row: Value = serde_json::from_str(line).unwrap();
            assert!(row["_error"]["message"].is_string());
            assert_eq!(row["resource"]["service.name"], "native-test-claude-code");
        }
    }
}

#[tokio::test]
async fn cp5_single_and_incremental_turns_preserve_unique_spans_and_last_output() {
    let records: Vec<AgentActivityEntry> =
        include_str!("unit/flushers/otlp-trace-flusher/fixtures/cp5-events.jsonl")
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
    assert_eq!(records.len(), 23);
    for split in [None, Some(8)] {
        let data = tempfile::tempdir().unwrap();
        let (url, received) = receiver(200, vec![]).await;
        let flusher = OtlpTraceFlusher::new(config(&url, data.path(), "gzip")).unwrap();
        if let Some(split) = split {
            flusher
                .send_batch(records[..split].to_vec(), None)
                .await
                .unwrap();
            assert_eq!(flusher.endpoint_counters()["local"].in_spans, 0);
            assert!(!received.is_finished(), "中间轮次不能触发输出");
            flusher
                .send_batch(records[split..].to_vec(), None)
                .await
                .unwrap();
        } else {
            flusher.send_batch(records.clone(), None).await.unwrap();
        }
        let (_, request) = received.await.unwrap();
        let spans = &request.resource_spans[0].scope_spans[0].spans;
        for (kind, count) in [
            ("ENTRY", 1),
            ("AGENT", 1),
            ("STEP", 3),
            ("LLM", 3),
            ("TOOL", 2),
        ] {
            assert_eq!(
                spans
                    .iter()
                    .filter(|span| attr(&span.attributes, "gen_ai.span.kind")
                        == &any_value::Value::StringValue(kind.into()))
                    .count(),
                count,
                "{kind}"
            );
        }
        assert_eq!(spans.len(), 10);
        assert_eq!(
            spans
                .iter()
                .map(|span| &span.span_id)
                .collect::<std::collections::HashSet<_>>()
                .len(),
            10
        );
        assert!(spans
            .iter()
            .filter(|span| attr(&span.attributes, "gen_ai.span.kind")
                == &any_value::Value::StringValue("LLM".into()))
            .any(|span| {
                span.attributes.iter().any(|attribute| {
                    attribute.key == "gen_ai.output.messages"
                        && matches!(attribute.value.as_ref().and_then(|v| v.value.as_ref()),
                    Some(any_value::Value::StringValue(text)) if !text.is_empty())
                })
            }));
        flusher.send_batch(records.clone(), None).await.unwrap();
        assert_eq!(flusher.endpoint_counters()["local"].out_spans, 10);
        flusher.shutdown().await.unwrap();
        assert_eq!(flusher.endpoint_counters()["local"].in_spans, 10);
        assert_eq!(flusher.endpoint_counters()["local"].out_failed, 0);
    }
}

#[test]
fn optional_script_extensions_are_accepted_lazily_before_transport() {
    let data = tempfile::tempdir().unwrap();
    let mut config = config("http://127.0.0.1:1", data.path(), "none");
    config.span_enricher_paths = Some(vec!["old.mjs".into()]);
    let flusher = OtlpTraceFlusher::new(config).unwrap();
    assert!(flusher
        .endpoint_counters()
        .values()
        .all(|counter| counter.out_spans == 0));
    drop(flusher);
    assert_eq!(std::fs::read_dir(data.path()).unwrap().count(), 0);
}
