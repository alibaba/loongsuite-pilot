// Exact legacy privacy callback contracts; actual Orchestrator wiring is tested separately.
struct OriginalPrivacyFixture {
    fixture: Fixture,
    processor: Arc<crate::multimodal::MultimodalProcessor>,
    uploads: Arc<SyntheticImageUploads>,
    private: String,
    public: String,
}
impl OriginalPrivacyFixture {
    fn new() -> Self {
        let root = isolated_fixture_root();
        let private = root.path().join("private").to_string_lossy().into_owned();
        let public = root.path().join("public").to_string_lossy().into_owned();
        let uploads = Arc::new(SyntheticImageUploads::default());
        let processor = crate::multimodal::MultimodalProcessor::new(
            Some("oss://test/original-privacy"),
            uploads.clone(),
            None,
        )
        .expect("synthetic processor");
        let fixture = Fixture::with_root_options(
            root,
            Some(crate::inputs::codex_transcript::CodexMultimodalOptions {
                enabled: true,
                upload_mode: Some(crate::types::MultimodalUploadMode::All),
                processor: Some(processor.clone()),
            }),
        );
        fixture
            .rt()
            .set_workspace_policy(crate::inputs::base::WorkspacePolicy::new(
                vec![private.clone()],
                None,
            ));
        Self {
            fixture,
            processor,
            uploads,
            private,
            public,
        }
    }
    fn params() -> crate::multimodal::types::BlobToUriParams {
        crate::multimodal::types::BlobToUriParams {
            content: "aGVsbG8=".into(),
            mime_type: Some("image/png".into()),
            modality: None,
            time_unix_ms: None,
            reuse_key: Some("image".into()),
        }
    }
    async fn assert_one_real_upload(&self) {
        self.processor.shutdown(1500).await;
        let uploads = self.uploads.0.lock().expect("real uploader observations");
        assert_eq!(uploads.len(), 1);
        assert_eq!(uploads[0].data.as_deref(), Some(&b"hello"[..]));
        assert_eq!(uploads[0].content_type, "image/png");
    }
}
#[tokio::test]
async fn workspace_l13_blocked_and_switched_session_never_calls_uploader_but_unknown_workspace_other_session_does(
) {
    let f = OriginalPrivacyFixture::new();
    let path = std::path::Path::new(&f.private)
        .join("rollout-2026-09-21T00-00-00-12345678-1234-1234-1234-123456789abc.jsonl")
        .to_string_lossy()
        .into_owned();
    let engine = f.fixture.engine();
    let params = OriginalPrivacyFixture::params();
    assert!(engine.make_blob(f.fixture.rt(), &path, Some(&f.private), None)(&params).is_none());
    assert!(engine.make_blob(f.fixture.rt(), &path, Some(&f.public), None)(&params).is_none());
    assert!(f.uploads.0.lock().expect("no private upload").is_empty());
    let other = std::path::Path::new(&f.private)
        .join("another-session.jsonl")
        .to_string_lossy()
        .into_owned();
    assert!(
        engine.make_blob(f.fixture.rt(), &other, None, None)(&params).is_some(),
        "a different unknown-workspace session must reach real processor"
    );
    f.assert_one_real_upload().await;
}
#[tokio::test]
async fn workspace_l31_text_only_child_exclusion_survives_cwd_change_without_blocking_allowed_parent_attachment(
) {
    let f = OriginalPrivacyFixture::new();
    let child_fixture=include_str!(concat!(env!("CARGO_MANIFEST_DIR"),"/tests/fixtures/codex-subagent/rollout-2026-08-07T10-00-04-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl"));
    let first: Value =
        serde_json::from_str(child_fixture.lines().next().expect("metadata")).unwrap();
    let meta = extract_codex_transcript_meta(first.as_object().unwrap())
        .expect("real checked-in child metadata");
    assert_ne!(meta.thread_id, meta.root_session_id);
    let child = f
        .fixture
        .root
        .path()
        .join(NATIVE_CHILDREN[0].0)
        .to_string_lossy()
        .into_owned();
    f.fixture
        .engine()
        .publish_transcript_owner_meta(&child, meta.clone());
    let child_entry = crate::normalization::build_agent_activity_entry(&json!({
        "event.id":"text-only-child","event.name":"other","gen_ai.agent.type":"codex",
        "gen_ai.session.id":meta.thread_id,"cwd":f.private
    }));
    assert!(f
        .fixture
        .rt()
        .with_workspace_policy(|policy| policy.filter_entries(
            std::slice::from_ref(&child_entry),
            crate::types::ClientType::CodexCliHook
        ))
        .is_empty());
    let params = OriginalPrivacyFixture::params();
    let engine = f.fixture.engine();
    assert!(engine.make_blob(f.fixture.rt(), &child, Some(&f.public), None)(&params).is_none());
    assert!(f
        .uploads
        .0
        .lock()
        .expect("child upload remains private")
        .is_empty());
    let mut changed = child_entry;
    changed.extra.insert("cwd".into(), json!(f.public));
    assert!(f
        .fixture
        .rt()
        .with_workspace_policy(
            |policy| policy.filter_entries(&[changed], crate::types::ClientType::CodexCliHook)
        )
        .is_empty());
    let parent = f
        .fixture
        .root
        .path()
        .join("parent.jsonl")
        .to_string_lossy()
        .into_owned();
    let mut parent_meta = meta.clone();
    parent_meta.thread_id = meta.root_session_id.clone();
    f.fixture
        .engine()
        .publish_transcript_owner_meta(&parent, parent_meta);
    assert!(
        engine.make_blob(f.fixture.rt(), &parent, Some(&f.public), None)(&params).is_some(),
        "parent sharing the root session must remain independently allowed"
    );
    f.assert_one_real_upload().await;
}
