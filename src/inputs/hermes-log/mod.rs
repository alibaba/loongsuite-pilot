//! Hermes plugin session JSONL input. Port of `hermes-log-input.ts`.

use std::sync::Arc;

use serde_json::Map;
use serde_json::Value;

use crate::inputs::rest_support::{
    transform_hook_record, BoxFuture, LineFn, SessionInputOptions, SessionJsonlInput,
};
use crate::types::ClientType;
use crate::utils::{directory_exists, resolve_home};

const DEFAULT_SESSION_DIR: &str = "~/.loongsuite-pilot/logs/hermes-agent";
const DEFAULT_FILE_PATTERN: &str = "hermes-agent-*.jsonl";

pub struct HermesLogInput {
    inner: SessionJsonlInput,
}

impl HermesLogInput {
    pub fn new(opts: SessionInputOptions) -> Self {
        Self {
            inner: SessionJsonlInput::new(
                "HermesLogInput",
                "hermes-agent-log",
                ClientType::Hermes,
                DEFAULT_SESSION_DIR,
                DEFAULT_FILE_PATTERN,
                opts,
                hermes_lines(),
            ),
        }
    }

    pub async fn check_availability() -> bool {
        directory_exists(&resolve_home(DEFAULT_SESSION_DIR)).await
    }

    pub fn watch_paths() -> Vec<String> {
        vec![resolve_home(DEFAULT_SESSION_DIR)]
    }
}

impl std::ops::Deref for HermesLogInput {
    type Target = SessionJsonlInput;
    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

fn hermes_lines() -> LineFn {
    Arc::new(|record: Map<String, Value>, _path: String| {
        Box::pin(
            async move { transform_hook_record(&record, ClientType::Hermes, "hermes-agent").await },
        ) as BoxFuture<_>
    })
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::Arc;

    use serde_json::{json, Value};

    use super::*;
    use crate::inputs::rest_support::{entry_json, memory_state_store};
    use crate::types::CollectionMethod;

    struct Env {
        dir: tempfile::TempDir,
        store: Arc<crate::checkpoints::StateStore>,
    }

    impl Env {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("temp");
            let store = memory_state_store(dir.path());
            Self { dir, store }
        }

        fn input(
            &self,
            session_dir: Option<String>,
            file_pattern: Option<String>,
        ) -> HermesLogInput {
            HermesLogInput::new(SessionInputOptions {
                state_store: Arc::clone(&self.store),
                session_dir: Some(
                    session_dir.unwrap_or_else(|| self.dir.path().to_string_lossy().to_string()),
                ),
                file_pattern,
                poll_interval_ms: Some(60_000),
            })
        }

        fn write(&self, name: &str, records: &[Value]) -> PathBuf {
            let path = self.dir.path().join(name);
            let body = if records.is_empty() {
                String::new()
            } else {
                format!(
                    "{}\n",
                    records
                        .iter()
                        .map(|v| v.to_string())
                        .collect::<Vec<_>>()
                        .join("\n")
                )
            };
            std::fs::write(&path, body).unwrap();
            path
        }
    }

    fn make_record(event_id: &str) -> Value {
        json!({
            "event.id": event_id,
            "event.name": "llm.response",
            "user.id": "user-1",
            "gen_ai.session.id": "session-1",
            "gen_ai.turn.id": "turn-1",
            "gen_ai.step.id": event_id,
            "gen_ai.agent.type": "untrusted-source-value",
            "gen_ai.provider.name": "alibaba",
            "gen_ai.request.model": "qwen3-coder-plus",
            "gen_ai.response.model": "qwen3-coder-plus",
            "gen_ai.output.messages": [{ "role": "assistant", "parts": [{ "type": "text", "content": event_id }] }]
        })
    }

    fn event_ids(entries: &[crate::types::AgentActivityEntry]) -> Vec<String> {
        entries
            .iter()
            .map(|entry| {
                entry_json(entry)["event.id"]
                    .as_str()
                    .unwrap_or("")
                    .to_string()
            })
            .collect()
    }

    #[test]
    fn identity_and_watch_paths() {
        let env = Env::new();
        let input = env.input(None, None);
        assert_eq!(input.id(), "hermes-agent-log");
        assert_eq!(input.agent_type(), ClientType::Hermes);
        assert_eq!(
            input.collection_method(),
            CollectionMethod::SessionFilePolling
        );
        let home = std::env::var("HOME").expect("HOME");
        assert_eq!(
            HermesLogInput::watch_paths(),
            vec![PathBuf::from(home)
                .join(".loongsuite-pilot")
                .join("logs")
                .join("hermes-agent")
                .to_string_lossy()
                .into_owned()]
        );
    }

    #[tokio::test]
    async fn missing_directory_yields_no_files() {
        let env = Env::new();
        let input = env.input(
            Some(env.dir.path().join("missing").to_string_lossy().to_string()),
            None,
        );
        assert!(input.discover_session_files().await.is_empty());
    }

    #[tokio::test]
    async fn discovers_matching_files_in_order() {
        let env = Env::new();
        let file_b = env.write("hermes-agent-200.jsonl", &[]);
        let file_a = env.write("hermes-agent-100.jsonl", &[]);
        env.write("other-agent-100.jsonl", &[]);
        std::fs::create_dir(env.dir.path().join("hermes-agent-directory.jsonl")).unwrap();
        let files = env.input(None, None).discover_session_files().await;
        assert_eq!(
            files,
            vec![
                file_a.to_string_lossy().to_string(),
                file_b.to_string_lossy().to_string()
            ]
        );
    }

    #[tokio::test]
    async fn supports_custom_file_pattern() {
        let env = Env::new();
        let custom = env.write("worker-a.log", &[]);
        env.write("hermes-agent-100.jsonl", &[]);
        let files = env
            .input(None, Some("worker-?.log".to_string()))
            .discover_session_files()
            .await;
        assert_eq!(files, vec![custom.to_string_lossy().to_string()]);
    }

    #[tokio::test]
    async fn collects_files_with_independent_checkpoints() {
        let env = Env::new();
        let file_b = env.write("hermes-agent-202.jsonl", &[make_record("event-b1")]);
        let file_a = env.write("hermes-agent-101.jsonl", &[make_record("event-a1")]);
        let input = env.input(None, None);
        let initial = input.collect_entries().await.expect("collect");
        assert_eq!(
            event_ids(&initial),
            vec!["event-a1".to_string(), "event-b1".to_string()]
        );
        assert!(initial
            .iter()
            .all(|entry| entry.agent_type == ClientType::Hermes.as_str()));
        assert!(
            env.store
                .get_offset(&format!("hermes-agent-log:{}", file_a.display()))
                > 0.0
        );
        assert!(
            env.store
                .get_offset(&format!("hermes-agent-log:{}", file_b.display()))
                > 0.0
        );

        std::fs::write(
            &file_a,
            format!(
                "{}\n{}\n",
                std::fs::read_to_string(&file_a).unwrap().trim_end(),
                make_record("event-a2")
            ),
        )
        .unwrap();
        assert_eq!(
            event_ids(&input.collect_entries().await.unwrap()),
            vec!["event-a2".to_string()]
        );
        std::fs::write(
            &file_b,
            format!(
                "{}\n{}\n",
                std::fs::read_to_string(&file_b).unwrap().trim_end(),
                make_record("event-b2")
            ),
        )
        .unwrap();
        assert_eq!(
            event_ids(&input.collect_entries().await.unwrap()),
            vec!["event-b2".to_string()]
        );
    }

    #[tokio::test]
    async fn does_not_emit_existing_records_after_restart() {
        let env = Env::new();
        let file = env.write("hermes-agent-101.jsonl", &[make_record("event-1")]);
        assert_eq!(
            env.input(None, None).collect_entries().await.unwrap().len(),
            1
        );
        assert!(env
            .input(None, None)
            .collect_entries()
            .await
            .unwrap()
            .is_empty());
        std::fs::write(
            &file,
            format!(
                "{}\n{}\n",
                std::fs::read_to_string(&file).unwrap().trim_end(),
                make_record("event-2")
            ),
        )
        .unwrap();
        assert_eq!(
            event_ids(&env.input(None, None).collect_entries().await.unwrap()),
            vec!["event-2".to_string()]
        );
    }

    #[tokio::test]
    async fn preserves_skill_attributes_and_worker_resource() {
        let env = Env::new();
        let mut skill = make_record("skill-event");
        let obj = skill.as_object_mut().unwrap();
        obj.insert("event.name".to_string(), json!("tool.result"));
        obj.insert("gen_ai.tool.name".to_string(), json!("skill_view"));
        obj.insert(
            "gen_ai.skill.name".to_string(),
            json!("loongsuite-pr-review"),
        );
        obj.insert("gen_ai.skill.id".to_string(), json!("skill-pr-review"));
        obj.insert(
            "gen_ai.skill.description".to_string(),
            json!("Review LoongSuite PR readiness."),
        );
        obj.insert("gen_ai.skill.version".to_string(), json!("1.2.3"));
        env.write("hermes-agent-101.jsonl", &[skill]);
        let entries = env.input(None, None).collect_entries().await.unwrap();
        let value = entry_json(&entries[0]);
        assert_eq!(value["gen_ai.skill.name"], "loongsuite-pr-review");
        assert_eq!(value["gen_ai.skill.id"], "skill-pr-review");
        assert_eq!(
            value["gen_ai.skill.description"],
            "Review LoongSuite PR readiness."
        );
        assert_eq!(value["gen_ai.skill.version"], "1.2.3");

        let mut worker = make_record("worker-event");
        let obj = worker.as_object_mut().unwrap();
        obj.insert("gen_ai.agent.name".to_string(), json!("planner"));
        obj.insert(
            "resourceAttributes".to_string(),
            json!({ "agentteams.worker.name": "planner" }),
        );
        let env = Env::new();
        env.write("hermes-agent-101.jsonl", &[worker]);
        let entries = env.input(None, None).collect_entries().await.unwrap();
        let value = entry_json(&entries[0]);
        assert_eq!(value["gen_ai.agent.name"], "planner");
        assert_eq!(
            value["resourceAttributes"],
            json!({ "agentteams.worker.name": "planner" })
        );
    }

    #[tokio::test]
    async fn waits_for_incomplete_utf8_line() {
        let env = Env::new();
        let mut record = make_record("event-unicode");
        record.as_object_mut().unwrap().insert(
            "gen_ai.output.messages".to_string(),
            json!([{ "role": "assistant", "parts": [{ "type": "text", "content": "你好，Hermes" }] }]),
        );
        let complete = format!("{record}\n").into_bytes();
        let needle = "你好，Hermes".as_bytes();
        let unicode_start = complete
            .windows(needle.len())
            .position(|w| w == needle)
            .expect("needle");
        let split_at = unicode_start + 1;
        let file = env.dir.path().join("hermes-agent-101.jsonl");
        std::fs::write(&file, &complete[..split_at]).unwrap();
        let input = env.input(None, None);
        assert!(input.collect_entries().await.unwrap().is_empty());
        let key = format!("hermes-agent-log:{}", file.display());
        assert_eq!(env.store.get_offset(&key), 0.0);
        let mut handle = std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap();
        handle.write_all(&complete[split_at..]).unwrap();
        let entries = input.collect_entries().await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entry_json(&entries[0])["event.id"], "event-unicode");
        assert_eq!(
            entry_json(&entries[0])["gen_ai.output.messages"],
            json!([{ "role": "assistant", "parts": [{ "type": "text", "content": "你好，Hermes" }] }])
        );
        assert_eq!(env.store.get_offset(&key), complete.len() as f64);
    }

    #[tokio::test]
    async fn skips_malformed_lines() {
        let env = Env::new();
        let file = env.dir.path().join("hermes-agent-101.jsonl");
        std::fs::write(&file, format!("not-json\n{}\n", make_record("event-1"))).unwrap();
        let input = env.input(None, None);
        assert_eq!(
            event_ids(&input.collect_entries().await.unwrap()),
            vec!["event-1".to_string()]
        );
        let mut handle = std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap();
        writeln!(handle, "{}", make_record("event-2")).unwrap();
        assert_eq!(
            event_ids(&input.collect_entries().await.unwrap()),
            vec!["event-2".to_string()]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn diagnoses_unreadable_session_directory_once() {
        use crate::inputs::rest_support::process_uid;
        use std::os::unix::fs::PermissionsExt;
        if process_uid() == Some(0) {
            return;
        }
        let env = Env::new();
        let locked = env.dir.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::write(
            locked.join("hermes-agent-100.jsonl"),
            format!("{}\n", make_record("event-1")),
        )
        .unwrap();
        let mut perms = std::fs::metadata(&locked).unwrap().permissions();
        perms.set_mode(0o000);
        std::fs::set_permissions(&locked, perms).unwrap();
        let input = env.input(Some(locked.to_string_lossy().to_string()), None);
        assert!(input.discover_session_files().await.is_empty());
        assert_eq!(input.ownership_warning_count(), 1);
        assert!(input.discover_session_files().await.is_empty());
        assert_eq!(input.ownership_warning_count(), 1);
        let mut perms = std::fs::metadata(&locked).unwrap().permissions();
        perms.set_mode(0o755);
        let _ = std::fs::set_permissions(&locked, perms);
    }
}
