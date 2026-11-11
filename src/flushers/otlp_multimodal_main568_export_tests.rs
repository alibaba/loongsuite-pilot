//! End-to-end public #568 cases through the native converter and OTLP exporter boundary.
use super::{ExporterFactory, OtlpTraceFlusher, ReadableSpan, TraceExporter};
use crate::flushers::base_flusher::BaseFlusher;
use crate::normalization::entry_from_map;
use crate::types::OtlpTraceFlusherConfig;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

struct Capture(Arc<Mutex<Vec<ReadableSpan>>>);
#[async_trait::async_trait]
impl TraceExporter for Capture {
    async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
        self.0.lock().unwrap().extend(spans);
        Ok(())
    }
    async fn shutdown(&self) {}
}

fn image(name: &str) -> Value {
    json!({"uri":format!("oss://bucket/{name}.png"),"mime_type":"image/png","modality":"image"})
}
fn messages(image: &Value) -> Value {
    let mut part = image.as_object().unwrap().clone();
    part.insert("type".into(), json!("uri"));
    json!([{"role":"user","parts":[part]}])
}
fn metadata(span: &ReadableSpan, key: &str) -> Option<Value> {
    span.attributes
        .get(key)
        .and_then(Value::as_str)
        .map(|s| serde_json::from_str(s).unwrap())
}

#[tokio::test]
async fn main568_actual_export_keeps_cumulative_snapshot_and_missing_response_identity() {
    for full_snapshot in [false, true] {
        for with_response_ids in [true, false] {
            let root = tempfile::tempdir().unwrap();
            let output = Arc::new(Mutex::new(Vec::new()));
            let shared = output.clone();
            let factory: ExporterFactory =
                Arc::new(move |_| Arc::new(Capture(shared.clone())) as Arc<dyn TraceExporter>);
            let config:OtlpTraceFlusherConfig=serde_json::from_value(json!({
                "enabled":true,"serviceName":"multimodal-main568","protocol":"http/protobuf","dataDir":root.path(),
                "turnIdleTimeoutMs":0,"endpoints":[{"name":"capture","endpoint":"http://unused:4318","headers":{}}]
            })).unwrap();
            let flusher = OtlpTraceFlusher::with_parts(config, None, Some(factory), None).unwrap();
            let a = image("a");
            let b = image("b");
            let mut records = Vec::new();
            for i in 0..3 {
                let ms = 10 + i * 10;
                let mut request = json!({
                    "trace_id":"1234567890abcdef1234567890abcdef","event.id":format!("req-{i}"),"event.name":"llm.request",
                    "gen_ai.agent.type":"qwen-work-cn","gen_ai.provider.name":"qwen","gen_ai.session.id":"session-1",
                    "gen_ai.turn.id":"turn-1","gen_ai.step.id":format!("step-{i}"),"user.id":"test-user",
                    "time_unix_nano":(1_700_000_000_000_000_000_i128+ms*1_000_000).to_string(),"gen_ai.request.model":"test-model"
                });
                if with_response_ids {
                    request["gen_ai.response.id"] = json!(format!("r{i}"));
                }
                if i == 1 {
                    request["gen_ai.input.messages_delta"] =
                        json!([{"role":"user","parts":[{"type":"text","content":"tool output"}]}]);
                } else {
                    let item = if i == 0 { &a } else { &b };
                    request["gen_ai.input.messages_delta"] = messages(item);
                    request["gen_ai.input.multimodal_metadata"] = json!([item]);
                    request["gen_ai.input.multimodal_metadata_delta"] = json!([item]);
                }
                if i == 2 && full_snapshot {
                    request["gen_ai.input.messages"] = messages(&b);
                    request["gen_ai.input.multimodal_metadata"] = json!([a, b]);
                }
                let mut response = request.clone();
                response["event.id"] = json!(format!("resp-{i}"));
                response["event.name"] = json!("llm.response");
                response["time_unix_nano"] =
                    json!((1_700_000_000_000_000_000_i128 + (ms + 1) * 1_000_000).to_string());
                response["gen_ai.output.messages"] = json!([{"role":"assistant","parts":[{"type":"text","content":format!("answer-{i}")}]}]);
                response["gen_ai.response.finish_reasons"] = json!(["stop"]);
                for key in [
                    "gen_ai.input.messages",
                    "gen_ai.input.messages_delta",
                    "gen_ai.input.multimodal_metadata",
                    "gen_ai.input.multimodal_metadata_delta",
                ] {
                    response.as_object_mut().unwrap().remove(key);
                }
                records.push(entry_from_map(request.as_object().unwrap().clone()));
                records.push(entry_from_map(response.as_object().unwrap().clone()));
            }
            flusher.send_batch(records, None).await.unwrap();
            flusher.flush().await.unwrap();
            let mut spans = output
                .lock()
                .unwrap()
                .iter()
                .filter(|span| {
                    span.attributes
                        .get("gen_ai.span.kind")
                        .and_then(Value::as_str)
                        == Some("LLM")
                })
                .cloned()
                .collect::<Vec<_>>();
            spans.sort_by_key(|span| span.start_time);
            assert_eq!(
                spans.len(),
                3,
                "snapshot={full_snapshot} ids={with_response_ids}"
            );
            assert_eq!(
                metadata(&spans[1], "gen_ai.input.multimodal_metadata"),
                Some(json!([a]))
            );
            assert!(metadata(&spans[1], "gen_ai.input.multimodal_metadata_delta").is_none());
            assert_eq!(
                metadata(&spans[2], "gen_ai.input.multimodal_metadata"),
                Some(if full_snapshot {
                    json!([b])
                } else {
                    json!([a, b])
                })
            );
            assert_eq!(
                metadata(&spans[2], "gen_ai.input.multimodal_metadata_delta"),
                Some(json!([b]))
            );
            if !with_response_ids {
                assert!(spans.iter().all(|span| span
                    .attributes
                    .get("gen_ai.response.id")
                    .is_none_or(|v| v.is_null())));
            }
            flusher.shutdown().await.unwrap();
        }
    }
}
