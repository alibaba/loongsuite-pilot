use super::*;
use serde_json::json;
use std::io::Write;

fn append(path: &Path, bytes: &[u8]) {
    std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .unwrap()
        .write_all(bytes)
        .unwrap();
}
async fn poll(
    reader: &mut QoderLegacyHookReader,
    path: &Path,
    offset: &mut u64,
) -> LegacyHookBatch {
    let mut acc = InputRuntimeAccumulator::new();
    let batch = reader.read(path, *offset, Some(&mut acc)).await.unwrap();
    assert_eq!(acc.finish(0.0).raw_read_bytes, batch.bytes_read);
    assert_eq!(acc.finish(0.0).raw_read_calls, batch.read_calls);
    *offset = batch.next_offset;
    batch
}
#[tokio::test]
async fn source_l26_unchanged_partial_is_read_once_and_split_utf8_completed_without_replay() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("history.jsonl");
    let mut reader = QoderLegacyHookReader::new(64 * 1024, 256 * 1024);
    let mut offset = 0;
    let value = json!({"text":format!("{}中文🙂","x".repeat(160*1024))});
    let bytes = serde_json::to_vec(&value).unwrap();
    let split = bytes
        .windows("中文".len())
        .position(|v| v == "中文".as_bytes())
        .unwrap()
        + 1;
    std::fs::write(&path, &bytes[..split]).unwrap();
    let mut total = 0;
    for _ in 0..4 {
        let batch = poll(&mut reader, &path, &mut offset).await;
        assert!(batch.buffer.is_empty());
        assert_eq!(batch.next_offset, 0);
        assert!(batch.bytes_read <= 64 * 1024);
        total += batch.bytes_read;
    }
    assert_eq!(total, split as u64);
    assert_eq!(poll(&mut reader, &path, &mut offset).await.bytes_read, 0);
    append(&path, &bytes[split..]);
    append(&path, b"\n");
    let batch = poll(&mut reader, &path, &mut offset).await;
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&batch.buffer).unwrap(),
        value
    );
    assert!(batch.bytes_read < 256);
    assert!(poll(&mut reader, &path, &mut offset)
        .await
        .buffer
        .is_empty());
    assert_eq!(poll(&mut reader, &path, &mut offset).await.bytes_read, 0);
}
#[tokio::test]
async fn source_l50_oversize_record_has_bounded_quarantine_then_successor_drains_source_unchanged()
{
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("history.jsonl");
    let mut reader = QoderLegacyHookReader::new(64 * 1024, 128 * 1024);
    let mut offset = 0;
    let large = format!("{}\n", json!({"text":"x".repeat(192*1024)}));
    let source = format!("{}{}\n", large, json!({"id":"following-record"}));
    std::fs::write(&path, &source).unwrap();
    let mut records = Vec::new();
    let mut ranges = Vec::new();
    for _ in 0..6 {
        if offset >= source.len() as u64 {
            break;
        }
        let batch = poll(&mut reader, &path, &mut offset).await;
        assert!(batch.bytes_read <= 64 * 1024);
        for line in batch
            .buffer
            .split(|b| *b == b'\n')
            .filter(|s| !s.is_empty())
        {
            records.push(serde_json::from_slice::<serde_json::Value>(line).unwrap());
        }
        ranges.extend(batch.quarantine);
    }
    assert_eq!(records, vec![json!({"id":"following-record"})]);
    assert!(ranges.iter().any(|r| r.from == 0
        && r.to == Some(large.len() as u64)
        && r.reason == "record-byte-limit"));
    assert_eq!(offset, source.len() as u64);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), source);
    assert_eq!(poll(&mut reader, &path, &mut offset).await.bytes_read, 0);
}
#[tokio::test]
async fn source_l71_truncation_or_physical_replacement_drops_cached_partial() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("history.jsonl");
    let mut reader = QoderLegacyHookReader::new(64 * 1024, 256 * 1024);
    let mut offset = 0;
    std::fs::write(&path, format!("{{\"text\":\"{}", "x".repeat(96 * 1024))).unwrap();
    assert_eq!(poll(&mut reader, &path, &mut offset).await.next_offset, 0);
    std::fs::write(&path, b"{\"id\":\"rewritten\"}\n").unwrap();
    let batch = poll(&mut reader, &path, &mut offset).await;
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&batch.buffer).unwrap(),
        json!({"id":"rewritten"})
    );
    let replacement = path.with_extension("new");
    std::fs::write(&replacement, b"{\"id\":\"replacement\"}\n").unwrap();
    std::fs::remove_file(&path).unwrap();
    std::fs::rename(&replacement, &path).unwrap();
    reader.reset();
    let batch = reader.read(&path, 0, None).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&batch.buffer).unwrap(),
        json!({"id":"replacement"})
    );
}
#[tokio::test]
async fn source_l87_growing_rewrite_must_validate_partial_identity_prefix() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("history.jsonl");
    let mut reader = QoderLegacyHookReader::new(64 * 1024, 256 * 1024);
    let mut offset = 0;
    std::fs::write(
        &path,
        format!("{{\"id\":\"old\",\"text\":\"{}", "x".repeat(96 * 1024)),
    )
    .unwrap();
    assert_eq!(poll(&mut reader, &path, &mut offset).await.next_offset, 0);
    let expected = json!({"id":"new","text":"x".repeat(96*1024)});
    let value = format!("{}\n", expected);
    std::fs::write(&path, &value).unwrap();
    let mut buffers = Vec::new();
    for _ in 0..4 {
        if offset >= value.len() as u64 {
            break;
        }
        buffers.extend(poll(&mut reader, &path, &mut offset).await.buffer);
    }
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&buffers).unwrap(),
        expected
    );
}

#[tokio::test]
async fn native_callback_observes_read_before_physical_replacement_error_and_recovery() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("history.jsonl");
    std::fs::write(&path, b"{\"id\":\"old\"}\n").unwrap();
    let moved = root.path().join("source-retained.jsonl");
    let mut reader = QoderLegacyHookReader::default();
    let mut observations = Vec::new();
    let result = reader
        .read_observed(&path, 0, |bytes, requested, duration| {
            observations.push((bytes, requested, duration));
            if !moved.exists() {
                std::fs::rename(&path, &moved).unwrap();
                std::fs::write(&path, b"{\"id\":\"new\"}\n").unwrap();
            }
        })
        .await;
    assert!(result.is_err());
    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0].0, b"{\"id\":\"old\"}\n".len() as u64);
    assert!(observations[0].2 >= 0.0);
    let recovered = reader.read(&path, 0, None).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&recovered.buffer).unwrap(),
        json!({"id":"new"})
    );
    assert_eq!(std::fs::read(&moved).unwrap(), b"{\"id\":\"old\"}\n");
}

#[tokio::test]
async fn native_growing_rewrite_rechecks_partial_prefix_even_with_coalesced_metadata_stamp() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("history.jsonl");
    let mut reader = QoderLegacyHookReader::new(64 * 1024, 256 * 1024);
    let mut offset = 0;
    std::fs::write(
        &path,
        format!("{{\"id\":\"old\",\"text\":\"{}", "x".repeat(96 * 1024)),
    )
    .unwrap();
    assert_eq!(poll(&mut reader, &path, &mut offset).await.next_offset, 0);
    let expected = json!({"id":"new","text":"x".repeat(96*1024)});
    let source = format!("{expected}\n");
    std::fs::write(&path, &source).unwrap();
    let actual = snapshot(&open_regular(&path).await.unwrap()).await.unwrap();
    let cached = &mut reader.tail.as_mut().unwrap().snapshot;
    // Windows may coalesce the metadata timestamps for these rapid writes.
    // Keep the real cached bytes/size/identity and actual rewritten body.
    cached.modified = actual.modified;
    cached.changed = actual.changed;
    assert!(cached.same_stamp(&actual));
    assert!(actual.size > cached.size);
    let mut bytes = Vec::new();
    for _ in 0..4 {
        if offset >= source.len() as u64 {
            break;
        }
        let batch = poll(&mut reader, &path, &mut offset).await;
        assert!(batch.bytes_read <= 64 * 1024);
        bytes.extend(batch.buffer);
    }
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
        expected
    );
    assert_eq!(offset, source.len() as u64);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), source);
}
