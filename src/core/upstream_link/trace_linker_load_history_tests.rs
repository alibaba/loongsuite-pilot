//! Original load3 workloads: same sizes, deterministic interleaving and timing guard.
use super::*;
use crate::utils::content_hash;
use serde_json::json;
use std::collections::HashSet;
use std::io::Write;
use std::path::Path;

#[derive(Clone)]
struct Turn {
    id: String,
    text: String,
    expected: Option<(String, String)>,
    local: String,
}
struct Random(u32);
impl Random {
    fn draw(&mut self) -> u32 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut value = (self.0 ^ (self.0 >> 15)).wrapping_mul(1 | self.0);
        value = value.wrapping_add((value ^ (value >> 7)).wrapping_mul(61 | value)) ^ value;
        value ^ (value >> 14)
    }
    fn pick(&mut self, bound: usize) -> usize {
        ((f64::from(self.draw()) / 4294967296.0) * bound as f64).floor() as usize
    }
}
fn event(sid: &str, turn: &Turn, name: &str) -> AgentActivityEntry {
    let mut value = json!({
        "event.name":name,"gen_ai.session.id":sid,"gen_ai.turn.id":turn.id,
        "trace_id":turn.local,"span_id":if name=="other" {"aaaaaaaaaaaaaaaa"} else {"cccccccccccccccc"}
    });
    if name == "other" {
        value["gen_ai.input.messages_delta"] =
            json!([{"role":"user","parts":[{"type":"text","content":turn.text}]}]);
    } else {
        value["parent_span_id"] = json!("dddddddddddddddd");
    }
    serde_json::from_value(value).unwrap()
}
fn session(root: &Path, sid: &str, m: usize, counter: &mut u64) -> Vec<Turn> {
    let mut file =
        std::io::BufWriter::new(std::fs::File::create(root.join(format!("{sid}.jsonl"))).unwrap());
    let mut turns = Vec::new();
    for index in 0..m {
        let mut local = format!("local{sid}_{index}");
        while local.len() < 32 {
            local.push('0');
        }
        local.truncate(32);
        let kind = if index % 7 == 3 {
            "dup"
        } else if index % 7 == 5 {
            "prefix"
        } else if index % 11 == 9 {
            "miss"
        } else {
            "unique"
        };
        let id = format!("{sid}:t{index}");
        if kind == "miss" {
            turns.push(Turn {
                id,
                text: format!("miss-{sid}-{index}"),
                expected: None,
                local,
            });
            continue;
        }
        let trace = format!("{:032x}", *counter);
        let span = format!("{:016x}", *counter);
        *counter += 1;
        let text = if kind == "dup" {
            format!("dup-{sid}")
        } else if kind == "prefix" {
            format!("pfx-{sid}-{index}")
        } else {
            format!("q-{sid}-{index}-{}", "x".repeat((index * 7) % 300))
        };
        writeln!(file,"{}",json!({"type":"turn","sessionId":sid,"contentHash":content_hash(&text),"contentPrefix":text.chars().take(128).collect::<String>(),"traceparent":format!("00-{trace}-{span}-01")})).unwrap();
        let collected = if kind == "prefix" {
            format!("{text}\nCalled the Read tool: /tmp/f{index}.txt")
        } else {
            text
        };
        turns.push(Turn {
            id,
            text: collected,
            expected: Some((trace, span)),
            local,
        });
    }
    file.flush().unwrap();
    turns
}
fn check_turn(turn: &Turn, entries: &[AgentActivityEntry]) {
    for entry in entries {
        if let Some((trace, parent)) = &turn.expected {
            assert_eq!(entry.trace_id.as_deref(), Some(trace.as_str()));
            if entry.event_name == Some(crate::types::AgentEventName::Other) {
                assert_eq!(entry.parent_span_id.as_deref(), Some(parent.as_str()));
            }
        } else {
            assert_eq!(entry.trace_id.as_deref(), Some(turn.local.as_str()));
            if entry.event_name == Some(crate::types::AgentEventName::Other) {
                assert_eq!(entry.parent_span_id, None);
            }
        }
    }
}
async fn interleave_original_sixty_by_forty() {
    let root = tempfile::tempdir().unwrap();
    let mut counter = 1;
    let mut turns = Vec::new();
    let mut streams = Vec::new();
    for index in 0..60 {
        let sid = format!("ses_{index}");
        let current = session(root.path(), &sid, 40, &mut counter);
        let events = current
            .iter()
            .flat_map(|turn| {
                [
                    event(&sid, turn, "other"),
                    event(&sid, turn, "llm.request"),
                    event(&sid, turn, "llm.response"),
                ]
            })
            .collect::<Vec<_>>();
        turns.push(current);
        streams.push(events);
    }
    let mut rng = Random(12345);
    let mut cursors = vec![0; 60];
    let mut remaining = 60 * 40 * 3;
    let mut batches = 0;
    let linker = TraceLinker::with_retry(CorrelationStore::new(root.path()), 0, 0);
    while remaining > 0 {
        let mut batch = Vec::new();
        let mut positions = Vec::new();
        let picks = 1 + rng.pick(5);
        for _ in 0..picks {
            let si = rng.pick(60);
            if cursors[si] >= streams[si].len() {
                continue;
            }
            let take = 1 + rng.pick(3);
            for _ in 0..take {
                if cursors[si] >= streams[si].len() {
                    break;
                }
                let cursor = cursors[si];
                batch.push(streams[si][cursor].clone());
                positions.push((si, cursor));
                cursors[si] += 1;
                remaining -= 1;
            }
        }
        if !batch.is_empty() {
            linker.stamp(&mut batch).await;
            batches += 1;
            for ((si, index), entry) in positions.into_iter().zip(batch) {
                streams[si][index] = entry;
            }
        }
    }
    let mut used = HashSet::new();
    let mut stamped = 0;
    let mut missed = 0;
    for (si, current) in turns.iter().enumerate() {
        for (index, turn) in current.iter().enumerate() {
            check_turn(turn, &streams[si][index * 3..index * 3 + 3]);
            if let Some((trace, _)) = &turn.expected {
                assert!(used.insert(trace.clone()));
                stamped += 1;
            } else {
                missed += 1;
            }
        }
    }
    assert!(stamped > 0);
    assert!(missed > 0);
    eprintln!("[load] sessions=60 turns=2400 stamped={stamped} missed={missed} batches={batches}");
}
async fn measure_original_scaling(m: usize) -> std::time::Duration {
    let root = tempfile::tempdir().unwrap();
    let sid = "ses_scale";
    let mut file = std::io::BufWriter::new(
        std::fs::File::create(root.path().join(format!("{sid}.jsonl"))).unwrap(),
    );
    let mut events = Vec::new();
    for index in 0..m {
        let text = format!("scale-{index}");
        writeln!(file,"{}",json!({"type":"turn","sessionId":sid,"contentHash":content_hash(&text),"contentPrefix":text,"traceparent":format!("00-{:032x}-{:016x}-01",index+1,index+1)})).unwrap();
        let turn = Turn {
            id: format!("t{index}"),
            text,
            expected: None,
            local: "localllllllllllllllllllllllllllll"
                .chars()
                .take(32)
                .collect(),
        };
        events.push(event(sid, &turn, "other"));
    }
    file.flush().unwrap();
    let linker = TraceLinker::with_retry(CorrelationStore::new(root.path()), 0, 0);
    let start = std::time::Instant::now();
    linker.stamp(&mut events).await;
    let elapsed = start.elapsed();
    assert_eq!(
        events[m - 1].trace_id.as_deref(),
        Some(format!("{m:032x}").as_str())
    );
    elapsed
}
async fn original_four_hundred_session_cache_workload() {
    let root = tempfile::tempdir().unwrap();
    let mut counter = 1;
    let linker = TraceLinker::with_retry(CorrelationStore::new(root.path()), 0, 0);
    for index in 0..400 {
        let sid = format!("ses_h{index}");
        let turns = session(root.path(), &sid, 10, &mut counter);
        let mut batch = turns
            .iter()
            .flat_map(|turn| [event(&sid, turn, "other"), event(&sid, turn, "llm.request")])
            .collect::<Vec<_>>();
        linker.stamp(&mut batch).await;
        for (index, turn) in turns.iter().enumerate() {
            check_turn(turn, &batch[index * 2..index * 2 + 2]);
        }
    }
    // Node-only global.gc/process.memoryUsage.heapUsed is retired. Keep its
    // actual workload and expose native retained state, with no heap byte bound
    // claimed (the source asserted only heapUsed > 0, not a limit).
    assert_eq!(linker.cache.lock().unwrap().len(), 4000);
    assert_eq!(linker.first_turn.lock().unwrap().len(), 400);
    eprintln!("[cache] 400 sessions x10 turns: native cache=4000 first_turn=400; no heap-byte bound asserted");
}
#[tokio::test]
async fn original_interleaving_scaling_and_cache_workloads_preserve_all_sizes_and_guards() {
    // First10 raw draws captured from the original Node mulberry32(12345).
    let mut oracle = Random(12345);
    assert_eq!(
        (0..10).map(|_| oracle.draw()).collect::<Vec<_>>(),
        [
            4207900869, 1317490944, 2079646450, 3513001552, 2187978186, 1492380277, 316786230,
            3291647763, 4281336957, 3543444592
        ]
    );
    interleave_original_sixty_by_forty().await;
    let first = measure_original_scaling(1500).await;
    let second = measure_original_scaling(3000).await;
    let ratio = second.as_secs_f64() / first.as_secs_f64().max(0.00001);
    eprintln!("[scale] M1500={first:?} M3000={second:?} ratio={ratio:.2}");
    assert!(
        second < std::time::Duration::from_millis(5000),
        "original M3000 guard exceeded: {second:?}"
    );
    original_four_hundred_session_cache_workload().await;
}
