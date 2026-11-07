use crate::utils::source_access::{self, SourceScope};
use std::io::{ErrorKind, Read};
use std::path::Path;
use std::sync::Arc;

struct Installed;
impl Installed {
    fn new(scope: Arc<SourceScope>) -> Self {
        source_access::install(Some(scope));
        Self
    }
}
impl Drop for Installed {
    fn drop(&mut self) {
        source_access::install(None);
    }
}
fn scope(root: &Path, files: usize, bytes: usize) -> Arc<SourceScope> {
    SourceScope::new(vec![root.canonicalize().unwrap()], files, bytes)
}

#[test]
fn source_capability_checks_opened_files_and_component_boundaries() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let inside = root.join("authorized");
    let outside = root.join("authorized-foreign");
    std::fs::create_dir(&inside).unwrap();
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(inside.join("input"), "authorized").unwrap();
    std::fs::write(outside.join("input"), "private").unwrap();
    let _guard = Installed::new(scope(&inside, 8, 4096));
    let mut bytes = String::new();
    source_access::open(inside.join("input"))
        .unwrap()
        .read_to_string(&mut bytes)
        .unwrap();
    assert_eq!(bytes, "authorized");
    assert_eq!(
        source_access::open(outside.join("input"))
            .unwrap_err()
            .kind(),
        ErrorKind::PermissionDenied
    );
    assert!(source_access::read_dir(&outside).is_err());
}

#[cfg(unix)]
#[test]
fn source_symlinks_and_owned_state_symlinks_are_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let data = root.join("data");
    let foreign = root.join("foreign");
    std::fs::create_dir(&data).unwrap();
    std::fs::write(&foreign, "private").unwrap();
    std::os::unix::fs::symlink(&foreign, data.join("input")).unwrap();
    let _guard = Installed::new(scope(&data, 8, 4096));
    assert!(source_access::open(data.join("input")).is_err());
    assert!(source_access::private_path(&data.join("input")).is_err());
    assert_eq!(std::fs::read_to_string(foreign).unwrap(), "private");
}

#[tokio::test]
async fn source_read_and_file_budgets_pause_without_silent_truncation() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    std::fs::write(root.join("one"), "0123456789").unwrap();
    std::fs::write(root.join("two"), "another").unwrap();
    let source = scope(&root, 1, 4);
    let _guard = Installed::new(source.clone());
    assert_eq!(
        source_access::read(root.join("one"))
            .await
            .unwrap_err()
            .kind(),
        ErrorKind::WouldBlock
    );
    assert_eq!(
        source_access::open(root.join("two")).unwrap_err().kind(),
        ErrorKind::WouldBlock
    );
    source.reset();
    assert!(source_access::open(root.join("two")).is_ok());
}
