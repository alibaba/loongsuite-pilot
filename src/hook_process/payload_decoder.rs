//! Windows host ANSI mojibake repair, preserving the frozen shared Hook contract.
//! Native conversion follows the WHATWG tables, without a Node runtime.
use std::collections::HashMap;
use std::sync::LazyLock;

type EncodeMap = HashMap<char, Vec<u8>>;
fn build_map(encoding: &'static encoding_rs::Encoding, multi: bool) -> EncodeMap {
    let mut map = HashMap::new();
    let mut insert = |bytes: &[u8]| {
        let (text, errors) = encoding.decode_without_bom_handling(bytes);
        let mut chars = text.chars();
        if let (Some(ch), None) = (chars.next(), chars.next()) {
            if !errors && ch != '\u{fffd}' && ch.len_utf16() == 1 {
                map.entry(ch).or_insert_with(|| bytes.to_vec());
            }
        }
    };
    for byte in 0x80..=0xff {
        insert(&[byte]);
    }
    if multi {
        for lead in 0x81..=0xfe {
            for trail in 0x40..=0xfe {
                if trail != 0x7f {
                    insert(&[lead, trail]);
                }
            }
        }
    }
    map
}
static WESTERN: LazyLock<EncodeMap> = LazyLock::new(|| build_map(encoding_rs::WINDOWS_1252, false));
static CHINESE: LazyLock<EncodeMap> = LazyLock::new(|| build_map(encoding_rs::GBK, true));

fn recover(text: &str, map: &EncodeMap) -> Option<String> {
    let mut segments = text.split('\u{fffd}').peekable();
    let mut result = String::with_capacity(text.len());
    let mut trim_head = false;
    while let Some(segment) = segments.next() {
        let trim_tail = segments.peek().is_some();
        let mut bytes = Vec::with_capacity(segment.len());
        for ch in segment.chars() {
            if ch.is_ascii() {
                bytes.push(ch as u8);
            } else {
                bytes.extend_from_slice(map.get(&ch)?);
            }
        }
        let mut start = 0;
        let mut end = bytes.len();
        if trim_head {
            while start < end && bytes[start] & 0xc0 == 0x80 {
                start += 1;
            }
        }
        if trim_tail {
            let mut at = end;
            while at > start && bytes[at - 1] & 0xc0 == 0x80 {
                at -= 1;
            }
            if at == start {
                end = start;
            } else {
                let lead = bytes[at - 1];
                let need = if lead < 0x80 {
                    0
                } else if lead < 0xe0 {
                    1
                } else if lead < 0xf0 {
                    2
                } else {
                    3
                };
                if lead >= 0x80 && end - at < need {
                    end = at - 1;
                }
            }
        }
        let recovered = std::str::from_utf8(&bytes[start..end]).ok()?;
        result.push_str(recovered.strip_prefix('\u{feff}').unwrap_or(recovered));
        if trim_tail {
            result.push('\u{fffd}');
        }
        trim_head = true;
    }
    Some(result)
}
pub(super) fn decode_for_platform(bytes: &[u8], windows: bool) -> String {
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let text = String::from_utf8_lossy(bytes).into_owned();
    if windows && bytes.len() > 2 && !text.is_ascii() {
        for map in [&WESTERN, &CHINESE] {
            if let Some(recovered) = recover(&text, map) {
                if text.chars().count() > recovered.chars().count()
                    && recovered
                        .chars()
                        .any(|ch| !ch.is_ascii() && ch != '\u{fffd}')
                {
                    return recovered;
                }
            }
        }
    }
    text
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    fn fixtures() -> Value {
        serde_json::from_str(include_str!(
            "../../tests/fixtures/hooks/ansi-payload-history.json"
        ))
        .unwrap()
    }
    fn row(page: &str, text: &str) -> String {
        fixtures()["fixtures"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["page"] == page && row["text"] == text)
            .unwrap()["mojibake"]
            .as_str()
            .unwrap()
            .to_owned()
    }
    fn decode(text: &str, windows: bool) -> String {
        decode_for_platform(text.as_bytes(), windows)
    }
    #[test]
    fn source_empty_nullish_input_maps_to_native_empty_bytes() {
        assert_eq!(decode_for_platform(&[], false), "");
        assert_eq!(decode_for_platform(&[], true), "");
    }
    #[test]
    fn source_bom_is_removed_on_every_platform() {
        for win in [false, true] {
            assert_eq!(decode("\u{feff}{\"a\":1}", win), "{\"a\":1}");
        }
    }
    #[test]
    fn source_clean_ascii_is_unchanged_on_every_platform() {
        for win in [false, true] {
            assert_eq!(
                decode(r#"{"tool":"Read","ok":true}"#, win),
                r#"{"tool":"Read","ok":true}"#
            );
        }
    }
    #[test]
    fn source_clean_cjk_is_preserved_off_windows() {
        for text in ["业", "中文", r#"{"serviceNamePrefix":"支付网关"}"#, "测试"] {
            assert_eq!(decode(text, false), text);
        }
    }
    #[test]
    fn source_gbk_mojibake_is_preserved_off_windows() {
        let encoded = row("gbk", "测试日志");
        assert_eq!(decode(&encoded, false), encoded);
    }
    #[test]
    fn source_gbk_multichar_and_ascii_mix_are_repaired_on_windows() {
        for text in ["中文", "测试日志", "中文abc123"] {
            assert_eq!(decode(&row("gbk", text), true), text);
        }
    }
    #[test]
    fn source_windows_ascii_short_circuit_is_unchanged() {
        let text = r#"{"session_id":"abc-123","n":42}"#;
        assert_eq!(decode(text, true), text);
    }
    #[test]
    fn source_windows_clean_cjk_inflation_gate_prevents_false_repair() {
        for text in [
            "业",
            r#"{"user":"业"}"#,
            r#"{"cwd":"C:/Users/业/proj"}"#,
            r#"{"a":"业","b":1}"#,
            r#"{"serviceNamePrefix":"支付网关"}"#,
            "中文",
            "测试日志",
            "你好world",
        ] {
            assert_eq!(decode(text, true), text);
        }
    }
    #[test]
    fn source_inflation_gate_keeps_all_genuine_multichar_repairs() {
        for text in ["中文", "测试日志", "中文abc123"] {
            assert_eq!(decode(&row("gbk", text), true), text);
        }
    }
    #[test]
    fn source_cp936_single_byte_euro_does_not_abort_repair() {
        for text in [
            r#"{"c":"一"}"#,
            r#"{"c":"什"}"#,
            r#"{"c":"最"}"#,
            r#"{"c":"稀"}"#,
            r#"{"c":"耀"}"#,
        ] {
            let encoded = row("gbk", text);
            assert!(encoded.contains('€'));
            assert_eq!(decode(&encoded, true), text);
        }
    }
    #[test]
    fn source_windows_cp1252_payloads_are_repaired() {
        for text in [
            r#"{"c":"中文"}"#,
            r#"{"c":"一下"}"#,
            r#"{"c":"帮我看一下这个问题"}"#,
            r#"{"workspace":{"path":"C:/Users/太业/项目"}}"#,
            r#"{"status":"完成","summary":"已修复三个缺陷"}"#,
        ] {
            assert_eq!(decode(&row("windows-1252", text), true), text);
        }
    }
    #[test]
    fn source_cp1252_correction_is_never_run_off_windows() {
        let encoded = row("windows-1252", r#"{"c":"中文"}"#);
        assert_eq!(decode(&encoded, false), encoded);
    }
    #[test]
    fn source_cp936_destroyed_bytes_keep_one_replacement_while_other_text_recovers() {
        for (text, expected) in [
            (r#"{"c":"一下"}"#, "{\"c\":\"一\u{fffd}\"}"),
            (r#"{"c":"什么"}"#, "{\"c\":\"什\u{fffd}\"}"),
            (
                r#"{"c":"帮我看一下这个问题"}"#,
                "{\"c\":\"帮我看一下这个问\u{fffd}\"}",
            ),
            (
                r#"{"status":"完成","summary":"已修复三个缺陷"}"#,
                "{\"status\":\"完成\",\"summary\":\"已修复三个缺\u{fffd}\"}",
            ),
        ] {
            let encoded = row("gbk", text);
            assert!(encoded.contains('\u{fffd}'));
            assert_eq!(decode(&encoded, true), expected);
        }
    }
    #[test]
    fn source_only_destroyed_non_ascii_is_preserved_as_original() {
        let encoded = row("gbk", r#"{"c":"上"}"#);
        assert_eq!(decode(&encoded, true), encoded);
    }
    #[test]
    fn source_clean_euro_replacement_and_latin_are_preserved() {
        for text in [
            r#"{"c":"€100"}"#,
            r#"{"c":"一下"}"#,
            "{\"c\":\"坏\u{fffd}字\"}",
            r#"{"c":"café"}"#,
        ] {
            assert_eq!(decode(text, true), text);
        }
    }
    #[test]
    fn source_original_five_hundred_case_cjk_sweep_is_never_corrupted() {
        let f = fixtures();
        let clean = f["clean"].as_array().unwrap();
        assert_eq!(clean.len(), 500);
        for text in clean {
            let text = text.as_str().unwrap();
            assert_eq!(decode(text, true), text);
        }
    }
}
