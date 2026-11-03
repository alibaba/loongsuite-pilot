use super::*;

fn env_for(root: &Path) -> Env {
    let mut env = Env::new();
    for key in ["HOME", "USERPROFILE", "LOONGSUITE_PILOT_DATA_DIR"] {
        env.insert(key.into(), root.to_string_lossy().into_owned());
    }
    env
}

#[test]
fn line_records_lazy_split_preserves_both_session_bindings_and_the_old_aggregate() {
    let root = tempfile::tempdir().unwrap();
    let env = env_for(root.path());
    let aggregate = aggregate_line_record_file(&env, "qoder-work");
    fs::create_dir_all(aggregate.parent().unwrap()).unwrap();
    fs::write(&aggregate,json!({
        "/tmp/transcript-a.jsonl":{"session_id":"session-a","last_line_count":10,"updated_at":"2026-07-22 10:00:00"},
        "/tmp/transcript-b.jsonl":{"session_id":"session-b","last_line_count":20,"updated_at":"2026-07-22 10:01:00"},
    }).to_string()).unwrap();
    for (session, path, count) in [
        ("session-a", "/tmp/transcript-a.jsonl", 10),
        ("session-b", "/tmp/transcript-b.jsonl", 20),
    ] {
        let record = load_line_record(&env, "qoder-work", session);
        assert_eq!(record["session_id"], session);
        assert_eq!(record["transcript_path"], path);
        assert_eq!(record["last_line_count"], count);
    }
    assert!(aggregate.exists());
    let records = fs::read_dir(root.path().join("state/hooks/qoder-work-line-records"))
        .unwrap()
        .filter(|entry| {
            entry
                .as_ref()
                .unwrap()
                .path()
                .extension()
                .is_some_and(|extension| extension == "json")
        })
        .count();
    assert_eq!(records, 2);
}

#[test]
fn line_records_rollback_progress_remains_monotonic_when_a_stale_writer_has_a_newer_timestamp() {
    let root = tempfile::tempdir().unwrap();
    let env = env_for(root.path());
    let aggregate = aggregate_line_record_file(&env, "qoder-work");
    fs::create_dir_all(aggregate.parent().unwrap()).unwrap();
    let path = "/tmp/transcript-rollback.jsonl";
    for (count, updated, expected) in [
        (10, "2026-07-22 10:00:00", 10),
        (30, "2026-07-22 10:05:00", 30),
        (20, "2026-07-22 10:10:00", 30),
    ] {
        fs::write(&aggregate,json!({path:{"session_id":"session-rollback","last_line_count":count,"updated_at":updated}}).to_string()).unwrap();
        let record = load_line_record(&env, "qoder-work", "session-rollback");
        assert_eq!(record["session_id"], "session-rollback");
        assert_eq!(record["transcript_path"], path);
        assert_eq!(record["last_line_count"], expected);
    }
    let saved = read_json_object(&session_line_record_file(
        &env,
        "qoder-work",
        "session-rollback",
    ))
    .unwrap();
    assert_eq!(saved["last_line_count"], 30);
}

#[test]
fn line_records_nonexistent_and_empty_files_have_zero_count_and_no_snapshot_lines() {
    let root = tempfile::tempdir().unwrap();
    let missing = root.path().join("missing.jsonl");
    let empty = root.path().join("empty.jsonl");
    fs::write(&empty, "").unwrap();
    for file in [missing, empty] {
        let snapshot = read_transcript_snapshot(&file.to_string_lossy());
        assert_eq!(snapshot.line_count, 0);
        assert!(snapshot.lines.is_empty());
    }
}

#[test]
fn line_records_all_seven_original_contents_keep_reference_counts_and_every_start_end_slice() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("transcript.jsonl");
    for (name, content, count, expected_lines) in [
        ("trailing newline", "a\nb\nc\n", 3, vec!["a", "b", "c", ""]),
        ("no trailing newline", "a\nb\nc", 3, vec!["a", "b", "c"]),
        ("single line no newline", "only", 1, vec!["only"]),
        (
            "CRLF endings",
            "a\r\nb\r\nc\r\n",
            3,
            vec!["a", "b", "c", ""],
        ),
        (
            "CRLF without final newline",
            "a\r\nb\r\nc",
            3,
            vec!["a", "b", "c"],
        ),
        ("blank lines", "\n\n\n", 3, vec!["", "", "", ""]),
        (
            "multibyte utf-8",
            "中文一行\n第二行没有换行的多字节内容",
            2,
            vec!["中文一行", "第二行没有换行的多字节内容"],
        ),
    ] {
        fs::write(&file, content).unwrap();
        let snapshot = read_transcript_snapshot(&file.to_string_lossy());
        let reference = content
            .chars()
            .filter(|character| *character == '\n')
            .count()
            + usize::from(!content.is_empty() && !content.ends_with('\n'));
        assert_eq!(snapshot.line_count, reference, "{name}");
        assert_eq!(snapshot.line_count, count, "{name}");
        for start in 0..=count {
            for end in start..=count + 1 {
                let expected = expected_lines
                    .iter()
                    .skip(start)
                    .take(end - start)
                    .filter(|line| !line.is_empty())
                    .map(|line| (*line).to_owned())
                    .collect::<Vec<_>>();
                let sliced = slice_transcript_lines(&snapshot.lines, start, end);
                assert_eq!(sliced, expected, "snapshot {name}/{start}/{end}");
                let reread = read_transcript_snapshot(&file.to_string_lossy());
                assert_eq!(reread.line_count, snapshot.line_count);
                assert_eq!(
                    slice_transcript_lines(&reread.lines, start, end),
                    expected,
                    "fresh read {name}/{start}/{end}"
                );
            }
        }
    }
}
