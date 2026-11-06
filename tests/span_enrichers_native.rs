//! Legacy .mjs contracts through the actual native worker, without Node.
use loongsuite_pilot::flushers::{ReadableSpan, SpanEnricherContext, SpanEnricherRunner};
use serde_json::json;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn context() -> SpanEnricherContext {
    SpanEnricherContext {
        agent_type: "codex".into(),
        service_name: "test-codex".into(),
    }
}
fn span() -> ReadableSpan {
    let mut span = ReadableSpan::minimal(
        "execute_tool shell",
        "0123456789abcdef0123456789abcdef",
        "0123456789abcdef",
    );
    span.attributes
        .insert("gen_ai.tool.name".into(), json!("shell"));
    span.attributes.insert(
        "gen_ai.tool.call.arguments".into(),
        json!("{\"command\":\"npm test\"}"),
    );
    span.attributes.insert("tags".into(), json!(["original"]));
    span
}
fn runner(paths: &[String]) -> SpanEnricherRunner {
    SpanEnricherRunner::new(paths)
        .unwrap()
        .with_worker_executable(env!("CARGO_BIN_EXE_loongsuite-pilot"))
}
async fn plugin(root: &std::path::Path, name: &str, source: &str) -> String {
    let path = root.join(format!("{name}.mjs"));
    tokio::fs::write(&path, source).await.unwrap();
    path.to_string_lossy().into_owned()
}

#[tokio::test]
async fn native_esm_modules_keep_order_module_state_realpath_identity_and_original_span() {
    let root = tempfile::tempdir().unwrap();
    let first=plugin(root.path(),"first",r#"let count=0;export default{enrich(s,c){
        return {'gen_ai.skill.name':s.attributes['gen_ai.tool.name']+':'+c.agentType,count:++count};}};"#).await;
    let second = plugin(
        root.path(),
        "second",
        r#"export default{enrich(s){return {
        'gen_ai.skill.name':s.attributes['gen_ai.skill.name']+':next'};}};"#,
    )
    .await;
    let mut paths = vec![first.clone(), first.clone()];
    #[cfg(unix)]
    {
        let alias = root.path().join("alias.mjs");
        std::os::unix::fs::symlink(&first, &alias).unwrap();
        paths.push(alias.to_string_lossy().into_owned());
    }
    paths.push(second);
    let runner = Arc::new(runner(&paths));
    let mut original = span();
    original.parent_span_id = Some("fedcba9876543210".into());
    original.start_time = [1000, 17];
    original.end_time = [1003, 62];
    original.duration = [3, 45];
    original.ended = true;
    original.dropped_attributes_count = 7;
    original.dropped_events_count = 8;
    original.dropped_links_count = 9;
    original.resource_attributes = Some(
        serde_json::from_value(json!({
            "service.name": "test-codex", "metadata.preserved": true
        }))
        .unwrap(),
    );
    original.links = vec![json!({
        "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "spanId": "bbbbbbbbbbbbbbbb",
        "attributes": {"link.preserved": true}
    })];
    let (a, b) = tokio::join!(
        runner.enrich(vec![original.clone()], context()),
        runner.enrich(vec![original.clone()], context())
    );
    assert_eq!(a[0].attributes["gen_ai.skill.name"], "shell:codex:next");
    assert_eq!(a[0].attributes["count"], 1);
    assert_eq!(b[0].attributes["count"], 2);
    assert!(!original.attributes.contains_key("gen_ai.skill.name"));
    assert_eq!(a[0].name, original.name);
    assert_eq!(a[0].trace_id, original.trace_id);
    assert_eq!(a[0].span_id, original.span_id);
    for enriched in [&a[0], &b[0]] {
        assert_eq!(enriched.parent_span_id, original.parent_span_id);
        assert_eq!(enriched.start_time, original.start_time);
        assert_eq!(enriched.end_time, original.end_time);
        assert_eq!(enriched.duration, original.duration);
        assert_eq!(enriched.ended, original.ended);
        assert_eq!(
            enriched.dropped_attributes_count,
            original.dropped_attributes_count
        );
        assert_eq!(enriched.dropped_events_count, original.dropped_events_count);
        assert_eq!(enriched.dropped_links_count, original.dropped_links_count);
        assert_eq!(enriched.resource_attributes, original.resource_attributes);
        assert_eq!(enriched.links, original.links);
        // The frozen SDK fixture has no events; preserve that list as well.
        assert_eq!(enriched.events.len(), original.events.len());
        for (event, original_event) in enriched.events.iter().zip(&original.events) {
            assert_eq!(event.name, original_event.name);
            assert_eq!(event.attributes, original_event.attributes);
        }
    }
    runner.shutdown().await;
}

#[tokio::test]
async fn native_loader_and_callbacks_fail_independently_and_readonly_snapshots_survive() {
    let root = tempfile::tempdir().unwrap();
    let mut paths = vec![root
        .path()
        .join("missing.mjs")
        .to_string_lossy()
        .into_owned()];
    for (name, source) in [
        ("syntax", "this is invalid javascript!"),
        ("shape", "export default {};"),
        (
            "throw",
            "export default {enrich(){throw new Error('SYNTHETIC_SECRET');}};",
        ),
        (
            "mutate",
            "export default {enrich(s){s.attributes.tags.push('bad');}};",
        ),
        ("good", "export default {enrich(){return {ok:true};}};"),
    ] {
        paths.push(plugin(root.path(), name, source).await);
    }
    let runner = runner(&paths);
    let original = span();
    let result = runner.enrich(vec![original.clone()], context()).await;
    assert_eq!(result[0].attributes["ok"], true);
    assert_eq!(result[0].attributes["tags"], json!(["original"]));
    assert!(!original.attributes.contains_key("ok"));
    runner.shutdown().await;
}

#[tokio::test]
async fn native_javascript_patch_validation_rejects_invalid_values_before_json_coercion() {
    let root = tempfile::tempdir().unwrap();
    for expression in [
        "null",
        "[]",
        "{good:true,bad:{}}",
        "{bad:NaN}",
        "{bad:Infinity}",
        "{good:true,bad:undefined}",
        "{good:true,bad:()=>{}}",
        "{good:true,bad:Symbol('x')}",
        "{good:true,bad:1n}",
        "{bad:[1,2n]}",
        "{prototype:'bad'}",
        "{constructor:'bad'}",
        "{bad:[1,'x']}",
        "JSON.parse('{\"__proto__\":\"bad\"}')",
        "Promise.reject(new Error('SYNTHETIC_SECRET'))",
    ] {
        let path = plugin(
            root.path(),
            "invalid",
            &format!("export default{{enrich(){{return {expression};}}}};"),
        )
        .await;
        let runner = runner(&[path]);
        let original = span();
        let result = runner.enrich(vec![original.clone()], context()).await;
        assert_eq!(result[0].attributes, original.attributes, "{expression}");
        runner.shutdown().await;
    }
    let path = plugin(
        root.path(),
        "valid",
        "export default{enrich(){return{s:'x',n:1,b:false,a:[1,null,2],empty:[]};}};",
    )
    .await;
    let runner = runner(&[path]);
    let result = runner.enrich(vec![span()], context()).await;
    for (key, value) in [
        ("s", json!("x")),
        ("n", json!(1)),
        ("b", json!(false)),
        ("a", json!([1, null, 2])),
        ("empty", json!([])),
    ] {
        assert_eq!(result[0].attributes[key], value);
    }
    runner.shutdown().await;
}

#[tokio::test]
async fn native_relative_esm_imports_and_method_receiver_keep_state_between_calls() {
    let root = tempfile::tempdir().unwrap();
    plugin(root.path(), "helper", "export const suffix=':relative';").await;
    let path=plugin(root.path(),"plugin",r#"import{suffix}from'./helper.mjs';
        export default{count:0,enrich(s){return{value:s.name+suffix,count:++this.count,source:import.meta.url};}};"#).await;
    let runner = runner(&[path]);
    let a = runner.enrich(vec![span()], context()).await;
    let b = runner.enrich(vec![span()], context()).await;
    assert_eq!(a[0].attributes["value"], "execute_tool shell:relative");
    assert_eq!(a[0].attributes["count"], 1);
    assert_eq!(b[0].attributes["count"], 2);
    assert!(a[0].attributes["source"]
        .as_str()
        .unwrap()
        .starts_with("file:"));
    runner.shutdown().await;
}

#[tokio::test]
async fn pending_module_and_busy_callback_each_have_a_real_five_second_process_boundary() {
    let root = tempfile::tempdir().unwrap();
    for (name, source) in [
        (
            "pending",
            "await new Promise(()=>{});export default{enrich(){}};",
        ),
        ("busy", "export default{enrich(){for(;;){}}};"),
    ] {
        let bad = plugin(root.path(), name, source).await;
        let good = plugin(
            root.path(),
            "good",
            "export default{count:0,enrich(){return{ok:true,count:++this.count};}};",
        )
        .await;
        let runner = runner(&[bad, good]);
        let started = Instant::now();
        let first = tokio::time::timeout(
            Duration::from_secs(9),
            runner.enrich(vec![span()], context()),
        )
        .await
        .unwrap();
        assert!(started.elapsed() >= Duration::from_millis(4800));
        assert_eq!(first[0].attributes["ok"], true);
        let second = tokio::time::timeout(
            Duration::from_secs(2),
            runner.enrich(vec![span()], context()),
        )
        .await
        .unwrap();
        assert_eq!(
            second[0].attributes["count"], 2,
            "healthy plugin state was reset"
        );
        runner.shutdown().await;
    }
}

#[tokio::test]
async fn only_first_sixteen_configured_modules_are_loaded_and_trace_still_exports() {
    let root = tempfile::tempdir().unwrap();
    let mut paths = Vec::new();
    for n in 0..17 {
        paths.push(
            plugin(
                root.path(),
                &format!("p{n}"),
                &format!("export default{{enrich(){{return{{'plugin.{n}':true}};}}}};"),
            )
            .await,
        );
    }
    let runner = runner(&paths);
    let result = runner.enrich(vec![span()], context()).await;
    for n in 0..16 {
        assert_eq!(result[0].attributes[&format!("plugin.{n}")], true);
    }
    assert!(!result[0].attributes.contains_key("plugin.16"));
    runner.shutdown().await;
}

#[tokio::test]
async fn icu24_native_worker_keeps_unicode_identifiers_and_all_normalization_forms() {
    let root = tempfile::tempdir().unwrap();
    let source = r#"let 变量 = 'ok'; let café = 'identifier';
        export default { enrich() { return {
            unicode_identifier: 变量 + ':' + café,
            nfc: 'A\u030A'.normalize('NFC'),
            nfd: '\u00C5'.normalize('NFD'),
            nfkc: '\uFB03'.normalize('NFKC'),
            nfkd: '\u00C5'.normalize('NFKD')
        }; } };"#;
    let path = plugin(root.path(), "icu24", source).await;
    let runner = runner(&[path]);
    let enriched = runner.enrich(vec![span()], context()).await;
    let values = &enriched[0].attributes;
    assert_eq!(values["unicode_identifier"], "ok:identifier");
    assert_eq!(values["nfc"], "\u{00C5}");
    assert_eq!(values["nfd"], "A\u{030A}");
    assert_eq!(values["nfkc"], "ffi");
    assert_eq!(values["nfkd"], "A\u{030A}");
    runner.shutdown().await;
}
