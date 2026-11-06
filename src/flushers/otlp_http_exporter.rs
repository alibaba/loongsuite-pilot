//! 原生 OTLP HTTP/protobuf 编码与传输；失败交由 flusher 计数并持久化。

use std::io::Write;
use std::time::Duration;

use async_trait::async_trait;
use flate2::{write::GzEncoder, Compression};
use opentelemetry_proto::tonic::{
    collector::trace::v1::{ExportTraceServiceRequest, ExportTraceServiceResponse},
    common::v1::{any_value, AnyValue, ArrayValue, InstrumentationScope, KeyValue},
    resource::v1::Resource,
    trace::v1::{span, ResourceSpans, ScopeSpans, Span, Status},
};
use prost::Message;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_ENCODING, CONTENT_TYPE};
use serde_json::{Map, Value};

use super::event_log_converter::valid_id;
use super::otlp_json_serializer::{hr_time_to_nano, ReadableSpan};
use super::otlp_trace_flusher::{ExporterOpts, TraceExporter};

const MAX_RESPONSE_BYTES: usize = 64 * 1024;

pub struct OtlpHttpExporter {
    options: ExporterOpts,
    client: Result<reqwest::Client, String>,
}

impl OtlpHttpExporter {
    pub fn new(options: ExporterOpts) -> Self {
        Self::with_timeout(options, Duration::from_secs(30))
    }

    fn with_timeout(options: ExporterOpts, timeout: Duration) -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10).min(timeout))
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "无法创建 OTLP HTTP client".to_owned());
        Self { options, client }
    }
}

#[async_trait]
impl TraceExporter for OtlpHttpExporter {
    async fn export(&self, spans: Vec<ReadableSpan>) -> Result<(), String> {
        if spans.is_empty() {
            return Ok(());
        }
        let mut body = encode_request(&spans)?.encode_to_vec();
        let mut headers = HeaderMap::new();
        for (name, value) in &self.options.headers {
            let name =
                HeaderName::from_bytes(name.as_bytes()).map_err(|_| "OTLP header 名称无效")?;
            let mut value = HeaderValue::from_str(value).map_err(|_| "OTLP header 值无效")?;
            value.set_sensitive(true);
            headers.insert(name, value);
        }
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("application/x-protobuf"),
        );
        headers.remove(CONTENT_ENCODING);
        match self.options.compression.as_str() {
            "gzip" => {
                let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
                encoder.write_all(&body).map_err(|_| "OTLP gzip 编码失败")?;
                body = encoder.finish().map_err(|_| "OTLP gzip 编码失败")?;
                headers.insert(CONTENT_ENCODING, HeaderValue::from_static("gzip"));
            }
            "none" | "" => {}
            _ => return Err("不支持的 OTLP compression".into()),
        }
        let client = self.client.as_ref().map_err(Clone::clone)?;
        let mut response = client
            .post(&self.options.url)
            .headers(headers)
            .body(body)
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    "OTLP HTTP 请求超时"
                } else {
                    "OTLP HTTP 传输失败"
                }
            })?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(format!("OTLP HTTP 状态 {}", response.status().as_u16()));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "读取 OTLP 响应失败")? {
            if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err("OTLP 响应超过大小限制".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let response = ExportTraceServiceResponse::decode(bytes.as_slice())
            .map_err(|_| "OTLP 响应不是有效 protobuf")?;
        if let Some(partial) = response.partial_success {
            if partial.rejected_spans != 0 {
                // 接收端文本可能含凭据或采集内容，不写入失败日志。
                return Err(format!(
                    "OTLP 接收端拒绝 {} 个 Span",
                    partial.rejected_spans
                ));
            }
        }
        Ok(())
    }

    async fn shutdown(&self) {}
}

fn id_bytes(id: &str, length: usize) -> Result<Vec<u8>, String> {
    if !valid_id(id, length) {
        return Err("OTLP trace/span ID 无效".into());
    }
    hex::decode(id).map_err(|_| "OTLP ID 编码失败".into())
}

fn nanos(time: [i64; 2]) -> Result<u64, String> {
    if !(0..1_000_000_000).contains(&time[1]) {
        return Err("OTLP 纳秒余数无效".into());
    }
    hr_time_to_nano(time)
        .parse()
        .map_err(|_| "OTLP 时间超出 u64 纳秒范围".into())
}

fn any(value: &Value) -> AnyValue {
    let value = match value {
        Value::Bool(value) => any_value::Value::BoolValue(*value),
        Value::Number(value) if value.is_i64() => {
            any_value::Value::IntValue(value.as_i64().unwrap())
        }
        Value::Number(value) if value.is_f64() => {
            any_value::Value::DoubleValue(value.as_f64().unwrap())
        }
        Value::String(value) => any_value::Value::StringValue(value.clone()),
        Value::Array(values) => any_value::Value::ArrayValue(ArrayValue {
            values: values.iter().map(any).collect(),
        }),
        _ => any_value::Value::StringValue(value.to_string()),
    };
    AnyValue { value: Some(value) }
}

fn attributes(values: &Map<String, Value>) -> Vec<KeyValue> {
    values
        .iter()
        .map(|(key, value)| KeyValue {
            key: key.clone(),
            value: Some(any(value)),
        })
        .collect()
}

fn count(value: u64) -> u32 {
    value.min(u32::MAX as u64) as u32
}

fn encode_span(source: &ReadableSpan) -> Result<Span, String> {
    let start = nanos(source.start_time)?;
    let end = nanos(source.end_time)?;
    if end < start || !(0..=4).contains(&source.kind) {
        return Err("OTLP Span 时间或 kind 无效".into());
    }
    let mut links = Vec::new();
    for link in &source.links {
        let context = link.get("context").unwrap_or(link);
        links.push(span::Link {
            trace_id: id_bytes(
                context.get("traceId").and_then(Value::as_str).unwrap_or(""),
                32,
            )?,
            span_id: id_bytes(
                context.get("spanId").and_then(Value::as_str).unwrap_or(""),
                16,
            )?,
            trace_state: context
                .get("traceState")
                .and_then(Value::as_str)
                .unwrap_or("")
                .into(),
            attributes: link
                .get("attributes")
                .and_then(Value::as_object)
                .map(attributes)
                .unwrap_or_default(),
            dropped_attributes_count: count(
                link.get("droppedAttributesCount")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            ),
            flags: context
                .get("traceFlags")
                .and_then(Value::as_u64)
                .map(count)
                .unwrap_or(0)
                & 0xff,
        });
    }
    Ok(Span {
        trace_id: id_bytes(&source.trace_id, 32)?,
        span_id: id_bytes(&source.span_id, 16)?,
        parent_span_id: source
            .parent_span_id
            .as_deref()
            .map(|id| id_bytes(id, 16))
            .transpose()?
            .unwrap_or_default(),
        name: source.name.clone(),
        // ReadableSpan 沿用 SDK 枚举；protobuf 的 UNSPECIFIED 占用 0。
        kind: source.kind as i32 + 1,
        start_time_unix_nano: start,
        end_time_unix_nano: end,
        attributes: attributes(&source.attributes),
        status: Some(Status {
            code: source
                .status
                .get("code")
                .and_then(Value::as_i64)
                .unwrap_or(0) as i32,
            message: source
                .status
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .into(),
        }),
        events: source
            .events
            .iter()
            .map(|event| {
                Ok(span::Event {
                    time_unix_nano: nanos(event.time)?,
                    name: event.name.clone(),
                    attributes: attributes(&event.attributes),
                    dropped_attributes_count: count(event.dropped_attributes_count),
                })
            })
            .collect::<Result<Vec<_>, String>>()?,
        links,
        flags: 1,
        dropped_attributes_count: count(source.dropped_attributes_count),
        dropped_events_count: count(source.dropped_events_count),
        dropped_links_count: count(source.dropped_links_count),
        ..Default::default()
    })
}

pub(crate) fn encode_request(spans: &[ReadableSpan]) -> Result<ExportTraceServiceRequest, String> {
    let mut groups: Vec<(Map<String, Value>, Vec<Span>)> = Vec::new();
    for span in spans {
        let resource = span.resource_attributes.clone().unwrap_or_default();
        let converted = encode_span(span)?;
        if let Some((_, spans)) = groups.iter_mut().find(|(key, _)| *key == resource) {
            spans.push(converted);
        } else {
            groups.push((resource, vec![converted]));
        }
    }
    Ok(ExportTraceServiceRequest {
        resource_spans: groups
            .into_iter()
            .map(|(resource, spans)| ResourceSpans {
                resource: Some(Resource {
                    attributes: attributes(&resource),
                    ..Default::default()
                }),
                scope_spans: vec![ScopeSpans {
                    scope: Some(InstrumentationScope {
                        name: "loongsuite-pilot".into(),
                        version: env!("CARGO_PKG_VERSION").into(),
                        ..Default::default()
                    }),
                    spans,
                    ..Default::default()
                }],
                ..Default::default()
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn protobuf_preserves_nanos_kinds_and_attribute_types() {
        let mut span = ReadableSpan::minimal("chat", &"ab".repeat(16), &"cd".repeat(8));
        span.start_time = [1_700_000_000, 1];
        span.end_time = [1_700_000_000, 23];
        span.kind = 2;
        span.attributes = json!({"integer": 42, "float": 1.5, "bool": true, "array": ["中", "😀"]})
            .as_object()
            .unwrap()
            .clone();
        let bytes = encode_request(&[span]).unwrap().encode_to_vec();
        let decoded = ExportTraceServiceRequest::decode(bytes.as_slice()).unwrap();
        let span = &decoded.resource_spans[0].scope_spans[0].spans[0];
        assert_eq!(span.kind, span::SpanKind::Client as i32);
        assert_eq!(span.start_time_unix_nano, 1_700_000_000_000_000_001);
        assert_eq!(span.end_time_unix_nano - span.start_time_unix_nano, 22);
        assert_eq!(span.trace_id, vec![0xab; 16]);
        assert_eq!(
            span.attributes[0].value.as_ref().unwrap().value,
            Some(any_value::Value::IntValue(42))
        );
    }

    #[test]
    fn rejects_invalid_ids_and_negative_time() {
        let mut span = ReadableSpan::minimal("n", "bad", "bad");
        assert!(encode_request(&[span.clone()]).is_err());
        span.trace_id = "ab".repeat(16);
        span.span_id = "cd".repeat(8);
        span.start_time = [-1, 0];
        assert!(encode_request(&[span]).is_err());
    }

    #[tokio::test]
    async fn bounds_transport_time_and_does_not_expose_credentials() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let exporter = OtlpHttpExporter::with_timeout(
            ExporterOpts {
                url: format!(
                    "http://{}/v1/traces?secret=do-not-log",
                    listener.local_addr().unwrap()
                ),
                headers: Default::default(),
                compression: "none".into(),
                name: "test".into(),
            },
            Duration::from_millis(50),
        );
        let span = ReadableSpan::minimal("n", &"ab".repeat(16), &"cd".repeat(8));
        let error = exporter.export(vec![span]).await.unwrap_err();
        assert!(error.contains("超时"));
        assert!(!error.contains("do-not-log"));
    }
}

#[cfg(test)]
mod observation_serialization_contracts {
    use super::*;
    use crate::flushers::otlp_json_serializer::{span_to_json, SpanEvent};
    use serde_json::json;

    #[test]
    fn observed_event_time_and_origin_link_survive_json_and_real_protobuf_encoding() {
        let mut span = ReadableSpan::minimal("run_task", &"a".repeat(32), &"b".repeat(16));
        span.start_time = [1_760_000_000, 123];
        span.end_time = [1_760_000_005, 987];
        span.events.push(SpanEvent {
            name: "gen_ai.tool.result".into(),
            time: [1_760_000_002, 456],
            attributes: json!({"gen_ai.tool.call.id":"observed-call"})
                .as_object()
                .unwrap()
                .clone(),
            dropped_attributes_count: 3,
        });
        span.links.push(json!({"context":{"traceId":"c".repeat(32),"spanId":"d".repeat(16),"traceState":"sample=1","traceFlags":1},"attributes":{"loongsuite.link.type":"origin_client_request"},"droppedAttributesCount":2}));
        let json: Value = serde_json::from_str(&span_to_json(&span)).unwrap();
        assert_eq!(json["events"][0]["timeUnixNano"], "1760000002000000456");
        assert_eq!(json["events"][0]["droppedAttributesCount"], 3);
        assert_eq!(json["links"][0]["traceId"], "c".repeat(32));
        assert_eq!(json["links"][0]["spanId"], "d".repeat(16));
        assert_eq!(json["links"][0]["traceState"], "sample=1");
        assert_eq!(
            json["links"][0]["attributes"]["loongsuite.link.type"],
            "origin_client_request"
        );
        let request = encode_request(&[span]).unwrap();
        let bytes = request.encode_to_vec();
        let decoded = ExportTraceServiceRequest::decode(bytes.as_slice()).unwrap();
        let actual = &decoded.resource_spans[0].scope_spans[0].spans[0];
        assert_eq!(actual.events[0].time_unix_nano, 1_760_000_002_000_000_456);
        assert_ne!(actual.events[0].time_unix_nano, actual.end_time_unix_nano);
        assert_eq!(actual.events[0].dropped_attributes_count, 3);
        assert_eq!(actual.links[0].trace_id, vec![0xcc; 16]);
        assert_eq!(actual.links[0].span_id, vec![0xdd; 8]);
        assert_eq!(actual.links[0].dropped_attributes_count, 2);
        assert_eq!(actual.links[0].trace_state, "sample=1");
        assert_eq!(actual.links[0].flags, 1);
    }

    #[test]
    fn absent_observations_stay_absent_and_invalid_event_time_fails_encoding() {
        let mut span = ReadableSpan::minimal("empty", &"a".repeat(32), &"b".repeat(16));
        let json: Value = serde_json::from_str(&span_to_json(&span)).unwrap();
        assert!(json.get("events").is_none() && json.get("links").is_none());
        span.events.push(SpanEvent {
            name: "invalid".into(),
            time: [-1, 0],
            attributes: Map::new(),
            dropped_attributes_count: 0,
        });
        assert!(encode_request(&[span]).is_err());
    }
}
