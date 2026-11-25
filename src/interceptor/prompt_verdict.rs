use super::{HookEventName, HookRequest};
use crate::types::AgentActivityEntry;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const CORRELATION: &str = "agent.pilot.interceptor.correlation";
pub(super) const MATCH_WINDOW_MS: u64 = 5_000;

#[derive(Clone, Debug, Hash, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PromptKey {
    pub session_id: String,
    pub agent_type: String,
    pub prompt_hash: String,
    pub request_id: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub missing_request_id: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub missing_agent_type: bool,
}

pub(crate) struct PromptLookup {
    pub session_id: String,
    pub agent_type: &'static str,
    pub prompt_hash: String,
    pub request_id: Option<String>,
    pub at: i64,
}

pub(crate) fn digest(text: &str) -> String {
    hex::encode(Sha256::digest(text))
}

pub(super) fn valid_digest(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
}

fn prompt_agent(agent: &str) -> Option<&'static str> {
    Some(match agent {
        "qodercli" | "qoder-cli" => "qoder-cli",
        "qoder" | "qoder-idea" | "qoder-jetbrains" => "qoder",
        "qoder-app" => "qoder-app",
        "qwen-work-cn" => "qwen-work-cn",
        "openclaw" => "openclaw",
        _ => return None,
    })
}

pub(super) fn is_qoder(agent: &str) -> bool {
    matches!(agent, "qoder" | "qoder-cli" | "qoder-app")
}

impl PromptKey {
    pub(crate) fn for_request(request: &HookRequest) -> Option<Self> {
        if request.event != HookEventName::UserPromptSubmit {
            return None;
        }
        let session = request.session_id.as_deref().filter(|s| !s.is_empty())?;
        let text = request.prompt.as_deref().filter(|s| !s.is_empty())?;
        let source = request.agent.as_str();
        let product = request
            .raw
            .get("parent_business_info")
            .and_then(|value| value.get("product"));
        let qoder = matches!(source, "qoder" | "qodercli" | "qoder-cli");
        let agent = prompt_agent(match (qoder, product.and_then(Value::as_str)) {
            (true, Some("cli")) => "qoder-cli",
            (true, Some("app")) => "qoder-app",
            _ => source,
        })?;
        let raw_id = request.raw.get("request_set_id");
        let request_id = raw_id
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 512)
            .map_or_else(|| uuid::Uuid::new_v4().to_string(), digest);
        Some(Self {
            session_id: session.into(),
            agent_type: agent.into(),
            prompt_hash: digest(text),
            request_id,
            missing_request_id: qoder && raw_id.is_none(),
            missing_agent_type: source == "qoder" && product.is_none(),
        })
    }

    pub(super) fn matches_source(&self, lookup: &PromptLookup) -> bool {
        self.session_id == lookup.session_id
            && self.prompt_hash == lookup.prompt_hash
            && (self.agent_type == lookup.agent_type
                || (self.missing_agent_type && is_qoder(lookup.agent_type)))
    }

    pub(super) fn valid(&self) -> bool {
        !self.session_id.is_empty()
            && prompt_agent(&self.agent_type).is_some()
            && (!self.missing_request_id || is_qoder(&self.agent_type))
            && (!self.missing_agent_type || self.agent_type == "qoder")
            && valid_digest(&self.prompt_hash)
            && (valid_digest(&self.request_id) || uuid::Uuid::parse_str(&self.request_id).is_ok())
    }
}

pub(crate) fn private_correlation(text: &str, at_ms: i64, request_id: Option<&str>) -> Value {
    let mut value = json!({"hash": digest(text), "at": at_ms});
    if let Some(id) = request_id.filter(|id| !id.is_empty() && id.len() <= 512) {
        value["requestId"] = json!(digest(id));
    }
    value
}

pub(crate) fn lookup_from_entry(entry: &AgentActivityEntry) -> Option<PromptLookup> {
    lookup(entry, entry.extra.get(CORRELATION).cloned())
}

pub(crate) fn lookup(entry: &AgentActivityEntry, metadata: Option<Value>) -> Option<PromptLookup> {
    let agent_type = prompt_agent(&entry.agent_type)?;
    if entry.session_id.is_empty() {
        return None;
    }
    if let Some(metadata) = metadata {
        let request_id = match metadata.get("requestId") {
            Some(value) => Some(value.as_str().filter(|id| valid_digest(id))?.to_owned()),
            None => None,
        };
        if let Some((hash, at)) = metadata["hash"]
            .as_str()
            .filter(|hash| valid_digest(hash))
            .zip(metadata["at"].as_i64())
        {
            return Some(PromptLookup {
                session_id: entry.session_id.clone(),
                agent_type,
                prompt_hash: hash.into(),
                at,
                request_id,
            });
        }
        if request_id.is_some() {
            return None;
        }
    }
    let mut users = entry
        .input_messages_delta
        .as_ref()?
        .as_array()?
        .iter()
        .filter(|message| message["role"] == "user");
    let user = users.next()?;
    if users.next().is_some() {
        return None;
    }
    let text = user["parts"]
        .as_array()?
        .iter()
        .filter(|part| part["type"] == "text")
        .filter_map(|part| part["content"].as_str())
        .collect::<String>();
    let at = entry.time_unix_nano.parse::<i64>().ok()? / 1_000_000;
    (!text.is_empty() && at > 0).then(|| PromptLookup {
        session_id: entry.session_id.clone(),
        agent_type,
        prompt_hash: digest(&text),
        at,
        request_id: None,
    })
}

pub(crate) fn remove_private_fields(entry: &mut AgentActivityEntry) -> Option<Value> {
    let correlation = entry.extra.remove(CORRELATION);
    for key in [
        "gen_ai.guardrail.reason",
        "gen_ai.guardrail.message",
        "gen_ai.guardrail.matched",
        "gen_ai.guardrail.enforcement",
        "gen_ai.guardrail.title",
        "gen_ai.guardrail.severity",
        "gen_ai.guardrail.match",
    ] {
        entry.extra.remove(key);
    }
    correlation
}

pub(crate) fn stamp_native_correlation(
    record: &mut Value,
    text: &str,
    at: i64,
    request_id: Option<&str>,
) {
    record[CORRELATION] = private_correlation(text, at, request_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interceptor::{GuardrailMetadata, ToolVerdictStore};

    #[test]
    fn missing_qoder_metadata_binds_once_and_keeps_ownership_after_restart() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("verdicts.json");
        let at = 1_795_168_801_000;
        let store = ToolVerdictStore::new(&path);
        let key = PromptKey {
            session_id: "shared".into(),
            agent_type: "qoder".into(),
            prompt_hash: digest("duplicate wording"),
            request_id: uuid::Uuid::new_v4().to_string(),
            missing_request_id: true,
            missing_agent_type: true,
        };
        let verdict = GuardrailMetadata::from_verdict(&json!({
            "action":"allow","matched":true,"ruleId":"test"
        }));
        let lookup = |request_id: &str, agent_type, delta| PromptLookup {
            session_id: key.session_id.clone(),
            agent_type,
            prompt_hash: key.prompt_hash.clone(),
            request_id: Some(digest(request_id)),
            at: at + delta,
        };
        store.put_prompt(key.clone(), Some(verdict.clone()), at);
        let unresolved = PromptKey {
            request_id: uuid::Uuid::new_v4().to_string(),
            ..key.clone()
        };
        store.put_prompt(unresolved, None, at + 200);
        assert!(store
            .get_prompt(lookup("first", "qoder-cli", 0), at + 200)
            .is_none());
        // The pending attempt is outside a nearby join by the time the first request is observed.
        assert_eq!(
            store.get_prompt(lookup("first", "qoder-cli", -4900), at + 200),
            Some(verdict.clone())
        );
        assert!(store
            .get_prompt(lookup("other", "qoder-app", -4900), at + 200)
            .is_none());
        store.stop_checkpoint_loop(at + 300).unwrap();
        let restored = ToolVerdictStore::new(path);
        restored.restore(at + 350);
        assert_eq!(
            restored.get_prompt(lookup("first", "qoder-cli", 7000), at + 350),
            Some(verdict)
        );
        assert!(restored
            .get_prompt(lookup("other", "qoder-cli", -4900), at + 350)
            .is_none());
    }

    #[test]
    fn historical_uuid_without_missing_metadata_never_binds_an_explicit_native_id() {
        let root = tempfile::tempdir().unwrap();
        let store = ToolVerdictStore::new(root.path().join("verdicts.json"));
        let at = 1_795_168_801_000;
        let key = PromptKey {
            session_id: "shared".into(),
            agent_type: "qoder-cli".into(),
            prompt_hash: digest("duplicate wording"),
            request_id: uuid::Uuid::new_v4().to_string(),
            missing_request_id: false,
            missing_agent_type: false,
        };
        store.put_prompt(
            key.clone(),
            Some(GuardrailMetadata::from_verdict(&json!({
                "action":"allow","matched":true,"ruleId":"test"
            }))),
            at,
        );
        assert!(store
            .get_prompt(
                PromptLookup {
                    session_id: key.session_id,
                    agent_type: "qoder-cli",
                    prompt_hash: key.prompt_hash,
                    request_id: Some(digest("unknown request")),
                    at,
                },
                at
            )
            .is_none());
    }

    #[test]
    fn exact_prompt_identity_survives_restart_and_ambiguous_text_stays_unlinked() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("verdicts.json");
        let at = 1_795_168_801_000;
        let key = PromptKey {
            session_id: "same-session".into(),
            agent_type: "qoder-cli".into(),
            prompt_hash: digest("same prompt"),
            request_id: digest("real-request"),
            missing_request_id: false,
            missing_agent_type: false,
        };
        let store = ToolVerdictStore::new(&path);
        let verdict = GuardrailMetadata::from_verdict(&json!({
            "action":"allow","matched":true,"ruleId":"log-review","ruleVersion":"1"
        }));
        store.put_prompt(key.clone(), Some(verdict.clone()), at);
        store.put_prompt(
            PromptKey {
                request_id: digest("other-request"),
                ..key.clone()
            },
            None,
            at + 1,
        );
        store.dump(at + 2).unwrap();
        let restored = ToolVerdictStore::new(path);
        restored.restore(at + 3);
        let query = |request_id| PromptLookup {
            session_id: "same-session".into(),
            agent_type: "qoder-cli",
            prompt_hash: digest("same prompt"),
            request_id,
            at,
        };
        assert_eq!(
            restored.get_prompt(query(Some(key.request_id)), at + 3),
            Some(verdict)
        );
        assert!(restored.get_prompt(query(None), at + 3).is_none());
    }
}
