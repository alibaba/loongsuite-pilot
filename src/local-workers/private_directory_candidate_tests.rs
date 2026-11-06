//! Real Native child contracts for the private Windows ACL execution boundary.
use super::*;
use crate::utils::candidate_process::{tests as native_fixture, CandidateChild};
use std::path::Path;
use std::process::Stdio;
use std::time::Instant;

const FIXTURE: &str =
    "local_workers::private_directory::candidate_tests::native_acl_boundary_fixture";

fn fixture(root: &Path, mode: &str) -> std::process::Command {
    let inherited = native_fixture::fixture(root, "leaf");
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", FIXTURE, "--nocapture"])
        .env_clear()
        .env("PILOT_ACL_BOUNDARY_ROOT", root)
        .env("PILOT_ACL_BOUNDARY_MODE", mode)
        .current_dir(root)
        .stdin(Stdio::null());
    for (key, value) in inherited.get_envs() {
        if let Some(value) = value {
            command.env(key, value);
        }
    }
    command
}

async fn within_original_budget(future: impl std::future::Future<Output = ()>) {
    tokio::time::timeout(Duration::from_secs(15), future)
        .await
        .expect("original fifteen-second worker budget");
}

#[test]
fn native_acl_boundary_fixture() {
    let Some(root) = std::env::var_os("PILOT_ACL_BOUNDARY_ROOT") else {
        return;
    };
    let root = Path::new(&root);
    let mode = std::env::var("PILOT_ACL_BOUNDARY_MODE").unwrap();
    match mode.as_str() {
        "success" => println!("ACL_NATIVE_SUCCESS"),
        "failure" => {
            eprintln!("ACL_NATIVE_FAILURE");
            std::process::exit(7);
        }
        "empty-failure" => std::process::exit(7),
        "stdout-excess" | "stderr-excess" => {
            use std::io::Write;
            let bytes = vec![b'x'; WINDOWS_ACL_OUTPUT_LIMIT + 1];
            if mode == "stdout-excess" {
                let _ = std::io::stdout().write_all(&bytes);
            } else {
                let _ = std::io::stderr().write_all(&bytes);
            }
        }
        "wait" | "sentinel" => {
            std::fs::write(root.join("acl-parent.pid"), std::process::id().to_string()).unwrap();
            let mut command = native_fixture::fixture(root, "leaf");
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
            }
            let mut leaf = command.spawn().unwrap();
            // The fixture is finite even if a future regression reintroduces
            // blocking std::process::Command::output and ignores the deadline.
            if mode == "sentinel" {
                loop {
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
            std::thread::sleep(Duration::from_secs(4));
            let _ = leaf.kill();
            let _ = leaf.wait();
        }
        _ => panic!("unknown private ACL fixture mode"),
    }
}

#[tokio::test]
async fn native_acl_candidate_preserves_success_rejection_and_bounded_stderr() {
    within_original_budget(async {
        for mode in [
            "success",
            "failure",
            "empty-failure",
            "stdout-excess",
            "stderr-excess",
        ] {
            let root = tempfile::tempdir().unwrap();
            let mut command = tokio::process::Command::from(fixture(root.path(), mode));
            let result = execute_windows_acl_command(
                &mut command,
                Duration::from_millis(WINDOWS_ACL_COMMAND_TIMEOUT_MS),
            )
            .await;
            if mode == "success" {
                result.unwrap();
            } else {
                let error = result.unwrap_err();
                assert!(error.starts_with("LocalWorkerDirectoryAclUnsafe: "));
                match mode {
                    "failure" => assert!(error.ends_with("ACL_NATIVE_FAILURE")),
                    "empty-failure" => assert_eq!(
                        error,
                        "LocalWorkerDirectoryAclUnsafe: failed to verify Windows directory ACL"
                    ),
                    _ => assert!(
                        error.len() < 512,
                        "oversized output must not enter the diagnostic"
                    ),
                }
            }
        }
    })
    .await;
}

#[tokio::test]
async fn native_acl_candidate_timeout_advances_the_runtime_and_reaps_the_owned_tree() {
    within_original_budget(async {
        let root = tempfile::tempdir().unwrap();
        let mut command = tokio::process::Command::from(fixture(root.path(), "wait"));
        let start = Instant::now();
        let run = async {
            let result = execute_windows_acl_command(&mut command, Duration::from_secs(2)).await;
            (result, start.elapsed())
        };
        let canary = async {
            tokio::time::sleep(Duration::from_millis(25)).await;
            start.elapsed()
        };
        let ((result, returned), ticked) = tokio::join!(run, canary);
        let error = result.unwrap_err();
        assert!(error.starts_with("LocalWorkerDirectoryAclUnsafe: "));
        assert!(
            ticked < returned,
            "the Tokio timer did not advance while the ACL child was running"
        );
        assert!(
            returned < Duration::from_secs(4),
            "the child finished naturally instead of the two-second injected deadline"
        );
        let leaf = native_fixture::ready(root.path()).await;
        native_fixture::stopped(leaf).await;
        let parent = std::fs::read_to_string(root.path().join("acl-parent.pid"))
            .unwrap()
            .parse()
            .unwrap();
        native_fixture::stopped(parent).await;
    })
    .await;
}

#[tokio::test]
async fn native_acl_candidate_cancellation_reaps_only_its_owned_tree() {
    within_original_budget(async {
        let unrelated = tempfile::tempdir().unwrap();
        let mut sentinel =
            CandidateChild::spawn(&mut fixture(unrelated.path(), "sentinel")).unwrap();
        let sentinel_leaf = native_fixture::ready(unrelated.path()).await;
        let root = tempfile::tempdir().unwrap();
        let mut command = tokio::process::Command::from(fixture(root.path(), "wait"));
        let task = tokio::spawn(async move {
            execute_windows_acl_command(
                &mut command,
                Duration::from_millis(WINDOWS_ACL_COMMAND_TIMEOUT_MS),
            )
            .await
        });
        let leaf = native_fixture::ready(root.path()).await;
        let parent = std::fs::read_to_string(root.path().join("acl-parent.pid"))
            .unwrap()
            .parse()
            .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        native_fixture::stopped(leaf).await;
        native_fixture::stopped(parent).await;
        assert!(
            sentinel.try_wait().unwrap().is_none(),
            "an unrelated candidate was terminated"
        );
        drop(sentinel);
        native_fixture::stopped(sentinel_leaf).await;
    })
    .await;
}
