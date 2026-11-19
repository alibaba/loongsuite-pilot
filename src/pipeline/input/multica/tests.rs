use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex as SyncMutex;

use crate::flushers::{SendError, SlsHttpRequest, SlsHttpResponse};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;

fn mock_config() -> Destination {
    Destination {
        endpoint: "https://example.invalid".into(),
        project: "p".into(),
        logstore: "multica-logs".into(),
        api_key: None,
    }
}

fn pipeline(input: Input, dir: &Path) -> MulticaPipeline {
    MulticaPipeline::new(Options {
        name: "multica-test",
        input,
        destination: mock_config(),
        state_dir: dir,
        mode: CollectionMode::Off,
        enabled: true,
        prefix: "synthetic-env",
        activation_path: None,
        daemon_profile: None,
    })
    .unwrap()
}

#[test]
fn multica_resolves_destination_without_borrowing_credentials_from_another_project() {
    let specific =
        json!({"Type":"flusher_sls","Endpoint":"us-west-1.log.aliyuncs.com","Project":"dedicated"});
    let selected = config::resolve_destination(Some(&specific), None).unwrap();
    assert_eq!(selected.endpoint, "https://us-west-1.log.aliyuncs.com");
    assert_eq!(selected.project, "dedicated");
    assert_eq!(selected.logstore, "multica-logs");
    assert!(selected.api_key.is_none());
    assert!(config::resolve_destination(
        Some(&json!({"Type":"flusher_sls","Project":"missing-endpoint"})),
        None
    )
    .is_err());
    let invalid = json!({"Type":"flusher_sls","Endpoint":"https://dedicated.us-west-1.log.aliyuncs.com","Project":"dedicated"});
    assert!(config::resolve_destination(Some(&invalid), None).is_err());
    let bad_source: Input =
        serde_json::from_value(json!({"PprofBaseUrl":"http://localhost:9090/metrics"})).unwrap();
    assert!(bad_source.validate().is_err());
}

#[tokio::test]
async fn multica_activation_checks_fingerprint_and_latches_after_consecutive_misses() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for body in [
            "multica_requests_total 1\n",
            "go_goroutines 2\n",
            "go_goroutines 3\n",
        ] {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") && request.len() < 4096 {
                request.push(stream.read_u8().await.unwrap());
            }
            let request = String::from_utf8(request).unwrap().to_ascii_lowercase();
            assert!(request.starts_with("get /metrics "));
            assert!(!request.contains("authorization:"));
            assert!(!request.contains("x-workspace-id:"));
            let response = format!(
                "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });
    let input = Input {
        metrics_urls: vec![format!("http://{addr}/metrics")],
        detection_failure_threshold: Some(2),
        token_file: Some(PathBuf::from("multica-test-missing-token")),
        ..Default::default()
    };
    let client = source_http::client().unwrap();
    let mut detector = Gate::new(&input);
    assert!(
        !detector
            .evaluate(&client, &input, CollectionMode::Off, true)
            .await
            .enabled
    );
    assert!(
        detector
            .evaluate(&client, &input, CollectionMode::On, true)
            .await
            .enabled
    );
    let first_miss = detector
        .evaluate(&client, &input, CollectionMode::On, true)
        .await;
    assert!(first_miss.enabled);
    assert_eq!(first_miss.consecutive_misses, 1);
    let stopped = detector
        .evaluate(&client, &input, CollectionMode::On, true)
        .await;
    assert!(!stopped.enabled);
    assert!(stopped.stopped);
    assert_eq!(
        detector
            .evaluate(&client, &input, CollectionMode::On, true)
            .await
            .reason,
        "detection_stopped"
    );
    server.await.unwrap();
}

#[derive(Default)]
struct MockDestination {
    accepts: AtomicBool,
    requests: SyncMutex<Vec<Value>>,
}

#[async_trait::async_trait]
impl SlsHttp for MockDestination {
    async fn post(&self, request: SlsHttpRequest) -> Result<SlsHttpResponse, SendError> {
        self.requests
            .lock()
            .unwrap()
            .push(serde_json::from_slice(&request.body).unwrap());
        Ok(SlsHttpResponse {
            status: if self.accepts.load(Ordering::Relaxed) {
                204
            } else {
                401
            },
            body: String::new(),
        })
    }
}

#[tokio::test]
async fn multica_replays_same_pending_records_and_advances_progress_only_after_ack() {
    let dir = tempfile::tempdir().unwrap();
    let destination = Arc::new(MockDestination::default());
    let mut first = pipeline(Input::default(), dir.path());
    first.sender = destination.clone();
    first.prepare_spool().await.unwrap();

    let source = "log:synthetic";
    let observed = Utc::now().timestamp_millis();
    let labels = record([("pod_uid", "synthetic-pod")]);
    let checkpoint = Checkpoint::next_profile(observed + 1000);
    let rejected = first
        .deliver_source(source, observed, &labels, async {
            Ok(SourceResult {
                records: vec![record([("record_type", "synthetic")])],
                checkpoint: Some(checkpoint),
                truncated: false,
            })
        })
        .await;
    assert!(rejected.is_err());
    let pending = first.spool.join(format!("{}.json", digest(source)));
    assert!(pending.is_file());
    assert_eq!(first.checkpoint(source).pprof_next_capture_at_ms, 0);
    drop(first);

    let mut restart = pipeline(Input::default(), dir.path());
    restart.sender = destination.clone();
    restart.state.load().await;
    destination.accepts.store(true, Ordering::Relaxed);
    restart
        .deliver_source(source, observed + 2000, &Record::new(), async {
            panic!("pending batch must be replayed before reading source")
        })
        .await
        .unwrap();
    assert!(!pending.exists());
    assert_eq!(
        restart.checkpoint(source).pprof_next_capture_at_ms,
        observed + 1000
    );
    let transactions = destination.requests.lock().unwrap();
    assert_eq!(transactions.len(), 2);
    assert_eq!(transactions[0], transactions[1]);
    assert!(transactions[0]["__logs__"][0]["event_id"]
        .as_str()
        .is_some_and(|id| id.len() == 64));
}

#[test]
fn multica_sanitizes_logs_and_attributes_without_collapsing_distinct_metric_series() {
    let metrics = records::prometheus("multica_requests{path=\"/api/x?token=secret\",private=\"one\"} 1\nmultica_requests{path=\"/api/x?token=secret\",private=\"two\"} 2\n");
    assert_eq!(metrics.len(), 2);
    assert_ne!(metrics[0]["entity_id"], metrics[1]["entity_id"]);
    let labels: Value = serde_json::from_str(&metrics[0]["metric_labels"]).unwrap();
    assert_eq!(labels, json!({"path":"/api/x"}));

    let input = "2026-11-17T03:42:50Z stdout F {\"msg\":\"task failed: Bearer synthetic-secret\",\"level\":\"error\",\"request_body\":\"classified sample\",\"error\":{\"message\":\"timeout\", \"accessToken\":\"another-secret\"},\"path\":\"/api/x?token=secret\"}";
    let parsed = sources::parse_log(input).unwrap();
    assert_eq!(parsed["message"], "task failed");
    assert_eq!(parsed["path"], "/api/x");
    let exported = serde_json::to_string(&parsed).unwrap();
    assert!(!exported.contains("classified sample"));
    assert!(!exported.contains("synthetic-secret"));
    assert!(!exported.contains("another-secret"));
    assert!(exported.contains("[REDACTED]"));
}

#[test]
fn multica_pod_labels_distinguish_local_and_service_metrics() {
    let input = Input {
        pod_uid: Some("test-pod-uid".into()),
        pod_ip: Some("10.0.0.42".into()),
        ..Default::default()
    };
    let local = pod_labels(&input, "metrics:http://127.0.0.1:9090/metrics");
    let remote = pod_labels(&input, "metrics:http://multica-backend:9090/metrics");
    assert_eq!(local["pod_uid"], "test-pod-uid");
    assert!(!remote.contains_key("pod_uid"));
    assert_eq!(remote["collector_pod_uid"], "test-pod-uid");
    let local = envelope(&input, "metrics:http://example", 1, Record::new(), &local);
    let remote = envelope(&input, "metrics:http://example", 1, Record::new(), &remote);
    assert_ne!(local["snapshot_id"], remote["snapshot_id"]);
    assert_ne!(local["event_id"], remote["event_id"]);
}
