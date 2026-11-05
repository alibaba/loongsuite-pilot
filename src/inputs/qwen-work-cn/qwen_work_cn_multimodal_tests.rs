//! One-to-one port of tests/unit/inputs/qwen-work-cn-multimodal.test.ts at 2caaaf9.
use super::*;
use crate::multimodal::types::UriResult;
use std::path::Path;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

fn entry(overrides: Value) -> AgentActivityEntry {
    let mut base = json!({"event.id":"e1","event.name":"other","gen_ai.agent.type":"qwen-work-cn",
        "gen_ai.session.id":"sess","gen_ai.turn.id":"turn-1","agent.qwenworkcn.cwd":"/work"});
    base.as_object_mut()
        .unwrap()
        .extend(overrides.as_object().unwrap().clone());
    crate::normalization::entry_from_map(base.as_object().unwrap().clone())
}
fn text_message(content: &str) -> AgentActivityEntry {
    entry(
        json!({"gen_ai.input.messages_delta":[{"role":"user","parts":[{"type":"text","content":content}]}]}),
    )
}
fn write_png(dir: &Path, name: &str, content: &str) -> String {
    let path = dir.join(name);
    std::fs::write(&path, content).unwrap();
    path.to_string_lossy().into_owned()
}
fn uri_parts(value: &Value) -> Vec<Value> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("uri"))
        .cloned()
        .collect()
}
fn uris(value: &Value) -> Vec<String> {
    uri_parts(value)
        .iter()
        .map(|part| part["uri"].as_str().unwrap().to_owned())
        .collect()
}
fn parts(entry: &AgentActivityEntry) -> &Value {
    &entry.input_messages_delta.as_ref().unwrap()[0]["parts"]
}
fn metadata(uri: &str, mime: &str) -> Value {
    json!([{"uri":uri,"mime_type":mime,"modality":"image"}])
}
fn fake_path() -> PathToUri {
    Arc::new(|path, _time| {
        Box::pin(async move {
            let Some(mime) = crate::multimodal::resolve::mime_from_image_path(&path) else {
                return Ok(None);
            };
            let Ok(bytes) = std::fs::read(&path) else {
                return Ok(None);
            };
            if bytes.is_empty() {
                return Ok(None);
            }
            Ok(Some(UriResult {
                uri: format!("oss://test/{}", String::from_utf8_lossy(&bytes)),
                mime_type: mime.into(),
                modality: Some("image".into()),
                size: bytes.len(),
                sha256: "deadbeef".into(),
            }))
        })
    })
}
async fn enrich(entries: &mut [AgentActivityEntry], mode: MultimodalUploadMode) {
    enrich_qwen_work_cn_multimodal(entries, mode, &fake_path()).await;
}
#[tokio::test]
async fn source55_reads_pasted_tag_later_attributes_and_several_images() {
    let dir = tempfile::tempdir().unwrap();
    let first = write_png(dir.path(), "a.png", "one");
    let second = write_png(dir.path(), "b.png", "two");
    let mut entries = vec![text_message(&format!("<user-pasted-image file=\"{first}\" /> 看这个\n<user-pasted-image file=\"{second}\" source=\"local-path\" source-version=\"1\" ordinal=\"0\" />"))];
    enrich(&mut entries, MultimodalUploadMode::Input).await;
    assert_eq!(
        uris(parts(&entries[0])),
        ["oss://test/one", "oss://test/two"]
    );
    assert_eq!(
        entries[0].input_multimodal_metadata_delta,
        Some(json!([
        {"uri":"oss://test/one","mime_type":"image/png","modality":"image"},
        {"uri":"oss://test/two","mime_type":"image/png","modality":"image"}]))
    );
}
#[tokio::test]
async fn source74_spaced_path_long_unclosed_tags_remain_under_original_500ms() {
    let dir = tempfile::tempdir().unwrap();
    let spaced = write_png(dir.path(), "my image.png", "spaced");
    let text = format!("{}<user-pasted-image file=\"{spaced}\" source=\"local-path\" source-version=\"1\" ordinal=\"0\" />", "<user-pasted-image file=\"a.png\" x".repeat(8000));
    let mut entries = vec![text_message(&text), text_message(&text)];
    entries[1].event_name = Some(AgentEventName::LlmRequest);
    let started = std::time::Instant::now();
    enrich(&mut entries, MultimodalUploadMode::Input).await;
    assert!(started.elapsed() < std::time::Duration::from_millis(500));
    for event in &entries {
        assert_eq!(uris(parts(event)), ["oss://test/spaced"]);
    }
}
#[tokio::test]
async fn source94_bare_filename_and_reminder_stay_unchanged() {
    let mut entries = vec![
        text_message("assets/hero.png"),
        text_message("<system-reminder>@[image:base64:older]</system-reminder>"),
    ];
    let before = serde_json::to_value(&entries).unwrap();
    enrich(&mut entries, MultimodalUploadMode::All).await;
    assert_eq!(serde_json::to_value(entries).unwrap(), before);
}
#[tokio::test]
async fn source106_read_file_path_only_from_read_tool_call() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("picture")).unwrap();
    let file = write_png(&dir.path().join("picture"), "upstream.jpg", "read");
    let mut entries = vec![
        entry(
            json!({"event.name":"tool.call","gen_ai.tool.name":"Read","gen_ai.tool.call.arguments":{"file_path":"picture/upstream.jpg"},"agent.qwenworkcn.cwd":dir.path()}),
        ),
        entry(
            json!({"event.name":"tool.call","gen_ai.tool.name":"Glob","gen_ai.tool.call.arguments":{"file_path":file}}),
        ),
    ];
    let before_other = serde_json::to_value(&entries[1]).unwrap();
    enrich(&mut entries, MultimodalUploadMode::Output).await;
    assert_eq!(
        uris(entries[0].tool_call_arguments.as_ref().unwrap()),
        ["oss://test/read"]
    );
    assert_eq!(
        entries[0].output_multimodal_metadata,
        Some(metadata("oss://test/read", "image/jpeg"))
    );
    assert_eq!(serde_json::to_value(&entries[1]).unwrap(), before_other);
}
#[tokio::test]
async fn source132_input_mode_keeps_read_arguments() {
    let dir = tempfile::tempdir().unwrap();
    let file = write_png(dir.path(), "a.png", "png-bytes");
    let mut entries = vec![entry(
        json!({"event.name":"tool.call","gen_ai.tool.name":"Read","gen_ai.tool.call.arguments":{"file_path":file}}),
    )];
    let before = serde_json::to_value(&entries).unwrap();
    enrich(&mut entries, MultimodalUploadMode::Input).await;
    assert_eq!(serde_json::to_value(entries).unwrap(), before);
}
#[tokio::test]
async fn source147_media_read_call_files_and_result_sources_once() {
    let dir = tempfile::tempdir().unwrap();
    let file = write_png(dir.path(), "pipeline.jpg", "seen");
    let mut entries = vec![
        entry(
            json!({"event.name":"tool.call","gen_ai.tool.name":"mcp__qw-builtin__qwenwork_media_read","gen_ai.tool.call.arguments":{"files":[file,file]}}),
        ),
        entry(
            json!({"event.name":"tool.result","gen_ai.tool.name":"mcp__qw-builtin__qwenwork_media_read","gen_ai.tool.call.result":json!({"success":true,"data":{"text":format!("caption {file}"),"files":[
            {"source":file,"kind":"image","mimeType":"image/jpeg"},{"source":file,"kind":"image","mimeType":"image/jpeg"},{"source":dir.path().join("note.txt"),"kind":"text"}]}}).to_string()}),
        ),
    ];
    enrich(&mut entries, MultimodalUploadMode::All).await;
    assert_eq!(
        uri_parts(entries[0].tool_call_arguments.as_ref().unwrap()).len(),
        1
    );
    assert_eq!(
        uri_parts(entries[1].tool_call_result.as_ref().unwrap()).len(),
        1
    );
    assert_eq!(
        entries[1].input_multimodal_metadata_delta,
        Some(metadata("oss://test/seen", "image/jpeg"))
    );
}
#[tokio::test]
async fn source180_completed_media_task_and_present_file_once() {
    let dir = tempfile::tempdir().unwrap();
    let file = write_png(dir.path(), "poster.jpg", "poster");
    let mut entries = vec![
        entry(
            json!({"event.name":"tool.result","gen_ai.tool.name":"mcp__qw-builtin__qwenwork_image_generate","gen_ai.tool.call.result":json!({"status":"pending","task_id":"media_1"}).to_string()}),
        ),
        entry(
            json!({"event.name":"tool.call","gen_ai.tool.name":"mcp__qw-builtin__qwenwork_media_task","gen_ai.tool.call.arguments":{"action":"wait","output_name":"poster"}}),
        ),
        entry(
            json!({"event.name":"tool.result","gen_ai.tool.name":"mcp__qw-builtin__qwenwork_media_task","gen_ai.tool.call.result":json!({"status":"completed","files":[file]}).to_string()}),
        ),
        entry(
            json!({"event.name":"tool.call","gen_ai.tool.name":"mcp__qw-builtin__qwenwork_file_present_files","gen_ai.tool.call.arguments":{"files":[{"file_path":file}]}}),
        ),
        entry(
            json!({"event.name":"tool.result","gen_ai.tool.name":"mcp__qw-builtin__qwenwork_file_present_files","gen_ai.tool.call.result":{"artifacts":[{"filePath":file}],"artifactPublication":{"artifacts":[{"uri":file,"metadata":{"originalUri":file}}]}}}),
        ),
    ];
    let before_pending = serde_json::to_value(&entries[0]).unwrap();
    let before_wait = serde_json::to_value(&entries[1]).unwrap();
    enrich(&mut entries, MultimodalUploadMode::All).await;
    assert_eq!(serde_json::to_value(&entries[0]).unwrap(), before_pending);
    assert_eq!(serde_json::to_value(&entries[1]).unwrap(), before_wait);
    assert_eq!(
        uri_parts(entries[2].tool_call_result.as_ref().unwrap()).len(),
        1
    );
    assert_eq!(
        uri_parts(entries[3].tool_call_arguments.as_ref().unwrap()).len(),
        1
    );
    assert_eq!(
        uri_parts(entries[4].tool_call_result.as_ref().unwrap()).len(),
        1
    );
    let other = write_png(dir.path(), "other.jpg", "other");
    assert_eq!(
        extract_qwen_work_cn_tool_result_paths(
            Some("mcp__qw-builtin__qwenwork_file_present_files"),
            &json!({"artifacts":[{"filePath":file}],"artifactPublication":{"artifacts":[{"uri":other,"metadata":{"originalUri":other}}]}}),
            None
        ),
        vec![file]
    );
}
#[tokio::test]
async fn source234_null_or_error_preserves_original_field() {
    let dir = tempfile::tempdir().unwrap();
    let outside = write_png(dir.path(), "outside.png", "out");
    let mut entries = vec![text_message(&format!(
        "<user-pasted-image file=\"{outside}\" />"
    ))];
    let before = serde_json::to_value(&entries).unwrap();
    let null: PathToUri = Arc::new(|_, _| Box::pin(async { Ok(None) }));
    enrich_qwen_work_cn_multimodal(&mut entries, MultimodalUploadMode::All, &null).await;
    assert_eq!(serde_json::to_value(&entries).unwrap(), before);
    let thrown_dir = tempfile::tempdir().unwrap();
    let file = write_png(thrown_dir.path(), "a.png", "png-bytes");
    let mut entries = vec![text_message(&format!(
        "<user-pasted-image file=\"{file}\" />"
    ))];
    let original = parts(&entries[0]).clone();
    let error: PathToUri = Arc::new(|_, _| Box::pin(async { Err("disk".into()) }));
    enrich_qwen_work_cn_multimodal(&mut entries, MultimodalUploadMode::All, &error).await;
    assert_eq!(parts(&entries[0]), &original);
    assert_eq!(entries[0].input_multimodal_metadata, None);
}
#[tokio::test]
async fn source261_one_pasted_conversion_shared_with_first_request() {
    let dir = tempfile::tempdir().unwrap();
    let file = write_png(dir.path(), "paste.png", "paste");
    let text = format!("<user-pasted-image file=\"{file}\" />");
    let mut entries = vec![text_message(&text), text_message(&text)];
    entries[1].event_name = Some(AgentEventName::LlmRequest);
    let calls = Arc::new(AtomicUsize::new(0));
    let copy = calls.clone();
    let fake = fake_path();
    let callback: PathToUri = Arc::new(move |path, time| {
        let calls = copy.clone();
        let fake = fake.clone();
        Box::pin(async move {
            if calls.fetch_add(1, Ordering::SeqCst) > 0 {
                return Ok(None);
            }
            fake(path, time).await
        })
    });
    enrich_qwen_work_cn_multimodal(&mut entries, MultimodalUploadMode::Input, &callback).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    for event in &entries {
        assert_eq!(uris(parts(event)), ["oss://test/paste"]);
    }
}
#[tokio::test]
async fn source286_uri_cached_in_turn_converted_again_next_turn() {
    let dir = tempfile::tempdir().unwrap();
    let file = write_png(dir.path(), "paste.png", "paste");
    let text = format!("<user-pasted-image file=\"{file}\" />");
    let calls = Arc::new(AtomicUsize::new(0));
    let copy = calls.clone();
    let fake = fake_path();
    let callback: PathToUri = Arc::new(move |path, time| {
        copy.fetch_add(1, Ordering::SeqCst);
        fake(path, time)
    });
    let mut entries = vec![
        text_message(&text),
        text_message(&text),
        text_message(&text),
    ];
    for (event, turn) in entries.iter_mut().zip(["turn-a", "turn-a", "turn-b"]) {
        event.turn_id = Some(turn.into());
        enrich_qwen_work_cn_multimodal(
            std::slice::from_mut(event),
            MultimodalUploadMode::Input,
            &callback,
        )
        .await;
    }
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    for event in &entries {
        assert_eq!(uris(parts(event)), ["oss://test/paste"]);
    }
}
#[tokio::test]
async fn source314_read_uri_copied_to_repeated_model_tool_calls() {
    let dir = tempfile::tempdir().unwrap();
    let file = write_png(dir.path(), "upstream.jpg", "read");
    let args = json!({"file_path":file});
    let oss = json!({"type":"image","file":{"url":"https://example.oss/upstream.jpg"}});
    let mut entries = vec![
        entry(
            json!({"event.name":"llm.response","gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"tool_call","id":"msg_read","name":"Read","arguments":args}]}]}),
        ),
        entry(
            json!({"event.name":"tool.call","gen_ai.tool.name":"Read","gen_ai.tool.call.id":"msg_read","gen_ai.tool.call.arguments":args}),
        ),
        entry(
            json!({"event.name":"llm.request","gen_ai.input.messages_delta":[{"role":"assistant","parts":[{"type":"tool_call","id":"msg_read","name":"Read","arguments":args}]},{"role":"tool","parts":[{"type":"tool_call_response","id":"msg_read","response":oss}]}]}),
        ),
    ];
    let calls = Arc::new(AtomicUsize::new(0));
    let copy = calls.clone();
    let fake = fake_path();
    let callback: PathToUri = Arc::new(move |path, time| {
        copy.fetch_add(1, Ordering::SeqCst);
        fake(path, time)
    });
    enrich_qwen_work_cn_multimodal(&mut entries, MultimodalUploadMode::All, &callback).await;
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    assert_eq!(
        uris(entries[1].tool_call_arguments.as_ref().unwrap()),
        ["oss://test/read"]
    );
    assert_eq!(
        uris(&entries[0].output_messages.as_ref().unwrap()[0]["parts"][0]["arguments"]),
        ["oss://test/read"]
    );
    assert_eq!(
        uris(&entries[2].input_messages_delta.as_ref().unwrap()[0]["parts"][0]["arguments"]),
        ["oss://test/read"]
    );
    assert_eq!(
        entries[2].input_messages_delta.as_ref().unwrap()[1]["parts"][0]["response"],
        oss
    );
    assert_eq!(
        entries[0].output_multimodal_metadata,
        Some(metadata("oss://test/read", "image/jpeg"))
    );
}
#[tokio::test]
async fn source368_completed_task_uri_copied_to_next_tool_response() {
    let dir = tempfile::tempdir().unwrap();
    let file = write_png(dir.path(), "poster.jpg", "poster");
    let body = json!({"status":"completed","files":[file]});
    let mut entries = vec![
        entry(
            json!({"event.name":"tool.result","gen_ai.tool.name":"mcp__qw-builtin__qwenwork_media_task","gen_ai.tool.call.id":"msg_task","gen_ai.tool.call.result":body}),
        ),
        entry(
            json!({"event.name":"llm.request","gen_ai.input.messages_delta":[{"role":"assistant","parts":[{"type":"tool_call","id":"msg_task","name":"mcp__qw-builtin__qwenwork_media_task","arguments":{"action":"wait","output_name":"poster"}}]},{"role":"tool","parts":[{"type":"tool_call_response","id":"msg_task","response":body}]}]}),
        ),
    ];
    let calls = Arc::new(AtomicUsize::new(0));
    let copy = calls.clone();
    let fake = fake_path();
    let callback: PathToUri = Arc::new(move |path, time| {
        copy.fetch_add(1, Ordering::SeqCst);
        fake(path, time)
    });
    enrich_qwen_work_cn_multimodal(&mut entries, MultimodalUploadMode::Input, &callback).await;
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        uris(entries[0].tool_call_result.as_ref().unwrap()),
        ["oss://test/poster"]
    );
    assert_eq!(
        uris(&entries[1].input_messages_delta.as_ref().unwrap()[1]["parts"][0]["response"]),
        ["oss://test/poster"]
    );
    assert_eq!(
        entries[1].input_multimodal_metadata_delta,
        Some(metadata("oss://test/poster", "image/jpeg"))
    );
}
#[tokio::test]
async fn source416_input_rewrites_request_call_only_output_keeps_request() {
    let dir = tempfile::tempdir().unwrap();
    let file = write_png(dir.path(), "upstream.jpg", "read");
    let mut entries = vec![
        entry(
            json!({"event.name":"llm.request","gen_ai.input.messages_delta":[{"role":"assistant","parts":[{"type":"tool_call","id":"msg_read","name":"Read","arguments":{"file_path":file}}]}]}),
        ),
        entry(
            json!({"event.name":"llm.response","gen_ai.output.messages":[{"role":"assistant","parts":[{"type":"tool_call","id":"msg_read","name":"Read","arguments":{"file_path":file}}]}]}),
        ),
    ];
    let before = serde_json::to_value(&entries[1]).unwrap();
    enrich(&mut entries, MultimodalUploadMode::Input).await;
    assert_eq!(
        uris(&entries[0].input_messages_delta.as_ref().unwrap()[0]["parts"][0]["arguments"]),
        ["oss://test/read"]
    );
    assert_eq!(serde_json::to_value(&entries[1]).unwrap(), before);
    let mut output = vec![entry(
        json!({"event.name":"llm.request","gen_ai.input.messages_delta":[{"role":"assistant","parts":[{"type":"tool_call","id":"msg_task","name":"mcp__qw-builtin__qwenwork_media_task","arguments":{"action":"wait"}}]},{"role":"tool","parts":[{"type":"tool_call_response","id":"msg_task","response":{"status":"completed","files":[file]}}]}]}),
    )];
    let before = serde_json::to_value(&output).unwrap();
    enrich(&mut output, MultimodalUploadMode::Output).await;
    assert_eq!(serde_json::to_value(&output).unwrap(), before);
}
#[tokio::test]
async fn source468_none_mode_does_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let file = write_png(dir.path(), "a.png", "png-bytes");
    let mut entries = vec![text_message(&format!(
        "<user-pasted-image file=\"{file}\" />"
    ))];
    let before = serde_json::to_value(&entries).unwrap();
    enrich(&mut entries, MultimodalUploadMode::None).await;
    assert_eq!(serde_json::to_value(entries).unwrap(), before);
}
#[test]
fn source479_default_allowlist_has_two_product_directories() {
    let roots = super::super::qwen_work_cn_default_allowed_root_paths();
    assert!(roots
        .iter()
        .any(|root| root.ends_with("/.qwenworkcn/workspace")
            || root.ends_with(r"\.qwenworkcn\workspace")));
    assert!(roots
        .iter()
        .any(|root| root.ends_with("/.qwenworkcn/tmp") || root.ends_with(r"\.qwenworkcn\tmp")));
    assert_eq!(roots.len(), 2);
}
