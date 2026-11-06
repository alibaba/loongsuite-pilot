//! Snapshot work stays independent of retained conversation payload size.
//! This allocator belongs only to this integration-test executable.
use loongsuite_pilot::flushers::{
    BaseFlusher, ConvertOptions, ConvertResult, EventLogConverter, OtlpTraceFlusher,
};
use loongsuite_pilot::types::{AgentActivityEntry, OtlpTraceFlusherConfig};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::Arc;

thread_local! {
    static PROBING: Cell<bool> = const { Cell::new(false) };
    static ALLOCATED: Cell<usize> = const { Cell::new(0) };
}
struct CountingAllocator;
fn note_allocation(bytes: usize) {
    if PROBING.try_with(Cell::get).unwrap_or(false) {
        let _ = ALLOCATED.try_with(|total| total.set(total.get().saturating_add(bytes)));
    }
}
// SAFETY: All allocation operations delegate their unchanged pointer/layout to
// System; thread-local accounting never allocates and does not affect ownership.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            note_allocation(layout.size());
        }
        pointer
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            note_allocation(layout.size());
        }
        pointer
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let result = unsafe { System.realloc(pointer, layout, new_size) };
        if !result.is_null() {
            note_allocation(new_size);
        }
        result
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) }
    }
}
#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;
struct NoSpans;
impl EventLogConverter for NoSpans {
    fn convert(
        &self,
        _records: &[AgentActivityEntry],
        _options: &ConvertOptions,
    ) -> Result<ConvertResult, String> {
        Ok(ConvertResult::default())
    }
}
fn record(turn: &str, session: &str) -> AgentActivityEntry {
    serde_json::from_value(serde_json::json!({
        "event.name":"llm.response","gen_ai.agent.type":"codex",
        "gen_ai.turn.id":turn,"gen_ai.session.id":session,
        "gen_ai.output.messages":format!("private body {}", "x".repeat(128 * 1024))
    }))
    .unwrap()
}
#[tokio::test(flavor = "current_thread")]
async fn snapshot_does_not_copy_or_serialize_retained_conversation_payloads() {
    let root = tempfile::tempdir().unwrap();
    let config: OtlpTraceFlusherConfig = serde_json::from_value(serde_json::json!({
        "enabled":true,"protocol":"http/protobuf","serviceName":"test",
        "dataDir":root.path(),"turnIdleTimeoutMs":0,
        "endpoints":[{"name":"primary","endpoint":"http://unused:4318"}]
    }))
    .unwrap();
    let flusher =
        OtlpTraceFlusher::with_parts(config, None, None, Some(Arc::new(NoSpans))).unwrap();
    flusher
        .send(record("older", "a"), Some(20.0))
        .await
        .unwrap();
    flusher
        .send_batch(
            vec![record("larger", "b"), record("larger", "b")],
            Some(vec![40.0, 60.0]),
        )
        .await
        .unwrap();
    ALLOCATED.with(|total| total.set(0));
    PROBING.with(|active| active.set(true));
    let rows = flusher.trace_runtime_snapshot();
    PROBING.with(|active| active.set(false));
    let allocated = ALLOCATED.with(Cell::get);
    // A single retained payload exceeds 128 KiB; all snapshot metadata fits
    // comfortably below this budget, even in an unoptimized debug build.
    assert!(
        allocated < 16 * 1024,
        "snapshot allocated {allocated} bytes"
    );
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].pending_buffers, 2);
    assert_eq!(rows[0].pending_records, 3);
    assert_eq!(rows[0].pending_logical_bytes, 120.0);
    assert_eq!(rows[0].largest_buffer_turn_id.as_deref(), Some("larger"));
    assert!(!format!("{rows:?}").contains("private body"));
    flusher.shutdown().await.unwrap();
}
