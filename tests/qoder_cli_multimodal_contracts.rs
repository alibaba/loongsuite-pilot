//! Exact ef8953/f84 qoder-cli multimodal contracts through the unified native layer.
use loongsuite_pilot::inputs::qoder_trace::multimodal::{
    extract_cli_input_image_paths, extract_cli_tool_image_paths, PathToUri, QoderMultimodal,
};
use loongsuite_pilot::multimodal::processor::with_deadline;
use loongsuite_pilot::multimodal::resolve::resolve_image_path;
use loongsuite_pilot::multimodal::types::{UriResult, MAX_MULTIMODAL_PARTS};
use loongsuite_pilot::types::{AgentActivityEntry, MultimodalUploadMode as Mode};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn e(overrides: Value) -> AgentActivityEntry {
    let mut value=json!({"event.id":"e1","event.name":"other","gen_ai.agent.type":"qoder-cli","gen_ai.session.id":"sess","gen_ai.turn.id":"turn-1","time_unix_nano":"1700000000000000000"}).as_object().unwrap().clone();
    value.extend(overrides.as_object().unwrap().clone());
    serde_json::from_value(Value::Object(value)).unwrap()
}
fn input(text: &str, cwd: Option<&str>) -> Vec<String> {
    let entry = e(
        json!({"gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":text}]}]}),
    );
    extract_cli_input_image_paths(&entry, cwd)
}
fn joined(cwd: &str, relative: &str) -> String {
    let relative = if cfg!(windows) {
        relative.replace('/', r"\")
    } else {
        relative.to_owned()
    };
    Path::new(cwd).join(relative).to_string_lossy().into_owned()
}
fn native(unix: &str, win: &str) -> String {
    if cfg!(windows) {
        win.into()
    } else {
        unix.into()
    }
}
fn uri(label: &str) -> UriResult {
    UriResult {
        uri: format!("oss://test/{label}"),
        mime_type: "image/png".into(),
        modality: Some("image".into()),
        size: label.len(),
        sha256: label.into(),
    }
}
fn fake() -> PathToUri {
    Arc::new(|p, _| Box::pin(async move { Ok(std::fs::read_to_string(p).ok().map(|v| uri(&v))) }))
}
type Calls = Arc<Mutex<Vec<String>>>;
fn counted(value: Option<UriResult>) -> (PathToUri, Calls) {
    let calls = Arc::new(Mutex::new(vec![]));
    let copy = calls.clone();
    (
        Arc::new(move |p, _| {
            copy.lock().unwrap().push(p);
            let value = value.clone();
            Box::pin(async move { Ok(value) })
        }),
        calls,
    )
}
fn image(dir: &Path, name: &str, label: &str) -> String {
    let file = dir.join(name);
    std::fs::write(&file, label).unwrap();
    file.to_string_lossy().into_owned()
}
async fn enrich(entries: &mut [AgentActivityEntry], mode: Mode, callback: PathToUri) {
    QoderMultimodal::new()
        .enrich_cli(entries, mode, &callback)
        .await;
}
fn v(e: &AgentActivityEntry) -> Value {
    serde_json::to_value(e).unwrap()
}
fn has_uri(parts: &Value, expected: &str) -> bool {
    parts
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["type"] == "uri" && p["uri"] == expected)
}
fn input_parts(entry: &AgentActivityEntry) -> Value {
    entry.input_messages_delta.as_ref().unwrap()[0]["parts"].clone()
}
fn tool(raw: Value, name: &str) -> AgentActivityEntry {
    e(json!({"event.name":"tool.call","gen_ai.tool.name":name,"gen_ai.tool.call.arguments":raw}))
}

#[test]
fn cli_l50_paste_at_and_comma_paths_keep_actual_platform_resolution() {
    let cwd = native("/Users/me/workspace", r"C:\Users\me\workspace");
    let clip = native("/tmp/clip.png.png", r"C:\tmp\clip.png.png");
    assert_eq!(input(&format!("[Image: source: {clip}]"), None), vec![clip]);
    assert_eq!(
        input(
            "@loongsuite-pilot/picture/pipeline.jpg 这个图像是上个图像的扩展？",
            Some(&cwd)
        ),
        vec![joined(&cwd, "loongsuite-pilot/picture/pipeline.jpg")]
    );
    let absolute = native(
        "/Users/me/Documents/picture/pipeline.jpg",
        r"C:\Users\me\Documents\picture\pipeline.jpg",
    );
    assert_eq!(
        input(&format!("@{absolute} 这个图是一样的？"), None),
        vec![absolute]
    );
    assert_eq!(input("[Image: source: docs/_assets/img/dashboard.png, original 2556x1656, displayed at 2000x1296]",Some(&cwd)),vec![joined(&cwd,"docs/_assets/img/dashboard.png")]);
    let comma = native("/tmp/chart,final.png", r"C:\tmp\chart,final.png");
    for suffix in ["", ", original 100x80, displayed at 50x40"] {
        assert_eq!(
            input(&format!("[Image: source: {comma}{suffix}]"), None),
            vec![comma.clone()]
        );
    }
}
#[test]
fn cli_l99_file_citations_ignore_size_only_blocks_and_text_files() {
    let a = native("/tmp/a949604a.png", r"C:\tmp\a949604a.png");
    let b = native("/tmp/55cc677b.jpg", r"C:\tmp\55cc677b.jpg");
    let text=format!("附件引用：\n- 文件：{a}\n- 文件：{b}\n- 文件：/tmp/notes.txt\n[Image: original 2516x1418, displayed at 2000x1127. Multiply coordinates by 1.26 to map to original image.]");
    assert_eq!(input(&text, None), vec![a.clone(), b.clone()]);
    assert_eq!(
        input(&format!("文件：{a}\n文件:{b}\n文件：/tmp/notes.txt"), None),
        vec![a, b]
    );
    let clip = native("/tmp/clip.png", r"C:\tmp\clip.png");
    assert_eq!(input(&format!("文件: {clip}"), None), vec![clip]);
}
#[test]
fn cli_l123_attachment_union_filters_types_and_deduplicates_after_resolution() {
    let cwd = native("/Users/me/workspace", r"C:\Users\me\workspace");
    let filename = joined(&cwd, "picture/pipeline.jpg");
    let extra = native("/tmp/extra.png", r"C:\tmp\extra.png");
    let entry = e(json!({"event.name":"llm.request","agent.qoder.cwd":cwd,
        "agent.qoder.attachments":[{"type":"image_file","filename":filename,"displayPath":"picture/pipeline.jpg"},{"type":"skill_listing","filename":"/tmp/ignore.png"}],
        "gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":"@picture/pipeline.jpg 用一句话说明这张图"},{"type":"text","content":format!("[Image: source: {extra}]")}]}]}));
    assert_eq!(
        extract_cli_input_image_paths(&entry, Some(&cwd)),
        vec![filename, extra]
    );
}
#[test]
fn cli_l152_read_image_image_file_and_imagegen_extract_actual_paths() {
    let cwd = native("/Users/me/proj", r"C:\Users\me\proj");
    assert_eq!(
        extract_cli_tool_image_paths("Read image: picture/pipeline.jpg (52KB)", Some(&cwd)),
        vec![joined(&cwd, "picture/pipeline.jpg")]
    );
    let a = native("/tmp/a.png", r"C:\tmp\a.png");
    let generated = native("/tmp/gen.png", r"C:\tmp\gen.png");
    assert_eq!(
        extract_cli_tool_image_paths(&format!("Image file: {a}"), None),
        vec![a]
    );
    assert_eq!(extract_cli_tool_image_paths(&format!("Image generated successfully! The absolute path of the image is: {generated}\nRequest ID: x"),None),vec![generated]);
}
#[test]
fn cli_l177_long_at_prefix_stays_within_original_200ms_budget() {
    input("", None); // Source JS compiles module regex before the timed operation too.
    let noise = "@a".repeat(80_000);
    let ok = native("/tmp/ok.png", r"C:\tmp\ok.png");
    let started = Instant::now();
    assert_eq!(input(&format!("{noise} @{ok}"), None), vec![ok]);
    assert!(started.elapsed() < Duration::from_millis(200));
    assert!(input(&noise, None).is_empty());
}
#[tokio::test]
async fn cli_l187_missing_candidates_are_capped_before_callback_and_preserve_text() {
    let d = tempfile::tempdir().unwrap();
    let listed = (0..MAX_MULTIMODAL_PARTS + 20)
        .map(|i| {
            d.path()
                .join(format!("missing-{i}.png"))
                .to_string_lossy()
                .into_owned()
        })
        .collect::<Vec<_>>();
    let text = listed
        .iter()
        .map(|p| format!("Read image: {p} (1KB)"))
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(
        extract_cli_tool_image_paths(&text, None),
        listed[..MAX_MULTIMODAL_PARTS]
    );
    let mut entries = vec![e(
        json!({"event.name":"tool.result","gen_ai.tool.call.result":text}),
    )];
    let (callback, calls) = counted(None);
    enrich(&mut entries, Mode::Input, callback).await;
    assert_eq!(*calls.lock().unwrap(), listed[..MAX_MULTIMODAL_PARTS]);
    assert_eq!(entries[0].tool_call_result.as_ref().unwrap(), &text);
}
#[test]
fn cli_l206_unmarked_globs_mentions_and_bare_paths_are_not_images() {
    assert!(extract_cli_tool_image_paths(
        "docs/_assets/img/dashboard.png\npicture/pipeline.jpg",
        None
    )
    .is_empty());
    assert!(input("hello @someone please look", None).is_empty());
    let cwd = native("/tmp", r"C:\tmp");
    assert!(input("picture/pipeline.jpg这个是什么？", Some(&cwd)).is_empty());
}
#[test]
fn cli_l215_absolute_paths_ignore_cwd_and_relative_paths_join_it() {
    let absolute = native("/abs/a.png", r"C:\abs\a.png");
    let cwd = native("/cwd", r"C:\cwd");
    assert_eq!(resolve_image_path(&absolute, Some(&cwd)), absolute);
    assert_eq!(
        resolve_image_path("rel/a.png", Some(&cwd)),
        joined(&cwd, "rel/a.png")
    );
}
#[tokio::test]
async fn cli_l228_every_path_carrier_gets_its_own_uri_and_relative_at_is_supported() {
    let d = tempfile::tempdir().unwrap();
    let img = image(d.path(), "clip.png", "clip");
    image(d.path(), "at.png", "at");
    let messages = json!([{"role":"user","parts":[{"type":"text","content":"[Image #0]看图"},{"type":"text","content":format!("[Image: source: {img}]")}]}]);
    let mut entries = vec![
        e(json!({"event.name":"other","gen_ai.input.messages_delta":messages})),
        e(json!({"event.name":"llm.request","gen_ai.input.messages_delta":messages})),
    ];
    enrich(&mut entries, Mode::Input, fake()).await;
    for entry in &entries {
        assert!(has_uri(&input_parts(entry), "oss://test/clip"));
    }
    let mut at = vec![e(
        json!({"event.name":"llm.request","gen_ai.turn.id":"turn-at","agent.qoder.cwd":d.path(),"gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":"@at.png 这是什么"}]}]}),
    )];
    enrich(&mut at, Mode::Input, fake()).await;
    assert!(has_uri(&input_parts(&at[0]), "oss://test/at"));
}
#[tokio::test]
async fn cli_l279_later_same_turn_request_without_image_never_steals_first_image() {
    let d = tempfile::tempdir().unwrap();
    let file = image(d.path(), "pipeline.jpg", "pipe");
    let mut entries = vec![
        e(
            json!({"event.name":"llm.request","gen_ai.step.id":"t:s1","agent.qoder.cwd":d.path(),"gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":format!("@{file}")}]}]}),
        ),
        e(
            json!({"event.name":"llm.request","gen_ai.step.id":"t:s2","agent.qoder.cwd":d.path(),"gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":"tool follow-up without image"}]}]}),
        ),
    ];
    enrich(&mut entries, Mode::Input, fake()).await;
    assert!(has_uri(&input_parts(&entries[0]), "oss://test/pipe"));
    assert!(!input_parts(&entries[1])
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["type"] == "uri"));
}
#[tokio::test]
async fn cli_l307_read_and_imagegen_result_rewrites_preserve_original_text() {
    let d = tempfile::tempdir().unwrap();
    let img = image(d.path(), "read.png", "read-img");
    let generated = image(d.path(), "gen.png", "gen-img");
    let text = format!("Read image: {img} (31KB)");
    let mut read = vec![e(
        json!({"event.name":"tool.result","gen_ai.tool.name":"Read","gen_ai.tool.call.result":text}),
    )];
    enrich(&mut read, Mode::Input, fake()).await;
    assert_eq!(
        read[0].tool_call_result.as_ref().unwrap()[0],
        json!({"type":"text","content":text})
    );
    assert!(has_uri(
        read[0].tool_call_result.as_ref().unwrap(),
        "oss://test/read-img"
    ));
    let mut generated = vec![e(
        json!({"event.name":"tool.result","gen_ai.tool.name":"ImageGen","gen_ai.tool.call.result":format!("Image generated successfully! The absolute path of the image is: {generated}\nRequest ID: abc")}),
    )];
    enrich(&mut generated, Mode::All, fake()).await;
    assert!(has_uri(
        generated[0].tool_call_result.as_ref().unwrap(),
        "oss://test/gen-img"
    ));
}
#[tokio::test]
async fn cli_l336_tool_results_obey_input_direction_and_skip_output_only() {
    let d = tempfile::tempdir().unwrap();
    let file = image(d.path(), "tool-gate.png", "tool-gate");
    let text = format!("Read image: {file} (1KB)");
    let original = e(json!({"event.name":"tool.result","gen_ai.tool.call.result":text}));
    let mut output = vec![original.clone()];
    enrich(&mut output, Mode::Output, fake()).await;
    assert_eq!(output[0].tool_call_result.as_ref().unwrap(), &text);
    let mut input = vec![original];
    enrich(&mut input, Mode::Input, fake()).await;
    assert!(has_uri(
        input[0].tool_call_result.as_ref().unwrap(),
        "oss://test/tool-gate"
    ));
}
#[tokio::test]
async fn cli_l356_read_call_keeps_encoded_json_and_exact_output_metadata() {
    let d = tempfile::tempdir().unwrap();
    let file = image(d.path(), "call.png", "call-img");
    let encoded = json!({"file_path":file}).to_string();
    let mut entries = vec![tool(json!(encoded), "Read")];
    enrich(&mut entries, Mode::Output, fake()).await;
    let value = v(&entries[0]);
    assert_eq!(
        value["gen_ai.tool.call.arguments"][0],
        json!({"type":"text","content":encoded})
    );
    assert_eq!(
        value["gen_ai.tool.call.arguments"][1],
        json!({"type":"uri","uri":"oss://test/call-img","mime_type":"image/png","modality":"image"})
    );
    assert_eq!(
        value["gen_ai.output.multimodal_metadata"],
        json!([{"uri":"oss://test/call-img","mime_type":"image/png","modality":"image"}])
    );
}
#[tokio::test]
async fn cli_l376_tool_calls_obey_output_direction_and_skip_input_only() {
    let d = tempfile::tempdir().unwrap();
    let file = image(d.path(), "call-gate.png", "call-gate");
    let raw = json!({"file_path":file});
    let mut input = vec![tool(raw.clone(), "Read")];
    enrich(&mut input, Mode::Input, fake()).await;
    assert_eq!(input[0].tool_call_arguments.as_ref().unwrap(), &raw);
    let mut output = vec![tool(raw, "Read")];
    enrich(&mut output, Mode::Output, fake()).await;
    assert!(has_uri(
        output[0].tool_call_arguments.as_ref().unwrap(),
        "oss://test/call-gate"
    ));
}
#[tokio::test]
async fn cli_l397_relative_read_call_resolves_agent_cwd() {
    let d = tempfile::tempdir().unwrap();
    let file = image(d.path(), "rel.png", "rel-call");
    let mut call = tool(json!({"file_path":"rel.png"}), "Read");
    call.extra.insert("agent.qoder.cwd".into(), json!(d.path()));
    let mut entries = vec![call];
    let (cb, calls) = counted(Some(uri("rel-call")));
    enrich(&mut entries, Mode::Output, cb).await;
    assert_eq!(*calls.lock().unwrap(), vec![file]);
    assert!(has_uri(
        entries[0].tool_call_arguments.as_ref().unwrap(),
        "oss://test/rel-call"
    ));
}
#[tokio::test]
async fn cli_l413_write_and_writeable_never_use_read_file_path_or_add_metadata() {
    let d = tempfile::tempdir().unwrap();
    let file = image(d.path(), "write.png", "write-img");
    let raw = json!({"file_path":file});
    for name in ["Write", "Writeable"] {
        let (cb, calls) = counted(Some(uri("write-img")));
        let mut entries = vec![tool(raw.clone(), name)];
        enrich(&mut entries, Mode::Output, cb).await;
        assert!(calls.lock().unwrap().is_empty());
        assert_eq!(entries[0].tool_call_arguments.as_ref().unwrap(), &raw);
        assert!(v(&entries[0])
            .get("gen_ai.output.multimodal_metadata")
            .is_none());
    }
}
#[tokio::test]
async fn cli_l433_nonimage_read_arguments_stay_unchanged() {
    let raw = json!({"file_path":"/tmp/notes.ts"});
    let mut entries = vec![tool(raw.clone(), "Read")];
    let (cb, calls) = counted(Some(uri("must-not-run")));
    enrich(&mut entries, Mode::Output, cb).await;
    assert!(calls.lock().unwrap().is_empty());
    assert_eq!(entries[0].tool_call_arguments.as_ref().unwrap(), &raw);
}
#[tokio::test]
async fn cli_l443_none_missing_and_null_callbacks_leave_original_entries_unchanged() {
    let d = tempfile::tempdir().unwrap();
    let file = image(d.path(), "x.png", "x");
    let entry = e(
        json!({"event.name":"tool.result","gen_ai.tool.call.result":format!("Read image: {file} (1KB)")}),
    );
    let before = v(&entry);
    let mut none = vec![entry.clone()];
    enrich(&mut none, Mode::None, fake()).await;
    assert_eq!(v(&none[0]), before);
    let mut missing = vec![e(
        json!({"event.name":"tool.result","gen_ai.tool.call.result":"Read image: /no/such/file.png (1KB)"}),
    )];
    enrich(&mut missing, Mode::Input, fake()).await;
    assert_eq!(
        missing[0].tool_call_result.as_ref().unwrap(),
        "Read image: /no/such/file.png (1KB)"
    );
    let mut null = vec![entry];
    enrich(&mut null, Mode::Input, counted(None).0).await;
    assert_eq!(
        null[0].tool_call_result.as_ref().unwrap(),
        &format!("Read image: {file} (1KB)")
    );
}
#[tokio::test]
async fn cli_l469_conversion_is_capped_and_duplicate_image_surfaces_add_one_uri() {
    let d = tempfile::tempdir().unwrap();
    let text = (0..MAX_MULTIMODAL_PARTS + 3)
        .map(|i| {
            format!(
                "Read image: {} (1KB)",
                image(d.path(), &format!("n{i}.png"), &format!("img-{i}"))
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut entries = vec![e(
        json!({"event.name":"tool.result","gen_ai.tool.call.result":text}),
    )];
    enrich(&mut entries, Mode::Input, fake()).await;
    assert_eq!(
        entries[0]
            .tool_call_result
            .as_ref()
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| p["type"] == "uri")
            .count(),
        MAX_MULTIMODAL_PARTS
    );
    let duplicate = image(d.path(), "dup.png", "dup");
    let mut entries = vec![e(
        json!({"event.name":"tool.result","gen_ai.turn.id":"dup-turn","gen_ai.tool.call.result":format!("Read image: {duplicate} (1KB)\nImage file: {duplicate}")}),
    )];
    enrich(&mut entries, Mode::Input, fake()).await;
    assert_eq!(
        entries[0]
            .tool_call_result
            .as_ref()
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| p["type"] == "uri")
            .count(),
        1
    );
}
#[tokio::test]
async fn cli_l494_real_40ms_deadline_releases_hung_callback_and_converts_later_image() {
    let d = tempfile::tempdir().unwrap();
    let hang = image(d.path(), "hang.png", "hang");
    let ok = image(d.path(), "ok.png", "ok");
    let text = format!("Read image: {hang} (1KB)\nRead image: {ok} (1KB)");
    let mut entries = vec![e(
        json!({"event.name":"tool.result","gen_ai.tool.call.result":text}),
    )];
    let callback: PathToUri = Arc::new(move |path, _| {
        let hang = hang.clone();
        Box::pin(async move {
            Ok(with_deadline(
                async move {
                    if path == hang {
                        std::future::pending::<Option<UriResult>>().await
                    } else {
                        Some(uri("ok"))
                    }
                },
                40,
                || None,
            )
            .await)
        })
    });
    let started = Instant::now();
    enrich(&mut entries, Mode::Input, callback).await;
    assert!(started.elapsed() < Duration::from_millis(500));
    assert_eq!(
        entries[0].tool_call_result.as_ref().unwrap()[0],
        json!({"type":"text","content":text})
    );
    assert!(has_uri(
        entries[0].tool_call_result.as_ref().unwrap(),
        "oss://test/ok"
    ));
}
#[tokio::test]
async fn cli_l527_ordinary_callback_error_preserves_exact_original_text() {
    let d = tempfile::tempdir().unwrap();
    let file = image(d.path(), "boom.png", "boom");
    let text = format!("Read image: {file} (1KB)");
    let mut entries = vec![e(
        json!({"event.name":"tool.result","gen_ai.tool.call.result":text}),
    )];
    let callback: PathToUri = Arc::new(|_, _| Box::pin(async { Err("processor boom".into()) }));
    enrich(&mut entries, Mode::Input, callback).await;
    assert_eq!(entries[0].tool_call_result.as_ref().unwrap(), &text);
    assert!(v(&entries[0])
        .get("gen_ai.input.multimodal_metadata")
        .is_none());
}
#[tokio::test]
async fn cli_l543_relative_read_result_resolves_agent_cwd() {
    let d = tempfile::tempdir().unwrap();
    let file = image(d.path(), "rel.png", "rel-img");
    let mut entries = vec![e(
        json!({"event.name":"tool.result","agent.qoder.cwd":d.path(),"gen_ai.tool.call.result":"Read image: rel.png (1KB)"}),
    )];
    let (cb, calls) = counted(Some(uri("rel-img")));
    enrich(&mut entries, Mode::Input, cb).await;
    assert_eq!(*calls.lock().unwrap(), vec![file]);
    assert!(has_uri(
        entries[0].tool_call_result.as_ref().unwrap(),
        "oss://test/rel-img"
    ));
}

#[test]
fn main585_cli_at_and_file_citations_accept_video_and_deduplicate_mixed_media() {
    let cwd = native("/Users/me/workspace", r"C:\Users\me\workspace");
    let expected = joined(&cwd, "clip.mp4");
    let picture = joined(&cwd, "picture.png");
    assert_eq!(input("@clip.mp4", Some(&cwd)), vec![expected.clone()]);
    assert_eq!(
        input(
            "文件：clip.mp4\n@clip.mp4\n文件: picture.png\n文件：notes.txt",
            Some(&cwd)
        ),
        vec![expected, picture]
    );
}

#[tokio::test]
async fn main585_cli_video_uri_keeps_original_text_images_and_unknown_fields() {
    let text = "@clip.mp4";
    let original_parts = json!([
        {"type":"text","content":text,"custom-text":true},
        {"type":"uri","uri":"oss://test/existing-image","mime_type":"image/png","modality":"image","custom-image":7},
        {"type":"vendor-part","payload":{"preserve":true}}
    ]);
    let mut entries = vec![e(json!({
        "event.name":"llm.request","agent.qoder.cwd":"/work","custom-entry":{"preserve":true},
        "gen_ai.input.messages_delta":[{"role":"user","custom-message":9,"parts":original_parts}]
    }))];
    let callback: PathToUri = Arc::new(|_, _| {
        Box::pin(async {
            Ok(Some(UriResult {
                mime_type: "video/mp4".into(),
                modality: Some("video".into()),
                ..uri("video")
            }))
        })
    });
    enrich(&mut entries, Mode::Input, callback).await;
    let output = v(&entries[0]);
    assert_eq!(output["custom-entry"], json!({"preserve":true}));
    assert_eq!(
        output["gen_ai.input.messages_delta"][0]["custom-message"],
        9
    );
    let parts = input_parts(&entries[0]);
    assert_eq!(
        &parts.as_array().unwrap()[..3],
        original_parts.as_array().unwrap()
    );
    assert_eq!(
        parts[3],
        json!({"type":"uri","uri":"oss://test/video","mime_type":"video/mp4","modality":"video"})
    );
    assert!(output["gen_ai.input.multimodal_metadata_delta"]
        .as_array()
        .unwrap()
        .iter()
        .any(|part| part["modality"] == "video"));
}
