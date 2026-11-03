use super::*;

#[tokio::test]
async fn main_config_l7_concurrent_edit_is_rejected_and_no_temporary_file_remains() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("config.json");
    tokio::fs::write(&file, "{\"original\":true}")
        .await
        .unwrap();
    let snapshot = Snapshot::read(&file).await.unwrap();
    tokio::fs::write(&file, "{\"userEdit\":true}")
        .await
        .unwrap();
    let error = snapshot.write("{\"pilot\":true}").await.unwrap_err();
    assert!(error.to_string().contains("file changed"), "{error}");
    assert_eq!(
        tokio::fs::read_to_string(&file).await.unwrap(),
        "{\"userEdit\":true}"
    );
    let files = std::fs::read_dir(root.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    assert_eq!(files, vec![std::ffi::OsString::from("config.json")]);
}
