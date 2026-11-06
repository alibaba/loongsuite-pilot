//! Original mocked-SQLite attachment contracts, executed on the native path.
use loongsuite_pilot::inputs::qoder_trace::multimodal::{
    derive_synthetic_ide_request_event_id, ImageLookup, PathToUri, QoderMultimodal,
};
use loongsuite_pilot::inputs::qoder_trace::AttachedImageLookup;
use loongsuite_pilot::multimodal::types::UriResult;
use loongsuite_pilot::types::{AgentActivityEntry, MultimodalUploadMode as Mode};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
type Rows = HashMap<String, AttachedImageLookup>;
type Answer = Result<Rows, String>;
#[derive(Default)]
struct Queries {
    rows: Rows,
    answers: Mutex<VecDeque<Answer>>,
    calls: Mutex<Vec<Vec<String>>>,
}
struct Harness {
    mm: QoderMultimodal,
    queries: Arc<Queries>,
    callback: PathToUri,
    converted: Arc<AtomicUsize>,
}
impl Harness {
    fn new(rows: Rows) -> Self {
        Self::scripted(rows, vec![])
    }
    fn scripted(rows: Rows, answers: Vec<Answer>) -> Self {
        let queries = Arc::new(Queries {
            rows,
            answers: Mutex::new(answers.into()),
            ..Default::default()
        });
        let reader = queries.clone();
        let lookup: ImageLookup = Arc::new(move |ids| {
            reader.calls.lock().unwrap().push(ids);
            let answer = reader
                .answers
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Ok(reader.rows.clone()));
            Box::pin(async move { answer })
        });
        let converted = Arc::new(AtomicUsize::new(0));
        let count = converted.clone();
        let callback: PathToUri = Arc::new(move |p, _| {
            count.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                Ok(std::fs::read_to_string(p).ok().map(|name| UriResult {
                    uri: format!("oss://test/{name}"),
                    mime_type: "image/png".into(),
                    modality: Some("image".into()),
                    size: 2,
                    sha256: name,
                }))
            })
        });
        Self {
            mm: QoderMultimodal::with_lookup(lookup),
            queries,
            callback,
            converted,
        }
    }
    async fn run(&self, entries: &mut Vec<AgentActivityEntry>, mode: Mode) {
        self.mm.enrich_ide(entries, mode, &self.callback).await;
    }
    fn calls(&self) -> Vec<Vec<String>> {
        self.queries.calls.lock().unwrap().clone()
    }
    fn converted(&self) -> usize {
        self.converted.load(Ordering::SeqCst)
    }
}
fn entry(overrides: Value) -> AgentActivityEntry {
    let mut base = json!({"event.id":"e1","event.name":"other","gen_ai.agent.type":"qoder",
 "gen_ai.session.id":"sess","gen_ai.turn.id":"turn-1","time_unix_nano":"1700000000000000000"})
    .as_object()
    .unwrap()
    .clone();
    base.extend(overrides.as_object().unwrap().clone());
    serde_json::from_value(Value::Object(base)).unwrap()
}
fn request(id: &str, text: &str) -> AgentActivityEntry {
    entry(json!({"event.name":"llm.request","gen_ai.request.id":id,
 "gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":text}]}]}))
}
fn response(id: &str) -> AgentActivityEntry {
    entry(
        json!({"event.id":format!("resp-{}",id.trim_start_matches("req-")),
 "event.name":"llm.response","gen_ai.request.id":id}),
    )
}
fn other(text: &str) -> AgentActivityEntry {
    entry(json!({"event.name":"other",
 "gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":text}]}]}))
}
fn image(d: &std::path::Path, name: &str) -> String {
    let p = d.join(format!("{name}.png"));
    std::fs::write(&p, name).unwrap();
    p.to_string_lossy().into_owned()
}
fn row(id: &str, path: &str) -> Rows {
    HashMap::from([(
        id.into(),
        AttachedImageLookup {
            paths: vec![path.into()],
            start_ms: None,
        },
    )])
}
fn parts(e: &AgentActivityEntry) -> Vec<Value> {
    e.input_messages_delta.as_ref().unwrap()[0]["parts"]
        .as_array()
        .unwrap()
        .clone()
}
fn has_uri(e: &AgentActivityEntry, name: &str) -> bool {
    parts(e)
        .iter()
        .any(|p| p["type"] == "uri" && p["uri"] == format!("oss://test/{name}"))
}
fn value(e: &AgentActivityEntry) -> Value {
    serde_json::to_value(e).unwrap()
}
#[tokio::test]
async fn attached_l1711_request_and_metadata() {
    let d = tempfile::tempdir().unwrap();
    let p = image(d.path(), "attach");
    let h = Harness::new(row("req-1", &p));
    let mut entries = vec![request("req-1", "look")];
    h.run(&mut entries, Mode::Input).await;
    assert_eq!(h.calls(), vec![vec!["req-1"]]);
    assert!(parts(&entries[0]).iter().any(|p| p["type"] == "text"));
    assert!(has_uri(&entries[0], "attach"));
    assert_eq!(
        value(&entries[0])["gen_ai.input.multimodal_metadata"],
        json!([{"uri":"oss://test/attach","mime_type":"image/png","modality":"image"}])
    );
}
#[tokio::test]
async fn attached_l1740_shared_id_only_first() {
    let d = tempfile::tempdir().unwrap();
    let p = image(d.path(), "first");
    let h = Harness::new(row("req-shared", &p));
    let mut entries = vec![
        request("req-shared", "first"),
        request("req-shared", "later"),
    ];
    h.run(&mut entries, Mode::Input).await;
    assert!(has_uri(&entries[0], "first"));
    assert_eq!(
        parts(&entries[1]),
        json!([{"type":"text","content":"later"}])
            .as_array()
            .unwrap()
            .clone()
    );
}
#[tokio::test]
async fn attached_l1773_input_gate() {
    let d = tempfile::tempdir().unwrap();
    let p = image(d.path(), "in-gate");
    let h = Harness::new(row("req-in-gate", &p));
    let mut output = vec![request("req-in-gate", "look")];
    h.run(&mut output, Mode::Output).await;
    assert_eq!(parts(&output[0]).len(), 1);
    assert_eq!(parts(&output[0])[0]["type"], "text");
    h.mm.clear_cache();
    let mut all = vec![request("req-in-gate", "look")];
    h.run(&mut all, Mode::All).await;
    assert!(has_uri(&all[0], "in-gate"));
}
#[tokio::test]
async fn attached_l1799_request_and_other_share_conversion() {
    let d = tempfile::tempdir().unwrap();
    let p = image(d.path(), "prefer");
    let h = Harness::new(row("req-pref", &p));
    let mut entries = vec![request("req-pref", "ctx"), other("explain")];
    h.run(&mut entries, Mode::Input).await;
    assert_eq!(h.converted(), 1);
    assert!(parts(&entries[0]).iter().any(|p| p["type"] == "uri"));
    assert!(parts(&entries[1]).iter().any(|p| p["type"] == "uri"));
}
#[tokio::test]
async fn attached_l1825_other_only_does_not_consume() {
    let d = tempfile::tempdir().unwrap();
    let p = image(d.path(), "retry");
    let h = Harness::new(row("req-retry", &p));
    let mut r = request("req-retry", "ctx");
    r.input_messages_delta = Some(json!([null]));
    let mut entries = vec![r, other("explain")];
    h.run(&mut entries, Mode::Input).await;
    assert_eq!(h.converted(), 1);
    assert_eq!(entries[0].input_messages_delta, Some(json!([null])));
    assert!(has_uri(&entries[1], "retry"));
    entries[0].input_messages_delta =
        Some(json!([{"role":"user","parts":[{"type":"text","content":"ctx"}]}]));
    h.run(&mut entries, Mode::Input).await;
    assert_eq!(h.converted(), 2);
    assert!(has_uri(&entries[0], "retry"));
}
#[tokio::test]
async fn attached_l1861_batch_ids_match_rows() {
    let d = tempfile::tempdir().unwrap();
    let a = image(d.path(), "a");
    let b = image(d.path(), "b");
    let mut rows = row("req-a", &a);
    rows.extend(row("req-b", &b));
    rows.insert("req-empty".into(), AttachedImageLookup::default());
    let h = Harness::new(rows);
    let mut entries = vec![
        request("req-a", "a"),
        request("req-b", "b"),
        request("req-empty", "none"),
    ];
    h.run(&mut entries, Mode::Input).await;
    for mut queried in h.calls() {
        queried.sort();
        assert_eq!(queried, vec!["req-a", "req-b", "req-empty"]);
    }
    assert!(parts(&entries[0]).iter().any(|p| p["type"] == "uri"));
    assert!(parts(&entries[1]).iter().any(|p| p["type"] == "uri"));
    assert_eq!(parts(&entries[2]).len(), 1);
}
#[tokio::test]
async fn attached_l1906_missing_id_empty_map_skip() {
    let h = Harness::new(Rows::new());
    let mut entries = vec![other("hi")];
    entries[0].event_name = Some(loongsuite_pilot::types::AgentEventName::LlmRequest);
    h.run(&mut entries, Mode::Input).await;
    assert_eq!(h.converted(), 0);
    assert_eq!(parts(&entries[0]).len(), 1);
}
#[tokio::test]
async fn attached_l1922_persistent_failure_three_attempts_tool_survives() {
    let d = tempfile::tempdir().unwrap();
    let p = image(d.path(), "t");
    let h = Harness::scripted(
        Rows::new(),
        vec![
            Err("sqlite down".into()),
            Err("sqlite down".into()),
            Err("sqlite down".into()),
        ],
    );
    let mut entries = vec![
        request("req-x", "hi"),
        entry(
            json!({"event.name":"tool.result","gen_ai.tool.call.result":format!("Image file: {p}")}),
        ),
    ];
    h.run(&mut entries, Mode::All).await;
    assert_eq!(h.calls(), vec![vec!["req-x"], vec!["req-x"], vec!["req-x"]]);
    assert_eq!(parts(&entries[0]).len(), 1);
    assert!(entries[1].tool_call_result.as_ref().unwrap().is_array());
}
#[tokio::test]
async fn attached_l1952_exception_then_recovery() {
    let d = tempfile::tempdir().unwrap();
    let p = image(d.path(), "recovered");
    let h = Harness::scripted(
        Rows::new(),
        vec![Err("sqlite busy".into()), Ok(row("req-recovered", &p))],
    );
    let mut entries = vec![request("req-recovered", "look")];
    h.run(&mut entries, Mode::Input).await;
    assert_eq!(h.calls().len(), 2);
    assert!(has_uri(&entries[0], "recovered"));
}
#[tokio::test]
async fn attached_l1976_response_only_id_falls_back() {
    let d = tempfile::tempdir().unwrap();
    let p = image(d.path(), "fb");
    let h = Harness::new(row("req-fb", &p));
    let mut entries = vec![other("img?"), response("req-fb")];
    h.run(&mut entries, Mode::Input).await;
    assert!(parts(&entries[0]).iter().any(|p| p["type"] == "uri"));
}
#[tokio::test]
async fn attached_l2006_done_not_queried_or_attached() {
    let d = tempfile::tempdir().unwrap();
    let p = image(d.path(), "cached");
    let h = Harness::new(row("req-cache", &p));
    let mut first = vec![request("req-cache", "1")];
    h.run(&mut first, Mode::Input).await;
    assert_eq!(h.calls().len(), 1);
    assert!(parts(&first[0]).iter().any(|p| p["type"] == "uri"));
    let mut second = vec![request("req-cache", "2")];
    h.run(&mut second, Mode::Input).await;
    assert_eq!(h.calls().len(), 1);
    assert!(!parts(&second[0]).iter().any(|p| p["type"] == "uri"));
    assert_eq!(h.converted(), 1);
}
#[tokio::test]
async fn attached_l2036_queries_only_new_ids() {
    let d = tempfile::tempdir().unwrap();
    let a = image(d.path(), "a");
    let b = image(d.path(), "b");
    let h = Harness::scripted(
        Rows::new(),
        vec![Ok(row("req-a", &a)), Ok(row("req-b", &b))],
    );
    let mut first = vec![request("req-a", "a")];
    h.run(&mut first, Mode::Input).await;
    let mut next = vec![request("req-a", "a2"), request("req-b", "b")];
    h.run(&mut next, Mode::Input).await;
    assert_eq!(h.calls(), vec![vec!["req-a"], vec!["req-b"]]);
    assert!(!parts(&next[0]).iter().any(|p| p["type"] == "uri"));
    assert!(parts(&next[1]).iter().any(|p| p["type"] == "uri"));
}
#[tokio::test]
async fn attached_l2075_synthetic_request_and_done() {
    let d = tempfile::tempdir().unwrap();
    let p = image(d.path(), "solo");
    let h = Harness::new(row("req-solo", &p));
    let mut r = response("req-solo");
    r.turn_start = Some(true);
    r.turn_end = Some(true);
    r.output_messages =
        Some(json!([{"role":"assistant","parts":[{"type":"text","content":"ok"}]}]));
    let mut entries = vec![r.clone()];
    h.run(&mut entries, Mode::Input).await;
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].event_id, r.event_id);
    let req = &entries[1];
    assert_eq!(value(req)["event.name"], "llm.request");
    assert_eq!(
        req.event_id,
        derive_synthetic_ide_request_event_id("resp-solo", "req-solo")
    );
    assert_eq!(req.request_id.as_deref(), Some("req-solo"));
    assert_eq!(req.turn_start, Some(true));
    assert_eq!(req.turn_end, None);
    assert_eq!(req.time_unix_nano, entries[0].time_unix_nano);
    assert_eq!(entries[0].turn_start, None);
    assert_eq!(entries[0].turn_end, Some(true));
    assert_eq!(
        parts(req),
        json!([{"type":"uri","mime_type":"image/png","modality":"image","uri":"oss://test/solo"}])
            .as_array()
            .unwrap()
            .clone()
    );
    let mut later = vec![request("req-solo", "explain")];
    h.run(&mut later, Mode::Input).await;
    assert!(!parts(&later[0]).iter().any(|p| p["type"] == "uri"));
    assert_eq!(h.converted(), 1);
}
#[tokio::test]
async fn attached_l2121_earlier_user_clock() {
    let d = tempfile::tempdir().unwrap();
    let p = image(d.path(), "clock");
    let mut rows = row("req-clock", &p);
    rows.get_mut("req-clock").unwrap().start_ms = Some(1699999995000);
    let h = Harness::new(rows);
    let mut entries = vec![response("req-clock")];
    h.run(&mut entries, Mode::Input).await;
    assert_eq!(entries[1].time_unix_nano, "1699999995000000000");
    assert_eq!(entries[0].time_unix_nano, "1700000000000000000");
}
#[tokio::test]
async fn attached_l2141_context_and_response_field_projection() {
    use loongsuite_pilot::normalization::apply_invocation_identity;
    let d = tempfile::tempdir().unwrap();
    let p = image(d.path(), "ctx");
    let h = Harness::new(row("req-ctx", &p));
    let r = entry(
        json!({"event.id":"resp-ctx","event.name":"llm.response","gen_ai.request.id":"req-ctx","user.id":"native-user",
 "gen_ai.session.id":"native-sess","agent.source":"qoder-hook","workspace.path":"/tmp/ws","git.repo":"org/repo",
 "observed_time_unix_nano":"1700000000000000001","resourceAttributes":{"service.version":"1.0.0"},
 "multica.issue.id":"ISSUE-1","agent.pilot.invocation.session.id":"inv-sess","agent.pilot.invocation.user.id":"inv-user",
 "gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"text","content":"ok"}]}],"gen_ai.response.id":"chatcmpl-1",
 "gen_ai.response.finish_reasons":["stop"],"gen_ai.usage.input_tokens":12,"error.type":"none",
 "agent.stop_reason":"end_turn","agent.client_request_id":"cli-req","agent.qoder.match_ts":1700000000000i64}),
    );
    let mut entries = vec![r];
    h.run(&mut entries, Mode::Input).await;
    let req = value(&entries[1]);
    assert_eq!(req["event.name"], "llm.request");
    assert_eq!(req["agent.source"], "qoder-hook");
    assert_eq!(req["workspace.path"], "/tmp/ws");
    assert_eq!(req["git.repo"], "org/repo");
    assert_eq!(entries[1].time_unix_nano, entries[0].time_unix_nano);
    assert_eq!(req["observed_time_unix_nano"], "1700000000000000001");
    assert_eq!(
        req["resourceAttributes"],
        json!({"service.version":"1.0.0"})
    );
    assert_eq!(req["multica.issue.id"], "ISSUE-1");
    assert_eq!(req["agent.pilot.invocation.session.id"], "inv-sess");
    assert_eq!(req["agent.pilot.invocation.user.id"], "inv-user");
    for key in [
        "agent.stop_reason",
        "agent.client_request_id",
        "agent.qoder.match_ts",
        "gen_ai.output.messages",
        "gen_ai.response.id",
        "gen_ai.response.finish_reasons",
        "gen_ai.usage.input_tokens",
        "error.type",
    ] {
        assert!(req.get(key).is_none(), "{key}");
    }
    for e in &mut entries {
        apply_invocation_identity(e, "", "fallback");
        assert_eq!(e.session_id, "inv-sess");
        assert_eq!(e.user_id, "inv-user");
    }
}
#[tokio::test]
async fn attached_l2200_replay_deterministic_id() {
    let d = tempfile::tempdir().unwrap();
    let p = image(d.path(), "replay");
    let h = Harness::new(row("req-replay", &p));
    let mut first = vec![response("req-replay")];
    h.run(&mut first, Mode::Input).await;
    h.mm.clear_cache();
    let mut second = vec![response("req-replay")];
    h.run(&mut second, Mode::Input).await;
    assert_eq!(first[1].event_id, second[1].event_id);
    assert_eq!(
        first[1].event_id,
        derive_synthetic_ide_request_event_id("resp-replay", "req-replay")
    );
}
#[tokio::test]
async fn attached_l2220_failure_drops_synthetic_restores_start() {
    let h = Harness::new(row("req-fail", "/tmp/missing.png"));
    let mut r = response("req-fail");
    r.turn_start = Some(true);
    let mut entries = vec![r.clone()];
    let cb: PathToUri = Arc::new(|_, _| Box::pin(async { Ok(None) }));
    h.mm.enrich_ide(&mut entries, Mode::Input, &cb).await;
    assert_eq!(
        serde_json::to_value(&entries).unwrap(),
        serde_json::to_value(vec![r]).unwrap()
    );
    assert_eq!(entries[0].turn_start, Some(true));
}
#[tokio::test]
async fn attached_l2233_confirmed_empty_cached() {
    let h = Harness::new(HashMap::from([(
        "req-empty".into(),
        AttachedImageLookup::default(),
    )]));
    for _ in 0..2 {
        h.run(&mut vec![request("req-empty", "look")], Mode::Input)
            .await;
    }
    assert_eq!(h.calls().len(), 1);
    assert_eq!(h.converted(), 0);
}
#[tokio::test]
async fn attached_l2250_absent_row_retried_same_event() {
    let d = tempfile::tempdir().unwrap();
    let p = image(d.path(), "retry");
    let h = Harness::scripted(Rows::new(), vec![Ok(Rows::new()), Ok(row("req-retry", &p))]);
    let mut entries = vec![request("req-retry", "look")];
    h.run(&mut entries, Mode::Input).await;
    assert_eq!(h.calls().len(), 2);
    assert!(has_uri(&entries[0], "retry"));
}
