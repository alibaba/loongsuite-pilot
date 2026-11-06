//! Port of `src/flushers/sls-loggroup-codec.ts`.
//!
//! Wire bytes follow the Aliyun LogGroup protobuf subset that file encodes:
//! repeated logs (field 1), topic (field 3), source (field 4), and tags (field 6).
//! Timestamps are truncated to uint32 the same way JavaScript `value >>> 0` does.

use indexmap::IndexMap;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SlsLogEntryPayload {
    pub timestamp: i64,
    pub content: IndexMap<String, String>,
    pub timestamp_ns_part: Option<u32>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SlsLogGroupPayload {
    pub logs: Vec<SlsLogEntryPayload>,
    pub topic: Option<String>,
    pub source: Option<String>,
    pub tags: Option<Vec<IndexMap<String, String>>>,
}

pub fn encode_sls_log_group(payload: &SlsLogGroupPayload) -> Vec<u8> {
    let mut parts: Vec<Vec<u8>> = Vec::new();
    for log in &payload.logs {
        parts.push(field_bytes(1, &encode_log(log)));
    }
    if let Some(topic) = payload.topic.as_deref().filter(|value| !value.is_empty()) {
        parts.push(field_bytes(3, topic.as_bytes()));
    }
    if let Some(source) = payload.source.as_deref().filter(|value| !value.is_empty()) {
        parts.push(field_bytes(4, source.as_bytes()));
    }
    for tag in payload.tags.iter().flatten() {
        for (key, value) in tag {
            parts.push(field_bytes(6, &encode_key_value(key, value)));
        }
    }
    parts.into_iter().flatten().collect()
}

fn encode_log(log: &SlsLogEntryPayload) -> Vec<u8> {
    let mut parts = vec![field_varint(1, u64::from(log.timestamp as u32))];
    for (key, value) in &log.content {
        parts.push(field_bytes(2, &encode_key_value(key, value)));
    }
    if let Some(ns) = log.timestamp_ns_part {
        parts.push(field_fixed32(4, ns));
    }
    parts.into_iter().flatten().collect()
}

fn encode_key_value(key: &str, value: &str) -> Vec<u8> {
    let mut out = field_bytes(1, key.as_bytes());
    out.extend(field_bytes(2, value.as_bytes()));
    out
}

fn field_varint(field_no: u32, value: u64) -> Vec<u8> {
    let mut out = varint(u64::from(field_no) << 3);
    out.extend(varint(value));
    out
}

fn field_fixed32(field_no: u32, value: u32) -> Vec<u8> {
    let mut out = varint((u64::from(field_no) << 3) | 5);
    out.extend(value.to_le_bytes());
    out
}

fn field_bytes(field_no: u32, value: &[u8]) -> Vec<u8> {
    let mut out = varint((u64::from(field_no) << 3) | 2);
    out.extend(varint(value.len() as u64));
    out.extend(value);
    out
}

fn varint(mut value: u64) -> Vec<u8> {
    let mut out = Vec::new();
    while value >= 0x80 {
        out.push(((value & 0x7f) as u8) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;

    fn content(pairs: &[(&str, &str)]) -> IndexMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn encodes_log_topic_source_and_preserves_content_order() {
        let payload = SlsLogGroupPayload {
            logs: vec![SlsLogEntryPayload {
                timestamp: 1,
                content: content(&[("k", "v")]),
                timestamp_ns_part: None,
            }],
            topic: Some("t".to_string()),
            source: Some("s".to_string()),
            tags: None,
        };
        assert_eq!(
            encode_sls_log_group(&payload),
            hex_bytes("0a0a080112060a016b1201761a0174220173")
        );
    }

    #[test]
    fn encodes_nanosecond_part_as_fixed32_and_wraps_timestamp_to_uint32() {
        let payload = SlsLogGroupPayload {
            logs: vec![SlsLogEntryPayload {
                timestamp: -1,
                content: content(&[("k", "v")]),
                timestamp_ns_part: Some(5),
            }],
            topic: Some(String::new()),
            source: None,
            tags: None,
        };
        let bytes = encode_sls_log_group(&payload);
        // uint32(-1) is a 5-byte varint, so the log body is 19 bytes. Matches
        // `encodeSlsLogGroup` in sls-loggroup-codec.ts.
        assert_eq!(&bytes[0..2], &[0x0a, 0x13]);
        assert_eq!(&bytes[2..7], &[0x08, 0xff, 0xff, 0xff, 0xff]);
        assert_eq!(&bytes[bytes.len() - 5..], &[0x25, 0x05, 0x00, 0x00, 0x00]);
        assert!(!bytes.windows(2).any(|pair| pair == [0x1a, 0x00]));
    }

    #[test]
    fn encodes_tag_key_and_value_after_logs() {
        let mut tag = IndexMap::new();
        tag.insert("__hostname__".to_string(), "h".to_string());
        let payload = SlsLogGroupPayload {
            logs: vec![SlsLogEntryPayload {
                timestamp: 1,
                content: content(&[("message", "api-key-transport")]),
                timestamp_ns_part: None,
            }],
            topic: Some("api-key-test".to_string()),
            source: Some("unit-test".to_string()),
            tags: Some(vec![tag]),
        };
        let bytes = encode_sls_log_group(&payload);
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("api-key-transport"));
        assert!(text.contains("__hostname__"));
        assert!(text.contains("api-key-test"));
        assert!(text.contains("unit-test"));
    }

    #[test]
    fn empty_group_is_empty_bytes() {
        assert!(encode_sls_log_group(&SlsLogGroupPayload::default()).is_empty());
    }

    fn hex_bytes(hex_text: &str) -> Vec<u8> {
        (0..hex_text.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&hex_text[index..index + 2], 16).unwrap())
            .collect()
    }
}
