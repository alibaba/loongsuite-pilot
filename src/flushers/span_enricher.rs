//! Native pre-export enrichers, including persistent embedded-JS workers.
//! Configured trusted .mjs modules keep main's ESM and synchronous patch contract.
mod client;
mod worker;
pub use worker::run_span_enricher_worker;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{Map, Value};

use super::otlp_json_serializer::ReadableSpan;
use crate::utils::create_logger;

#[derive(Clone, Debug)]
pub struct SpanEnricherContext {
    pub agent_type: String,
    pub service_name: String,
}

pub trait SpanEnricher: Send + Sync {
    fn enrich(
        &self,
        span: &SpanView,
        context: &SpanEnricherContext,
    ) -> Result<Option<Map<String, Value>>, String>;
}

#[derive(Clone, Debug)]
pub struct SpanView {
    pub name: String,
    pub trace_id: String,
    pub span_id: String,
    pub attributes: Map<String, Value>,
}

struct LoadedEnricher {
    path: String,
    plugin: Arc<dyn SpanEnricher>,
    warned: AtomicBool,
}

pub struct SpanEnricherRunner {
    plugins: Vec<LoadedEnricher>,
    paths: Vec<String>,
    executable: Option<PathBuf>,
    scripts: tokio::sync::OnceCell<Vec<Arc<client::ScriptPlugin>>>,
}

/// 内建扩展在此注册；配置的 ESM 脚本由隔离的原生 worker 执行。
fn builtin_enrichers() -> Vec<(String, Arc<dyn SpanEnricher>)> {
    Vec::new()
}

impl SpanEnricherRunner {
    pub fn new(paths: &[String]) -> Result<Self, String> {
        let mut runner = Self::from_plugins(builtin_enrichers());
        runner.paths = paths.to_vec();
        Ok(runner)
    }

    pub fn from_plugins(plugins: Vec<(String, Arc<dyn SpanEnricher>)>) -> Self {
        Self {
            paths: Vec::new(),
            executable: None,
            scripts: tokio::sync::OnceCell::new(),
            plugins: plugins
                .into_iter()
                .map(|(path, plugin)| LoadedEnricher {
                    path,
                    plugin,
                    warned: AtomicBool::new(false),
                })
                .collect(),
        }
    }

    /// Tests and embedded callers can name the same native executable explicitly.
    /// Production defaults to current_exe; it never searches for node/python.
    pub fn with_worker_executable(mut self, executable: impl AsRef<Path>) -> Self {
        self.executable = Some(executable.as_ref().to_owned());
        self
    }

    async fn load_scripts(&self) -> Vec<Arc<client::ScriptPlugin>> {
        let mut scripts = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for path in self.paths.iter().take(16) {
            let canonical = if path.ends_with(".mjs") {
                tokio::fs::canonicalize(path).await.ok()
            } else {
                None
            };
            match canonical {
                Some(path) if seen.insert(path.clone()) => {
                    scripts.push(Arc::new(client::ScriptPlugin::new(path)))
                }
                Some(_) => {}
                None => create_logger("span-enricher").warn(
                    "Cannot resolve span enricher; skipping",
                    serde_json::json!({"path":path}).as_object(),
                ),
            }
        }
        // main loads modules concurrently: 16 pending modules still consume one
        // five-second loading window, not sixteen sequential windows.
        let mut tasks = tokio::task::JoinSet::new();
        for script in &scripts {
            let script = Arc::clone(script);
            let executable = self.executable.clone();
            tasks.spawn(async move {
                script.load(executable.as_deref()).await;
            });
        }
        while tasks.join_next().await.is_some() {}
        scripts
    }

    pub async fn enrich(
        &self,
        spans: Vec<ReadableSpan>,
        context: SpanEnricherContext,
    ) -> Vec<ReadableSpan> {
        let mut spans: Vec<_> = spans
            .into_iter()
            .map(|span| self.enrich_one(span, &context))
            .collect();
        if self.paths.is_empty() {
            return spans;
        }
        let scripts = self.scripts.get_or_init(|| self.load_scripts()).await;
        for span in &mut spans {
            for script in scripts {
                let view = SpanView {
                    name: span.name.clone(),
                    trace_id: span.trace_id.clone(),
                    span_id: span.span_id.clone(),
                    attributes: snapshot_attributes(&span.attributes),
                };
                if let Some(patch) = script.enrich(&view, &context).await {
                    if apply_patch(&mut span.attributes, &patch).is_err() {
                        script.warn_patch();
                    }
                }
            }
        }
        spans
    }

    pub async fn shutdown(&self) {
        if let Some(scripts) = self.scripts.get() {
            for script in scripts {
                script.stop().await;
            }
        }
    }

    fn enrich_one(&self, mut span: ReadableSpan, context: &SpanEnricherContext) -> ReadableSpan {
        for entry in &self.plugins {
            let view = SpanView {
                name: span.name.clone(),
                trace_id: span.trace_id.clone(),
                span_id: span.span_id.clone(),
                attributes: snapshot_attributes(&span.attributes),
            };
            match entry.plugin.enrich(&view, context) {
                Ok(None) => {}
                Ok(Some(patch)) => match apply_patch(&mut span.attributes, &patch) {
                    Ok(()) => {}
                    Err(_) => warn_once(entry),
                },
                Err(_) => warn_once(entry),
            }
        }
        span
    }
}

fn warn_once(entry: &LoadedEnricher) {
    if entry.warned.swap(true, Ordering::SeqCst) {
        return;
    }
    create_logger("span-enricher").warn(
        "Span enricher failed; ignoring its patch (further errors suppressed)",
        Some(&meta(&[("path", Value::String(entry.path.clone()))])),
    );
}

pub fn apply_patch(
    attributes: &mut Map<String, Value>,
    patch: &Map<String, Value>,
) -> Result<(), String> {
    let mut updates = Map::new();
    for (key, value) in patch {
        if key.is_empty()
            || matches!(key.as_str(), "__proto__" | "prototype" | "constructor")
            || !valid_value(value)
        {
            return Err("Invalid attribute".to_string());
        }
        updates.insert(key.clone(), value.clone());
    }
    for (key, value) in updates {
        attributes.insert(key, value);
    }
    Ok(())
}

pub fn valid_value(value: &Value) -> bool {
    fn scalar(value: &Value) -> bool {
        match value {
            Value::String(_) | Value::Bool(_) => true,
            Value::Number(number) => number.as_f64().is_some_and(|number| number.is_finite()),
            _ => false,
        }
    }
    if scalar(value) {
        return true;
    }
    let Value::Array(items) = value else {
        return false;
    };
    let values: Vec<&Value> = items.iter().filter(|item| !item.is_null()).collect();
    if values.is_empty() {
        return true;
    }
    let first = type_tag(values[0]);
    values
        .iter()
        .all(|item| scalar(item) && type_tag(item) == first)
}

fn type_tag(value: &Value) -> &'static str {
    match value {
        Value::String(_) => "string",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        _ => "other",
    }
}

fn snapshot_attributes(attributes: &Map<String, Value>) -> Map<String, Value> {
    let mut copy = Map::new();
    for (key, value) in attributes {
        copy.insert(
            key.clone(),
            if let Value::Array(items) = value {
                Value::Array(items.clone())
            } else {
                value.clone()
            },
        );
    }
    copy
}

fn meta(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), value.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::otlp_json_serializer::ReadableSpan;
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    struct Plugin {
        patch: Value,
        fail: bool,
    }

    impl SpanEnricher for Plugin {
        fn enrich(
            &self,
            span: &SpanView,
            context: &SpanEnricherContext,
        ) -> Result<Option<Map<String, Value>>, String> {
            if self.fail {
                return Err("secret".to_string());
            }
            let mut patch = match &self.patch {
                Value::Object(map) => map.clone(),
                _ => return Err("invalid".to_string()),
            };
            if patch.get("use-view").is_some() {
                let tool = span
                    .attributes
                    .get("gen_ai.tool.name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                patch.insert(
                    "gen_ai.skill.name".to_string(),
                    Value::String(format!("{tool}:{}", context.agent_type)),
                );
                patch.remove("use-view");
            }
            Ok(Some(patch))
        }
    }

    fn span() -> ReadableSpan {
        let mut span = ReadableSpan::minimal("execute_tool shell", "aa", "bb");
        span.attributes.insert(
            "gen_ai.tool.name".to_string(),
            Value::String("shell".to_string()),
        );
        span.attributes
            .insert("tags".to_string(), json!(["original"]));
        span
    }

    #[tokio::test]
    async fn applies_plugins_in_order_without_mutating_the_input_snapshot() {
        let original = span();
        let runner = SpanEnricherRunner::from_plugins(vec![
            (
                "first".to_string(),
                Arc::new(Plugin {
                    patch: json!({"use-view": true, "count": 1}),
                    fail: false,
                }),
            ),
            (
                "second".to_string(),
                Arc::new(Plugin {
                    patch: json!({"gen_ai.skill.name": "shell:codex:next"}),
                    fail: false,
                }),
            ),
        ]);
        let context = SpanEnricherContext {
            agent_type: "codex".to_string(),
            service_name: "test-codex".to_string(),
        };
        let enriched = runner.enrich(vec![original.clone()], context).await;
        assert_eq!(
            enriched[0].attributes["gen_ai.skill.name"],
            "shell:codex:next"
        );
        assert_eq!(enriched[0].attributes["count"], 1);
        assert!(original.attributes.get("gen_ai.skill.name").is_none());
        assert_eq!(enriched[0].trace_id, original.trace_id);
        assert_eq!(enriched[0].ended, original.ended);
    }

    #[tokio::test]
    async fn invalid_patches_are_ignored_and_later_plugins_still_run() {
        let cases = [
            json!(null),
            json!([]),
            json!({"good": true, "bad": {}}),
            json!({"bad": [1, "x"]}),
            json!({"__proto__": "bad"}),
        ];
        for patch in cases {
            let runner = SpanEnricherRunner::from_plugins(vec![(
                "invalid".to_string(),
                Arc::new(Plugin { patch, fail: false }),
            )]);
            let original = span();
            let enriched = runner
                .enrich(
                    vec![original.clone()],
                    SpanEnricherContext {
                        agent_type: "codex".to_string(),
                        service_name: "svc".to_string(),
                    },
                )
                .await;
            assert_eq!(enriched[0].attributes, original.attributes);
        }

        let runner = SpanEnricherRunner::from_plugins(vec![
            (
                "throw".to_string(),
                Arc::new(Plugin {
                    patch: json!({}),
                    fail: true,
                }),
            ),
            (
                "good".to_string(),
                Arc::new(Plugin {
                    patch: json!({"ok": true}),
                    fail: false,
                }),
            ),
        ]);
        let enriched = runner
            .enrich(
                vec![span()],
                SpanEnricherContext {
                    agent_type: "codex".to_string(),
                    service_name: "svc".to_string(),
                },
            )
            .await;
        assert_eq!(enriched[0].attributes["ok"], true);
        assert_eq!(enriched[0].attributes["tags"], json!(["original"]));
    }

    #[test]
    fn accepts_scalars_and_homogeneous_arrays() {
        let mut attributes = Map::new();
        let patch = json!({"s": "x", "n": 1, "b": false, "a": [1, null, 2], "empty": []})
            .as_object()
            .unwrap()
            .clone();
        apply_patch(&mut attributes, &patch).unwrap();
        assert_eq!(attributes["s"], "x");
        assert_eq!(attributes["a"], json!([1, null, 2]));
        assert!(!valid_value(&serde_json::Value::Null));
    }

    #[test]
    fn script_paths_are_loaded_lazily_without_rejecting_legacy_configuration() {
        assert!(SpanEnricherRunner::new(&[]).is_ok());
        for path in ["/tmp/plugin.mjs", "/tmp/nope.js", " "] {
            let runner = SpanEnricherRunner::new(&[path.into()]).unwrap();
            assert!(runner.scripts.get().is_none());
        }
    }
}
