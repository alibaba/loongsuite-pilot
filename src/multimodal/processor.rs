//! Convert blob bytes or a local media path into a storage URI and enqueue upload.

use std::collections::HashMap;
use std::future::{poll_fn, Future};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::Poll;
use std::time::Duration;
use tokio::time::Instant;

use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

use crate::utils::create_logger;

use super::http::log_meta;
use super::resolve::{
    decode_blob_content, ext_from_mime, is_real_path_inside_roots, join_storage_uri,
    lstat_regular_file, modality_from_mime, normalize_local_media_path,
    open_normalized_local_media_scoped, yyyymmdd_from_unix_ms,
};
use super::types::{
    BlobPart, BlobToUriParams, PathToUriOptions, StorageBaseResult, UploadItem, UploadOptions,
    Uploader, UriConvertMeta, UriResult, MAX_MULTIMODAL_BASE64_CHARS, MAX_MULTIMODAL_DATA_SIZE,
    MAX_MULTIMODAL_PARTS, MAX_MULTIMODAL_PATH_INFLIGHT, MAX_MULTIMODAL_PENDING_BYTES,
    MAX_MULTIMODAL_PENDING_UPLOADS, MULTIMODAL_SHUTDOWN_TIMEOUT_MS, PATH_TO_URI_DEADLINE_MS,
};
use super::uploader::lru_set::{LruMap, MULTIMODAL_LRU_LIMIT};

const DELEGATED_OSS_RETRY_BASE_MS: u64 = 1_000;
const DELEGATED_OSS_RETRY_MAX_MS: u64 = 60_000;
const DELEGATED_OSS_MISMATCH_REDISCOVERY_INTERVAL_MS: u128 = 60_000;

fn logger() -> crate::utils::BoundLogger {
    create_logger("MultimodalProcessor")
}

/// Convert at most ten distinct paths, counting failed attempts toward the cap.
pub async fn convert_paths_to_uri_parts<F, Fut>(
    paths: &[String],
    callback: &F,
    time: i64,
) -> Vec<serde_json::Value>
where
    F: Fn(String, i64) -> Fut + Sync + ?Sized,
    Fut: Future<Output = Result<Option<UriResult>, String>> + Send,
{
    let mut parts = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for path in paths {
        let path = path.trim();
        if path.is_empty() || seen.contains(path) {
            continue;
        }
        if seen.len() >= MAX_MULTIMODAL_PARTS {
            break;
        }
        seen.insert(path.to_owned());
        let work = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            callback(path.to_owned(), time)
        }));
        let result = match work {
            Ok(work) => {
                let mut work = Box::pin(work);
                poll_fn(move |cx| {
                    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        work.as_mut().poll(cx)
                    })) {
                        Ok(value) => value,
                        Err(_) => Poll::Ready(Err("multimodal callback panicked".into())),
                    }
                })
                .await
            }
            Err(_) => Err("multimodal callback panicked".into()),
        };
        match result {
            Ok(Some(result)) => {
                let mut part = json!({
                    "type": "uri",
                    "uri": result.uri,
                    "mime_type": result.mime_type,
                });
                if let Some(modality) = result.modality {
                    part["modality"] = json!(modality);
                }
                parts.push(part);
            }
            Ok(None) => {}
            Err(error) => logger().warn(
                "multimodal pathToUri failed; skipping path",
                Some(&log_meta(&[("path", json!(path)), ("error", json!(error))])),
            ),
        }
    }
    parts
}

pub async fn with_deadline<T: Send>(
    work: impl std::future::Future<Output = T> + Send,
    deadline_ms: i64,
    on_timeout: impl FnOnce() -> T,
) -> T {
    if deadline_ms <= 0 {
        return work.await;
    }
    tokio::select! {
        value = work => value,
        _ = tokio::time::sleep(Duration::from_millis(deadline_ms as u64)) => on_timeout(),
    }
}

#[derive(Clone)]
struct PathCacheEntry {
    mtime_ms: f64,
    size: u64,
    result: Option<UriResult>,
}

#[cfg(test)]
type PathIoHook = Arc<dyn Fn(&str) -> super::http::BoxFut<()> + Send + Sync>;

struct PendingUpload {
    target_path: String,
    done: oneshot::Receiver<()>,
}

struct AbortPathOnDrop(Arc<AtomicBool>);
impl Drop for AbortPathOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

/// Owns one coalesced read slot. Dropping the outer future must release both
/// capacity and waiters, including deadline/caller cancellation and unwinding.
struct PathReadLease {
    processor: Arc<MultimodalProcessor>,
    key: String,
    completed: bool,
}
impl PathReadLease {
    fn finish(&mut self, result: Option<UriResult>) {
        if self.completed {
            return;
        }
        self.completed = true;
        let waiters = self
            .processor
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .path_waiters
            .remove(&self.key)
            .unwrap_or_default();
        for waiter in waiters {
            let _ = waiter.send(result.clone());
        }
    }
}
impl Drop for PathReadLease {
    fn drop(&mut self) {
        self.finish(None);
    }
}

/// Always settle the accepted upload's accounting, including task unwind.
struct UploadLease {
    processor: Arc<MultimodalProcessor>,
    key: String,
    size: usize,
    done: Option<oneshot::Sender<()>>,
}
impl Drop for UploadLease {
    fn drop(&mut self) {
        {
            let mut inner = self
                .processor
                .inner
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if inner.pending_keys.remove(&self.key) {
                inner.pending_bytes = inner.pending_bytes.saturating_sub(self.size);
            }
            inner
                .pending
                .retain(|pending| pending.target_path != self.key);
        }
        if let Some(done) = self.done.take() {
            let _ = done.send(());
        }
    }
}
struct SniffLease {
    processor: Arc<MultimodalProcessor>,
    active: bool,
}
impl Drop for SniffLease {
    fn drop(&mut self) {
        if self.active {
            self.processor
                .inner
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .sniff_pending = false;
        }
    }
}

pub struct MultimodalProcessor {
    inner: Mutex<Inner>,
    uploader: Arc<dyn Uploader>,
    resolve_storage_base:
        Option<Arc<dyn Fn() -> super::http::BoxFut<StorageBaseResult> + Send + Sync>>,
    started: Instant,
    pending_bytes_limit: usize,
    path_inflight_limit: usize,
    io_slots: Arc<tokio::sync::Semaphore>,
    shutdown_changed: tokio::sync::Notify,
    #[cfg(test)]
    before_stat: Option<PathIoHook>,
    #[cfg(test)]
    before_read: Option<PathIoHook>,
    #[cfg(test)]
    before_upload_admission: Option<Arc<dyn Fn() + Send + Sync>>,
    #[cfg(test)]
    test_wall_now: Option<Arc<dyn Fn() -> chrono::DateTime<chrono::Local> + Send + Sync>>,
}

struct Inner {
    storage_base_path: String,
    pending: Vec<PendingUpload>,
    pending_keys: std::collections::HashSet<String>,
    pending_bytes: usize,
    shutting_down: bool,
    sniff_pending: bool,
    sniff_failure_count: u32,
    last_mismatch_at: Option<u128>,
    path_uri_cache: LruMap<PathCacheEntry>,
    path_waiters: HashMap<String, Vec<oneshot::Sender<Option<UriResult>>>>,
}

impl MultimodalProcessor {
    pub fn new(
        storage_base_path: Option<&str>,
        uploader: Arc<dyn Uploader>,
        resolve_storage_base: Option<
            Arc<dyn Fn() -> super::http::BoxFut<StorageBaseResult> + Send + Sync>,
        >,
    ) -> Result<Arc<Self>, String> {
        let base = storage_base_path
            .unwrap_or("")
            .trim()
            .trim_end_matches('/')
            .to_string();
        if base.is_empty() && resolve_storage_base.is_none() {
            return Err("multimodal storageBasePath is required".to_string());
        }
        let processor = Arc::new(Self {
            inner: Mutex::new(Inner {
                storage_base_path: base.clone(),
                pending: Vec::new(),
                pending_keys: std::collections::HashSet::new(),
                pending_bytes: 0,
                shutting_down: false,
                sniff_pending: false,
                sniff_failure_count: 0,
                last_mismatch_at: None,
                path_uri_cache: LruMap::new(MULTIMODAL_LRU_LIMIT).expect("lru"),
                path_waiters: HashMap::new(),
            }),
            uploader,
            resolve_storage_base,
            started: Instant::now(),
            pending_bytes_limit: MAX_MULTIMODAL_PENDING_BYTES,
            path_inflight_limit: MAX_MULTIMODAL_PATH_INFLIGHT,
            io_slots: Arc::new(tokio::sync::Semaphore::new(MAX_MULTIMODAL_PATH_INFLIGHT)),
            shutdown_changed: tokio::sync::Notify::new(),
            #[cfg(test)]
            before_stat: None,
            #[cfg(test)]
            before_read: None,
            #[cfg(test)]
            before_upload_admission: None,
            #[cfg(test)]
            test_wall_now: None,
        });
        if base.is_empty() {
            processor.schedule_sniff();
        }
        Ok(processor)
    }

    /// The currently usable storage origin. Delegated discovery can leave
    /// the processor waiting without a usable origin until a later retry.
    pub fn storage_base_path(&self) -> Option<String> {
        let base = self.inner.lock().unwrap().storage_base_path.clone();
        (!base.is_empty()).then_some(base)
    }

    #[cfg(test)]
    pub fn with_limits(mut self, pending_bytes: usize, path_inflight: usize) -> Self {
        self.pending_bytes_limit = pending_bytes;
        self.path_inflight_limit = path_inflight;
        self.io_slots = Arc::new(tokio::sync::Semaphore::new(path_inflight));
        self
    }

    pub fn blob_to_uri(self: &Arc<Self>, params: BlobToUriParams) -> Option<UriResult> {
        if self.inner.lock().unwrap().storage_base_path.is_empty() {
            return None;
        }
        if self.inner.lock().unwrap().shutting_down {
            logger().warn(
                "multimodal blob rejected",
                Some(&log_meta(&[("reason", json!("shutting_down"))])),
            );
            return None;
        }
        if params.content.is_empty() || params.content.len() > MAX_MULTIMODAL_BASE64_CHARS {
            logger().warn(
                "multimodal blob rejected",
                Some(&log_meta(&[(
                    "reason",
                    json!(if params.content.is_empty() {
                        "decode_failed"
                    } else {
                        "size_limit"
                    }),
                )])),
            );
            return None;
        }
        let decoded = decode_blob_content(&BlobPart {
            content: params.content.clone(),
            mime_type: params.mime_type.clone(),
            modality: params.modality.clone(),
        });
        let Some(bytes) = decoded else {
            logger().warn(
                "multimodal blob rejected",
                Some(&log_meta(&[("reason", json!("decode_failed"))])),
            );
            return None;
        };
        self.bytes_to_uri(
            bytes,
            UriConvertMeta {
                mime_type: params.mime_type,
                modality: params.modality,
                time_unix_ms: params.time_unix_ms,
            },
        )
    }

    pub async fn path_to_uri(
        self: &Arc<Self>,
        file_path: &str,
        time_unix_ms: Option<f64>,
        opts: PathToUriOptions,
    ) -> Option<UriResult> {
        if self.inner.lock().unwrap().storage_base_path.is_empty() {
            return None;
        }
        if self.inner.lock().unwrap().shutting_down {
            logger().warn(
                "multimodal pathToUri rejected",
                Some(&log_meta(&[("reason", json!("shutting_down"))])),
            );
            return None;
        }
        let deadline = opts.deadline_ms.unwrap_or(PATH_TO_URI_DEADLINE_MS as i64);
        let flag = Arc::new(AtomicBool::new(false));
        let _abort_on_drop = AbortPathOnDrop(flag.clone());
        let flag2 = Arc::clone(&flag);
        let this = Arc::clone(self);
        let file_path = file_path.to_string();
        let logged_path = file_path.clone();
        let work = async move {
            this.convert_path(&file_path, time_unix_ms, &opts, &flag2)
                .await
        };
        with_deadline(work, deadline, || {
            flag.store(true, Ordering::SeqCst);
            logger().warn(
                "multimodal pathToUri timed out",
                Some(&log_meta(&[
                    ("path", json!(logged_path)),
                    ("deadlineMs", json!(deadline)),
                ])),
            );
            None
        })
        .await
    }

    async fn convert_path(
        self: &Arc<Self>,
        file_path: &str,
        time_unix_ms: Option<f64>,
        opts: &PathToUriOptions,
        signal: &Arc<AtomicBool>,
    ) -> Option<UriResult> {
        let key = normalize_local_media_path(file_path)?;
        let roots: Vec<String> = opts
            .allowed_root_paths
            .clone()
            .unwrap_or_default()
            .into_iter()
            .map(|root| root.trim().to_string())
            .filter(|root| !root.is_empty())
            .collect();
        if roots.is_empty() {
            logger().warn(
                "multimodal pathToUri rejected",
                Some(&log_meta(&[
                    ("reason", json!("no_allowed_roots")),
                    ("path", json!(key)),
                ])),
            );
            return None;
        }
        #[cfg(test)]
        if let Some(hook) = &self.before_stat {
            hook(&key).await;
        }
        let stated = lstat_regular_file(&key, Some(signal)).await;
        let Some(stated) = stated else {
            if !signal.load(Ordering::SeqCst) {
                logger().warn(
                    "multimodal file read failed",
                    Some(&log_meta(&[("path", json!(key))])),
                );
            }
            return None;
        };
        // Authorization belongs to each call, including cache and inflight
        // hits. A permitted owner cannot confer its roots on another waiter.
        if !is_real_path_inside_roots(&key, &roots, Some(signal)).await {
            return None;
        }
        let day = yyyymmdd_from_unix_ms(time_unix_ms, self.wall_now());
        let cache_key = format!("{key}\0{day}");
        let cached = self
            .inner
            .lock()
            .unwrap()
            .path_uri_cache
            .get_copied(&cache_key);
        if let Some(cached) = cached {
            if cached.mtime_ms == stated.mtime_ms && cached.size == stated.size {
                return cached.result;
            }
        }
        let slot_key = format!("{key}\0{day}\0{}\0{}", stated.mtime_ms, stated.size);
        let (tx, rx) = oneshot::channel();
        let mut tx = Some(tx);
        let joined = {
            let mut inner = self.inner.lock().unwrap();
            if let Some(waiters) = inner.path_waiters.get_mut(&slot_key) {
                waiters.push(tx.take().expect("sender"));
                Some(true)
            } else if inner.path_waiters.len() >= self.path_inflight_limit {
                logger().warn(
                    "multimodal pathToUri rejected",
                    Some(&log_meta(&[
                        ("reason", json!("path_inflight_full")),
                        ("path", json!(key)),
                    ])),
                );
                Some(false)
            } else {
                inner.path_waiters.insert(slot_key.clone(), Vec::new());
                None
            }
        };
        match joined {
            Some(true) => return rx.await.ok().flatten(),
            Some(false) => return None,
            None => {}
        }
        let mut lease = PathReadLease {
            processor: self.clone(),
            key: slot_key,
            completed: false,
        };
        let result = self
            .read_path(&key, &cache_key, time_unix_ms, &roots, &stated, signal)
            .await;
        lease.finish(result.clone());
        let _ = tx;
        result
    }

    async fn read_path(
        self: &Arc<Self>,
        key: &str,
        cache_key: &str,
        time_unix_ms: Option<f64>,
        roots: &[String],
        stated: &super::resolve::ListedFile,
        signal: &Arc<AtomicBool>,
    ) -> Option<UriResult> {
        #[cfg(test)]
        if let Some(hook) = &self.before_read {
            hook(key).await;
        }
        let loaded = open_normalized_local_media_scoped(
            key,
            MAX_MULTIMODAL_DATA_SIZE,
            Some(roots),
            Some(signal),
            self.io_slots.clone(),
        )
        .await;
        if loaded.is_none() || signal.load(Ordering::SeqCst) {
            if loaded.is_none() && !signal.load(Ordering::SeqCst) {
                logger().warn(
                    "multimodal file read failed",
                    Some(&log_meta(&[("path", json!(key))])),
                );
            }
            return None;
        }
        let loaded = loaded.unwrap();
        if let Some(cached) = self
            .inner
            .lock()
            .unwrap()
            .path_uri_cache
            .get_copied(cache_key)
        {
            if cached.mtime_ms == loaded.mtime_ms && cached.size == loaded.size as u64 {
                return cached.result;
            }
        }
        let modality = modality_from_mime(&loaded.mime_type).map(str::to_owned);
        let result = self.bytes_to_uri(
            loaded.bytes,
            UriConvertMeta {
                mime_type: Some(loaded.mime_type),
                modality,
                time_unix_ms: time_unix_ms.filter(|ms| ms.is_finite() && *ms > 0.0),
            },
        );
        if result.is_some() {
            self.inner.lock().unwrap().path_uri_cache.set(
                cache_key.to_string(),
                PathCacheEntry {
                    mtime_ms: loaded.mtime_ms,
                    size: loaded.size as u64,
                    result: result.clone(),
                },
            );
        }
        let _ = stated;
        result
    }

    fn bytes_to_uri(self: &Arc<Self>, bytes: Vec<u8>, meta: UriConvertMeta) -> Option<UriResult> {
        if self.inner.lock().unwrap().shutting_down {
            return None;
        }
        if bytes.is_empty() || bytes.len() > MAX_MULTIMODAL_DATA_SIZE {
            return None;
        }
        let mime = meta
            .mime_type
            .clone()
            .unwrap_or_else(|| "application/octet-stream".into());
        let sha = hex::encode(Sha256::digest(&bytes));
        let day = yyyymmdd_from_unix_ms(meta.time_unix_ms, self.wall_now());
        let target_path = format!("{day}/{sha}.{}", ext_from_mime(&mime));
        #[cfg(test)]
        if let Some(hook) = &self.before_upload_admission {
            hook();
        }
        let (result, uploaded_key, done) = {
            let mut inner = self.inner.lock().unwrap();
            // Hashing and file IO can overlap shutdown or origin invalidation.
            // Admission and the storage URI snapshot must share this lock.
            if inner.shutting_down || inner.storage_base_path.is_empty() {
                return None;
            }
            let result = UriResult {
                uri: join_storage_uri(&inner.storage_base_path, &target_path),
                mime_type: mime.clone(),
                modality: meta.modality.clone().filter(|value| !value.is_empty()),
                size: bytes.len(),
                sha256: sha,
            };
            let key = format!("{}\0{target_path}", inner.storage_base_path);
            if inner.pending_keys.contains(&key)
                || inner.pending.len() >= MAX_MULTIMODAL_PENDING_UPLOADS
                || (self.pending_bytes_limit > 0
                    && bytes.len() > self.pending_bytes_limit.saturating_sub(inner.pending_bytes))
            {
                return Some(result);
            }
            let (tx, rx) = oneshot::channel();
            inner.pending_keys.insert(key.clone());
            inner.pending_bytes += bytes.len();
            inner.pending.push(PendingUpload {
                target_path: key.clone(),
                done: rx,
            });
            (result, key, tx)
        };
        let uploader = Arc::clone(&self.uploader);
        let this = Arc::clone(self);
        let item = UploadItem {
            target_path: target_path.clone(),
            content_type: mime.clone(),
            meta: HashMap::from([("mime_type".into(), mime)]),
            data: Some(bytes),
            source_uri: None,
            expected_size: result.size,
        };
        let lease = UploadLease {
            processor: this.clone(),
            key: uploaded_key,
            size: result.size,
            done: Some(done),
        };
        super::http::spawn_with_http_context(async move {
            let _lease = lease;
            let _ = uploader
                .upload(
                    item,
                    UploadOptions {
                        skip_if_exists: None,
                        on_storage_base_invalidated: Some(Arc::new({
                            let this = Arc::clone(&this);
                            move || this.note_origin_mismatch()
                        })),
                    },
                )
                .await;
        });
        Some(result)
    }

    /// Once accepted, close owns its drain even if the calling future is cancelled.
    pub async fn shutdown(self: &Arc<Self>, timeout_ms: u64) {
        let pending: Vec<_> = {
            let mut inner = self.inner.lock().unwrap();
            if inner.shutting_down {
                return;
            }
            inner.shutting_down = true;
            inner.sniff_pending = false;
            inner.path_uri_cache.clear();
            inner.path_waiters.clear();
            inner
                .pending
                .drain(..)
                .map(|pending| pending.done)
                .collect()
        };
        self.shutdown_changed.notify_waiters();
        let timeout = if timeout_ms == 0 {
            MULTIMODAL_SHUTDOWN_TIMEOUT_MS
        } else {
            timeout_ms
        };
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout);
        let uploader = self.uploader.clone();
        let (done, closed) = oneshot::channel();
        super::http::spawn_with_http_context(async move {
            if !pending.is_empty() {
                tokio::select! {
                    _ = futures_join(pending) => {}
                    _ = tokio::time::sleep_until(deadline) => {}
                }
            }
            uploader.shutdown().await;
            let _ = done.send(());
        });
        let _ = closed.await;
    }

    async fn wait_for_shutdown(&self) {
        loop {
            let changed = self.shutdown_changed.notified();
            tokio::pin!(changed);
            let _ = changed.as_mut().enable();
            if self.inner.lock().unwrap().shutting_down {
                return;
            }
            changed.await;
        }
    }

    fn wall_now(&self) -> chrono::DateTime<chrono::Local> {
        #[cfg(test)]
        if let Some(now) = &self.test_wall_now {
            return now();
        }
        chrono::Local::now()
    }

    fn note_origin_mismatch(self: &Arc<Self>) {
        let mut inner = self.inner.lock().unwrap();
        if inner.shutting_down || self.resolve_storage_base.is_none() || inner.sniff_pending {
            return;
        }
        let now = self.started.elapsed().as_millis();
        if inner.last_mismatch_at.is_some_and(|previous| {
            now.saturating_sub(previous) < DELEGATED_OSS_MISMATCH_REDISCOVERY_INTERVAL_MS
        }) {
            return;
        }
        inner.last_mismatch_at = Some(now);
        inner.storage_base_path.clear();
        inner.path_uri_cache.clear();
        drop(inner);
        self.schedule_sniff();
    }

    fn schedule_sniff(self: &Arc<Self>) {
        let delay = {
            let mut inner = self.inner.lock().unwrap();
            if inner.shutting_down
                || self.resolve_storage_base.is_none()
                || inner.sniff_pending
                || !inner.storage_base_path.is_empty()
            {
                return;
            }
            let exponent = inner.sniff_failure_count.min(6);
            let delay = (DELEGATED_OSS_RETRY_BASE_MS.saturating_mul(1u64 << exponent))
                .min(DELEGATED_OSS_RETRY_MAX_MS);
            inner.sniff_failure_count += 1;
            inner.sniff_pending = true;
            delay
        };
        let this = Arc::clone(self);
        let deadline = tokio::time::Instant::now() + Duration::from_millis(delay);
        super::http::spawn_with_http_context(async move {
            tokio::select! {
                biased;
                _ = this.wait_for_shutdown() => return,
                _ = tokio::time::sleep_until(deadline) => {}
            }
            this.sniff().await;
        });
    }

    async fn sniff(self: &Arc<Self>) {
        let Some(resolve) = &self.resolve_storage_base else {
            return;
        };
        if self.inner.lock().unwrap().shutting_down {
            return;
        }
        let mut lease = SniffLease {
            processor: self.clone(),
            active: true,
        };
        let sniffed = tokio::select! {
            biased;
            _ = self.wait_for_shutdown() => return,
            result = resolve() => result,
        };
        let mut inner = self.inner.lock().unwrap();
        lease.active = false;
        inner.sniff_pending = false;
        if inner.shutting_down {
            return;
        }
        match sniffed {
            StorageBaseResult::Ok { storage_base_path } => {
                inner.storage_base_path = storage_base_path;
                inner.sniff_failure_count = 0;
            }
            StorageBaseResult::Err { error } => {
                logger().warn(
                    "delegatedOss storage sniff failed; retrying",
                    Some(&log_meta(&[("error", json!(error))])),
                );
                drop(inner);
                self.schedule_sniff();
            }
        }
    }
}

async fn futures_join(pending: Vec<oneshot::Receiver<()>>) {
    for receiver in pending {
        let _ = receiver.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    struct Fake {
        items: Mutex<Vec<UploadItem>>,
        fail_next: AtomicBool,
        throw_on_upload: AtomicBool,
        shutdown_calls: Mutex<u32>,
        closed: AtomicBool,
        hold: Mutex<Option<oneshot::Receiver<()>>>,
    }

    #[async_trait::async_trait]
    impl Uploader for Fake {
        async fn upload(&self, item: UploadItem, _opts: UploadOptions) -> bool {
            if self.closed.load(Ordering::SeqCst) {
                return false;
            }
            let hold = self.hold.lock().unwrap().take();
            if let Some(hold) = hold {
                let _ = hold.await;
            }
            if self.closed.load(Ordering::SeqCst) {
                return false;
            }
            if self.throw_on_upload.load(Ordering::SeqCst) {
                return false;
            }
            self.items.lock().unwrap().push(item.clone());
            if self.fail_next.swap(false, Ordering::SeqCst) {
                return false;
            }
            true
        }

        async fn shutdown(&self) {
            self.closed.store(true, Ordering::SeqCst);
            *self.shutdown_calls.lock().unwrap() += 1;
        }
    }

    fn fake() -> Arc<Fake> {
        Arc::new(Fake {
            items: Mutex::new(Vec::new()),
            fail_next: AtomicBool::new(false),
            throw_on_upload: AtomicBool::new(false),
            shutdown_calls: Mutex::new(0),
            closed: AtomicBool::new(false),
            hold: Mutex::new(None),
        })
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[tokio::test]
    async fn with_deadline_and_blob_uri() {
        assert_eq!(with_deadline(async { 7 }, 1_000, || 0).await, 7);
        assert_eq!(
            with_deadline(std::future::pending::<i32>(), 10, || 5).await,
            5
        );
        assert_eq!(with_deadline(async { 9 }, 0, || 1).await, 9);

        let uploader = fake();
        let processor = MultimodalProcessor::new(
            Some("oss://bucket/pilot-mm"),
            uploader.clone() as Arc<dyn Uploader>,
            None,
        )
        .unwrap();
        let bytes = b"png-bytes";
        let result = processor
            .blob_to_uri(BlobToUriParams {
                content: b64(bytes),
                mime_type: Some("image/png".into()),
                modality: Some("image".into()),
                time_unix_ms: Some(1_700_000_000_000.0),
                reuse_key: None,
            })
            .unwrap();
        assert!(result.uri.contains("/pilot-mm/"));
        assert!(result.uri.ends_with(".png"));
        assert_eq!(result.sha256, hex::encode(Sha256::digest(bytes)));
        processor.shutdown(1_000).await;
        assert_eq!(uploader.items.lock().unwrap().len(), 1);
        assert!(MultimodalProcessor::new(Some("  "), fake(), None).is_err());
    }

    #[tokio::test]
    async fn rejects_empty_overlong_and_shutdown() {
        let uploader = fake();
        let processor = MultimodalProcessor::new(
            Some("oss://bucket/pilot-mm"),
            uploader.clone() as Arc<dyn Uploader>,
            None,
        )
        .unwrap();
        assert!(processor
            .blob_to_uri(BlobToUriParams {
                content: String::new(),
                mime_type: Some("image/png".into()),
                modality: None,
                time_unix_ms: None,
                reuse_key: None
            })
            .is_none());
        assert!(processor
            .blob_to_uri(BlobToUriParams {
                content: "!!!!".into(),
                mime_type: Some("image/png".into()),
                modality: None,
                time_unix_ms: None,
                reuse_key: None
            })
            .is_none());
        processor.shutdown(100).await;
        processor.shutdown(100).await;
        assert_eq!(*uploader.shutdown_calls.lock().unwrap(), 1);
        assert!(processor
            .blob_to_uri(BlobToUriParams {
                content: b64(b"late"),
                mime_type: Some("image/png".into()),
                modality: None,
                time_unix_ms: None,
                reuse_key: None
            })
            .is_none());
    }
}

#[cfg(test)]
#[path = "processor_contract_tests.rs"]
mod migration_contract_tests;

#[cfg(test)]
#[path = "processor_lifecycle_tests.rs"]
mod migration_lifecycle_tests;

#[cfg(test)]
#[path = "processor_delegated_tests.rs"]
mod migration_delegated_tests;
