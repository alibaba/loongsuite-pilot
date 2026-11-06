use super::super::http::{BoxFut, HttpHandler, HttpReply, HTTP_HANDLER};
use super::super::uploader::sls_client::{
    SlsResult, PRESIGN_ORIGIN_MISMATCH_ERROR, SLS_HTTP_STORAGE_PROBE_KEY,
};
use super::super::uploader::sls_uploader::{BackingAuthInput, SlsUploader};
use super::*;
use crate::types::{MultimodalAkAuth, MultimodalCredentialAuth, MultimodalSlsTarget};
use base64::Engine;
use std::sync::atomic::{AtomicI64, AtomicUsize};

const ORIGIN_A: &str = "https://bucket-a.oss-cn-hangzhou.aliyuncs.com";
const ORIGIN_B: &str = "https://bucket-b.oss-cn-hangzhou.aliyuncs.com";
const BASE_A: &str = "oss://bucket-a/proj/logstore";
const BASE_B: &str = "oss://bucket-b/proj/logstore";
type Resolver = Arc<dyn Fn() -> BoxFut<StorageBaseResult> + Send + Sync>;
#[derive(Clone, Debug)]
struct Put {
    origin: Option<String>,
    body: Vec<u8>,
    key: String,
}
fn uploader(origin: Option<&str>) -> Arc<SlsUploader> {
    Arc::new(
        SlsUploader::new(
            MultimodalSlsTarget {
                endpoint: "https://cn-hangzhou.log.aliyuncs.com".into(),
                project: "proj".into(),
                logstore: "logstore".into(),
            },
            BackingAuthInput::Delegated(MultimodalCredentialAuth::Ak(MultimodalAkAuth {
                access_key_id: "synthetic-ak".into(),
                access_key_secret: "synthetic-sk".into(),
                security_token: None,
            })),
            "sls://proj/logstore",
            origin.map(str::to_owned),
        )
        .unwrap(),
    )
}
fn blob(text: &str) -> BlobToUriParams {
    BlobToUriParams {
        content: base64::engine::general_purpose::STANDARD.encode(text),
        mime_type: Some("image/png".into()),
        modality: Some("image".into()),
        time_unix_ms: None,
        reuse_key: None,
    }
}
fn reply(ok: bool) -> SlsResult {
    SlsResult {
        ok,
        status_code: Some(if ok { 200 } else { 409 }),
        request_id: Some("unit-request".into()),
        error: (!ok).then(|| PRESIGN_ORIGIN_MISMATCH_ERROR.into()),
        retryable: Some(false),
        url: None,
    }
}
fn resolver(u: &Arc<SlsUploader>) -> Resolver {
    let u = u.clone();
    Arc::new(move || {
        let u = u.clone();
        Box::pin(async move { u.discover_delegated_oss_bucket().await })
    })
}
fn discovery(calls: Arc<AtomicUsize>, fail_first: bool) -> HttpHandler {
    Arc::new(move |call| {
        let attempt = calls.fetch_add(1, Ordering::SeqCst);
        assert!(call.url.ends_with("/presign"));
        assert_eq!(call.method, "POST");
        let input: serde_json::Value = serde_json::from_slice(&call.body).unwrap();
        assert_eq!(input["method"], "PUT");
        assert_eq!(input["key"], SLS_HTTP_STORAGE_PROBE_KEY);
        Box::pin(async move {
            Ok(HttpReply{status:if fail_first&&attempt==0{403}else{200},headers:vec![],
                body:serde_json::to_vec(&json!({"url":format!("{ORIGIN_B}/proj/logstore/{}?signature=fixture",input["key"].as_str().unwrap())})).unwrap(),error:None})
        })
    })
}
fn writes(u: &Arc<SlsUploader>, puts: &Arc<Mutex<Vec<Put>>>) {
    let puts = puts.clone();
    u.set_write_override(Arc::new(move |params, delegated| {
        assert!(delegated);
        puts.lock().unwrap().push(Put {
            origin: params.expected_origin,
            body: params.body,
            key: params.object_key,
        });
        Box::pin(async { reply(true) })
    }));
}
async fn eventually(check: impl Fn() -> bool) {
    let started = std::time::Instant::now();
    while !check() {
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "delegated transition did not finish"
        );
        tokio::task::yield_now().await;
    }
}
async fn advance(ms: u64) {
    tokio::time::advance(Duration::from_millis(ms)).await;
    tokio::task::yield_now().await;
}
async fn settled(p: &Arc<MultimodalProcessor>) {
    eventually(|| p.inner.lock().unwrap().pending_bytes == 0).await;
}
#[tokio::test(start_paused = true)]
async fn cold_delegated_sls_presign_failure_retries_then_pins_the_discovered_origin_on_upload() {
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    HTTP_HANDLER
        .scope(discovery(calls, true), async move {
            let u = uploader(None);
            let puts = Arc::new(Mutex::new(Vec::new()));
            writes(&u, &puts);
            let p = MultimodalProcessor::new(None, u.clone(), Some(resolver(&u))).unwrap();
            assert_eq!(observed.load(Ordering::SeqCst), 0);
            assert!(p.blob_to_uri(blob("cold")).is_none());
            advance(999).await;
            assert_eq!(observed.load(Ordering::SeqCst), 0);
            advance(1).await;
            eventually(|| p.inner.lock().unwrap().sniff_failure_count == 2).await;
            assert_eq!(observed.load(Ordering::SeqCst), 1);
            assert!(p.blob_to_uri(blob("cold")).is_none());
            advance(1999).await;
            assert_eq!(observed.load(Ordering::SeqCst), 1);
            advance(1).await;
            eventually(|| p.storage_base_path().as_deref() == Some(BASE_B)).await;
            assert_eq!(observed.load(Ordering::SeqCst), 2);
            assert!(p
                .blob_to_uri(blob("png"))
                .unwrap()
                .uri
                .starts_with(&format!("{BASE_B}/")));
            settled(&p).await;
            let entries = puts.lock().unwrap().clone();
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].origin.as_deref(), Some(ORIGIN_B));
            assert_eq!(entries[0].body, b"png");
            assert!(entries[0].key.ends_with(".png"));
            advance(60_000).await;
            assert_eq!(observed.load(Ordering::SeqCst), 2);
            p.shutdown(1000).await;
        })
        .await;
}
#[tokio::test(start_paused = true)]
async fn an_injected_storage_error_uses_the_result_error_channel_then_real_sls_rediscovery_recovers(
) {
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    HTTP_HANDLER
        .scope(discovery(calls, false), async move {
            let u = uploader(None);
            let puts = Arc::new(Mutex::new(Vec::new()));
            writes(&u, &puts);
            let attempts = Arc::new(AtomicUsize::new(0));
            let count = attempts.clone();
            let real = resolver(&u);
            let injected: Resolver = Arc::new(move || {
                if count.fetch_add(1, Ordering::SeqCst) == 0 {
                    Box::pin(async {
                        StorageBaseResult::Err {
                            error: "resolver failed".into(),
                        }
                    })
                } else {
                    real()
                }
            });
            let p = MultimodalProcessor::new(None, u.clone(), Some(injected)).unwrap();
            advance(1000).await;
            eventually(|| p.inner.lock().unwrap().sniff_failure_count == 2).await;
            assert_eq!(attempts.load(Ordering::SeqCst), 1);
            assert_eq!(observed.load(Ordering::SeqCst), 0);
            advance(2000).await;
            eventually(|| p.storage_base_path().as_deref() == Some(BASE_B)).await;
            assert_eq!(attempts.load(Ordering::SeqCst), 2);
            assert_eq!(observed.load(Ordering::SeqCst), 1);
            assert!(p.blob_to_uri(blob("png")).unwrap().uri.starts_with(BASE_B));
            settled(&p).await;
            assert_eq!(puts.lock().unwrap()[0].origin.as_deref(), Some(ORIGIN_B));
            p.shutdown(1000).await;
        })
        .await;
}
async fn origin_mismatch_scenario(backward_wall: bool) {
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    HTTP_HANDLER
        .scope(discovery(calls, false), async move {
            let u = uploader(Some(ORIGIN_A));
            let puts = Arc::new(Mutex::new(Vec::<Put>::new()));
            let attempts = Arc::new(AtomicUsize::new(0));
            let mismatches = Arc::new(AtomicBool::new(false));
            let (w, c, m) = (puts.clone(), attempts.clone(), mismatches.clone());
            u.set_write_override(Arc::new(move |params, delegated| {
                assert!(delegated);
                let n = c.fetch_add(1, Ordering::SeqCst);
                w.lock().unwrap().push(Put {
                    origin: params.expected_origin,
                    body: params.body,
                    key: params.object_key,
                });
                let ok = n != 1 && !m.load(Ordering::SeqCst);
                Box::pin(async move { reply(ok) })
            }));
            let mut p =
                MultimodalProcessor::new(Some(BASE_A), u.clone(), Some(resolver(&u))).unwrap();
            let initial = chrono::DateTime::parse_from_rfc3339("2026-01-02T00:10:00Z")
                .unwrap()
                .timestamp_millis();
            let earlier = chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
                .unwrap()
                .timestamp_millis();
            let wall = Arc::new(AtomicI64::new(initial));
            let clock = wall.clone();
            Arc::get_mut(&mut p).unwrap().test_wall_now = Some(Arc::new(move || {
                chrono::DateTime::from_timestamp_millis(clock.load(Ordering::SeqCst))
                    .unwrap()
                    .with_timezone(&chrono::Local)
            }));
            let one = p.blob_to_uri(blob("one")).unwrap();
            assert!(one.uri.starts_with(BASE_A));
            settled(&p).await;
            assert_eq!(observed.load(Ordering::SeqCst), 0);
            assert_eq!(puts.lock().unwrap()[0].origin.as_deref(), Some(ORIGIN_A));
            assert!(p.blob_to_uri(blob("two")).unwrap().uri.starts_with(BASE_A));
            settled(&p).await;
            assert!(p.storage_base_path().is_none());
            assert!(p.blob_to_uri(blob("pending")).is_none());
            advance(999).await;
            assert_eq!(observed.load(Ordering::SeqCst), 0);
            advance(1).await;
            eventually(|| p.storage_base_path().as_deref() == Some(BASE_B)).await;
            let learned = p.blob_to_uri(blob("one")).unwrap();
            assert!(learned.uri.starts_with(BASE_B));
            settled(&p).await;
            assert_eq!(
                puts.lock().unwrap().len(),
                3,
                "changed real SlsUploader origin must clear its successful object cache"
            );
            assert_eq!(puts.lock().unwrap()[2].origin.as_deref(), Some(ORIGIN_B));
            if backward_wall {
                wall.store(earlier, Ordering::SeqCst);
            }
            mismatches.store(true, Ordering::SeqCst);
            let four = p.blob_to_uri(blob("four")).unwrap();
            assert!(four.uri.starts_with(BASE_B));
            settled(&p).await;
            if backward_wall {
                let before = learned
                    .uri
                    .strip_prefix(&format!("{BASE_B}/"))
                    .unwrap()
                    .split('/')
                    .next()
                    .unwrap();
                let after = four
                    .uri
                    .strip_prefix(&format!("{BASE_B}/"))
                    .unwrap()
                    .split('/')
                    .next()
                    .unwrap();
                assert_ne!(
                    before, after,
                    "the injected backward wall clock must actually change default event day"
                );
            }
            assert_eq!(observed.load(Ordering::SeqCst), 1);
            assert!(p.storage_base_path().is_some());
            advance(58_999).await;
            assert_eq!(p.started.elapsed().as_millis(), 59_999);
            assert!(p.blob_to_uri(blob("five")).unwrap().uri.starts_with(BASE_B));
            settled(&p).await;
            assert!(p
                .blob_to_uri(blob("still-cooling"))
                .unwrap()
                .uri
                .starts_with(BASE_B));
            settled(&p).await;
            assert_eq!(observed.load(Ordering::SeqCst), 1);
            assert!(p.storage_base_path().is_some());
            advance(1).await;
            assert_eq!(p.started.elapsed().as_millis(), 60_000);
            assert!(p.blob_to_uri(blob("six")).unwrap().uri.starts_with(BASE_B));
            settled(&p).await;
            assert!(p.blob_to_uri(blob("pending-again")).is_none());
            advance(999).await;
            assert_eq!(observed.load(Ordering::SeqCst), 1);
            advance(1).await;
            eventually(|| observed.load(Ordering::SeqCst) == 2 && p.storage_base_path().is_some())
                .await;
            assert!(puts
                .lock()
                .unwrap()
                .iter()
                .skip(2)
                .all(|put| put.origin.as_deref() == Some(ORIGIN_B)));
            p.shutdown(1000).await;
        })
        .await;
}
#[tokio::test(start_paused = true)]
async fn delegated_origin_mismatch_relearns_the_bucket_and_enforces_the_exact_monotonic_cooldown() {
    origin_mismatch_scenario(false).await;
}
#[tokio::test(start_paused = true)]
async fn delegated_origin_cooldown_survives_an_observable_backward_wall_clock_jump() {
    origin_mismatch_scenario(true).await;
}
