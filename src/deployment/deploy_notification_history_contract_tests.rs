use super::*;
#[tokio::test]
async fn notification_l32_l40_l48_l56_exact_mount_messages_append_and_return_only_after_visible() {
    for (agent, mount, expected) in [
        ("Claude Code", MountType::Wrapper, "hash -r"),
        ("Codex", MountType::RcInject, "source ~/.bashrc"),
        ("TestAgent", MountType::EnvInject, "新的终端窗口"),
    ] {
        let t = tempfile::tempdir().unwrap();
        let data = t.path().to_str().unwrap();
        write_deploy_notification(data, agent, mount).await;
        let text = std::fs::read_to_string(t.path().join("notifications")).unwrap();
        assert!(text.contains(agent));
        assert!(text.contains(expected));
    }
    let t = tempfile::tempdir().unwrap();
    let data = t.path().to_str().unwrap();
    write_deploy_notification(data, "Agent1", MountType::Wrapper).await;
    write_deploy_notification(data, "Agent2", MountType::RcInject).await;
    let text = std::fs::read_to_string(t.path().join("notifications")).unwrap();
    assert!(text.contains("Agent1"));
    assert!(text.contains("Agent2"));
}
#[test]
fn notification_l67_l77_rc_snippet_markers_commands_target_and_same_input_are_exact() {
    let snippet = build_rc_snippet("/home/user/.loongsuite-pilot");
    for value in [
        "# loongsuite-pilot BEGIN",
        "# loongsuite-pilot END",
        "/home/user/.loongsuite-pilot/notifications",
        "cat",
        "rm -f",
    ] {
        assert!(snippet.contains(value), "{value}");
    }
    assert_eq!(build_rc_snippet("/data"), build_rc_snippet("/data"));
}
#[tokio::test]
async fn notification_l85_l91_l96_l102_readonly_exact_content_and_all_absent_blank_inputs() {
    let t = tempfile::tempdir().unwrap();
    let data = t.path().to_str().unwrap();
    let path = t.path().join("notifications");
    assert!(read_pending_notifications(data).await.is_none());
    assert!(!path.exists());
    std::fs::write(&path, "hello world").unwrap();
    let before = std::fs::metadata(&path).unwrap().modified().unwrap();
    assert_eq!(
        read_pending_notifications(data).await.as_deref(),
        Some("hello world")
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello world");
    assert_eq!(
        std::fs::metadata(&path).unwrap().modified().unwrap(),
        before
    );
    for raw in ["", "   \n  "] {
        std::fs::write(&path, raw).unwrap();
        assert!(read_pending_notifications(data).await.is_none());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), raw);
    }
}
