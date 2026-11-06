use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Git and workspace attributes produced by git enrichment. Always passed
/// through onto trace spans, independent of user-defined attributes.
pub const DEFAULT_GIT_PASSTHROUGH_KEYS: &[&str] = &[
    "git.repo",
    "git.branch",
    "git.domain",
    "workspace.current_root",
    "workspace.path",
];

/// Prefixes reserved for converter-managed and pipeline fields. User-defined
/// custom attributes matching these are dropped so they cannot clobber semantics.
const RESERVED_PREFIXES: &[&str] = &[
    "gen_ai.",
    "git.",
    "workspace.",
    "event.",
    "trace_",
    "user.",
    "cost_",
    "agent.",
    "time_unix_nano",
    "observed_time_unix_nano",
];

/// Insertion-ordered string map. Later inserts of an existing key update the
/// value in place, matching JavaScript object spread.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AttrMap {
    entries: Vec<(String, String)>,
}

impl AttrMap {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(existing, _)| existing == key)
            .map(|(_, value)| value.as_str())
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn keys(&self) -> Vec<String> {
        self.entries.iter().map(|(key, _)| key.clone()).collect()
    }

    pub fn insert(&mut self, key: String, value: String) {
        if let Some((_, existing)) = self
            .entries
            .iter_mut()
            .find(|(existing, _)| existing == &key)
        {
            *existing = value;
        } else {
            self.entries.push((key, value));
        }
    }

    fn overlay(&self, top: &AttrMap) -> AttrMap {
        let mut merged = self.clone();
        for (key, value) in &top.entries {
            merged.insert(key.clone(), value.clone());
        }
        merged
    }
}

pub fn is_reserved_key(key: &str) -> bool {
    RESERVED_PREFIXES
        .iter()
        .any(|prefix| key.starts_with(prefix))
}

/// Parse OTel-style `key1=value1,key2=value2`. Split on `,`, then on the first
/// `=`. Trim, and skip empty or malformed entries.
pub fn parse_key_value_attributes(raw: Option<&str>) -> AttrMap {
    let mut out = AttrMap::default();
    let Some(raw) = raw else {
        return out;
    };
    if raw.is_empty() {
        return out;
    }
    for pair in raw.split(',') {
        let Some(idx) = pair.find('=') else {
            continue;
        };
        if idx == 0 {
            continue;
        }
        let key = pair[..idx].trim();
        let value = pair[idx + 1..].trim();
        if key.is_empty() || value.is_empty() {
            continue;
        }
        out.insert(key.to_string(), value.to_string());
    }
    out
}

fn coerce_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Bool(flag) => Some(flag.to_string()),
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                Some(integer.to_string())
            } else if let Some(unsigned) = number.as_u64() {
                Some(unsigned.to_string())
            } else {
                number.as_f64().map(|float| {
                    if float.fract() == 0.0 && float.abs() < 1e21 {
                        format!("{}", float as i64)
                    } else {
                        number.to_string()
                    }
                })
            }
        }
        _ => None,
    }
}

/// Drop reserved-prefix keys and values that are not strings, numbers, or bools.
pub fn sanitize_attributes(input: &Map<String, Value>) -> AttrMap {
    let mut out = AttrMap::default();
    for (key, raw_value) in input {
        if is_reserved_key(key) {
            continue;
        }
        let Some(value) = coerce_string(raw_value) else {
            continue;
        };
        out.insert(key.clone(), value);
    }
    out
}

enum FileRead {
    Retry,
    Ready(AttrMap),
}

/// User-defined global span attributes. A static baseline (config and env,
/// captured at startup) is merged with a mutable JSON file re-read when its
/// mtime changes. File values win over the baseline.
///
/// These attributes are injected into trace spans only, not the event log.
pub struct GlobalAttributesProvider {
    baseline: AttrMap,
    file_path: PathBuf,
    cached_mtime: Option<SystemTime>,
    seen_file: bool,
    cached_merged: AttrMap,
}

impl GlobalAttributesProvider {
    pub fn new(baseline: &Map<String, Value>, file_path: impl Into<PathBuf>) -> Self {
        let baseline = sanitize_attributes(baseline);
        Self {
            cached_merged: baseline.clone(),
            baseline,
            file_path: file_path.into(),
            cached_mtime: None,
            seen_file: false,
        }
    }

    /// Merged attributes (baseline, then file). Re-reads the file only when its
    /// mtime changes.
    pub fn resolve(&mut self) -> AttrMap {
        let mtime = match file_mtime(&self.file_path) {
            Some(mtime) => mtime,
            None => {
                if self.seen_file {
                    self.cached_mtime = None;
                    self.seen_file = false;
                    self.cached_merged = self.baseline.clone();
                }
                return self.cached_merged.clone();
            }
        };

        if self.seen_file && self.cached_mtime == Some(mtime) {
            return self.cached_merged.clone();
        }

        match self.read_file_attrs() {
            FileRead::Retry => self.cached_merged.clone(),
            FileRead::Ready(attrs) => {
                self.cached_mtime = Some(mtime);
                self.seen_file = true;
                self.cached_merged = self.baseline.overlay(&attrs);
                self.cached_merged.clone()
            }
        }
    }

    pub fn keys(&mut self) -> Vec<String> {
        self.resolve().keys()
    }

    fn read_file_attrs(&self) -> FileRead {
        let raw = match fs::read_to_string(&self.file_path) {
            Ok(raw) => raw,
            Err(err) => {
                tracing::warn!(
                    target: "GlobalAttributes",
                    file_path = %self.file_path.display(),
                    error = %err,
                    "failed to read span-attributes file; will retry"
                );
                return FileRead::Retry;
            }
        };
        let parsed = match serde_json::from_str::<Value>(&raw) {
            Ok(parsed) => parsed,
            Err(err) => {
                tracing::warn!(
                    target: "GlobalAttributes",
                    file_path = %self.file_path.display(),
                    error = %err,
                    "span-attributes file has invalid JSON; will retry"
                );
                return FileRead::Retry;
            }
        };
        match parsed {
            Value::Object(map) => FileRead::Ready(sanitize_attributes(&map)),
            _ => {
                tracing::warn!(
                    target: "GlobalAttributes",
                    file_path = %self.file_path.display(),
                    "span-attributes file is not a JSON object; ignoring"
                );
                FileRead::Ready(AttrMap::default())
            }
        }
    }
}

fn file_mtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).ok()?.modified().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Map, Value};
    use std::fs::{self, OpenOptions};
    use std::time::{Duration, SystemTime};

    fn attr(pairs: &[(&str, &str)]) -> AttrMap {
        let mut map = AttrMap::default();
        for (key, value) in pairs {
            map.insert((*key).to_string(), (*value).to_string());
        }
        map
    }

    fn object(raw: &str) -> Map<String, Value> {
        serde_json::from_str(raw).expect("json object")
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!(
                "gattr-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&dir).expect("temp dir");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn set_mtime(path: &Path, when: SystemTime) {
        let file = OpenOptions::new().write(true).open(path).expect("open");
        file.set_modified(when).expect("set mtime");
    }

    #[test]
    fn parses_otel_style_pairs() {
        assert_eq!(
            parse_key_value_attributes(Some("team=infra,env=prod")),
            attr(&[("team", "infra"), ("env", "prod")])
        );
    }

    #[test]
    fn keeps_only_the_first_equals_as_separator() {
        assert_eq!(
            parse_key_value_attributes(Some("url=a=b")),
            attr(&[("url", "a=b")])
        );
    }

    #[test]
    fn trims_and_skips_empty_or_malformed_entries() {
        assert_eq!(
            parse_key_value_attributes(Some(" a = 1 , , b, =x, c=2 ")),
            attr(&[("a", "1"), ("c", "2")])
        );
    }

    #[test]
    fn returns_empty_for_missing_or_empty() {
        assert!(parse_key_value_attributes(None).is_empty());
        assert!(parse_key_value_attributes(Some("")).is_empty());
    }

    #[test]
    fn drops_reserved_prefix_keys() {
        let input = object(r#"{"team":"x","gen_ai.foo":"y","git.repo":"z","agent.o.cwd":"w"}"#);
        assert_eq!(sanitize_attributes(&input), attr(&[("team", "x")]));
    }

    #[test]
    fn coerces_number_and_boolean_and_skips_objects_and_arrays() {
        let input = object(r#"{"a":1,"b":true,"c":{"x":1},"d":[1],"e":"ok"}"#);
        assert_eq!(
            sanitize_attributes(&input),
            attr(&[("a", "1"), ("b", "true"), ("e", "ok")])
        );
    }

    #[test]
    fn flags_reserved_prefixes() {
        for key in [
            "gen_ai.x",
            "git.repo",
            "workspace.current_root",
            "event.name",
            "trace_id",
            "user.id",
            "cost_usd",
            "agent.o.cwd",
        ] {
            assert!(is_reserved_key(key), "{key}");
        }
    }

    #[test]
    fn allows_plain_custom_keys() {
        assert!(!is_reserved_key("team"));
        assert!(!is_reserved_key("deployment.env"));
    }

    #[test]
    fn returns_baseline_when_file_is_absent() {
        let dir = TempDir::new();
        let file_path = dir.path().join("span-attributes.json");
        let mut provider =
            GlobalAttributesProvider::new(&object(r#"{"team":"infra"}"#), &file_path);
        assert_eq!(provider.resolve(), attr(&[("team", "infra")]));
        assert_eq!(provider.keys(), vec!["team".to_string()]);
    }

    #[test]
    fn file_overrides_baseline() {
        let dir = TempDir::new();
        let file_path = dir.path().join("span-attributes.json");
        fs::write(&file_path, r#"{"env":"staging","extra":"v"}"#).unwrap();
        let mut provider =
            GlobalAttributesProvider::new(&object(r#"{"team":"infra","env":"prod"}"#), &file_path);
        let resolved = provider.resolve();
        assert_eq!(resolved.get("team"), Some("infra"));
        assert_eq!(resolved.get("env"), Some("staging"));
        assert_eq!(resolved.get("extra"), Some("v"));
        assert_eq!(resolved.len(), 3);
    }

    #[test]
    fn sanitizes_file_contents() {
        let dir = TempDir::new();
        let file_path = dir.path().join("span-attributes.json");
        fs::write(
            &file_path,
            r#"{"ok":"v","num":3,"git.repo":"x","obj":{"a":1}}"#,
        )
        .unwrap();
        let mut provider = GlobalAttributesProvider::new(&Map::new(), &file_path);
        let resolved = provider.resolve();
        assert_eq!(resolved.get("ok"), Some("v"));
        assert_eq!(resolved.get("num"), Some("3"));
        assert_eq!(resolved.len(), 2);
    }

    #[test]
    fn rereads_on_mtime_change() {
        let dir = TempDir::new();
        let file_path = dir.path().join("span-attributes.json");
        fs::write(&file_path, r#"{"v":"1"}"#).unwrap();
        let mut provider = GlobalAttributesProvider::new(&Map::new(), &file_path);
        assert_eq!(provider.resolve(), attr(&[("v", "1")]));
        fs::write(&file_path, r#"{"v":"2","w":"3"}"#).unwrap();
        set_mtime(&file_path, SystemTime::now() + Duration::from_secs(5));
        let resolved = provider.resolve();
        assert_eq!(resolved, attr(&[("v", "2"), ("w", "3")]));
    }

    #[test]
    fn falls_back_to_baseline_on_bad_json() {
        let dir = TempDir::new();
        let file_path = dir.path().join("span-attributes.json");
        fs::write(&file_path, "{ not json").unwrap();
        let mut provider =
            GlobalAttributesProvider::new(&object(r#"{"team":"infra"}"#), &file_path);
        assert_eq!(provider.resolve(), attr(&[("team", "infra")]));
    }

    #[test]
    fn keeps_last_good_and_retries_on_bad_json() {
        let dir = TempDir::new();
        let file_path = dir.path().join("span-attributes.json");
        fs::write(&file_path, r#"{"v":"1"}"#).unwrap();
        let mut provider =
            GlobalAttributesProvider::new(&object(r#"{"team":"infra"}"#), &file_path);
        let first = provider.resolve();
        assert_eq!(first, attr(&[("team", "infra"), ("v", "1")]));
        let good_mtime = provider.cached_mtime;

        fs::write(&file_path, "{ half-written").unwrap();
        let retry_mtime = SystemTime::now() + Duration::from_secs(5);
        set_mtime(&file_path, retry_mtime);
        let kept = provider.resolve();
        assert_eq!(kept, first);
        assert_eq!(provider.cached_mtime, good_mtime);

        fs::write(&file_path, r#"{"v":"2"}"#).unwrap();
        // 修复内容但保留损坏时的 mtime，证明失败未提交缓存时间戳，下一次仍会重读。
        set_mtime(&file_path, retry_mtime);
        let next = provider.resolve();
        assert_eq!(next.get("team"), Some("infra"));
        assert_eq!(next.get("v"), Some("2"));
        assert_eq!(next.len(), 2);
    }

    #[test]
    fn resets_to_baseline_when_file_is_deleted() {
        let dir = TempDir::new();
        let file_path = dir.path().join("span-attributes.json");
        fs::write(&file_path, r#"{"v":"1"}"#).unwrap();
        let mut provider =
            GlobalAttributesProvider::new(&object(r#"{"team":"infra"}"#), &file_path);
        let loaded = provider.resolve();
        assert_eq!(loaded, attr(&[("team", "infra"), ("v", "1")]));
        fs::remove_file(&file_path).unwrap();
        assert_eq!(provider.resolve(), attr(&[("team", "infra")]));
    }

    #[test]
    fn git_passthrough_keys_match_enrichment_fields() {
        assert_eq!(
            DEFAULT_GIT_PASSTHROUGH_KEYS,
            [
                "git.repo",
                "git.branch",
                "git.domain",
                "workspace.current_root",
                "workspace.path",
            ]
        );
    }
}
