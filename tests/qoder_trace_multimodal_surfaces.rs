//! Literal ef8953 image contracts; line suffixes are immutable source declaration IDs.
use loongsuite_pilot::inputs::qoder_trace::multimodal::{
    extract_markdown_image_paths, extract_tool_image_paths, PathToUri, QoderMultimodal,
};
use loongsuite_pilot::multimodal::types::{UriResult, MAX_MULTIMODAL_PARTS};
use loongsuite_pilot::types::{AgentActivityEntry, MultimodalUploadMode as Mode};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Mutex};
fn e(overrides: Value) -> AgentActivityEntry {
    let mut m = json!({"event.id":"mm-1","event.name":"llm.request","gen_ai.session.id":"sess-mm",
 "gen_ai.turn.id":"turn-mm","gen_ai.agent.type":"qoder","time_unix_nano":"1780000000000000000"})
    .as_object()
    .unwrap()
    .clone();
    m.extend(overrides.as_object().unwrap().clone());
    serde_json::from_value(Value::Object(m)).unwrap()
}
fn uri(name: &str) -> UriResult {
    UriResult {
        uri: format!("oss://test/{name}"),
        mime_type: "image/png".into(),
        modality: Some("image".into()),
        size: 2,
        sha256: name.into(),
    }
}
fn fake() -> PathToUri {
    Arc::new(|path, _| {
        Box::pin(async move { Ok(std::fs::read_to_string(path).ok().map(|name| uri(&name))) })
    })
}
fn image(dir: &Path, name: &str, content: &str) -> String {
    let p = dir.join(name);
    std::fs::write(&p, content).unwrap();
    p.to_string_lossy().into_owned()
}
type PathCalls = Arc<Mutex<Vec<(String, i64)>>>;
fn counter(result: Option<UriResult>) -> (PathToUri, PathCalls) {
    let calls = Arc::new(Mutex::new(vec![]));
    let saved = calls.clone();
    (
        Arc::new(move |p, t| {
            saved.lock().unwrap().push((p, t));
            let result = result.clone();
            Box::pin(async move { Ok(result) })
        }),
        calls,
    )
}
async fn enrich(entries: &mut Vec<AgentActivityEntry>, mode: Mode, callback: PathToUri) {
    QoderMultimodal::new()
        .enrich_ide(entries, mode, &callback)
        .await
}
fn value(e: &AgentActivityEntry) -> Value {
    serde_json::to_value(e).unwrap()
}
fn result(e: &AgentActivityEntry) -> Value {
    e.tool_call_result.clone().unwrap()
}
fn output(e: &AgentActivityEntry) -> Vec<Value> {
    e.output_messages.as_ref().unwrap()[0]["parts"]
        .as_array()
        .unwrap()
        .clone()
}
fn response(path: &str) -> AgentActivityEntry {
    e(
        json!({"event.name":"llm.response","gen_ai.output.messages":[
 {"role":"assistant","parts":[{"type":"text","content":format!("here ![g]({path})")}]}]}),
    )
}
#[test]
fn extract_l1649_tool_result_paths() {
    assert_eq!(
        extract_tool_image_paths("Image file: /tmp/a.png"),
        vec!["/tmp/a.png"]
    );
    assert_eq!(extract_tool_image_paths("Image generated successfully! The absolute path of the image is: /tmp/gen.png\nRequest ID: x"),vec!["/tmp/gen.png"]);
}
#[test]
fn extract_l1658_markdown_paths() {
    assert_eq!(
        extract_markdown_image_paths("see ![x](/tmp/a.png) and ![y](/tmp/b.jpg)", None),
        vec!["/tmp/a.png", "/tmp/b.jpg"]
    );
}
#[test]
fn extract_l1665_destinations_and_cwd() {
    // Substitute an absolute native cwd for the source's arbitrary /proj root.
    // All seven destination cases and their expected path relationships remain.
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_string_lossy();
    for (text, relative) in [
        ("![x](images/a.png)", "images/a.png"),
        ("![x](<images/My Image.png>)", "images/My Image.png"),
        ("![x](images/a.png \"preview\")", "images/a.png"),
        ("![x](rel/b.jpg 'preview')", "rel/b.jpg"),
    ] {
        assert_eq!(
            extract_markdown_image_paths(text, Some(&cwd)),
            vec![relative
                .split('/')
                .fold(dir.path().to_path_buf(), |path, part| path.join(part))
                .to_string_lossy()
                .into_owned()]
        );
    }
    for (name, angle) in [("a.png", false), ("My Image.png", true)] {
        let path = dir.path().join(name).to_string_lossy().into_owned();
        let text = if angle {
            format!("![x](<{path}>)")
        } else {
            format!("![x]({path})")
        };
        assert_eq!(extract_markdown_image_paths(&text, Some(&cwd)), vec![path]);
    }
    assert_eq!(
        extract_markdown_image_paths("![x](images/a.png)", None),
        vec!["images/a.png"]
    );
}
#[test]
fn extract_l1684_long_prefix_linear_bound() {
    extract_markdown_image_paths("", None); // JS compiles its module regex before this timer too.
    let start = std::time::Instant::now();
    let noise = "![".repeat(80_000);
    assert_eq!(
        extract_markdown_image_paths(&format!("{noise} ![x](/tmp/ok.png)"), None),
        vec!["/tmp/ok.png"]
    );
    assert!(start.elapsed().as_millis() < 200);
    assert!(extract_markdown_image_paths(&noise, None).is_empty());
}
#[test]
fn extract_l1692_caps_paths() {
    let paths = (0..MAX_MULTIMODAL_PARTS + 20)
        .map(|i| format!("/tmp/missing-{i}.png"))
        .collect::<Vec<_>>();
    assert_eq!(
        extract_tool_image_paths(
            &paths
                .iter()
                .map(|p| format!("Image file: {p}"))
                .collect::<Vec<_>>()
                .join("\n")
        ),
        paths[..MAX_MULTIMODAL_PARTS]
    );
    assert_eq!(
        extract_markdown_image_paths(
            &paths
                .iter()
                .enumerate()
                .map(|(i, p)| format!("![n{i}]({p})"))
                .collect::<Vec<_>>()
                .join(" "),
            None
        ),
        paths[..MAX_MULTIMODAL_PARTS]
    );
}
#[tokio::test]
async fn surface_l2274_tool_result_text_uri() {
    let d = tempfile::tempdir().unwrap();
    let p = image(d.path(), "read.png", "read-img");
    let mut entries = vec![e(
        json!({"event.name":"tool.result","gen_ai.tool.name":"Read","gen_ai.tool.call.result":format!("Image file: {p}")}),
    )];
    enrich(&mut entries, Mode::Input, fake()).await;
    assert_eq!(
        result(&entries[0])[0],
        json!({"type":"text","content":format!("Image file: {p}")})
    );
    assert_eq!(result(&entries[0])[1]["type"], "uri");
    assert_eq!(result(&entries[0])[1]["uri"], "oss://test/read-img");
    assert_eq!(result(&entries[0])[1]["modality"], "image");
}
#[tokio::test]
async fn surface_l2291_caps_failed_attempts() {
    let text = (0..MAX_MULTIMODAL_PARTS + 20)
        .map(|i| format!("Image file: /tmp/missing-{i}.png"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut entries = vec![e(
        json!({"event.name":"tool.result","gen_ai.tool.call.result":text}),
    )];
    let (cb, calls) = counter(None);
    enrich(&mut entries, Mode::Input, cb).await;
    assert_eq!(calls.lock().unwrap().len(), MAX_MULTIMODAL_PARTS);
    assert_eq!(result(&entries[0]), text);
}
#[tokio::test]
async fn surface_l2303_imagegen() {
    let d = tempfile::tempdir().unwrap();
    let p = image(d.path(), "gen.png", "gen-img");
    let mut entries = vec![e(
        json!({"event.name":"tool.result","gen_ai.tool.name":"ImageGen",
 "gen_ai.tool.call.result":format!("Image generated successfully! The absolute path of the image is: {p}\nRequest ID: abc")}),
    )];
    enrich(&mut entries, Mode::Input, fake()).await;
    assert!(result(&entries[0])
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["type"] == "uri" && p["uri"] == "oss://test/gen-img"));
}
#[tokio::test]
async fn surface_l2319_tool_result_gate() {
    let d = tempfile::tempdir().unwrap();
    let p = image(d.path(), "tool-gate.png", "tool-gate");
    let tool =
        e(json!({"event.name":"tool.result","gen_ai.tool.call.result":format!("Image file: {p}")}));
    let mut out = vec![tool.clone()];
    enrich(&mut out, Mode::Output, fake()).await;
    assert_eq!(result(&out[0]), format!("Image file: {p}"));
    let mut input = vec![tool];
    enrich(&mut input, Mode::Input, fake()).await;
    assert!(result(&input[0]).is_array());
    assert!(result(&input[0])
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["type"] == "uri" && p["uri"] == "oss://test/tool-gate"));
}
#[tokio::test]
async fn surface_l2339_read_arguments() {
    let d = tempfile::tempdir().unwrap();
    let p = image(d.path(), "call.png", "call-img");
    let encoded = json!({"file_path":p}).to_string();
    let mut entries = vec![e(
        json!({"event.name":"tool.call","gen_ai.tool.name":"Read","gen_ai.tool.call.arguments":encoded}),
    )];
    enrich(&mut entries, Mode::Output, fake()).await;
    let v = value(&entries[0]);
    assert_eq!(
        v["gen_ai.tool.call.arguments"][0],
        json!({"type":"text","content":encoded})
    );
    assert_eq!(v["gen_ai.tool.call.arguments"][1]["type"], "uri");
    assert_eq!(
        v["gen_ai.tool.call.arguments"][1]["uri"],
        "oss://test/call-img"
    );
    assert_eq!(v["gen_ai.tool.call.arguments"][1]["modality"], "image");
    assert_eq!(
        v["gen_ai.output.multimodal_metadata"],
        json!([{"uri":"oss://test/call-img","mime_type":"image/png","modality":"image"}])
    );
}
#[tokio::test]
async fn surface_l2359_tool_call_gate() {
    let d = tempfile::tempdir().unwrap();
    let p = image(d.path(), "call-gate.png", "call-gate");
    let tool = e(
        json!({"event.name":"tool.call","gen_ai.tool.name":"Read","gen_ai.tool.call.arguments":{"file_path":p}}),
    );
    let mut input = vec![tool.clone()];
    enrich(&mut input, Mode::Input, fake()).await;
    assert_eq!(input[0].tool_call_arguments, Some(json!({"file_path":p})));
    let mut out = vec![tool];
    enrich(&mut out, Mode::Output, fake()).await;
    assert!(out[0].tool_call_arguments.as_ref().unwrap().is_array());
    assert!(out[0]
        .tool_call_arguments
        .as_ref()
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["type"] == "uri" && p["uri"] == "oss://test/call-gate"));
}
#[tokio::test]
async fn surface_l2380_only_read() {
    let d = tempfile::tempdir().unwrap();
    let p = image(d.path(), "write.png", "write-img");
    for name in ["Write", "Writeable"] {
        let (cb, calls) = counter(Some(uri("write-img")));
        let mut entries = vec![e(
            json!({"event.name":"tool.call","gen_ai.tool.name":name,"gen_ai.tool.call.arguments":{"file_path":p}}),
        )];
        enrich(&mut entries, Mode::Output, cb).await;
        assert!(calls.lock().unwrap().is_empty());
        assert_eq!(entries[0].tool_call_arguments, Some(json!({"file_path":p})));
        assert!(value(&entries[0])
            .get("gen_ai.output.multimodal_metadata")
            .is_none());
    }
}
#[tokio::test]
async fn surface_l2400_relative_output_cwd() {
    let d = tempfile::tempdir().unwrap();
    image(d.path(), "rel.png", "rel-img");
    let (cb, calls) = counter(Some(uri("rel-img")));
    let mut r = response("rel.png");
    r.extra.insert("agent.qoder.cwd".into(), json!(d.path()));
    let mut entries = vec![r];
    enrich(&mut entries, Mode::Output, cb).await;
    assert_eq!(
        calls.lock().unwrap().as_slice(),
        &[(
            d.path().join("rel.png").to_string_lossy().into_owned(),
            1780000000000
        )]
    );
    assert_eq!(output(&entries[0])[1]["type"], "uri");
    assert_eq!(output(&entries[0])[1]["uri"], "oss://test/rel-img");
}
#[tokio::test]
async fn surface_l2421_output_uri_metadata() {
    let d = tempfile::tempdir().unwrap();
    let p = image(d.path(), "out.png", "out-img");
    let mut entries = vec![response(&p)];
    enrich(&mut entries, Mode::Output, fake()).await;
    assert_eq!(output(&entries[0])[0]["type"], "text");
    assert_eq!(output(&entries[0])[1]["type"], "uri");
    assert_eq!(output(&entries[0])[1]["uri"], "oss://test/out-img");
    let v = value(&entries[0]);
    assert_eq!(
        v["gen_ai.output.multimodal_metadata"],
        json!([{"uri":"oss://test/out-img","mime_type":"image/png","modality":"image"}])
    );
    assert!(v.get("gen_ai.input.multimodal_metadata").is_none());
}
#[tokio::test]
async fn surface_l2445_output_gate() {
    let d = tempfile::tempdir().unwrap();
    let p = image(d.path(), "out-gate.png", "out-gate");
    let r = response(&p);
    let mut input = vec![r.clone()];
    enrich(&mut input, Mode::Input, fake()).await;
    assert_eq!(output(&input[0]).len(), 1);
    assert_eq!(output(&input[0])[0]["type"], "text");
    let mut all = vec![r];
    enrich(&mut all, Mode::All, fake()).await;
    assert!(output(&all[0])
        .iter()
        .any(|p| p["type"] == "uri" && p["uri"] == "oss://test/out-gate"));
}
#[tokio::test]
async fn surface_l2467_all_surfaces() {
    let d = tempfile::tempdir().unwrap();
    let p = image(d.path(), "shared.png", "shared");
    let mut entries = vec![
        e(json!({"event.name":"tool.result","gen_ai.tool.call.result":format!("Image file: {p}")})),
        response(&p),
    ];
    enrich(&mut entries, Mode::All, fake()).await;
    assert!(result(&entries[0]).is_array());
    assert!(output(&entries[1]).iter().any(|p| p["type"] == "uri"));
}
#[tokio::test]
async fn surface_l2488_none_missing_null_noop() {
    let d = tempfile::tempdir().unwrap();
    let p = image(d.path(), "x.png", "x");
    let tool =
        e(json!({"event.name":"tool.result","gen_ai.tool.call.result":format!("Image file: {p}")}));
    let before = value(&tool);
    let mut entries = vec![tool.clone()];
    enrich(&mut entries, Mode::None, fake()).await;
    assert_eq!(value(&entries[0]), before);
    let mut missing = vec![e(
        json!({"event.name":"tool.result","gen_ai.tool.call.result":"Image file: /no/such/file.png"}),
    )];
    enrich(&mut missing, Mode::Input, fake()).await;
    assert_eq!(result(&missing[0]), "Image file: /no/such/file.png");
    let mut null = vec![tool];
    enrich(&mut null, Mode::Input, counter(None).0).await;
    assert_eq!(result(&null[0]), format!("Image file: {p}"));
}
#[tokio::test]
async fn surface_l2515_caps_conversion() {
    let d = tempfile::tempdir().unwrap();
    let text = (0..MAX_MULTIMODAL_PARTS + 3)
        .map(|i| {
            format!(
                "![{i}]({})",
                image(d.path(), &format!("n{i}.png"), &format!("img-{i}"))
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut entries = vec![response("/unused")];
    entries[0].output_messages =
        Some(json!([{"role":"assistant","parts":[{"type":"text","content":text}]}]));
    enrich(&mut entries, Mode::Output, fake()).await;
    assert_eq!(
        output(&entries[0])
            .iter()
            .filter(|p| p["type"] == "uri")
            .count(),
        MAX_MULTIMODAL_PARTS
    );
}
#[tokio::test]
async fn surface_l2539_fallible_adapter() {
    let d = tempfile::tempdir().unwrap();
    let p = image(d.path(), "boom.png", "boom");
    let mut entries = vec![e(
        json!({"event.name":"tool.result","gen_ai.tool.call.result":format!("Image file: {p}")}),
    )];
    let cb: PathToUri = Arc::new(|_, _| Box::pin(async { Err("processor boom".into()) }));
    enrich(&mut entries, Mode::Input, cb).await;
    assert_eq!(value(&entries[0])["event.name"], "tool.result");
    assert!(entries[0].tool_call_result.is_some());
}
#[tokio::test]
async fn surface_l2556_continue_after_failure() {
    let d = tempfile::tempdir().unwrap();
    let boom = image(d.path(), "boom.png", "boom");
    let ok = image(d.path(), "ok.png", "ok");
    let mut entries = vec![e(
        json!({"event.name":"tool.result","gen_ai.tool.call.result":format!("Image file: {boom}\nImage file: {ok}")}),
    )];
    let cb: PathToUri = Arc::new(move |p, _| {
        let failed = p == boom;
        Box::pin(async move {
            if failed {
                Err("processor boom".into())
            } else {
                Ok(Some(uri("ok")))
            }
        })
    });
    enrich(&mut entries, Mode::Input, cb).await;
    assert!(result(&entries[0])
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["type"] == "uri" && p["uri"] == "oss://test/ok"));
    assert_eq!(
        value(&entries[0])["gen_ai.input.multimodal_metadata"],
        json!([{"uri":"oss://test/ok","mime_type":"image/png","modality":"image"}])
    );
}
