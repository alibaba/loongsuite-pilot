//! Shell notifications written after a plugin-probe mount.

use crate::types::MountType;
use crate::utils::{create_logger, ensure_dir};
use std::path::Path;

fn logger() -> crate::utils::BoundLogger {
    create_logger("DeployNotification")
}

fn build_notification_message(agent_display_name: &str, mount_type: MountType) -> String {
    let mut lines = vec![format!(
        "  loongsuite-pilot: 已为 {agent_display_name} 部署采集能力"
    )];
    match mount_type {
        MountType::Wrapper => {
            lines.push("  如果命令未生效，请执行：hash -r".into());
            lines.push("  或者打开一个新的终端窗口。".into());
        }
        MountType::RcInject => {
            lines.push("  请执行：source ~/.bashrc 或 source ~/.zshrc".into());
            lines.push("  或者打开一个新的终端窗口。".into());
        }
        MountType::EnvInject => {
            lines.push("  请打开一个新的终端窗口以生效。".into());
        }
    }
    lines.join("\n")
}

pub async fn write_deploy_notification(
    data_dir: &str,
    agent_display_name: &str,
    mount_type: MountType,
) {
    let notification_path = Path::new(data_dir).join("notifications");
    let message = build_notification_message(agent_display_name, mount_type);
    ensure_dir(data_dir).await;
    let append = async {
        use tokio::io::AsyncWriteExt;
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&notification_path)
            .await?;
        file.write_all(format!("{message}\n\n").as_bytes()).await?;
        // Tokio 文件写入会排队到阻塞线程；返回成功前等待最后一批写入完成。
        file.flush().await?;
        Ok::<(), std::io::Error>(())
    };
    match append.await {
        Ok(()) => logger().info(
            "notification written",
            Some(
                &serde_json::json!({ "agent": agent_display_name, "mountType": mount_type.as_str() })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
            ),
        ),
        Err(err) => logger().warn(
            "failed to write notification",
            Some(&serde_json::json!({ "error": err.to_string() }).as_object().cloned().unwrap_or_default()),
        ),
    }
}

const RC_BEGIN: &str = "# loongsuite-pilot BEGIN";
const RC_END: &str = "# loongsuite-pilot END";

pub fn build_rc_snippet(data_dir: &str) -> String {
    let notification_path = Path::new(data_dir)
        .join("notifications")
        .to_string_lossy()
        .into_owned();
    [
        RC_BEGIN,
        &format!("if [ -f \"{notification_path}\" ]; then"),
        "  echo \"\"",
        &format!("  cat \"{notification_path}\""),
        "  echo \"\"",
        &format!("  rm -f \"{notification_path}\""),
        "fi",
        RC_END,
    ]
    .join("\n")
}

pub async fn read_pending_notifications(data_dir: &str) -> Option<String> {
    let notification_path = Path::new(data_dir).join("notifications");
    let content = tokio::fs::read_to_string(notification_path).await.ok()?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn writes_each_mount_message_and_appends() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        write_deploy_notification(&root, "Claude Code", MountType::Wrapper).await;
        write_deploy_notification(&root, "Codex", MountType::RcInject).await;
        write_deploy_notification(&root, "TestAgent", MountType::EnvInject).await;
        let content = std::fs::read_to_string(dir.path().join("notifications")).unwrap();
        assert!(content.contains("Claude Code"));
        assert!(content.contains("hash -r"));
        assert!(content.contains("Codex"));
        assert!(content.contains("source ~/.bashrc"));
        assert!(content.contains("TestAgent"));
        assert!(content.contains("新的终端窗口"));
        for index in 0..32 {
            let name = format!("ImmediateAgent-{index}");
            write_deploy_notification(&root, &name, MountType::EnvInject).await;
            let visible = std::fs::read_to_string(dir.path().join("notifications")).unwrap();
            assert!(visible.contains(&name), "返回成功后必须立即可读：{name}");
        }
    }

    #[test]
    fn rc_snippet_is_stable_and_marked() {
        let snippet = build_rc_snippet("/home/user/.loongsuite-pilot");
        assert!(snippet.contains("# loongsuite-pilot BEGIN"));
        assert!(snippet.contains("# loongsuite-pilot END"));
        assert!(snippet
            .replace('\\', "/")
            .contains("/home/user/.loongsuite-pilot/notifications"));
        assert!(snippet.contains("cat"));
        assert!(snippet.contains("rm -f"));
        assert_eq!(build_rc_snippet("/data"), build_rc_snippet("/data"));
    }

    #[tokio::test]
    async fn reads_pending_text_and_treats_blank_as_absent() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        assert!(read_pending_notifications(&root).await.is_none());
        std::fs::write(dir.path().join("notifications"), "hello world").unwrap();
        assert_eq!(
            read_pending_notifications(&root).await.as_deref(),
            Some("hello world")
        );
        std::fs::write(dir.path().join("notifications"), "").unwrap();
        assert!(read_pending_notifications(&root).await.is_none());
        std::fs::write(dir.path().join("notifications"), "   \n  ").unwrap();
        assert!(read_pending_notifications(&root).await.is_none());
    }
}

#[cfg(test)]
#[path = "deploy_notification_history_contract_tests.rs"]
mod history_contract_tests;
