use super::*;
fn migration_turn(index: i64, padding: usize) -> Vec<Value> {
    vec![
        json!({"type":"user","uuid":format!("user-{index}"),"timestamp":iso(index*1000),"message":{"role":"user","content":format!("prompt {index}{}","x".repeat(padding))}}),
        json!({"type":"assistant","timestamp":iso(index*1000+100),"message":{"id":format!("response-{index}"),"role":"assistant","model":"synthetic-model","content":[{"type":"text","text":format!("answer {index}")}],"stop_reason":"end_turn"}}),
        json!({"type":"last-prompt"}),
    ]
}
async fn migration_fixture(agent: &str) -> Fixture {
    let f = Fixture::new(agent).await;
    {
        let mut c = f.source.inner.lock().await;
        c.stable_ms = 0;
        c.settle_ms = 0;
    }
    f
}
fn publish(f: &Fixture, event: &str, identity: Option<&Value>) {
    let empty = Map::new();
    assert!(crate::hook_process::publish_qoder_wakeup(
        &json!({"session_id":"session","transcript_path":f.file,"hook_event_name":event}),
        &f.root,
        &f.agent,
        identity,
        &empty,
        &empty
    ));
}
async fn migration_restart(f: &mut Fixture) {
    f.restart().await;
    let mut c = f.source.inner.lock().await;
    c.stable_ms = 0;
    c.settle_ms = 0;
}
#[tokio::test]
async fn migration_l40_next_prompt_at_saved_watermark_keeps_identity_through_ack_and_restart() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = migration_fixture(agent).await;
        f.write(&migration_turn(0, 0));
        publish(&f, "Stop", None);
        let first = f.collect().await;
        assert_eq!(first.records.len(), 3);
        let saved = f.state.clone();
        f.source
            .inner
            .lock()
            .await
            .acknowledge(&saved, &f.source.stopped);
        publish(
            &f,
            "UserPromptSubmit",
            Some(&json!({"name":"synthetic-next-owner"})),
        );
        f.source
            .inner
            .lock()
            .await
            .acknowledge(&saved, &f.source.stopped);
        assert!(f.collect().await.records.is_empty());
        migration_restart(&mut f).await;
        f.source
            .inner
            .lock()
            .await
            .acknowledge(&f.state, &f.source.stopped);
        f.append(&migration_turn(1, 0));
        let next = f.collect().await;
        assert_eq!(next.records.len(), 3);
        assert!(next
            .records
            .iter()
            .all(|r| r["user.name"] == "synthetic-next-owner"));
        assert_eq!(
            next.records
                .iter()
                .map(|r| r["gen_ai.turn.id"].as_str().unwrap())
                .collect::<HashSet<_>>()
                .len(),
            1
        );
        f.source
            .inner
            .lock()
            .await
            .acknowledge(&f.state, &f.source.stopped);
        assert!(f.collect().await.records.is_empty());
    }
}
#[tokio::test]
async fn migration_l66_prior_cursor_does_not_ack_same_inode_rewritten_stop() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = migration_fixture(agent).await;
        f.write(&migration_turn(0, 2048));
        publish(&f, "UserPromptSubmit", None);
        f.collect().await;
        f.append(&migration_turn(1, 1024));
        publish(&f, "Stop", None);
        assert_eq!(f.collect().await.records.len(), 3);
        f.source
            .inner
            .lock()
            .await
            .acknowledge(&f.state, &f.source.stopped);
        let inode = scanner::version(&scanner::open_regular(&f.file).unwrap())
            .unwrap()
            .ino;
        f.write(&migration_turn(2, 0));
        assert_eq!(
            scanner::version(&scanner::open_regular(&f.file).unwrap())
                .unwrap()
                .ino,
            inode
        );
        publish(&f, "Stop", None);
        f.source
            .inner
            .lock()
            .await
            .acknowledge(&f.state, &f.source.stopped);
        let next = f.collect().await;
        assert_eq!(next.records.len(), 3);
        assert!(serde_json::to_string(&next.records)
            .unwrap()
            .contains("prompt 2"));
        assert!(f.collect().await.records.is_empty());
    }
}
#[cfg(unix)]
fn directory_alias(target: &Path, alias: &Path) {
    std::os::unix::fs::symlink(target, alias).unwrap();
}
#[cfg(windows)]
fn directory_alias(target: &Path, alias: &Path) {
    use std::io::{Read, Seek, SeekFrom};
    use std::process::{Command, Stdio};
    let shell = PathBuf::from(std::env::var_os("SystemRoot").expect("Windows SystemRoot"))
        .join("System32/cmd.exe");
    let mut stdout = tempfile::tempfile().unwrap();
    let mut stderr = tempfile::tempfile().unwrap();
    let mut command = Command::new(shell);
    // cmd's built-in junction creation avoids PowerShell module/cold startup.
    // Paths are normalized and passed as literal arguments in this temp fixture.
    command
        .args(["/d", "/c", "mklink", "/J"])
        .arg(fixture_native_path(alias.to_path_buf()))
        .arg(fixture_native_path(target.to_path_buf()))
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout.try_clone().unwrap()))
        .stderr(Stdio::from(stderr.try_clone().unwrap()));
    let mut child = crate::utils::candidate_process::CandidateChild::spawn(&mut command).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break Some(status);
        }
        if std::time::Instant::now() >= deadline {
            break None;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    drop(child);
    stdout.seek(SeekFrom::Start(0)).unwrap();
    stderr.seek(SeekFrom::Start(0)).unwrap();
    let mut out = Vec::new();
    let mut err = Vec::new();
    stdout.take(1024 * 1024).read_to_end(&mut out).unwrap();
    stderr.take(1024 * 1024).read_to_end(&mut err).unwrap();
    assert!(
        status.is_some_and(|s| s.success()),
        "junction failed status={status:?}: {} {}",
        String::from_utf8_lossy(&out),
        String::from_utf8_lossy(&err)
    );
    assert_eq!(
        std::fs::canonicalize(alias).unwrap(),
        std::fs::canonicalize(target).unwrap()
    );
}
#[tokio::test]
async fn migration_l88_missing_descendant_behind_directory_alias_has_one_canonical_source() {
    for agent in ["qoder", "qoder-cn"] {
        for nested in [false, true] {
            let mut f = migration_fixture(agent).await;
            let real = f.root.join("real");
            let alias = f.root.join("alias");
            std::fs::create_dir(&real).unwrap();
            directory_alias(&real, &alias);
            f.file = if nested {
                alias.join("not-created-yet/session.jsonl")
            } else {
                alias.join("session.jsonl")
            };
            publish(&f, "UserPromptSubmit", None);
            std::fs::create_dir_all(f.file.parent().unwrap()).unwrap();
            f.write(&migration_turn(0, 0));
            publish(&f, "Stop", None);
            let batch = f.collect().await;
            assert_eq!(batch.records.len(), 3);
            assert_eq!(
                batch
                    .records
                    .iter()
                    .map(|r| r["gen_ai.turn.id"].as_str().unwrap())
                    .collect::<HashSet<_>>()
                    .len(),
                1
            );
            assert_eq!(
                std::fs::read_dir(
                    f.root
                        .join("state/qoder-transcripts")
                        .join(agent)
                        .join("sources")
                )
                .unwrap()
                .count(),
                1
            );
            assert!(f.collect().await.records.is_empty());
        }
    }
}
#[cfg(unix)]
#[tokio::test]
async fn migration_l108_dangling_file_alias_keeps_identity_when_target_appears() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = migration_fixture(agent).await;
        let target = f.root.join("target.jsonl");
        let alias = f.root.join("alias.jsonl");
        std::os::unix::fs::symlink(&target, &alias).unwrap();
        f.file = alias;
        publish(&f, "UserPromptSubmit", None);
        std::fs::write(&target, jsonl(&migration_turn(0, 0))).unwrap();
        publish(&f, "Stop", None);
        assert_eq!(f.collect().await.records.len(), 3);
        assert_eq!(
            std::fs::read_dir(
                f.root
                    .join("state/qoder-transcripts")
                    .join(agent)
                    .join("sources")
            )
            .unwrap()
            .count(),
            1
        );
    }
}
fn lock_path(f: &Fixture) -> PathBuf {
    let lock = qoder_legacy_retry_lock_path(&f.root, &f.file);
    std::fs::create_dir_all(lock.parent().unwrap()).unwrap();
    lock
}
#[tokio::test]
async fn migration_l122_incomplete_legacy_lock_grace_expires_without_deleting_owner_file() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = migration_fixture(agent).await;
        f.write(&migration_turn(0, 0));
        publish(&f, "Stop", None);
        let lock = lock_path(&f);
        std::fs::write(&lock, []).unwrap();
        assert!(f.collect().await.records.is_empty());
        f.clock.fetch_add(5000, Ordering::SeqCst);
        assert_eq!(f.collect().await.records.len(), 3);
        assert!(lock.exists());
        assert!(f.collect().await.records.is_empty());
    }
}
#[tokio::test]
async fn migration_l139_expired_reused_current_pid_does_not_block_native_collection() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = migration_fixture(agent).await;
        f.write(&migration_turn(0, 0));
        publish(&f, "Stop", None);
        let lock = lock_path(&f);
        let born =
            process_birth::birth_ms(std::process::id()).expect("native current process birth");
        std::fs::write(
            &lock,
            json!({"pid":std::process::id(),"sessionId":"session","startedAt":born-120000.0})
                .to_string(),
        )
        .unwrap();
        assert_eq!(f.collect().await.records.len(), 3);
        assert!(f.collect().await.records.is_empty());
    }
}
#[tokio::test]
async fn migration_l155_genuine_live_owner_survives_old_ttl_and_release_resumes() {
    for agent in ["qoder", "qoder-cn"] {
        let mut f = migration_fixture(agent).await;
        f.write(&migration_turn(0, 0));
        publish(&f, "Stop", None);
        let lock = lock_path(&f);
        std::fs::write(&lock,json!({"pid":std::process::id(),"sessionId":"session","startedAt":f.clock.load(Ordering::SeqCst)}).to_string()).unwrap();
        f.clock.fetch_add(120000, Ordering::SeqCst);
        assert!(f.collect().await.records.is_empty());
        std::fs::remove_file(lock).unwrap();
        assert_eq!(f.collect().await.records.len(), 3);
    }
}
