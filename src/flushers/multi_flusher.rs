//! Port of `src/flushers/multi-flusher.ts`.
//!
//! Ordinary child failures are isolated; Codex durability failures propagate. Each child receives
//! its own clone of the entry. The TypeScript flusher shares one object, so a
//! child that mutates an entry during `send` can be observed by a sibling that
//! has not finished. The Rust port does not share that mutation.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Map, Value};

use super::base_flusher::{BaseFlusher, FlushError, TraceRuntimeSnapshot};
use crate::types::AgentActivityEntry;
use crate::utils::create_logger;

pub struct MultiFlusher {
    flushers: Vec<Arc<dyn BaseFlusher>>,
}

impl MultiFlusher {
    pub fn new(flushers: Vec<Arc<dyn BaseFlusher>>) -> Self {
        Self { flushers }
    }

    pub fn flushers(&self) -> &[Arc<dyn BaseFlusher>] {
        &self.flushers
    }
}

#[async_trait]
impl BaseFlusher for MultiFlusher {
    fn name(&self) -> &str {
        "multi"
    }

    fn uses_prepared_batch(&self) -> bool {
        self.flushers
            .iter()
            .any(|flusher| flusher.uses_prepared_batch())
    }

    async fn send_prepared_batch(
        &self,
        entries: Vec<AgentActivityEntry>,
        encoded: Vec<Vec<u8>>,
    ) -> Result<(), FlushError> {
        let lengths: Vec<f64> = encoded.iter().map(|row| row.len() as f64).collect();
        let Some(owner) = self
            .flushers
            .iter()
            .rposition(|flusher| flusher.uses_prepared_batch())
        else {
            return self.send_batch(entries, Some(lengths)).await;
        };
        let mut tasks = tokio::task::JoinSet::new();
        for (index, flusher) in self.flushers.iter().enumerate() {
            if index == owner {
                continue;
            }
            let flusher = Arc::clone(flusher);
            let entries = entries.clone();
            if flusher.uses_prepared_batch() {
                let encoded = encoded.clone();
                tasks.spawn(async move {
                    let name = flusher.name().to_owned();
                    (name, flusher.send_prepared_batch(entries, encoded).await)
                });
            } else {
                let lengths = lengths.clone();
                tasks.spawn(async move {
                    let name = flusher.name().to_owned();
                    (name, flusher.send_batch(entries, Some(lengths)).await)
                });
            }
        }
        let flusher = Arc::clone(&self.flushers[owner]);
        tasks.spawn(async move {
            let name = flusher.name().to_owned();
            (name, flusher.send_prepared_batch(entries, encoded).await)
        });
        finish_batch_tasks(tasks).await
    }

    async fn send(
        &self,
        entry: AgentActivityEntry,
        logical_bytes: Option<f64>,
    ) -> Result<(), FlushError> {
        let mut set = tokio::task::JoinSet::new();
        for (index, flusher) in self.flushers.iter().cloned().enumerate() {
            let entry = entry.clone();
            set.spawn(async move {
                let name = flusher.name().to_string();
                (index, name, flusher.send(entry, logical_bytes).await)
            });
        }
        let logger = create_logger("MultiFlusher");
        let mut durable_failure = None;
        while let Some(joined) = set.join_next().await {
            match joined {
                Ok((_, name, Err(error))) => {
                    logger.error(
                        "flusher send failed",
                        Some(&meta(&[
                            ("flusher", Value::String(name)),
                            ("error", Value::String(error.to_string())),
                        ])),
                    );
                    if error.preserves_checkpoint() && durable_failure.is_none() {
                        durable_failure = Some(error);
                    }
                }
                Ok((_, _, Ok(()))) => {}
                Err(error) => {
                    logger.error(
                        "flusher send failed",
                        Some(&meta(&[("error", Value::String(error.to_string()))])),
                    );
                }
            }
        }
        if let Some(error) = durable_failure {
            return Err(error);
        }
        Ok(())
    }

    async fn send_batch(
        &self,
        entries: Vec<AgentActivityEntry>,
        logical_bytes: Option<Vec<f64>>,
    ) -> Result<(), FlushError> {
        let mut set = tokio::task::JoinSet::new();
        if let Some((last_flusher, other_flushers)) = self.flushers.split_last() {
            for flusher in other_flushers {
                let flusher = Arc::clone(flusher);
                let entries = entries.clone();
                let logical_bytes = logical_bytes.clone();
                set.spawn(async move {
                    let name = flusher.name().to_string();
                    (name, flusher.send_batch(entries, logical_bytes).await)
                });
            }
            // The final destination can own the original batch. Keep its task
            // boundary so failure isolation and concurrent fan-out are unchanged.
            let flusher = Arc::clone(last_flusher);
            set.spawn(async move {
                let name = flusher.name().to_string();
                (name, flusher.send_batch(entries, logical_bytes).await)
            });
        }
        finish_batch_tasks(set).await
    }

    async fn flush(&self) -> Result<(), FlushError> {
        let mut set = tokio::task::JoinSet::new();
        for flusher in &self.flushers {
            let flusher = Arc::clone(flusher);
            set.spawn(async move { flusher.flush().await });
        }
        while set.join_next().await.is_some() {}
        Ok(())
    }

    async fn shutdown(&self) -> Result<(), FlushError> {
        let mut set = tokio::task::JoinSet::new();
        for flusher in &self.flushers {
            let flusher = Arc::clone(flusher);
            set.spawn(async move { flusher.shutdown().await });
        }
        while set.join_next().await.is_some() {}
        Ok(())
    }

    fn trace_runtime_snapshot(&self) -> Vec<TraceRuntimeSnapshot> {
        self.flushers
            .iter()
            .flat_map(|flusher| flusher.trace_runtime_snapshot())
            .collect()
    }

    async fn send_raw(&self, topic: &str, payload: &Map<String, Value>) -> Result<(), FlushError> {
        let mut set = tokio::task::JoinSet::new();
        for flusher in &self.flushers {
            let flusher = Arc::clone(flusher);
            let topic = topic.to_string();
            let payload = payload.clone();
            set.spawn(async move { flusher.send_raw(&topic, &payload).await });
        }
        while set.join_next().await.is_some() {}
        Ok(())
    }
}

async fn finish_batch_tasks(
    mut tasks: tokio::task::JoinSet<(String, Result<(), FlushError>)>,
) -> Result<(), FlushError> {
    let logger = create_logger("MultiFlusher");
    let mut durable_failure = None;
    while let Some(joined) = tasks.join_next().await {
        if let Ok((name, Err(error))) = joined {
            logger.error(
                "flusher sendBatch failed",
                Some(&meta(&[
                    ("flusher", Value::String(name)),
                    ("error", Value::String(error.to_string())),
                ])),
            );
            if error.preserves_checkpoint() && durable_failure.is_none() {
                durable_failure = Some(error);
            }
        }
    }
    durable_failure.map_or(Ok(()), Err)
}

fn meta(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), value.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{BaseFlusher, FlushError, MultiFlusher};
    use crate::types::AgentActivityEntry;
    use async_trait::async_trait;
    use serde_json::{json, Map, Value};
    use std::sync::{Arc, Mutex};

    struct MockFlusher {
        name: String,
        should_fail: Mutex<bool>,
        sends: Mutex<usize>,
        batches: Mutex<Vec<usize>>,
        raw: Mutex<Vec<(String, Map<String, Value>)>>,
        flushes: Mutex<usize>,
        shutdowns: Mutex<usize>,
        batch_bytes: Mutex<Vec<Option<Vec<f64>>>>,
    }

    impl MockFlusher {
        fn new(name: &str) -> Arc<Self> {
            Arc::new(Self {
                name: name.to_string(),
                should_fail: Mutex::new(false),
                sends: Mutex::new(0),
                batches: Mutex::new(Vec::new()),
                raw: Mutex::new(Vec::new()),
                flushes: Mutex::new(0),
                shutdowns: Mutex::new(0),
                batch_bytes: Mutex::new(Vec::new()),
            })
        }
    }

    #[async_trait]
    impl BaseFlusher for MockFlusher {
        fn name(&self) -> &str {
            &self.name
        }

        async fn send(
            &self,
            _entry: AgentActivityEntry,
            _logical_bytes: Option<f64>,
        ) -> Result<(), FlushError> {
            *self.sends.lock().unwrap() += 1;
            if *self.should_fail.lock().unwrap() {
                Err(FlushError::new("fail"))
            } else {
                Ok(())
            }
        }

        async fn send_batch(
            &self,
            entries: Vec<AgentActivityEntry>,
            logical_bytes: Option<Vec<f64>>,
        ) -> Result<(), FlushError> {
            self.batches.lock().unwrap().push(entries.len());
            self.batch_bytes.lock().unwrap().push(logical_bytes);
            if *self.should_fail.lock().unwrap() {
                Err(FlushError::new("fail"))
            } else {
                Ok(())
            }
        }

        async fn flush(&self) -> Result<(), FlushError> {
            *self.flushes.lock().unwrap() += 1;
            Ok(())
        }

        async fn shutdown(&self) -> Result<(), FlushError> {
            *self.shutdowns.lock().unwrap() += 1;
            if *self.should_fail.lock().unwrap() {
                Err(FlushError::new("fail"))
            } else {
                Ok(())
            }
        }

        async fn send_raw(
            &self,
            topic: &str,
            payload: &Map<String, Value>,
        ) -> Result<(), FlushError> {
            self.raw
                .lock()
                .unwrap()
                .push((topic.to_string(), payload.clone()));
            if *self.should_fail.lock().unwrap() {
                Err(FlushError::new("fail"))
            } else {
                Ok(())
            }
        }
    }

    #[tokio::test]
    async fn fans_out_batches_and_isolates_failures() {
        let first = MockFlusher::new("f1");
        let second = MockFlusher::new("f2");
        let multi = MultiFlusher::new(vec![first.clone(), second.clone()]);
        let entries = vec![crate::normalization::build_test_entry(&json!({}))];
        multi
            .send_batch(entries.clone(), Some(vec![123.0]))
            .await
            .unwrap();
        assert_eq!(
            first.batch_bytes.lock().unwrap()[0].as_ref().unwrap(),
            &vec![123.0]
        );
        assert!(multi.trace_runtime_snapshot().is_empty());

        multi
            .send_batch(
                vec![
                    crate::normalization::build_test_entry(&json!({})),
                    crate::normalization::build_test_entry(&json!({})),
                ],
                None,
            )
            .await
            .unwrap();
        assert_eq!(first.batches.lock().unwrap()[1], 2);
        assert_eq!(second.batches.lock().unwrap()[1], 2);

        *first.should_fail.lock().unwrap() = true;
        multi.send_batch(entries, None).await.unwrap();
        assert_eq!(second.batches.lock().unwrap().len(), 3);
        *first.should_fail.lock().unwrap() = false;
        *second.should_fail.lock().unwrap() = true;
        multi
            .send_batch(
                vec![crate::normalization::build_test_entry(&json!({}))],
                None,
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn send_raw_shutdown_and_flush_reach_every_child() {
        let first = MockFlusher::new("f1");
        let second = MockFlusher::new("f2");
        let multi = MultiFlusher::new(vec![first.clone(), second.clone()]);
        multi
            .send(crate::normalization::build_test_entry(&json!({})), None)
            .await
            .unwrap();
        assert_eq!(*first.sends.lock().unwrap(), 1);
        assert_eq!(*second.sends.lock().unwrap(), 1);

        let mut payload = Map::new();
        payload.insert("data".to_string(), Value::String("payload".to_string()));
        multi.send_raw("topic-x", &payload).await.unwrap();
        assert_eq!(first.raw.lock().unwrap()[0].0, "topic-x");
        assert_eq!(
            first.raw.lock().unwrap()[0].1.get("data").unwrap(),
            "payload"
        );
        assert_eq!(second.raw.lock().unwrap().len(), 1);

        *first.should_fail.lock().unwrap() = true;
        multi.send_raw("topic", &payload).await.unwrap();
        assert_eq!(second.raw.lock().unwrap().len(), 2);

        multi.shutdown().await.unwrap();
        assert_eq!(*second.shutdowns.lock().unwrap(), 1);
        *first.should_fail.lock().unwrap() = false;
        multi.flush().await.unwrap();
        assert_eq!(*first.flushes.lock().unwrap(), 1);
        assert_eq!(*second.flushes.lock().unwrap(), 1);
    }
}

#[cfg(test)]
mod migration_dispatch_contracts {
    use super::*;
    use async_trait::async_trait;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;
    use std::time::Duration;
    use tokio::sync::Barrier;

    type CapturedBatch = (Vec<Value>, Option<Vec<f64>>);

    struct RecordingSink {
        label: &'static str,
        fail: AtomicBool,
        barrier: Option<Arc<Barrier>>,
        singles: Mutex<Vec<Value>>,
        batches: Mutex<Vec<CapturedBatch>>,
        raw: Mutex<Vec<(String, Map<String, Value>)>>,
        flushes: AtomicUsize,
        shutdowns: AtomicUsize,
    }

    impl RecordingSink {
        fn new(label: &'static str, barrier: Option<Arc<Barrier>>) -> Arc<Self> {
            Arc::new(Self {
                label,
                fail: AtomicBool::new(false),
                barrier,
                singles: Mutex::new(Vec::new()),
                batches: Mutex::new(Vec::new()),
                raw: Mutex::new(Vec::new()),
                flushes: AtomicUsize::new(0),
                shutdowns: AtomicUsize::new(0),
            })
        }
        fn result(&self) -> Result<(), FlushError> {
            if self.fail.load(Ordering::SeqCst) {
                Err(FlushError::new("synthetic ordinary child failure"))
            } else {
                Ok(())
            }
        }
    }

    #[async_trait]
    impl BaseFlusher for RecordingSink {
        fn name(&self) -> &str {
            self.label
        }
        async fn send(&self, entry: AgentActivityEntry, _: Option<f64>) -> Result<(), FlushError> {
            self.singles
                .lock()
                .unwrap()
                .push(serde_json::to_value(entry).unwrap());
            self.result()
        }
        async fn send_batch(
            &self,
            entries: Vec<AgentActivityEntry>,
            bytes: Option<Vec<f64>>,
        ) -> Result<(), FlushError> {
            self.batches.lock().unwrap().push((
                entries
                    .into_iter()
                    .map(|entry| serde_json::to_value(entry).unwrap())
                    .collect(),
                bytes,
            ));
            if let Some(barrier) = &self.barrier {
                barrier.wait().await;
            }
            self.result()
        }
        async fn send_raw(
            &self,
            topic: &str,
            payload: &Map<String, Value>,
        ) -> Result<(), FlushError> {
            self.raw
                .lock()
                .unwrap()
                .push((topic.to_owned(), payload.clone()));
            self.result()
        }
        async fn flush(&self) -> Result<(), FlushError> {
            self.flushes.fetch_add(1, Ordering::SeqCst);
            self.result()
        }
        async fn shutdown(&self) -> Result<(), FlushError> {
            self.shutdowns.fetch_add(1, Ordering::SeqCst);
            self.result()
        }
    }

    fn entry(id: &str) -> AgentActivityEntry {
        crate::normalization::build_test_entry(&json!({
            "uuid":id,"agentType":"qoder","sessionId":"synthetic-session",
            "gen_ai.input.messages":[{"role":"user","parts":[{"type":"text","content":"synthetic input"}]}],
            "gen_ai.usage.total_tokens":17
        }))
    }

    #[tokio::test]
    async fn concurrent_batch_dispatch_preserves_each_entry_and_existing_byte_measurement() {
        let barrier = Arc::new(Barrier::new(2));
        let first = RecordingSink::new("first", Some(barrier.clone()));
        let second = RecordingSink::new("second", Some(barrier));
        let multi = MultiFlusher::new(vec![first.clone(), second.clone()]);
        for (entries, sizes) in [
            (vec![entry("measured")], Some(vec![123.0])),
            (vec![entry("left"), entry("right")], None),
        ] {
            let expected: Vec<Value> = entries
                .iter()
                .map(|row| serde_json::to_value(row).unwrap())
                .collect();
            // Both children must reach the barrier. Sequential fan-out would
            // deadlock, rather than merely happen to retain two final counts.
            tokio::time::timeout(
                Duration::from_secs(3),
                multi.send_batch(entries, sizes.clone()),
            )
            .await
            .expect("child batches did not run concurrently")
            .unwrap();
            for sink in [&first, &second] {
                let batches = sink.batches.lock().unwrap();
                assert_eq!(batches.last().unwrap(), &(expected.clone(), sizes.clone()));
            }
            assert!(multi.trace_runtime_snapshot().is_empty());
        }
        assert_eq!(first.batches.lock().unwrap().len(), 2);
        assert_eq!(second.batches.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn either_ordinary_child_failure_preserves_all_dispatch_and_lifecycle_calls() {
        for failing in 0..2 {
            let first = RecordingSink::new("first", None);
            let second = RecordingSink::new("second", None);
            let sinks = [&first, &second];
            let multi = MultiFlusher::new(vec![first.clone(), second.clone()]);
            let input = entry("single");
            let expected = serde_json::to_value(&input).unwrap();
            multi.send(input, None).await.unwrap();
            let payload = json!({"data":"payload"}).as_object().unwrap().clone();
            multi.send_raw("topic-x", &payload).await.unwrap();
            for sink in sinks {
                assert_eq!(*sink.singles.lock().unwrap(), vec![expected.clone()]);
                assert_eq!(
                    *sink.raw.lock().unwrap(),
                    vec![("topic-x".to_owned(), payload.clone())]
                );
            }
            sinks[failing].fail.store(true, Ordering::SeqCst);
            let batch = entry("ordinary-failure-batch");
            let expected = serde_json::to_value(&batch).unwrap();
            multi.send_batch(vec![batch], None).await.unwrap();
            let payload = json!({"x":1}).as_object().unwrap().clone();
            multi.send_raw("topic", &payload).await.unwrap();
            multi.shutdown().await.unwrap();
            for sink in sinks {
                assert_eq!(
                    *sink.batches.lock().unwrap(),
                    vec![(vec![expected.clone()], None)]
                );
                assert_eq!(
                    sink.raw.lock().unwrap()[1],
                    ("topic".to_owned(), payload.clone())
                );
                assert_eq!(sink.shutdowns.load(Ordering::SeqCst), 1);
            }
            sinks[failing].fail.store(false, Ordering::SeqCst);
            multi.shutdown().await.unwrap();
            multi.flush().await.unwrap();
            for sink in sinks {
                assert_eq!(sink.shutdowns.load(Ordering::SeqCst), 2);
                assert_eq!(sink.flushes.load(Ordering::SeqCst), 1);
            }
        }
    }
}

#[cfg(test)]
#[path = "multi_flusher_main_tests.rs"]
mod main_tests;
