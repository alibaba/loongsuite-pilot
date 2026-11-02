// Original sender8 missing boundary assertions; same transport-mock boundary.
#[test]
fn history_original_sixty_four_thousand_capacity_rejects_the_next_line() {
    let sink=Arc::new(RecordingSink::default());let (sender,_root)=sender(sink);
    let lines=(0..64_000).map(|index|format!("line{index}")).collect::<Vec<_>>();
    assert!(sender.enqueue(&lines,"/tmp/test.log"));
    assert_eq!(sender.buffer_size(),64_000);
    assert!(!sender.enqueue(&["overflow_line".into()],"/tmp/test.log"));
    assert_eq!(sender.buffer_size(),64_000);
}
#[test]
fn history_original_thirty_two_thousand_high_watermark_sets_backpressure() {
    let sink=Arc::new(RecordingSink::default());let (sender,_root)=sender(sink);
    assert!(!sender.is_backpressured());
    let lines=(0..32_000).map(|index|format!("line{index}")).collect::<Vec<_>>();
    assert!(sender.enqueue(&lines,"/tmp/test.log"));
    assert!(sender.is_backpressured());
}
struct RealFailureMetadata;
#[async_trait::async_trait]
impl crate::pipeline::sls_transport::SlsSink for RealFailureMetadata {
    async fn post_webtracking(
        &self,_config:&crate::pipeline::sls_transport::SlsTransportConfig,
        _logs:Vec<std::collections::HashMap<String,String>>,
        _opts:crate::pipeline::sls_transport::PostOptions,
    )->Result<(),String> {Err("controlled network error".into())}
    async fn persist_failed(&self,dir:&str,name:&str,context:crate::pipeline::sls_transport::FailContext,error:String) {
        crate::pipeline::sls_transport::persist_failed_logs(dir,name,&context,&error).await;
    }
}
#[tokio::test]
async fn history_real_failure_metadata_never_persists_the_raw_log_batch() {
    let root=tempfile::tempdir().unwrap();let failed=root.path().join("failed");
    let sender=FileSlsSender::new(&PipelineSlsFlusherConfig{
        endpoint:"cn-hangzhou.log.aliyuncs.com".into(),project:"test-project".into(),logstore:"test-logstore".into(),
        region:None,aliuid:None,telemetry_type:None,
    },"test-config",failed.to_str().unwrap(),root.path().join("data").to_str().unwrap(),Some(Arc::new(RealFailureMetadata)));
    let secret="private-log-must-not-enter-failure-metadata";
    assert!(sender.enqueue(&[secret.into()],"/synthetic/input.log"));sender.flush().await;
    let files=std::fs::read_dir(failed).unwrap().map(|entry|entry.unwrap().path()).collect::<Vec<_>>();
    assert_eq!(files.len(),1);
    let text=std::fs::read_to_string(&files[0]).unwrap();
    assert!(!text.contains(secret));assert!(!text.contains("__logs__"));
    let row:serde_json::Value=serde_json::from_str(text.trim()).unwrap();
    assert_eq!(row["mode"],"webtracking");assert_eq!(row["project"],"test-project");
    assert_eq!(row["logstore"],"test-logstore");assert_eq!(row["kind"],"test-config");
    assert_eq!(row["batch_count"],1);assert!(row["batch_bytes"].as_u64().unwrap()>0);
}
