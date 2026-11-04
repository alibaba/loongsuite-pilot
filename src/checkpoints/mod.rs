//! Input checkpoints.
//!
//! [`StateStore`] persists per-input offsets. [`SnapshotStore`] dedups IDE
//! snapshot events. Both write the same pretty JSON as the TypeScript
//! checkpoint stores: two-space indent, a trailing newline, and a temp-file
//! rename. Filesystem helpers live in this module so checkpoints do not depend
//! on `crate::utils`.

mod snapshot_store;
pub(crate) mod source_ownership;
mod state_json;
mod state_store;

pub use snapshot_store::{SnapshotEntry, SnapshotStatus, SnapshotStore};
pub use state_store::{CheckpointOutputHold, InputState, InputStatePatch, StateStore};

use std::collections::HashMap;

/// Insertion-ordered map. Iteration follows first-insert order, matching
/// JavaScript `Map`.
#[derive(Clone, Debug)]
struct OrderedMap<V> {
    order: Vec<String>,
    values: HashMap<String, V>,
}

impl<V> Default for OrderedMap<V> {
    fn default() -> Self {
        Self {
            order: Vec::new(),
            values: HashMap::new(),
        }
    }
}

impl<V> OrderedMap<V> {
    fn clear(&mut self) {
        self.order.clear();
        self.values.clear();
    }

    fn len(&self) -> usize {
        self.values.len()
    }

    fn contains(&self, key: &str) -> bool {
        self.values.contains_key(key)
    }

    fn get(&self, key: &str) -> Option<&V> {
        self.values.get(key)
    }

    fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.values.get_mut(key)
    }

    fn insert(&mut self, key: String, value: V) {
        match self.values.entry(key) {
            std::collections::hash_map::Entry::Occupied(mut entry) => {
                entry.insert(value);
            }
            std::collections::hash_map::Entry::Vacant(entry) => {
                self.order.push(entry.key().clone());
                entry.insert(value);
            }
        }
    }

    fn remove(&mut self, key: &str) -> Option<V> {
        let removed = self.values.remove(key)?;
        self.order.retain(|existing| existing != key);
        Some(removed)
    }

    fn keys(&self) -> impl Iterator<Item = &str> {
        self.order.iter().map(String::as_str)
    }

    fn iter(&self) -> impl Iterator<Item = (&str, &V)> {
        self.order
            .iter()
            .filter_map(|key| self.values.get(key).map(|value| (key.as_str(), value)))
    }
}

mod json_file {
    use std::fmt;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde::de::{self, Deserializer, MapAccess, SeqAccess, Visitor};
    use serde::Deserialize;

    #[derive(Clone, Debug)]
    pub(super) enum JVal {
        Null,
        Bool(bool),
        Number(serde_json::Number),
        String(String),
        Array(Vec<JVal>),
        Object(Vec<(String, JVal)>),
    }

    impl PartialEq for JVal {
        fn eq(&self, other: &Self) -> bool {
            match (self, other) {
                (Self::Null, Self::Null) => true,
                (Self::Bool(left), Self::Bool(right)) => left == right,
                (Self::Number(left), Self::Number(right)) => numbers_eq(left, right),
                (Self::String(left), Self::String(right)) => left == right,
                (Self::Array(left), Self::Array(right)) => {
                    left.len() == right.len() && left.iter().zip(right.iter()).all(|(a, b)| a == b)
                }
                (Self::Object(left), Self::Object(right)) => {
                    left.len() == right.len()
                        && left.iter().all(|(key, value)| {
                            right
                                .iter()
                                .find(|(candidate, _)| candidate == key)
                                .is_some_and(|(_, other_value)| value == other_value)
                        })
                }
                _ => false,
            }
        }
    }

    fn numbers_eq(left: &serde_json::Number, right: &serde_json::Number) -> bool {
        if left == right {
            return true;
        }
        // Converting both integers to f64 would merge adjacent identities above
        // 2^53. Keep exact integer comparison, including signed/unsigned pairs.
        match (integer_value(left), integer_value(right)) {
            (Some(left), Some(right)) => left == right,
            (Some(integer), None) => float_equals_integer(right, integer),
            (None, Some(integer)) => float_equals_integer(left, integer),
            (None, None) => match (left.as_f64(), right.as_f64()) {
                (Some(left), Some(right)) => left == right,
                _ => false,
            },
        }
    }

    fn integer_value(number: &serde_json::Number) -> Option<i128> {
        number
            .as_i64()
            .map(i128::from)
            .or_else(|| number.as_u64().map(i128::from))
    }

    fn float_equals_integer(number: &serde_json::Number, integer: i128) -> bool {
        let Some(value) = number.as_f64() else {
            return false;
        };
        // The upper bound is exclusive: u64::MAX rounds to 2^64 in f64.
        // Casting that rounded value to u64 would saturate and falsely match.
        value.is_finite()
            && value.fract() == 0.0
            && (i64::MIN as f64..u64::MAX as f64).contains(&value)
            && value as i128 == integer
    }

    impl<'de> Deserialize<'de> for JVal {
        fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
        where
            D: Deserializer<'de>,
        {
            deserializer.deserialize_any(JsonVisitor)
        }
    }

    struct JsonVisitor;

    impl<'de> Visitor<'de> for JsonVisitor {
        type Value = JVal;

        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            formatter.write_str("any JSON value")
        }

        fn visit_bool<E: de::Error>(self, value: bool) -> Result<JVal, E> {
            Ok(JVal::Bool(value))
        }

        fn visit_i64<E: de::Error>(self, value: i64) -> Result<JVal, E> {
            Ok(JVal::Number(value.into()))
        }

        fn visit_u64<E: de::Error>(self, value: u64) -> Result<JVal, E> {
            Ok(JVal::Number(value.into()))
        }

        fn visit_f64<E: de::Error>(self, value: f64) -> Result<JVal, E> {
            match serde_json::Number::from_f64(value) {
                Some(number) => Ok(JVal::Number(number)),
                None => Ok(JVal::Null),
            }
        }

        fn visit_str<E: de::Error>(self, value: &str) -> Result<JVal, E> {
            Ok(JVal::String(value.to_owned()))
        }

        fn visit_string<E: de::Error>(self, value: String) -> Result<JVal, E> {
            Ok(JVal::String(value))
        }

        fn visit_unit<E: de::Error>(self) -> Result<JVal, E> {
            Ok(JVal::Null)
        }

        fn visit_none<E: de::Error>(self) -> Result<JVal, E> {
            Ok(JVal::Null)
        }

        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<JVal, A::Error> {
            let mut items = Vec::new();
            while let Some(item) = seq.next_element::<JVal>()? {
                items.push(item);
            }
            Ok(JVal::Array(items))
        }

        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<JVal, A::Error> {
            // Preserve file order. `JSON.parse` keeps the first key position and
            // the last value when a key is repeated.
            let mut fields = Vec::new();
            while let Some((key, value)) = map.next_entry::<String, JVal>()? {
                if let Some((_, slot)) = fields.iter_mut().find(|(existing, _)| existing == &key) {
                    *slot = value;
                } else {
                    fields.push((key, value));
                }
            }
            Ok(JVal::Object(fields))
        }
    }

    pub(super) fn from_value(value: serde_json::Value) -> JVal {
        match value {
            serde_json::Value::Null => JVal::Null,
            serde_json::Value::Bool(value) => JVal::Bool(value),
            serde_json::Value::Number(value) => JVal::Number(value),
            serde_json::Value::String(value) => JVal::String(value),
            serde_json::Value::Array(items) => {
                JVal::Array(items.into_iter().map(from_value).collect())
            }
            serde_json::Value::Object(fields) => JVal::Object(
                fields
                    .into_iter()
                    .map(|(key, value)| (key, from_value(value)))
                    .collect(),
            ),
        }
    }

    pub(super) fn to_value(value: &JVal) -> serde_json::Value {
        match value {
            JVal::Null => serde_json::Value::Null,
            JVal::Bool(value) => serde_json::Value::Bool(*value),
            JVal::Number(value) => serde_json::Value::Number(value.clone()),
            JVal::String(value) => serde_json::Value::String(value.clone()),
            JVal::Array(items) => serde_json::Value::Array(items.iter().map(to_value).collect()),
            JVal::Object(fields) => {
                let mut map = serde_json::Map::new();
                for (key, value) in fields {
                    map.insert(key.clone(), to_value(value));
                }
                serde_json::Value::Object(map)
            }
        }
    }

    /// Whole numbers are written as integers, matching `JSON.stringify`.
    /// Non-finite numbers become `null`.
    pub(super) fn number_from_f64(value: f64) -> JVal {
        if !value.is_finite() {
            return JVal::Null;
        }
        if value.fract() == 0.0 {
            if value >= 0.0 {
                let as_u = value as u64;
                if as_u as f64 == value {
                    return JVal::Number(as_u.into());
                }
            } else if value >= i64::MIN as f64 {
                let as_i = value as i64;
                if as_i as f64 == value {
                    return JVal::Number(as_i.into());
                }
            }
        }
        match serde_json::Number::from_f64(value) {
            Some(number) => JVal::Number(number),
            None => JVal::Null,
        }
    }

    pub(super) fn to_pretty(value: &JVal) -> String {
        let mut out = String::new();
        write_pretty(&mut out, value, 0);
        out
    }

    fn write_pretty(out: &mut String, value: &JVal, indent: usize) {
        match value {
            JVal::Null => out.push_str("null"),
            JVal::Bool(true) => out.push_str("true"),
            JVal::Bool(false) => out.push_str("false"),
            JVal::Number(number) => out.push_str(&number.to_string()),
            JVal::String(value) => {
                out.push_str(&serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned()))
            }
            JVal::Array(items) if items.is_empty() => out.push_str("[]"),
            JVal::Array(items) => {
                out.push_str("[\n");
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push_str(",\n");
                    }
                    push_indent(out, indent + 1);
                    write_pretty(out, item, indent + 1);
                }
                out.push('\n');
                push_indent(out, indent);
                out.push(']');
            }
            JVal::Object(fields) if fields.is_empty() => out.push_str("{}"),
            JVal::Object(fields) => {
                out.push_str("{\n");
                for (index, (key, value)) in fields.iter().enumerate() {
                    if index > 0 {
                        out.push_str(",\n");
                    }
                    push_indent(out, indent + 1);
                    out.push_str(&serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_owned()));
                    out.push_str(": ");
                    write_pretty(out, value, indent + 1);
                }
                out.push('\n');
                push_indent(out, indent);
                out.push('}');
            }
        }
    }

    fn push_indent(out: &mut String, levels: usize) {
        for _ in 0..levels {
            out.push_str("  ");
        }
    }

    pub(super) fn system_now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
            .unwrap_or(0)
    }

    /// Reads JSON, returning `None` on any I/O or parse failure.
    /// A leading UTF-8 BOM is stripped before parsing.
    pub(super) async fn read_json(path: &Path) -> Option<JVal> {
        let text = tokio::fs::read_to_string(path).await.ok()?;
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
        serde_json::from_str(text).ok()
    }

    pub(super) async fn write_text_atomic(path: &Path, text: &str) -> Result<(), anyhow::Error> {
        let dir = path.parent().unwrap_or_else(|| Path::new(""));
        ensure_dir(dir).await;
        let tmp = atomic_tmp_path(path);
        match write_rename(&tmp, path, text).await {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                let _ = tokio::fs::remove_file(&tmp).await;
                ensure_dir(dir).await;
                let retry = atomic_tmp_path(path);
                match write_rename(&retry, path, text).await {
                    Ok(()) => Ok(()),
                    Err(retry_err) => {
                        let _ = tokio::fs::remove_file(&retry).await;
                        Err(retry_err.into())
                    }
                }
            }
            Err(err) if is_share_violation(&err) => {
                if tokio::fs::metadata(&tmp).await.is_ok() {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    match tokio::fs::rename(&tmp, path).await {
                        Ok(()) => Ok(()),
                        Err(_) => {
                            let _ = tokio::fs::remove_file(&tmp).await;
                            Err(err.into())
                        }
                    }
                } else {
                    Err(err.into())
                }
            }
            Err(err) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                Err(err.into())
            }
        }
    }

    async fn write_rename(tmp: &Path, dest: &Path, text: &str) -> std::io::Result<()> {
        tokio::fs::write(tmp, text.as_bytes()).await?;
        tokio::fs::rename(tmp, dest).await
    }

    async fn ensure_dir(dir: &Path) {
        if dir.as_os_str().is_empty() || dir == Path::new(".") {
            return;
        }
        let _ = tokio::fs::create_dir_all(dir).await;
    }

    fn atomic_tmp_path(path: &Path) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let mut tmp = path.as_os_str().to_owned();
        tmp.push(format!(
            ".{}.{}.{}.tmp",
            std::process::id(),
            system_now_ms(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        PathBuf::from(tmp)
    }

    fn is_share_violation(err: &std::io::Error) -> bool {
        // Node retries the rename on EPERM, EACCES, and EBUSY (and the Windows
        // sharing failures those codes surface as).
        match err.raw_os_error() {
            Some(1 | 13 | 16 | 5 | 32 | 33) => true,
            _ => err.kind() == std::io::ErrorKind::PermissionDenied,
        }
    }
}

#[cfg(test)]
#[path = "numeric_equality_tests.rs"]
mod numeric_equality_tests;

#[cfg(test)]
mod state_json_tests;
