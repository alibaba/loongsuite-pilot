//! Content-free checkpoints with branch-level copy on write.
use super::types::{DoubaoLogEvent, DoubaoPendingTurn};
use indexmap::IndexMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::ops::Deref;
use std::sync::Arc;
#[derive(Clone, Debug)]
pub struct CowMap<T>(Arc<IndexMap<String, T>>);
impl<T> Default for CowMap<T> {
    fn default() -> Self {
        Self(Arc::new(IndexMap::new()))
    }
}
impl<T> Deref for CowMap<T> {
    type Target = IndexMap<String, T>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl<T: Serialize> Serialize for CowMap<T> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.0.as_ref().serialize(s)
    }
}
impl<'de, T: Deserialize<'de>> Deserialize<'de> for CowMap<T> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        IndexMap::deserialize(d).map(|m| Self(Arc::new(m)))
    }
}
impl<T: Clone + PartialEq> CowMap<T> {
    pub fn set(&mut self, key: String, value: T) {
        if self.get(&key) != Some(&value) {
            Arc::make_mut(&mut self.0).insert(key, value);
        }
    }
    pub fn remove(&mut self, key: &str) {
        if self.contains_key(key) {
            Arc::make_mut(&mut self.0).shift_remove(key);
        }
    }
    pub fn compact(&mut self, max: usize, ttl: i64, now: i64, time: impl Fn(&T) -> i64) -> usize {
        let mut keys: Vec<_> = self
            .iter()
            .filter(|(_, v)| time(v) >= now - ttl)
            .map(|(k, v)| (k.clone(), time(v)))
            .collect();
        keys.sort_by_key(|(_, t)| *t);
        let mut drop: Vec<String> = self
            .iter()
            .filter(|(_, v)| time(v) < now - ttl)
            .map(|(k, _)| k.clone())
            .collect();
        drop.extend(
            keys.iter()
                .take(keys.len().saturating_sub(max))
                .map(|(k, _)| k.clone()),
        );
        for key in &drop {
            self.remove(key);
        }
        drop.len()
    }
}
impl<T> CowMap<T> {
    fn shares(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCursor {
    pub identity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub birthtime_bits: Option<u64>,
    pub offset: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub skipping_line: bool,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingTool {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<DoubaoLogEvent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<DoubaoLogEvent>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub conflict: bool,
    pub updated_ms: i64,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sandbox {
    pub actors: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub conflict: bool,
    pub updated_ms: i64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedExecution {
    pub digest: String,
    pub updated_ms: i64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationActor {
    pub call_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_nano: Option<String>,
    pub updated_ms: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub schema: u32,
    pub since_ms: i64,
    pub files: CowMap<FileCursor>,
    pub pending: CowMap<DoubaoPendingTurn>,
    pub completed: CowMap<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_scan_cursor: Option<String>,
    #[serde(default)]
    pub tools: CowMap<PendingTool>,
    #[serde(default)]
    pub roots: CowMap<DoubaoPendingTurn>,
    #[serde(default)]
    pub sandboxes: CowMap<Sandbox>,
    #[serde(default)]
    pub native_completed: CowMap<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_scan_cursor: Option<String>,
    #[serde(default)]
    pub executions_completed: CowMap<CompletedExecution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_scan_cursor: Option<String>,
    #[serde(default)]
    pub execution_first_seen: CowMap<i64>,
    #[serde(default)]
    pub native_mutation_actors: CowMap<MutationActor>,
}
impl Checkpoint {
    pub fn new(now: i64) -> Self {
        Self {
            schema: 1,
            since_ms: now,
            files: Default::default(),
            pending: Default::default(),
            completed: Default::default(),
            pending_scan_cursor: None,
            tools: Default::default(),
            roots: Default::default(),
            sandboxes: Default::default(),
            native_completed: Default::default(),
            native_scan_cursor: None,
            executions_completed: Default::default(),
            execution_scan_cursor: None,
            execution_first_seen: Default::default(),
            native_mutation_actors: Default::default(),
        }
    }
    pub fn unchanged(&self, base: &Self) -> bool {
        self.schema == base.schema
            && self.since_ms == base.since_ms
            && self.pending_scan_cursor == base.pending_scan_cursor
            && self.native_scan_cursor == base.native_scan_cursor
            && self.execution_scan_cursor == base.execution_scan_cursor
            && self.files.shares(&base.files)
            && self.pending.shares(&base.pending)
            && self.completed.shares(&base.completed)
            && self.tools.shares(&base.tools)
            && self.roots.shares(&base.roots)
            && self.sandboxes.shares(&base.sandboxes)
            && self.native_completed.shares(&base.native_completed)
            && self.executions_completed.shares(&base.executions_completed)
            && self.execution_first_seen.shares(&base.execution_first_seen)
            && self
                .native_mutation_actors
                .shares(&base.native_mutation_actors)
    }
    pub fn compact(&mut self, now: i64) {
        const DAY: i64 = 86_400_000;
        self.pending.compact(512, DAY, now, |v| v.updated_ms);
        self.completed.compact(4096, 7 * DAY, now, |v| *v);
        self.tools.compact(4096, DAY, now, |v| v.updated_ms);
        self.roots.compact(512, DAY, now, |v| v.updated_ms);
        self.sandboxes.compact(512, DAY, now, |v| v.updated_ms);
        self.native_completed.compact(4096, 7 * DAY, now, |v| *v);
        self.executions_completed
            .compact(4096, 7 * DAY, now, |v| v.updated_ms);
        self.execution_first_seen.compact(4096, DAY, now, |v| *v);
        self.native_mutation_actors
            .compact(4096, DAY, now, |v| v.updated_ms);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn idle_draft_keeps_every_committed_branch_and_noop_write_is_shared() {
        let mut base = Checkpoint::new(1);
        base.completed.set("one".into(), 1);
        let mut draft = base.clone();
        draft.completed.set("one".into(), 1);
        draft.completed.remove("absent");
        assert!(draft.unchanged(&base));
        assert!(Arc::ptr_eq(&draft.completed.0, &base.completed.0));
    }
    #[test]
    fn changed_branch_does_not_mutate_committed_and_preserves_unrelated_branches() {
        let mut base = Checkpoint::new(1);
        base.completed.set("one".into(), 1);
        let mut draft = base.clone();
        draft.completed.set("one".into(), 2);
        assert!(!draft.unchanged(&base));
        assert_eq!(base.completed["one"], 1);
        assert_eq!(draft.completed["one"], 2);
        assert!(Arc::ptr_eq(&draft.files.0, &base.files.0));
        let wire = serde_json::to_value(&draft).unwrap();
        assert_eq!(wire["completed"]["one"], 2);
        assert_eq!(
            serde_json::from_value::<Checkpoint>(wire)
                .unwrap()
                .completed["one"],
            2
        );
    }
    #[test]
    fn capacity_and_ttl_drop_oldest_but_keep_stable_newest_order() {
        let mut map = CowMap::default();
        for i in 0..5 {
            map.set(i.to_string(), i);
        }
        assert_eq!(map.compact(2, 3, 5, |v| *v), 3);
        assert_eq!(map.keys().cloned().collect::<Vec<_>>(), ["3", "4"]);
    }
    #[test]
    fn nested_array_and_record_edits_keep_the_committed_checkpoint_intact() {
        let mut base = Checkpoint::new(1);
        base.sandboxes.set(
            "box".into(),
            Sandbox {
                actors: vec!["one".into()],
                updated_ms: 1,
                ..Default::default()
            },
        );
        base.completed.set("one".into(), 2);
        let mut next = base.clone();
        let mut box_state = next.sandboxes["box"].clone();
        box_state.actors.push("two".into());
        box_state.updated_ms += 1;
        next.sandboxes.set("box".into(), box_state);
        assert_eq!(base.sandboxes["box"].actors, ["one"]);
        assert_eq!(base.sandboxes["box"].updated_ms, 1);
        assert_eq!(next.sandboxes["box"].actors, ["one", "two"]);
        assert_eq!(next.sandboxes["box"].updated_ms, 2);
        assert!(Arc::ptr_eq(&base.completed.0, &next.completed.0));
        let encoded = serde_json::to_value(&next).unwrap();
        let decoded: Checkpoint = serde_json::from_value(encoded.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), encoded);
    }
    #[test]
    fn moving_pending_to_roots_resolves_the_owned_terminal_and_keeps_original_pending() {
        let mut base = Checkpoint::new(1);
        let pending = DoubaoPendingTurn {
            turn_id: "one".into(),
            terminal: Some(DoubaoLogEvent {
                time_nano: "123".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        base.pending.set("one".into(), pending);
        let mut next = base.clone();
        let borrowed = next.pending["one"].clone();
        next.roots.set("one".into(), borrowed);
        next.pending.remove("one");
        assert_eq!(next.roots["one"].terminal, base.pending["one"].terminal);
        assert!(base.pending.contains_key("one"));
        assert!(!next.pending.contains_key("one"));
        assert_eq!(
            serde_json::to_value(&next).unwrap()["roots"]["one"]["terminal"]["timeNano"],
            "123"
        );
    }
}
