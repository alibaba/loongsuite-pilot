//! Remove only owned registration nodes and commas, retaining all outer trivia.
use crate::utils::{parse_json_document, JsonSyntax};
use anyhow::{ensure, Context, Result};
use serde_json::Value;

#[derive(Clone)]
struct Element {
    start: usize,
    value: usize,
    end: usize,
    key: Option<String>,
    comma: Option<usize>,
}
fn trivia(bytes: &[u8], mut at: usize) -> Result<usize> {
    if at == 0 && bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        at = 3;
    }
    loop {
        while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
            at += 1;
        }
        if bytes.get(at..at + 2) == Some(b"//") {
            at += 2;
            while bytes.get(at).is_some_and(|c| *c != b'\r' && *c != b'\n') {
                at += 1;
            }
        } else if bytes.get(at..at + 2) == Some(b"/*") {
            at += 2;
            loop {
                ensure!(at + 1 < bytes.len(), "Invalid Copilot JSONC comment");
                if &bytes[at..at + 2] == b"*/" {
                    at += 2;
                    break;
                }
                at += 1;
            }
        } else {
            return Ok(at);
        }
    }
}
fn string_end(bytes: &[u8], start: usize) -> Result<usize> {
    ensure!(
        bytes.get(start) == Some(&b'"'),
        "Invalid Copilot JSONC string"
    );
    let mut at = start + 1;
    while let Some(byte) = bytes.get(at) {
        match byte {
            b'\\' => at += 2,
            b'"' => return Ok(at + 1),
            _ => at += 1,
        }
    }
    anyhow::bail!("Invalid Copilot JSONC string")
}
fn value_end(bytes: &[u8], start: usize) -> Result<usize> {
    let first = *bytes.get(start).context("Missing Copilot JSONC value")?;
    if first == b'"' {
        return string_end(bytes, start);
    }
    if first != b'{' && first != b'[' {
        let mut at = start;
        while bytes
            .get(at)
            .is_some_and(|b| !b.is_ascii_whitespace() && !matches!(b, b',' | b']' | b'}' | b'/'))
        {
            at += 1;
        }
        ensure!(at > start, "Invalid Copilot JSONC scalar");
        return Ok(at);
    }
    let mut stack = vec![if first == b'{' { b'}' } else { b']' }];
    let mut at = start + 1;
    while !stack.is_empty() {
        at = trivia(bytes, at)?;
        match *bytes.get(at).context("Unclosed Copilot JSONC container")? {
            b'"' => at = string_end(bytes, at)?,
            b'{' => {
                stack.push(b'}');
                at += 1;
            }
            b'[' => {
                stack.push(b']');
                at += 1;
            }
            b'}' | b']' => {
                ensure!(
                    stack.pop() == bytes.get(at).copied(),
                    "Invalid Copilot JSONC container"
                );
                at += 1;
            }
            _ => at += 1,
        }
    }
    Ok(at)
}
fn elements(raw: &str, start: usize) -> Result<Vec<Element>> {
    let bytes = raw.as_bytes();
    let object = bytes.get(start) == Some(&b'{');
    ensure!(
        object || bytes.get(start) == Some(&b'['),
        "Invalid Copilot JSONC container"
    );
    let close = if object { b'}' } else { b']' };
    let mut at = trivia(bytes, start + 1)?;
    let mut out = Vec::new();
    while bytes.get(at) != Some(&close) {
        let begin = at;
        let key = if object {
            let end = string_end(bytes, at)?;
            let key = serde_json::from_str::<String>(&raw[at..end])?;
            at = trivia(bytes, end)?;
            ensure!(bytes.get(at) == Some(&b':'), "Missing Copilot JSONC colon");
            at = trivia(bytes, at + 1)?;
            Some(key)
        } else {
            None
        };
        let value = at;
        let end = value_end(bytes, at)?;
        at = trivia(bytes, end)?;
        let comma = if bytes.get(at) == Some(&b',') {
            let comma = at;
            at = trivia(bytes, at + 1)?;
            Some(comma)
        } else {
            None
        };
        out.push(Element {
            start: begin,
            value,
            end,
            key,
            comma,
        });
        ensure!(
            comma.is_some() || bytes.get(at) == Some(&close),
            "Missing Copilot JSONC separator"
        );
    }
    Ok(out)
}
fn field(raw: &str, parent: usize, name: &str) -> Result<Option<Element>> {
    Ok(elements(raw, parent)?
        .into_iter()
        .rev()
        .find(|element| element.key.as_deref() == Some(name)))
}
fn remove_element(raw: &str, parent: usize, index: usize) -> Result<String> {
    let items = elements(raw, parent)?;
    let item = items.get(index).context("Missing Copilot JSONC node")?;
    let comma = item
        .comma
        .or_else(|| index.checked_sub(1).and_then(|i| items[i].comma));
    let mut edits = vec![(item.start, item.end)];
    if let Some(comma) = comma {
        edits.push((comma, comma + 1));
    }
    edits.sort_unstable_by_key(|entry| std::cmp::Reverse(entry.0));
    let mut output = raw.to_owned();
    for (start, end) in edits {
        output.replace_range(start..end, "");
    }
    Ok(output)
}
fn checked(raw: &str) -> Result<Value> {
    let value = parse_json_document(raw, JsonSyntax::Jsonc)
        .map_err(|_| anyhow::anyhow!("Invalid Copilot JSONC; original file preserved"))?;
    ensure!(value.is_object(), "Copilot JSONC must be an object");
    Ok(value)
}
fn root(raw: &str) -> Result<usize> {
    trivia(raw.as_bytes(), 0)
}
fn owned(entry: &Value, id: &str) -> bool {
    entry["name"] == id && entry["marketplace"] == id
}
pub(super) fn remove_registrations(
    settings: &str,
    installed: &str,
    id: &str,
) -> Result<(String, String)> {
    // Validate both documents before computing edits for either one.
    let mut expected_settings = checked(settings)?;
    let mut expected_installed = checked(installed)?;
    ensure!(
        expected_settings
            .get("enabledPlugins")
            .is_none_or(Value::is_object),
        "Invalid Copilot enabledPlugins map"
    );
    ensure!(
        expected_installed
            .get("installedPlugins")
            .is_none_or(Value::is_array),
        "Invalid Copilot installedPlugins array"
    );
    let key = format!("{id}@{id}");
    if let Some(map) = expected_settings
        .get_mut("enabledPlugins")
        .and_then(Value::as_object_mut)
    {
        map.remove(&key);
    }
    if let Some(array) = expected_installed
        .get_mut("installedPlugins")
        .and_then(Value::as_array_mut)
    {
        array.retain(|entry| !owned(entry, id));
    }
    let mut settings = settings.to_owned();
    let mut installed = installed.to_owned();
    if let Some(map) = field(&settings, root(&settings)?, "enabledPlugins")? {
        let targets: Vec<_> = elements(&settings, map.value)?
            .iter()
            .enumerate()
            .filter(|(_, element)| element.key.as_deref() == Some(key.as_str()))
            .map(|(i, _)| i)
            .collect();
        for index in targets.into_iter().rev() {
            let map = field(&settings, root(&settings)?, "enabledPlugins")?
                .context("Missing Copilot enabledPlugins")?;
            settings = remove_element(&settings, map.value, index)?;
        }
    }
    if let Some(array) = field(&installed, root(&installed)?, "installedPlugins")? {
        let parsed = checked(&installed)?;
        let values = parsed["installedPlugins"]
            .as_array()
            .context("Invalid Copilot installedPlugins")?;
        let targets: Vec<_> = values
            .iter()
            .enumerate()
            .filter(|(_, v)| owned(v, id))
            .map(|(i, _)| i)
            .collect();
        ensure!(
            elements(&installed, array.value)?.len() == values.len(),
            "Ambiguous Copilot installedPlugins nodes"
        );
        for index in targets.into_iter().rev() {
            let array = field(&installed, root(&installed)?, "installedPlugins")?
                .context("Missing Copilot installedPlugins")?;
            installed = remove_element(&installed, array.value, index)?;
        }
    }
    ensure!(
        checked(&settings)? == expected_settings && checked(&installed)? == expected_installed,
        "Copilot JSONC cleanup changed unowned values"
    );
    Ok((settings, installed))
}

/// Update the one enabled flag and append one owned installation node.
/// Existing foreign map/array nodes, separators and comments are not serialized.
pub(super) fn set_registration(
    settings: &str,
    installed: &str,
    id: &str,
    entry: Value,
) -> Result<(String, String)> {
    use crate::utils::{edit_jsonc, JsonEditOptions, JsonPathSeg};
    let mut expected_settings = checked(settings)?;
    let mut expected_installed = checked(installed)?;
    ensure!(
        expected_settings
            .get("enabledPlugins")
            .is_none_or(Value::is_object),
        "Invalid Copilot enabledPlugins map"
    );
    ensure!(
        expected_installed
            .get("installedPlugins")
            .is_none_or(Value::is_array),
        "Invalid Copilot installedPlugins array"
    );
    ensure!(owned(&entry, id), "Invalid Copilot registration ownership");
    let key = format!("{id}@{id}");
    let expected_map = expected_settings
        .as_object_mut()
        .unwrap()
        .entry("enabledPlugins")
        .or_insert_with(|| Value::Object(Default::default()))
        .as_object_mut()
        .unwrap();
    expected_map.insert(key.clone(), Value::Bool(true));
    let expected_array = expected_installed
        .as_object_mut()
        .unwrap()
        .entry("installedPlugins")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .unwrap();
    expected_array.retain(|value| !owned(value, id));
    let index = expected_array.len();
    expected_array.push(entry.clone());
    let next_settings = edit_jsonc(
        settings,
        &[
            JsonPathSeg::Key("enabledPlugins".into()),
            JsonPathSeg::Key(key),
        ],
        Some(&Value::Bool(true)),
        JsonEditOptions::default(),
    );
    let (_, without_owned) = remove_registrations("{}", installed, id)?;
    let next_installed = edit_jsonc(
        &without_owned,
        &[
            JsonPathSeg::Key("installedPlugins".into()),
            JsonPathSeg::Index(index),
        ],
        Some(&entry),
        JsonEditOptions {
            is_array_insertion: true,
        },
    );
    ensure!(
        checked(&next_settings)? == expected_settings
            && checked(&next_installed)? == expected_installed,
        "Copilot registration edit changed unowned values"
    );
    Ok((next_settings, next_installed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn cleanup_preserves_bom_unicode_internal_comments_and_foreign_values() {
        let settings="\u{feff}// user settings\n{\"enabledPlugins\":{\"loongsuite-pilot@loongsuite-pilot\":true,\n// third-party registration\n\"third@third\":true,},\"user\":\"中文\"}\n";
        let installed="// CLI managed\n{\"installedPlugins\":[{\"name\":\"loongsuite-pilot\",\"marketplace\":\"loongsuite-pilot\"},\n// third-party metadata\n{\"name\":\"third\",\"marketplace\":\"third\"},{\"name\":\"loongsuite-pilot\",\"marketplace\":\"loongsuite-pilot\"},],\"url\":\"https://example.test/path//keep\"}\n";
        let (a, b) = remove_registrations(settings, installed, "loongsuite-pilot").unwrap();
        assert!(a.starts_with('\u{feff}'));
        assert!(a.contains("// user settings") && a.contains("// third-party registration"));
        assert!(b.contains("// CLI managed") && b.contains("// third-party metadata"));
        assert_eq!(
            checked(&a).unwrap(),
            json!({"enabledPlugins":{"third@third":true},"user":"中文"})
        );
        assert_eq!(
            checked(&b).unwrap(),
            json!({"installedPlugins":[{"name":"third","marketplace":"third"}],"url":"https://example.test/path//keep"})
        );
        assert_eq!(
            remove_registrations(&a, &b, "loongsuite-pilot").unwrap(),
            (a, b)
        );
    }
    #[test]
    fn every_array_position_and_trailing_comma_keeps_separator_trivia() {
        for position in 0..3 {
            for trailing in [false, true] {
                let mut entries = vec![r#"{"name":"first"}"#, r#"{"name":"last"}"#];
                entries.insert(
                    position,
                    r#"{"name":"loongsuite-pilot","marketplace":"loongsuite-pilot"}"#,
                );
                let raw = format!(
                    "{{\"installedPlugins\":[{}{}]}}",
                    entries.join(", /* foreign separator */ "),
                    if trailing { "," } else { "" }
                );
                let (_, out) = remove_registrations("{}", &raw, "loongsuite-pilot").unwrap();
                assert_eq!(out.matches("foreign separator").count(), 2);
                assert_eq!(
                    checked(&out).unwrap()["installedPlugins"],
                    json!([{"name":"first"},{"name":"last"}])
                );
            }
        }
    }
    #[test]
    fn escaped_owned_keys_and_comment_syntax_inside_strings_are_not_misparsed() {
        let settings = r#"{"enabledPlugins":{"loongsuite\u002dpilot@loongsuite-pilot":true,/* stay */"other":false},"text":"/* literal */ // keep \"quoted\""}"#;
        let (a, b) =
            remove_registrations(settings, r#"{"installedPlugins":[]}"#, "loongsuite-pilot")
                .unwrap();
        assert!(a.contains("/* stay */"));
        assert_eq!(
            checked(&a).unwrap()["text"],
            "/* literal */ // keep \"quoted\""
        );
        assert_eq!(
            checked(&a).unwrap()["enabledPlugins"],
            json!({"other":false})
        );
        assert_eq!(b, r#"{"installedPlugins":[]}"#);
    }
    #[test]
    fn absent_registration_preserves_every_byte_and_malformed_pair_is_rejected() {
        let settings = "\u{feff}{/* preserve */\"enabledPlugins\":{\"foreign\":true,},}\n";
        let installed = "{\"installedPlugins\":[/* preserve */{\"name\":\"foreign\"}],}\n";
        assert_eq!(
            remove_registrations(settings, installed, "loongsuite-pilot").unwrap(),
            (settings.into(), installed.into())
        );
        for bad in ["{broken", r#"{"installedPlugins":{}}"#] {
            assert!(remove_registrations(settings, bad, "loongsuite-pilot").is_err());
        }
        assert!(
            remove_registrations(r#"{"enabledPlugins":[]}"#, installed, "loongsuite-pilot")
                .is_err()
        );
    }
}

#[cfg(test)]
mod registration_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn set_nodes_preserves_nested_comments_separators_bom_and_duplicate_owned_entries() {
        for position in 0..3 {
            let settings="\u{feff}{\"enabledPlugins\":{/* map head */\"third@third\":true,/* map separator */\"loongsuite-pilot@loongsuite-pilot\":false,/* map tail */},\"custom\":\"中文\"}\n";
            let mut items = vec![
                r#"{"name":"first","detail":{/* nested */"url":"https://example.test//literal"}}"#,
                r#"{"name":"last"}"#,
            ];
            items.insert(
                position,
                r#"{"name":"loongsuite-pilot","marketplace":"loongsuite-pilot"}"#,
            );
            items.push(r#"{"name":"loongsuite-pilot","marketplace":"loongsuite-pilot"}"#);
            let installed = format!(
                "{{\"installedPlugins\":[/* head */{}/* tail */],\"other\":true}}",
                items.join(",/* separator */")
            );
            let entry = json!({"name":"loongsuite-pilot","marketplace":"loongsuite-pilot","cache_path":"/test"});
            let (a, b) =
                set_registration(settings, &installed, "loongsuite-pilot", entry.clone()).unwrap();
            assert!(a.starts_with('\u{feff}'));
            for marker in ["map head", "map separator", "map tail"] {
                assert!(a.contains(marker));
            }
            for marker in ["/* head */", "/* tail */", "/* nested */"] {
                assert!(b.contains(marker));
            }
            assert_eq!(b.matches("/* separator */").count(), 3);
            assert_eq!(
                checked(&a).unwrap()["enabledPlugins"],
                json!({"third@third":true,"loongsuite-pilot@loongsuite-pilot":true})
            );
            assert_eq!(
                checked(&b).unwrap()["installedPlugins"],
                json!([{"name":"first","detail":{"url":"https://example.test//literal"}},{"name":"last"},entry])
            );
        }
    }
    #[test]
    fn set_nodes_creates_missing_containers_and_validates_both_before_returning() {
        let entry = json!({"name":"pilot","marketplace":"pilot"});
        let (a, b) = set_registration(
            "{/* settings */}",
            "{/* installed */}",
            "pilot",
            entry.clone(),
        )
        .unwrap();
        assert!(a.contains("/* settings */") && b.contains("/* installed */"));
        assert_eq!(
            checked(&a).unwrap(),
            json!({"enabledPlugins":{"pilot@pilot":true}})
        );
        assert_eq!(checked(&b).unwrap(), json!({"installedPlugins":[entry]}));
        for bad in ["{broken", r#"{"installedPlugins":{}}"#] {
            assert!(set_registration(
                "{} ",
                bad,
                "pilot",
                json!({"name":"pilot","marketplace":"pilot"})
            )
            .is_err());
        }
    }
}
