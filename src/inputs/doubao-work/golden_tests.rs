//! Frozen-main pure-function oracle. Fixtures are generated from pinned TypeScript
//! using synthetic source tests, never executed by the native collector.
use super::*;
use chrono::TimeZone;
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::sync::{Arc, LazyLock};
fn native_content(value: &Value) -> Option<content::NativeContent> {
    if value.is_null() {
        return None;
    }
    let decode = |name: &str| value.get(name).cloned().unwrap_or_else(|| json!({}));
    Some(content::NativeContent {
        calls: serde_json::from_value(decode("calls")).unwrap(),
        assignments: serde_json::from_value(decode("assignments")).unwrap(),
        last_answers: serde_json::from_value(decode("lastAnswers")).unwrap(),
        transcripts: serde_json::from_value::<IndexMap<String, Vec<Value>>>(decode("transcripts"))
            .unwrap()
            .into_iter()
            .map(|(k, v)| (k, v.into_iter().map(Arc::new).collect()))
            .collect(),
        transcript_offsets: serde_json::from_value(decode("transcriptOffsets")).unwrap(),
        source_versions: serde_json::from_value(decode("sourceVersions")).unwrap(),
        source_bytes: serde_json::from_value(decode("sourceBytes")).unwrap(),
        user_rows: None,
    })
}
fn native_graph(value: &Value) -> native::NativeGraph {
    native::NativeGraph {
        main: value["main"].as_str().unwrap().into(),
        edges: serde_json::from_value(value["edges"].clone()).unwrap(),
        content: value.get("content").and_then(native_content),
    }
}
fn localized_log(line: &str, file: &str, offset: i64) -> String {
    static CLOCK: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r":(\d{2})(\d{2})/(\d{2})(\d{2})(\d{2})\.(\d{3,6}):").unwrap()
    });
    static YEAR: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"_(\d{4})\.").unwrap());
    let Some(clock) = CLOCK.captures(line) else {
        return line.into();
    };
    let Some(year) = YEAR.captures(file).and_then(|c| c[1].parse::<i32>().ok()) else {
        return line.into();
    };
    let parse = |i: usize| clock[i].parse::<u32>().ok();
    let (Some(month), Some(day), Some(hour), Some(minute), Some(second)) =
        (parse(1), parse(2), parse(3), parse(4), parse(5))
    else {
        return line.into();
    };
    let Some(fixed) = chrono::FixedOffset::east_opt((-offset * 60) as i32) else {
        return line.into();
    };
    let Some(at) = fixed
        .with_ymd_and_hms(year, month, day, hour, minute, second)
        .single()
    else {
        return line.into();
    };
    let at = at.with_timezone(&chrono::Local);
    CLOCK
        .replace(
            line,
            format!(
                ":{}.{fraction}:",
                at.format("%m%d/%H%M%S"),
                fraction = &clock[6]
            ),
        )
        .into_owned()
}
fn run_case(item: &Value) -> serde_json::Result<Value> {
    let a = item["args"].as_array().unwrap();
    let arg = |i| a.get(i).unwrap_or(&Value::Null);
    let text = |i| arg(i).as_str().unwrap_or("");
    let integer = |i| arg(i).as_i64().unwrap();
    let ids = |i| serde_json::from_value::<Vec<String>>(arg(i).clone()).unwrap();
    let event = |i| serde_json::from_value::<types::DoubaoPendingTurn>(arg(i).clone()).unwrap();
    Ok(match item["function"].as_str().unwrap() {
        "parseDoubaoLogLine" => serde_json::to_value(log::parse_doubao_log_line(
            &localized_log(text(0), text(1), item["timezoneOffset"].as_i64().unwrap()),
            text(1),
        ))?,
        "buildDoubaoTaskEvents" => serde_json::to_value(log::build_doubao_task_events(
            text(0),
            &event(1),
            &serde_json::from_value(arg(2).clone())?,
            integer(3),
            &if arg(4).is_null() {
                vec![]
            } else {
                serde_json::from_value(arg(4).clone())?
            },
        ))?,
        "parseNativeContent" => match content::parse_native_content(
            &serde_json::from_value(arg(0).clone())?,
            &serde_json::from_value(arg(1).clone())?,
        ) {
            Ok(c) => serde_json::to_value(c)?,
            Err(budget::DoubaoWorkError::Json(e)) => return Err(e),
            Err(e) => panic!("oracle unexpected error: {e}"),
        },
        "nativeTaskContent" => content::native_task_content(
            native_content(arg(0)).as_ref(),
            text(1),
            integer(2),
            text(3),
            &ids(4),
        ),
        "enrichNativeToolEvents" => serde_json::to_value(content::enrich_native_tool_events(
            serde_json::from_value(arg(0).clone())?,
            native_content(arg(1)).as_ref(),
        ))?,
        "nativeToolObservations" => json!(content::native_tool_observations(
            &serde_json::from_value::<Vec<types::DoubaoToolPair>>(arg(0).clone())?,
            native_content(arg(1)).as_ref()
        )),
        "parseNativeGraph" => serde_json::to_value(native::parse_native_graph(
            &serde_json::from_value(arg(0).clone())?,
        ))?,
        "buildNativeToolEvents" => json!(native::build_native_tool_events(
            text(0),
            &event(1),
            &native_graph(arg(2)),
            &serde_json::from_value(arg(3).clone())?,
            integer(4)
        )),
        "parseNativeExecution" => serde_json::to_value(execution::parse_native_execution(arg(0)))?,
        "buildNativeExecutionEvents" => json!(execution::build_native_execution_events(
            text(0),
            &event(1),
            &native_graph(arg(2)),
            &serde_json::from_value(arg(3).clone())?,
            &serde_json::from_value::<Vec<execution::NativeExecution>>(arg(4).clone())?,
            integer(5)
        )),
        "isUniqueNativeToolOwner" => json!(execution::is_unique_native_tool_owner(
            &serde_json::from_value(arg(0).clone())?,
            &serde_json::from_value::<Vec<execution::NativeExecution>>(arg(1).clone())?,
            text(2),
            text(3)
        )),
        "nativeExecutionSpanId" => json!(execution::native_execution_span_id(text(0), text(1))),
        "reconstructNativeRounds" => serde_json::to_value(rounds::reconstruct_native_rounds(
            native_content(arg(0)).as_ref(),
            text(1),
            integer(2),
            text(3),
            &ids(4),
            arg(5).as_str().unwrap_or("client_request"),
        ))?,
        other => panic!("unregistered oracle function {other}"),
    })
}
fn oracle_cases() -> Vec<Value> {
    serde_json::from_str(include_str!("pure-golden.json")).unwrap()
}
fn assert_cases(source: &str) {
    let cases = oracle_cases();
    let mut count = 0;
    for (i, item) in cases
        .iter()
        .enumerate()
        .filter(|(_, v)| v["source"].as_str().unwrap().ends_with(source))
    {
        count += 1;
        let result = run_case(item);
        let label = format!(
            "case {i}: {} {} params={} function={}",
            item["source"], item["test"], item["parameters"], item["function"]
        );
        if item["throws"] == true {
            assert!(result.is_err(), "{label} expected rejection");
        } else {
            assert_eq!(result.unwrap(), item["expected"], "{label}");
        }
    }
    assert!(count > 0);
}
#[test]
fn frozen_main_native_content_exact_fields_and_negative_ownership() {
    assert_cases("doubao-work-content.test.ts");
}
#[test]
fn frozen_main_graph_exact_ancestry_and_late_tool_facts() {
    assert_cases("doubao-work-native.test.ts");
}
#[test]
fn frozen_main_execution_metadata_boundaries_owner_ancestry_and_digests() {
    assert_cases("doubao-work-execution.test.ts");
}
#[test]
fn frozen_main_first_output_18_negative_producers_and_source_time() {
    assert_cases("doubao-work-first-output.test.ts");
}
#[test]
fn frozen_main_rounds_exact_json_ids_utf8_suffix_parallel_skill_and_fragment() {
    assert_cases("doubao-work-rounds.test.ts");
}

#[test]
fn frozen_main_log_protocol_producer_allowlists_privacy_outcomes_and_year_rollover() {
    assert_cases("doubao-work-input.test.ts");
}
#[test]
fn frozen_main_windows_console_precision_and_mismatched_family_rejections() {
    assert_cases("doubao-work-windows.test.ts");
}

#[test]
fn native_recursive_mask_receives_decoded_newline_tool_content_and_preserves_the_originals() {
    let cases = oracle_cases();
    let parse = &cases[13];
    assert_eq!(parse["function"], "parseNativeContent");
    let content = content::parse_native_content(
        &serde_json::from_value(parse["args"][0].clone()).unwrap(),
        &serde_json::from_value(parse["args"][1].clone()).unwrap(),
    )
    .unwrap()
    .unwrap();
    let secret = format!("sk-{}", "x".repeat(24));
    let original_content = serde_json::to_string(&content).unwrap();
    let enriched = content::enrich_native_tool_events(
        serde_json::from_value(cases[14]["args"][0].clone()).unwrap(),
        Some(&content),
    );
    let parsed_event = |index: usize| {
        let item = &cases[index];
        let line = localized_log(
            item["args"][0].as_str().unwrap(),
            item["args"][1].as_str().unwrap(),
            item["timezoneOffset"].as_i64().unwrap(),
        );
        log::parse_doubao_log_line(&line, item["args"][1].as_str().unwrap()).unwrap()
    };
    let observations = content::native_tool_observations(
        &[types::DoubaoToolPair {
            start: parsed_event(15),
            end: parsed_event(16),
        }],
        Some(&content),
    );
    assert_eq!(observations.len(), 1);
    assert_eq!(
        observations[0]["arguments"],
        json!({
            "content": format!("total=90\n{secret}"),
            "file_path": "synthetic-file"
        })
    );
    let before_observations = serde_json::to_string(&observations).unwrap();
    let mut fields = enriched[0].clone();
    fields.extend(
        json!({"time_unix_nano":"1792897200100123000","event.id":"mask-json",
        "user.id":"synthetic","gen_ai.agent.type":"doubao-work",
        "agent.doubao_work.tool_observations":observations})
        .as_object()
        .unwrap()
        .clone(),
    );
    let entry = crate::normalization::entry_from_map(fields);
    let before_entry = serde_json::to_string(&entry).unwrap();
    let masked = crate::mask::mask_agent_activity_entry(
        &entry,
        &crate::types::MaskConfig {
            mode: crate::types::MaskMode::All,
            types: vec![],
            replacement_mode: None,
        },
        None,
        None,
    )
    .into_owned();
    assert!(!serde_json::to_string(&masked).unwrap().contains(&secret));
    let masked = serde_json::to_value(masked).unwrap();
    assert_eq!(
        masked["gen_ai.tool.call.arguments"]["file_path"],
        "synthetic-file"
    );
    assert_eq!(serde_json::to_string(&entry).unwrap(), before_entry);
    assert_eq!(serde_json::to_string(&content).unwrap(), original_content);
    assert_eq!(
        serde_json::to_string(&observations).unwrap(),
        before_observations
    );
    assert!(before_entry.contains(&secret));
}
#[test]
fn native_recursive_mask_receives_decoded_round_arguments_without_mutating_reconstruction() {
    let cases = oracle_cases();
    let parse = &cases[141];
    assert_eq!(parse["function"], "parseNativeContent");
    let content = content::parse_native_content(
        &serde_json::from_value(parse["args"][0].clone()).unwrap(),
        &serde_json::from_value(parse["args"][1].clone()).unwrap(),
    )
    .unwrap()
    .unwrap();
    let secret = format!("sk-{}", "x".repeat(24));
    let rebuilt = rounds::reconstruct_native_rounds(
        Some(&content),
        "m_synthetic",
        1792897200000,
        "1792897230000000000",
        &["mask".to_owned()],
        "client_request",
    )
    .unwrap();
    let rebuilt = serde_json::to_value(rebuilt).unwrap();
    assert_eq!(
        rebuilt["rounds"][0]["tools"][0]["arguments"]["content"],
        format!(
            "value
{secret}"
        )
    );
    let before = serde_json::to_string(&rebuilt).unwrap();
    assert!(before.contains(&secret));
    let fields = json!({"time_unix_nano":"1792897230000000000","event.id":"mask-rounds",
        "event.name":"other","user.id":"synthetic","gen_ai.agent.type":"doubao-work",
        "agent.doubao_work.assistant_rounds":rebuilt})
    .as_object()
    .unwrap()
    .clone();
    let entry = crate::normalization::entry_from_map(fields);
    let masked = crate::mask::mask_agent_activity_entry(
        &entry,
        &crate::types::MaskConfig {
            mode: crate::types::MaskMode::All,
            types: vec![],
            replacement_mode: None,
        },
        None,
        None,
    )
    .into_owned();
    assert!(!serde_json::to_string(&masked).unwrap().contains(&secret));
    assert_eq!(serde_json::to_string(&rebuilt).unwrap(), before);
    assert!(serde_json::to_string(&entry).unwrap().contains(&secret));
}
