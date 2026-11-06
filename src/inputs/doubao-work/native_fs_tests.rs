use super::*;
use execution::{read_native_executions, NativeExecution};
use indexmap::IndexMap;
use native::read_native_profile_graph;
use serde_json::json;
use std::path::{Path, PathBuf};
const CID: &str = "12345678";
fn execution() -> NativeExecution {
    NativeExecution {
        execution_key: "00000000-0000-4000-8000-000000000001".into(),
        conversation_id: CID.into(),
        query_message_id: "00000000-0000-4000-8000-000000000002".into(),
        agent_id: "s_nativeLeaf".into(),
        agent_type: "sub_agent".into(),
        sandbox_id: "synthetic-sandbox".into(),
        started_at_ms: 1_792_897_201_000,
        ended_at_ms: 1_792_897_202_000,
    }
}
async fn save(root: &Path, e: &NativeExecution, account: &str) -> PathBuf {
    let folder = root
        .join(account)
        .join(&e.conversation_id)
        .join(&e.execution_key);
    tokio::fs::create_dir_all(&folder).await.unwrap();
    let file = folder.join(format!("{}.json", e.agent_id));
    tokio::fs::write(&file,util::js_encode(&json!({"execution":e,"files":[{"path":"SYNTHETIC_PRIVATE_PATH"}],"fileContents":"SYNTHETIC_PRIVATE_CONTENT"}))).await.unwrap();
    file
}
async fn seed(root: &Path, profile: &str, cid: &str) {
    for (actor, child, parent, thread, call) in [
        (
            "m_nativeMain",
            "o_nativeOrg",
            "main_agent",
            "101",
            "root-create",
        ),
        (
            "o_nativeOrg",
            "s_nativeLeaf",
            "o_nativeOrg",
            "102",
            "child-create",
        ),
    ] {
        let folder = root
            .join(profile)
            .join(".doubaowork/agent_mode/workspace/.sessions")
            .join(cid)
            .join("agents")
            .join(actor)
            .join("system");
        tokio::fs::create_dir_all(&folder).await.unwrap();
        let rows = [
            json!({"role":"assistant","tool_calls":[{"id":call,"function":{"name":"create_agent","arguments":{"subtask":"SYNTHETIC_PRIVATE"}}}]}),
            json!({"role":"tool","tool_call_id":call,"content":format!("create_agent ok\nagent_id: {child}\nparent_id: {parent}\nthread_id: {thread}\nagent_type: organizer\nsubtask: SYNTHETIC_PRIVATE")}),
        ];
        tokio::fs::write(
            folder.join("trajectory.jsonl"),
            rows.iter()
                .map(util::js_encode)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .await
        .unwrap();
    }
}
#[tokio::test]
async fn execution_scan_selects_exact_conversation_without_private_account_or_file_content() {
    let root = tempfile::tempdir().unwrap();
    let e = execution();
    save(root.path(), &e, "123").await;
    let mut other = e.clone();
    other.conversation_id = "87654321".into();
    save(root.path(), &other, "123").await;
    let values = read_native_executions(root.path().to_str().unwrap(), CID)
        .await
        .unwrap();
    assert_eq!(values, vec![e]);
    let encoded = serde_json::to_string(&values).unwrap();
    assert!(!encoded.contains("SYNTHETIC_PRIVATE"));
    assert!(
        read_native_executions(root.path().to_str().unwrap(), "../escape")
            .await
            .unwrap()
            .is_empty()
    );
}
#[tokio::test]
async fn execution_scan_rejects_truncated_and_cross_account_conflicting_identity() {
    let root = tempfile::tempdir().unwrap();
    let e = execution();
    let file = save(root.path(), &e, "123").await;
    tokio::fs::write(file, "{half").await.unwrap();
    assert!(read_native_executions(root.path().to_str().unwrap(), CID)
        .await
        .is_err());
    save(root.path(), &e, "123").await;
    let mut other = e;
    other.ended_at_ms += 1;
    save(root.path(), &other, "456").await;
    let error = read_native_executions(root.path().to_str().unwrap(), CID)
        .await
        .unwrap_err();
    assert!(error.to_string().to_ascii_lowercase().contains("conflict"));
}
#[tokio::test]
async fn execution_scan_rejects_path_identity_mismatch_and_oversized_metadata_before_parse() {
    let root = tempfile::tempdir().unwrap();
    let e = execution();
    let file = save(root.path(), &e, "123").await;
    let mut other = e;
    other.agent_id = "unrelated".into();
    tokio::fs::write(&file, util::js_encode(&json!({"execution":other})))
        .await
        .unwrap();
    assert!(read_native_executions(root.path().to_str().unwrap(), CID)
        .await
        .unwrap_err()
        .to_string()
        .contains("identity"));
    tokio::fs::write(&file, vec![b' '; 2 * 1024 * 1024 + 1])
        .await
        .unwrap();
    assert!(read_native_executions(root.path().to_str().unwrap(), CID)
        .await
        .unwrap_err()
        .to_string()
        .contains("limit"));
}
#[cfg(unix)]
#[tokio::test]
async fn execution_scan_never_follows_conversation_or_execution_directory_symlink() {
    for execution_link in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let e = execution();
        save(other.path(), &e, "123").await;
        let parent = if execution_link {
            root.path().join("123").join(CID)
        } else {
            root.path().join("123")
        };
        tokio::fs::create_dir_all(&parent).await.unwrap();
        let target = if execution_link {
            other.path().join("123").join(CID).join(&e.execution_key)
        } else {
            other.path().join("123").join(CID)
        };
        let dest = if execution_link {
            parent.join(&e.execution_key)
        } else {
            parent.join(CID)
        };
        std::os::unix::fs::symlink(target, dest).unwrap();
        let result = read_native_executions(root.path().to_str().unwrap(), CID).await;
        // A symlinked execution folder is excluded by the directory enumerator; a symlinked conversation is an explicit unsafe source.
        if execution_link {
            assert!(result.unwrap().is_empty());
        } else {
            assert!(result.unwrap_err().to_string().contains("Unsafe"));
        }
    }
}
#[tokio::test]
async fn profiles_link_default_and_switched_exact_conversation_without_copying_private_instructions(
) {
    for profile in ["Default", "Profile 3"] {
        let root = tempfile::tempdir().unwrap();
        seed(root.path(), profile, CID).await;
        let graph = read_native_profile_graph(root.path().to_str().unwrap(), CID, false)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(graph.edges["s_nativeLeaf"].parent, "o_nativeOrg");
        assert!(!serde_json::to_string(&graph)
            .unwrap()
            .contains("SYNTHETIC_PRIVATE"));
    }
}
#[tokio::test]
async fn profiles_ignore_stale_default_and_refuse_cross_profile_ambiguity() {
    let root = tempfile::tempdir().unwrap();
    seed(root.path(), "Default", "99999").await;
    seed(root.path(), "Profile 3", CID).await;
    assert_eq!(
        read_native_profile_graph(root.path().to_str().unwrap(), CID, false)
            .await
            .unwrap()
            .unwrap()
            .main,
        "m_nativeMain"
    );
    assert!(
        read_native_profile_graph(root.path().to_str().unwrap(), "missing", false)
            .await
            .unwrap()
            .is_none()
    );
    seed(root.path(), "Default", CID).await;
    assert!(
        read_native_profile_graph(root.path().to_str().unwrap(), CID, false)
            .await
            .unwrap()
            .is_none()
    );
}
#[tokio::test]
async fn profiles_ignore_arbitrary_folders_and_reject_unsafe_conversation() {
    let root = tempfile::tempdir().unwrap();
    seed(root.path(), "unrelated", CID).await;
    assert!(
        read_native_profile_graph(root.path().to_str().unwrap(), CID, false)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        read_native_profile_graph(root.path().to_str().unwrap(), "../12345", false)
            .await
            .unwrap()
            .is_none()
    );
}
#[tokio::test]
async fn profile_count_limit_is_enforced_before_conversation_body_reads() {
    let root = tempfile::tempdir().unwrap();
    seed(root.path(), "Default", CID).await;
    for i in 0..16 {
        tokio::fs::create_dir(root.path().join(format!("Profile {i}")))
            .await
            .unwrap();
    }
    assert!(
        read_native_profile_graph(root.path().to_str().unwrap(), CID, false)
            .await
            .unwrap()
            .is_none()
    );
}
#[cfg(unix)]
#[tokio::test]
async fn profile_symlink_is_rejected_instead_of_reusing_the_default() {
    let root = tempfile::tempdir().unwrap();
    seed(root.path(), "Default", CID).await;
    std::os::unix::fs::symlink(root.path().join("Default"), root.path().join("Profile 3")).unwrap();
    assert!(
        read_native_profile_graph(root.path().to_str().unwrap(), CID, false)
            .await
            .unwrap()
            .is_none()
    );
}
#[test]
fn platform_paths_preserve_windows_localappdata_fallback_mac_roots_and_unsupported_linux() {
    let windows = paths::resolve_doubao_work_paths_with(
        "win32",
        r"C:\Users\Synthetic 用户",
        Some(r"D:\Synthetic Local"),
    );
    assert_eq!(
        windows.user_data_root.as_deref(),
        Some(r"D:\Synthetic Local\DoubaoWork\User Data")
    );
    assert_eq!(
        windows.log_dir.as_deref(),
        Some(r"D:\Synthetic Local\DoubaoWork\User Data\sdk_storage\log")
    );
    assert_eq!(
        windows.snapshot_root.as_deref(),
        Some(r"D:\Synthetic Local\DoubaoWork\User Data\coding\snapshot")
    );
    for local in [None, Some("")] {
        assert_eq!(
            paths::resolve_doubao_work_paths_with("win32", r"C:\Users\Synthetic 用户", local)
                .user_data_root
                .as_deref(),
            Some(r"C:\Users\Synthetic 用户\AppData\Local\DoubaoWork\User Data")
        );
    }
    let mac =
        paths::resolve_doubao_work_paths_with("darwin", "/Users/Synthetic 用户", Some("ignored"));
    assert_eq!(
        mac.user_data_root.as_deref(),
        Some("/Users/Synthetic 用户/Library/Application Support/DoubaoWork")
    );
    assert_eq!(
        mac.log_dir.as_deref(),
        Some("/Users/Synthetic 用户/Library/Application Support/DoubaoWork/sdk_storage/log")
    );
    assert_eq!(
        paths::resolve_doubao_work_paths_with("linux", "/home/synthetic", Some("ignored")),
        paths::DoubaoWorkPaths::default()
    );
}
#[test]
fn lexical_path_normalization_preserves_windows_unc_and_rooted_unicode() {
    let roots = IndexMap::from([
        (
            r"\\server\share\Chinese 用户",
            r"\\server\share\Chinese 用户\DoubaoWork\User Data",
        ),
        (
            r"D:\Synthetic Local\..\真实",
            r"D:\真实\DoubaoWork\User Data",
        ),
    ]);
    for (base, expected) in roots {
        assert_eq!(
            paths::resolve_doubao_work_paths_with("win32", "ignored", Some(base))
                .user_data_root
                .as_deref(),
            Some(expected)
        );
    }
}
