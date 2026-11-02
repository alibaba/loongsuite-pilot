//! Source contracts through actual filesystem IO and owned sampler lifecycle.
use super::*;
use std::sync::atomic::AtomicUsize;

#[tokio::test]
async fn source_l444_actual_directory_reads_stop_at_the_entry_budget() {
    let root = tempfile::tempdir().unwrap();
    for (name, size) in [("one", 1), ("two", 2), ("three", 3)] {
        std::fs::write(root.path().join(name), vec![b'x'; size]).unwrap();
    }
    let sampler = Arc::new(DiskUsageSampler::new(
        DiskUsageSamplerOptions {
            max_entries: 2,
            batch_pause_ms: 0,
            ..DiskUsageSamplerOptions::new(root.path().to_string_lossy())
        },
        Arc::new(|_| {}),
    ));
    sampler.sample().await;
    let snapshot = sampler.get_snapshot();
    assert_eq!(snapshot.status, DiskUsageStatus::Partial);
    assert_eq!(snapshot.data_bytes, None);
    assert_eq!(sampler.test_read_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn real_periodic_stop_restart_drains_cancelled_cycle_and_samples_again() {
    let root = tempfile::tempdir().unwrap();
    for name in ["one", "two", "three"] {
        std::fs::write(root.path().join(name), b"x").unwrap();
    }
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);
    let sampler = Arc::new(DiskUsageSampler::new(
        DiskUsageSamplerOptions {
            initial_delay_ms: 0,
            interval_ms: 10,
            batch_size: 1,
            batch_pause_ms: 20,
            budget_ms: 1000,
            ..DiskUsageSamplerOptions::new(root.path().to_string_lossy())
        },
        Arc::new(move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
        }),
    ));
    sampler.start();
    tokio::time::timeout(Duration::from_secs(1), async {
        while !sampler.state.lock().unwrap().in_flight {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    sampler.stop();
    sampler.start();
    let result = tokio::time::timeout(Duration::from_secs(1), async {
        while calls.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await;
    sampler.stop();
    assert!(
        result.is_ok(),
        "ordinary public stop/start left sampler permanently in_flight"
    );
    assert_eq!(sampler.get_snapshot().status, DiskUsageStatus::Ok);
    assert_eq!(sampler.get_snapshot().data_bytes, Some(3));
}

// The original source uses controlled filesystem metadata/Dir adapters. This
// adapter drives the same native walker, with ordinary IO Results and no fake snapshots.
use async_trait::async_trait;
use fs_io::{Directory, FileSystem, Kind, Node};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::future::Future;
use std::io;
use std::pin::Pin;

type Hook = Arc<
    dyn Fn(&'static str, PathBuf) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send>>
        + Send
        + Sync,
>;
#[derive(Clone, Debug)]
struct Opened {
    path: PathBuf,
    reads: usize,
    closed: bool,
}
struct TreeState {
    nodes: HashMap<PathBuf, Node>,
    names: HashMap<PathBuf, Vec<OsString>>,
    opened: Vec<Opened>,
    calls: Vec<(&'static str, PathBuf)>,
    active: usize,
    max_active: usize,
    handles: usize,
    max_handles: usize,
    next_identity: u64,
    realpaths: HashMap<PathBuf, PathBuf>,
}
struct Tree {
    root: PathBuf,
    state: Mutex<TreeState>,
    hook: Mutex<Option<Hook>>,
}
struct Operation {
    tree: Arc<Tree>,
}
impl Drop for Operation {
    fn drop(&mut self) {
        self.tree.state.lock().unwrap().active -= 1;
    }
}
impl Tree {
    fn new() -> Arc<Self> {
        let root = if cfg!(windows) {
            PathBuf::from(r"C:\pilot-disk-sampler-fixture")
        } else {
            PathBuf::from("/pilot-disk-sampler-fixture")
        };
        let mut nodes = HashMap::new();
        nodes.insert(
            root.clone(),
            Node {
                kind: Kind::Directory,
                bytes: 0,
                identity: (1, 1),
            },
        );
        let mut names = HashMap::new();
        names.insert(root.clone(), Vec::new());
        Arc::new(Self {
            root,
            state: Mutex::new(TreeState {
                nodes,
                names,
                opened: Vec::new(),
                calls: Vec::new(),
                active: 0,
                max_active: 0,
                handles: 0,
                max_handles: 0,
                next_identity: 2,
                realpaths: HashMap::new(),
            }),
            hook: Mutex::new(None),
        })
    }
    fn add_dir(&self, relative: &str) {
        let path = self.root.join(relative);
        let mut lineage = Vec::new();
        let mut next = path.as_path();
        while next != self.root {
            lineage.push(next.to_owned());
            next = next.parent().unwrap();
        }
        let mut state = self.state.lock().unwrap();
        for path in lineage.into_iter().rev() {
            if state.nodes.contains_key(&path) {
                continue;
            }
            let identity = state.next_identity;
            state.next_identity += 1;
            state.nodes.insert(
                path.clone(),
                Node {
                    kind: Kind::Directory,
                    bytes: 0,
                    identity: (1, identity),
                },
            );
            state.names.entry(path.clone()).or_default();
            let siblings = state
                .names
                .entry(path.parent().unwrap().to_owned())
                .or_default();
            let name = path.file_name().unwrap().to_owned();
            if !siblings.contains(&name) {
                siblings.push(name);
            }
        }
    }
    fn add(&self, relative: &str, bytes: u64) {
        let path = self.root.join(relative);
        let parent = path
            .parent()
            .unwrap()
            .strip_prefix(&self.root)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        self.add_dir(&parent);
        let mut state = self.state.lock().unwrap();
        let id = state.next_identity;
        state.next_identity += 1;
        state.nodes.insert(
            path.clone(),
            Node {
                kind: Kind::File,
                bytes,
                identity: (1, id),
            },
        );
        let names = state
            .names
            .entry(path.parent().unwrap().to_owned())
            .or_default();
        let name = path.file_name().unwrap().to_owned();
        if !names.contains(&name) {
            names.push(name);
        }
    }
    fn link(&self, relative: &str) {
        let path = self.root.join(relative);
        self.state
            .lock()
            .unwrap()
            .nodes
            .get_mut(&path)
            .unwrap()
            .kind = Kind::Link;
    }
    fn hook<F, Fut>(&self, hook: F)
    where
        F: Fn(&'static str, PathBuf) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = io::Result<()>> + Send + 'static,
    {
        *self.hook.lock().unwrap() = Some(Arc::new(move |operation, path| {
            Box::pin(hook(operation, path))
        }));
    }
    fn clear_hook(&self) {
        *self.hook.lock().unwrap() = None;
    }
    async fn before(self: &Arc<Self>, op: &'static str, path: &Path) -> io::Result<Operation> {
        {
            let mut state = self.state.lock().unwrap();
            state.calls.push((op, path.to_owned()));
            state.active += 1;
            state.max_active = state.max_active.max(state.active);
        }
        let guard = Operation {
            tree: Arc::clone(self),
        };
        let hook = self.hook.lock().unwrap().clone();
        if let Some(hook) = hook {
            hook(op, path.to_owned()).await?;
        }
        Ok(guard)
    }
    fn opened(&self) -> Vec<Opened> {
        self.state.lock().unwrap().opened.clone()
    }
    fn all_closed(&self) -> bool {
        self.opened().iter().all(|frame| frame.closed)
    }
    fn max_active(&self) -> usize {
        self.state.lock().unwrap().max_active
    }
    fn calls(&self) -> Vec<(&'static str, PathBuf)> {
        self.state.lock().unwrap().calls.clone()
    }
}
#[derive(Clone)]
struct ReplayFs(Arc<Tree>);
#[async_trait]
impl FileSystem for ReplayFs {
    async fn realpath(&self, path: &Path) -> io::Result<PathBuf> {
        let _op = self.0.before("realpath", path).await?;
        let state = self.0.state.lock().unwrap();
        if !state.nodes.contains_key(path) {
            return Err(io::ErrorKind::NotFound.into());
        }
        Ok(state
            .realpaths
            .get(path)
            .cloned()
            .unwrap_or_else(|| path.to_owned()))
    }
    async fn metadata(&self, path: &Path) -> io::Result<Node> {
        let _op = self.0.before("lstat", path).await?;
        let node = {
            let state = self.0.state.lock().unwrap();
            state.nodes.get(path).cloned()
        };
        node.ok_or_else(|| io::ErrorKind::NotFound.into())
    }
    async fn open(&self, path: &Path) -> io::Result<Box<dyn Directory>> {
        // Hold a real directory-object identity across the asynchronous open
        // boundary, just as the production native handle does.
        let node = self
            .0
            .state
            .lock()
            .unwrap()
            .nodes
            .get(path)
            .cloned()
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
        let _op = self.0.before("opendir", path).await?;
        let mut state = self.0.state.lock().unwrap();
        let names = state.names.get(path).cloned().unwrap_or_default();
        let index = state.opened.len();
        state.opened.push(Opened {
            path: path.to_owned(),
            reads: 0,
            closed: false,
        });
        state.handles += 1;
        state.max_handles = state.max_handles.max(state.handles);
        Ok(Box::new(ReplayDir {
            tree: Arc::clone(&self.0),
            path: path.to_owned(),
            identity: node.identity,
            index,
            names,
            cursor: 0,
            closed: false,
        }))
    }
}
struct ReplayDir {
    tree: Arc<Tree>,
    path: PathBuf,
    identity: (u64, u64),
    index: usize,
    names: Vec<OsString>,
    cursor: usize,
    closed: bool,
}
impl ReplayDir {
    fn release(&mut self) {
        if !self.closed {
            self.closed = true;
            let mut state = self.tree.state.lock().unwrap();
            state.opened[self.index].closed = true;
            state.handles -= 1;
        }
    }
}
impl Drop for ReplayDir {
    fn drop(&mut self) {
        self.release();
    }
}
#[async_trait]
impl Directory for ReplayDir {
    fn identity(&self) -> (u64, u64) {
        self.identity
    }
    async fn read(&mut self) -> io::Result<Option<OsString>> {
        let _op = self.tree.before("read", &self.path).await?;
        self.tree.state.lock().unwrap().opened[self.index].reads += 1;
        let name = self.names.get(self.cursor).cloned();
        self.cursor += usize::from(name.is_some());
        Ok(name)
    }
    async fn close(&mut self) -> io::Result<()> {
        let result = self.tree.before("close", &self.path).await;
        self.release();
        result.map(|_| ())
    }
}
struct V {
    tree: Arc<Tree>,
    sampler: Arc<DiskUsageSampler>,
    samples: Arc<Mutex<Vec<DiskUsageSnapshot>>>,
}
impl V {
    fn new(files: &[(&str, u64)], configure: impl FnOnce(&mut DiskUsageSamplerOptions)) -> Self {
        let tree = Tree::new();
        for (name, size) in files {
            tree.add(name, *size);
        }
        let samples = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&samples);
        let mut opts = DiskUsageSamplerOptions::new(tree.root.to_string_lossy());
        configure(&mut opts);
        let origin = Instant::now();
        let mut sampler = DiskUsageSampler::new(
            opts,
            Arc::new(move |snapshot| captured.lock().unwrap().push(snapshot)),
        );
        sampler.fs = Arc::new(ReplayFs(Arc::clone(&tree)));
        sampler.now_ms = Arc::new(move || 1_000_000 + origin.elapsed().as_millis() as i64);
        Self {
            tree,
            sampler: Arc::new(sampler),
            samples,
        }
    }
    fn simple(files: &[(&str, u64)]) -> Self {
        Self::new(files, |_| {})
    }
    fn count(&self) -> usize {
        self.samples.lock().unwrap().len()
    }
    fn snap(&self) -> DiskUsageSnapshot {
        self.sampler.get_snapshot()
    }
    fn assert_size(&self, status: DiskUsageStatus, data: u64, logs: u64) {
        let value = self.snap();
        assert_eq!(value.status, status);
        assert_eq!(value.data_bytes, Some(data));
        assert_eq!(value.logs_bytes, Some(logs));
    }
    fn spawn(&self) -> tokio::task::JoinHandle<()> {
        let sampler = Arc::clone(&self.sampler);
        tokio::spawn(async move {
            sampler.sample().await;
        })
    }
}
impl Drop for V {
    fn drop(&mut self) {
        self.sampler.stop();
        self.tree.clear_hook();
    }
}
async fn settle() {
    for _ in 0..12 {
        tokio::task::yield_now().await;
    }
}
async fn tick(ms: u64) {
    tokio::time::advance(Duration::from_millis(ms)).await;
    settle().await;
}

#[tokio::test(start_paused = true)]
async fn source_l132_pending_hidden_files_and_only_root_logs_are_counted_once() {
    let v = V::simple(&[
        (".hidden", 3),
        ("logs/output/a.jsonl", 7),
        ("local-workers/logs/b", 11),
    ]);
    assert_eq!(v.snap(), DiskUsageSnapshot::default());
    v.sampler.sample().await;
    v.assert_size(DiskUsageStatus::Ok, 21, 7);
    assert_eq!(v.snap().sampled_at, Some(1_000_000));
    assert_eq!(v.tree.max_active(), 1);
    assert!(v.tree.all_closed());
    assert_eq!(v.tree.opened()[0].path, v.tree.root);
    v.snap();
    v.snap();
    assert_eq!(v.count(), 1);
}

#[tokio::test(start_paused = true)]
async fn source_l147_mutable_root_allowlist_keeps_files_and_nested_managed_names() {
    let files = [
        ("ordinary", 3),
        ("Logs/output/event.jsonl", 5),
        ("state/checkpoint.json", 7),
        ("cache/versions/metadata.json", 11),
        ("configs/inner/data_config.json", 13),
        ("agents.d.local/custom.json", 17),
        ("acp-correlate/session.json", 19),
        ("sls-failed-logs/failed.jsonl", 23),
        ("sls-failed-logs.delete-pending/old.jsonl", 29),
        ("local-workers/lw_1/state/runtime/metadata.json", 31),
    ];
    let v = V::simple(&files);
    let excluded = [
        "versions",
        "runtime",
        "package",
        "download-tmp",
        "plugins",
        "hooks",
        "skills",
        "apps",
        "bin",
        "local-worker-template-cache",
        ".tmp",
        "tmp",
        "future-managed-directory",
    ];
    for (index, name) in excluded.iter().enumerate() {
        v.tree
            .add(&format!("{name}/nested/payload.bin"), 1000 + index as u64);
    }
    v.sampler.sample().await;
    v.assert_size(DiskUsageStatus::Ok, files.iter().map(|(_, s)| *s).sum(), 5);
    let opened = v.tree.opened();
    let calls = v.tree.calls();
    for name in excluded {
        let path = v.tree.root.join(name);
        assert!(!opened.iter().any(|frame| frame.path == path));
        assert!(!calls
            .iter()
            .any(|(_, p)| p != &path && p.starts_with(&path)));
    }
    for name in ["cache/versions", "local-workers/lw_1/state/runtime"] {
        assert!(opened
            .iter()
            .any(|frame| frame.path == v.tree.root.join(name)));
    }
}

#[tokio::test(start_paused = true)]
async fn source_l189_opened_directories_are_a_strict_subset_of_the_old_traversal() {
    let fixture = [
        ("logs/output/day", true),
        ("STATE/checkpoints/active", true),
        ("cache/nested/versions/runtime", true),
        ("versions/v1/node_modules", false),
        ("runtime/node/bin", false),
        ("download-tmp/extract/node_modules", false),
        ("package/node_modules/pkg", false),
        ("Versions/v2/node_modules", false),
        ("future-managed-directory/nested", false),
        ("local-workers/lw_1/bundle/node_modules/pkg", false),
        (
            "local-workers/lw_1/.BUNDLE.STAGING-123/node_modules/pkg",
            false,
        ),
        ("local-workers/lw_1/state/bundle/node_modules/pkg", true),
    ];
    let v = V::simple(&[]);
    for (path, _) in fixture {
        v.tree.add_dir(path);
    }
    v.sampler.sample().await;
    assert_eq!(v.snap().status, DiskUsageStatus::Ok);
    let actual: HashSet<_> = v
        .tree
        .opened()
        .into_iter()
        .map(|frame| frame.path)
        .collect();
    // Exact old oracle excludes only the two case-sensitive root names, and
    // intentionally contains no copy of the new mutable allowlist.
    let old: HashSet<_> = v
        .tree
        .state
        .lock()
        .unwrap()
        .nodes
        .iter()
        .filter(|(_, node)| node.kind == Kind::Directory)
        .filter(|(path, _)| {
            let relative = path.strip_prefix(&v.tree.root).unwrap();
            let first = relative.components().next().map(|part| part.as_os_str());
            first != Some(std::ffi::OsStr::new("versions"))
                && first != Some(std::ffi::OsStr::new("runtime"))
        })
        .map(|(path, _)| path.clone())
        .collect();
    assert!(actual.is_subset(&old));
    assert!(actual.len() < old.len());
    for (path, expected) in fixture {
        assert_eq!(actual.contains(&v.tree.root.join(path)), expected, "{path}");
    }
    for path in [
        "download-tmp",
        "Versions",
        "future-managed-directory",
        "local-workers/lw_1/bundle",
        "local-workers/lw_1/.BUNDLE.STAGING-123",
    ] {
        let path = v.tree.root.join(path);
        assert!(old.contains(&path));
        assert!(!actual.contains(&path));
    }
}

#[tokio::test(start_paused = true)]
async fn source_l250_worker_bundles_are_pruned_without_pruning_instance_mutable_data() {
    let v = V::simple(&[
        ("local-workers/lw_1/instance.json", 2),
        ("local-workers/lw_1/credentials/token.json", 3),
        ("local-workers/lw_1/state/checkpoint.json", 5),
        ("local-workers/lw_1/logs/worker.log", 7),
        ("local-workers/lw_1/state/bundle/metadata.json", 11),
        ("local-workers/lw_1/Bundle/node_modules/pkg/index.js", 101),
        (
            "local-workers/lw_1/.BUNDLE.STAGING-123/node_modules/pkg/index.js",
            103,
        ),
        (
            "local-workers/lw_1/.Bundle.Backup-456/node_modules/pkg/index.js",
            107,
        ),
        ("local-workers/arbitrary-instance/bundle/runtime.js", 109),
        ("local-workers/arbitrary-instance/state/metadata.json", 13),
    ]);
    v.sampler.sample().await;
    v.assert_size(DiskUsageStatus::Ok, 41, 0);
    let opened = v.tree.opened();
    let calls = v.tree.calls();
    for path in [
        "local-workers/lw_1/Bundle",
        "local-workers/lw_1/.BUNDLE.STAGING-123",
        "local-workers/lw_1/.Bundle.Backup-456",
        "local-workers/arbitrary-instance/bundle",
    ] {
        let path = v.tree.root.join(path);
        assert!(!opened.iter().any(|frame| frame.path == path));
        assert!(!calls
            .iter()
            .any(|(_, p)| p != &path && p.starts_with(&path)));
    }
    assert!(opened
        .iter()
        .any(|frame| frame.path == v.tree.root.join("local-workers/lw_1/state/bundle")));
}

#[tokio::test(start_paused = true)]
async fn source_l282_ten_thousand_worker_bundle_entries_do_not_consume_the_scan_budget() {
    let v = V::new(
        &[("local-workers/lw_large/state/checkpoint.json", 7)],
        |opts| opts.max_entries = 20,
    );
    for index in 0..10_000 {
        v.tree.add(
            &format!("local-workers/lw_large/bundle/node_modules/pkg-{index}/index.js"),
            1,
        );
    }
    v.sampler.sample().await;
    v.assert_size(DiskUsageStatus::Ok, 7, 0);
    assert!(!v
        .tree
        .opened()
        .iter()
        .any(|frame| frame.path == v.tree.root.join("local-workers/lw_large/bundle")));
    assert!(
        v.tree.calls().len() < 100,
        "actual metadata API calls {}",
        v.tree.calls().len()
    );
}

#[tokio::test(start_paused = true)]
async fn source_l299_empty_directory_is_zero_and_cached_snapshots_are_copies() {
    let v = V::simple(&[]);
    v.sampler.sample().await;
    v.assert_size(DiskUsageStatus::Ok, 0, 0);
    let mut copy = v.snap();
    copy.data_bytes = Some(999);
    assert_eq!(copy.data_bytes, Some(999));
    assert_eq!(v.snap().data_bytes, Some(0));
}

#[tokio::test(start_paused = true)]
async fn source_l309_links_and_post_readdir_link_substitutions_are_not_followed() {
    let v = V::simple(&[("ordinary", 5), ("cached-link", 99), ("new-link", 88)]);
    v.tree.add_dir("linked-directory");
    v.tree.link("cached-link");
    v.tree.link("linked-directory");
    let tree = Arc::clone(&v.tree);
    v.tree.hook(move |op, path| {
        let tree = Arc::clone(&tree);
        async move {
            if op == "lstat" && path == tree.root.join("new-link") {
                tree.link("new-link");
            }
            Ok(())
        }
    });
    v.sampler.sample().await;
    v.assert_size(DiskUsageStatus::Ok, 5, 0);
    assert_eq!(v.tree.opened().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn source_l324_link_replacement_during_open_is_closed_before_any_read() {
    let v = V::simple(&[("cache/child/a", 99)]);
    let tree = Arc::clone(&v.tree);
    v.tree.hook(move |op, path| {
        let tree = Arc::clone(&tree);
        async move {
            if op == "opendir" && path == tree.root.join("cache/child") {
                tree.link("cache/child");
            }
            Ok(())
        }
    });
    v.sampler.sample().await;
    assert_eq!(v.snap().status, DiskUsageStatus::Partial);
    assert_eq!(v.snap().data_bytes, None);
    assert_eq!(
        v.tree
            .opened()
            .iter()
            .find(|frame| frame.path == v.tree.root.join("cache/child"))
            .unwrap()
            .reads,
        0
    );
    assert!(v.tree.all_closed());
}

#[tokio::test(start_paused = true)]
async fn source_l338_outside_realpath_at_nested_boundary_is_rejected_before_open() {
    let v = V::simple(&[("cache/parent/child/a", 99)]);
    let child = v.tree.root.join("cache/parent/child");
    v.tree.state.lock().unwrap().realpaths.insert(
        child.clone(),
        v.tree.root.parent().unwrap().join("outside/child"),
    );
    v.sampler.sample().await;
    assert_eq!(v.snap().status, DiskUsageStatus::Partial);
    assert!(!v.tree.opened().iter().any(|frame| frame.path == child));
    assert!(v.tree.all_closed());
}

#[tokio::test(start_paused = true)]
async fn source_l351_vanished_unopened_children_are_skipped_without_spinning() {
    let v = V::simple(&[("vanished", 99), ("remaining", 7)]);
    v.tree.add_dir("deleted-directory");
    let tree = Arc::clone(&v.tree);
    v.tree.hook(move |op, path| {
        let tree = Arc::clone(&tree);
        async move {
            if op == "lstat"
                && (path == tree.root.join("vanished")
                    || path == tree.root.join("deleted-directory"))
            {
                tree.state.lock().unwrap().nodes.remove(&path);
            }
            Ok(())
        }
    });
    v.sampler.sample().await;
    v.assert_size(DiskUsageStatus::Ok, 7, 0);
    assert!(v.tree.all_closed());
    assert!(v.tree.calls().len() < 50);
}

fn fail_second_read(tree: &Arc<Tree>) -> Arc<AtomicUsize> {
    let reads = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&reads);
    tree.hook(move |op, _| {
        let count = Arc::clone(&count);
        async move {
            if op == "read" && count.fetch_add(1, Ordering::SeqCst) == 1 {
                return Err(io::ErrorKind::NotFound.into());
            }
            Ok(())
        }
    });
    reads
}
#[tokio::test(start_paused = true)]
async fn source_l366_read_enoent_on_existing_directory_is_partial_without_values() {
    let v = V::simple(&[("a", 7), ("b", 9)]);
    let reads = fail_second_read(&v.tree);
    v.sampler.sample().await;
    let value = v.snap();
    assert_eq!(value.status, DiskUsageStatus::Partial);
    assert!(value.scan_ms.is_some());
    assert_eq!(value.data_bytes, None);
    assert_eq!(value.logs_bytes, None);
    assert_eq!(value.sampled_at, None);
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    assert!(v
        .tree
        .state
        .lock()
        .unwrap()
        .nodes
        .contains_key(&v.tree.root));
    assert!(v.tree.all_closed());
}
#[tokio::test(start_paused = true)]
async fn source_l380_read_enoent_retains_full_cached_snapshot_and_reports_failure() {
    let v = V::simple(&[("a", 7), ("b", 9)]);
    v.sampler.sample().await;
    let good = v.snap();
    tick(100).await;
    let reads = fail_second_read(&v.tree);
    v.sampler.sample().await;
    v.assert_size(DiskUsageStatus::Partial, 16, 0);
    assert_eq!(v.snap().sampled_at, good.sampled_at);
    assert_eq!(v.count(), 2);
    assert_eq!(
        v.samples.lock().unwrap()[1].status,
        DiskUsageStatus::Partial
    );
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    assert!(v.tree.all_closed());
}

#[tokio::test(start_paused = true)]
async fn source_l401_permission_failure_retains_values_and_outranks_staleness() {
    let v = V::simple(&[("a", 7)]);
    v.sampler.sample().await;
    let good = v.snap();
    tick(DISK_USAGE_STALE_MS as u64 + 1).await;
    assert_eq!(v.snap().status, DiskUsageStatus::Stale);
    let target = v.tree.root.join("a");
    v.tree.hook(move |op, path| {
        let target = target.clone();
        async move {
            if op == "lstat" && path == target {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            Ok(())
        }
    });
    v.sampler.sample().await;
    assert_eq!(v.snap().status, DiskUsageStatus::Partial);
    assert_eq!(v.snap().data_bytes, Some(7));
    assert_eq!(v.snap().sampled_at, good.sampled_at);
}

#[tokio::test(start_paused = true)]
async fn source_l417_root_open_failure_reports_error_without_fabricated_zero() {
    let v = V::simple(&[]);
    v.tree.hook(|op, _| async move {
        if op == "opendir" {
            Err(io::ErrorKind::PermissionDenied.into())
        } else {
            Ok(())
        }
    });
    v.sampler.sample().await;
    let value = v.snap();
    assert_eq!(value.status, DiskUsageStatus::Error);
    assert!(value.scan_ms.is_some());
    assert_eq!(value.data_bytes, None);
    assert_eq!(value.logs_bytes, None);
    assert_eq!(value.sampled_at, None);
    assert_eq!(v.count(), 1);
}
#[tokio::test(start_paused = true)]
async fn source_l429_disappearing_root_is_error_not_successful_empty_directory() {
    let v = V::simple(&[]);
    let tree = Arc::clone(&v.tree);
    v.tree.hook(move |op, _| {
        let tree = Arc::clone(&tree);
        async move {
            if op == "read" {
                tree.state.lock().unwrap().nodes.remove(&tree.root);
                return Err(io::ErrorKind::NotFound.into());
            }
            Ok(())
        }
    });
    v.sampler.sample().await;
    assert_eq!(v.snap().status, DiskUsageStatus::Error);
    assert_eq!(v.snap().data_bytes, None);
    assert!(v.tree.all_closed());
}

#[tokio::test(start_paused = true)]
async fn source_l444_entry_limit_closes_all_handles_without_partial_totals() {
    let v = V::new(&[("one", 1), ("two", 2), ("three", 3)], |opts| {
        opts.max_entries = 2
    });
    v.sampler.sample().await;
    assert_eq!(v.snap().status, DiskUsageStatus::Partial);
    assert_eq!(v.snap().data_bytes, None);
    assert_eq!(v.tree.opened()[0].reads, 2);
    assert!(v.tree.all_closed());
}
#[tokio::test(start_paused = true)]
async fn source_l454_never_exceeds_thirty_two_live_directory_layers() {
    let v = V::simple(&[]);
    let path = format!(
        "state/{}/file",
        (0..35)
            .map(|i| format!("d{i}"))
            .collect::<Vec<_>>()
            .join("/")
    );
    v.tree.add(&path, 9);
    v.sampler.sample().await;
    assert_eq!(v.snap().status, DiskUsageStatus::Partial);
    assert_eq!(v.tree.state.lock().unwrap().max_handles, 32);
    assert!(v.tree.all_closed());
}

#[tokio::test(start_paused = true)]
async fn source_l465_hundred_entry_pauses_count_toward_exact_scan_time() {
    let v = V::simple(&[]);
    for i in 0..201 {
        v.tree.add(&format!("f{i}"), 1);
    }
    let pending = v.spawn();
    settle().await;
    tick(19).await;
    assert_eq!(v.count(), 0);
    assert_eq!(v.tree.opened()[0].reads, 100);
    tick(1).await;
    tick(20).await;
    pending.await.unwrap();
    v.assert_size(DiskUsageStatus::Ok, 201, 0);
    assert_eq!(v.snap().scan_ms, Some(40));
    assert_eq!(v.tree.max_active(), 1);
}
#[tokio::test(start_paused = true)]
async fn source_l479_batch_pause_timeout_closes_handles_and_keeps_prior_success() {
    let v = V::new(&[("a", 7)], |opts| {
        opts.batch_size = 2;
        opts.batch_pause_ms = 20;
        opts.budget_ms = 10;
    });
    v.sampler.sample().await;
    let good = v.snap();
    v.tree.add("b", 9);
    let pending = v.spawn();
    settle().await;
    tick(20).await;
    pending.await.unwrap();
    assert_eq!(v.snap().status, DiskUsageStatus::Timeout);
    assert_eq!(v.snap().data_bytes, Some(7));
    assert_eq!(v.snap().sampled_at, good.sampled_at);
    assert!(v.tree.all_closed());
}

async fn slow_open_contract(budget: Option<u128>, delay: u64) {
    let v = V::new(&[("a", 7)], |opts| {
        if let Some(budget) = budget {
            opts.budget_ms = budget;
        }
    });
    assert_eq!(DiskUsageSamplerOptions::new("unused").budget_ms, 10_000);
    v.tree.hook(move |op, _| async move {
        if op == "opendir" {
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
        Ok(())
    });
    let pending = v.spawn();
    settle().await;
    tick(delay).await;
    pending.await.unwrap();
    assert_eq!(v.snap().status, DiskUsageStatus::Timeout);
    let frames = v.tree.opened();
    assert!(frames[0].closed);
    assert_eq!(frames[0].reads, 0);
    assert_eq!(v.tree.calls().last().unwrap().0, "close");
}
#[tokio::test(start_paused = true)]
async fn source_l492_slow_open_is_closed_after_deadline_before_first_read() {
    slow_open_contract(Some(50), 60).await;
}
#[tokio::test(start_paused = true)]
async fn source_l506_default_ten_second_budget_is_checked_after_outstanding_io() {
    slow_open_contract(None, 10_001).await;
}

#[tokio::test(start_paused = true)]
async fn source_l519_slow_read_preserves_timeout_and_closes_its_handle() {
    let v = V::new(&[("a", 7)], |opts| opts.budget_ms = 50);
    v.tree.hook(|op, _| async move {
        if op == "read" {
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
        Ok(())
    });
    let pending = v.spawn();
    settle().await;
    tick(60).await;
    pending.await.unwrap();
    assert_eq!(v.snap().status, DiskUsageStatus::Timeout);
    assert_eq!(v.snap().data_bytes, None);
    let frames = v.tree.opened();
    assert_eq!(frames[0].reads, 1);
    assert!(frames[0].closed);
    assert_eq!(v.tree.calls().last().unwrap().0, "close");
}
#[tokio::test(start_paused = true)]
async fn source_l534_complete_final_close_may_cross_budget_without_false_timeout() {
    let v = V::new(&[("a", 7)], |opts| opts.budget_ms = 50);
    v.tree.hook(|op, _| async move {
        if op == "close" {
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
        Ok(())
    });
    let pending = v.spawn();
    settle().await;
    tick(60).await;
    pending.await.unwrap();
    v.assert_size(DiskUsageStatus::Ok, 7, 0);
    assert_eq!(v.snap().scan_ms, Some(60));
    assert!(v.tree.all_closed());
    assert_eq!(v.tree.calls().last().unwrap().0, "close");
}
#[tokio::test(start_paused = true)]
async fn source_l550_explicit_close_result_error_is_partial_never_complete() {
    let v = V::simple(&[]);
    let failures = Arc::new(AtomicUsize::new(0));
    let calls = Arc::clone(&failures);
    v.tree.hook(move |op, _| {
        let calls = Arc::clone(&calls);
        async move {
            if op == "close" && calls.fetch_add(1, Ordering::SeqCst) == 0 {
                return Err(io::Error::other("EIO"));
            }
            Ok(())
        }
    });
    v.sampler.sample().await;
    assert_eq!(v.snap().status, DiskUsageStatus::Partial);
    assert_eq!(v.snap().data_bytes, None);
    assert!(v.tree.all_closed());
    assert_eq!(failures.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn source_l563_schedule_keeps_thirty_second_delay_ten_minute_cadence_and_duplicate_start_guard(
) {
    let v = V::simple(&[("a", 7)]);
    assert_eq!(v.sampler.options.initial_delay_ms, 30000);
    assert_eq!(v.sampler.options.interval_ms, 600000);
    v.sampler.start();
    v.sampler.start();
    settle().await;
    tick(29999).await;
    assert!(v.tree.calls().is_empty());
    tick(1).await;
    assert_eq!(v.count(), 1);
    tick(600000).await;
    assert_eq!(v.count(), 2);
    v.sampler.stop();
    tick(600000).await;
    assert_eq!(v.count(), 2);
    assert!(v.tree.all_closed());
}
#[tokio::test(start_paused = true)]
async fn source_l580_failures_back_off_twenty_forty_sixty_minutes_then_recover() {
    let v = V::new(&[], |opts| opts.initial_delay_ms = 0);
    let fail = Arc::new(AtomicBool::new(true));
    let state = Arc::clone(&fail);
    v.tree.hook(move |op, _| {
        let state = Arc::clone(&state);
        async move {
            if op == "opendir" && state.load(Ordering::SeqCst) {
                Err(io::ErrorKind::PermissionDenied.into())
            } else {
                Ok(())
            }
        }
    });
    v.sampler.start();
    settle().await;
    tick(0).await;
    assert_eq!(v.count(), 1);
    tick(600000).await;
    assert_eq!(v.count(), 2);
    tick(600000).await;
    assert_eq!(v.count(), 2);
    tick(600000).await;
    assert_eq!(v.count(), 3);
    tick(3 * 600000).await;
    assert_eq!(v.count(), 3);
    tick(600000).await;
    assert_eq!(v.count(), 4);
    tick(5 * 600000).await;
    assert_eq!(v.count(), 4);
    fail.store(false, Ordering::SeqCst);
    tick(600000).await;
    assert_eq!(v.count(), 5);
    tick(600000).await;
    assert_eq!(v.count(), 6);
    v.sampler.stop();
}

#[tokio::test(start_paused = true)]
async fn source_l609_slow_scan_is_single_flight_and_does_not_queue_missed_attempts() {
    let v = V::new(&[], |opts| {
        opts.initial_delay_ms = 0;
        opts.interval_ms = 10;
        opts.budget_ms = 1000;
    });
    let release = Arc::new(Notify::new());
    let gate = Arc::clone(&release);
    v.tree.hook(move |op, _| {
        let gate = Arc::clone(&gate);
        async move {
            if op == "opendir" {
                gate.notified().await;
            }
            Ok(())
        }
    });
    v.sampler.start();
    settle().await;
    tick(50).await;
    let same = v.spawn();
    settle().await;
    assert_eq!(
        v.tree
            .calls()
            .iter()
            .filter(|(op, _)| *op == "opendir")
            .count(),
        1
    );
    v.tree.clear_hook();
    release.notify_one();
    same.await.unwrap();
    assert_eq!(v.count(), 1);
    assert_eq!(v.tree.max_active(), 1);
    tick(9).await;
    assert_eq!(v.count(), 1);
    tick(1).await;
    assert_eq!(v.count(), 2);
    v.sampler.stop();
}

#[tokio::test(start_paused = true)]
async fn source_l632_stop_cancels_batch_wait_without_extra_reads_callbacks_or_result() {
    let v = V::new(&[("a", 7), ("b", 9)], |opts| {
        opts.batch_size = 1;
        opts.batch_pause_ms = 20;
    });
    let pending = v.spawn();
    settle().await;
    v.sampler.stop();
    pending.await.unwrap();
    let frames = v.tree.opened();
    assert_eq!(frames[0].reads, 1);
    assert!(frames[0].closed);
    assert_eq!(v.snap(), DiskUsageSnapshot::default());
    assert_eq!(v.count(), 0);
    assert!(!v.sampler.test_is_scheduled());
    assert!(!v.sampler.state.lock().unwrap().in_flight);
    tick(1000).await;
    assert_eq!(v.tree.opened()[0].reads, 1);
    assert_eq!(v.count(), 0);
}

#[tokio::test(start_paused = true)]
async fn source_l646_stop_and_restart_wait_for_owned_read_before_close_and_new_work() {
    let v = V::simple(&[]);
    let release = Arc::new(Notify::new());
    let gate = Arc::clone(&release);
    v.tree.hook(move |op, _| {
        let gate = Arc::clone(&gate);
        async move {
            if op == "read" {
                gate.notified().await;
            }
            Ok(())
        }
    });
    let old = v.spawn();
    settle().await;
    v.sampler.stop();
    v.sampler.start();
    assert!(!v.tree.opened()[0].closed);
    v.tree.clear_hook();
    release.notify_one();
    old.await.unwrap();
    assert!(v.tree.opened()[0].closed);
    assert_eq!(v.tree.max_active(), 1);
    assert_eq!(v.count(), 0);
    settle().await;
    tick(30000).await;
    assert_eq!(v.count(), 1);
}

#[tokio::test(start_paused = true)]
async fn source_l668_overdue_restart_tick_runs_immediately_after_old_read_settles() {
    let v = V::simple(&[("a", 7)]);
    let release = Arc::new(Notify::new());
    let gate = Arc::clone(&release);
    v.tree.hook(move |op, _| {
        let gate = Arc::clone(&gate);
        async move {
            if op == "read" {
                gate.notified().await;
            }
            Ok(())
        }
    });
    let old = v.spawn();
    settle().await;
    v.sampler.stop();
    v.sampler.start();
    settle().await;
    tick(30000).await;
    assert_eq!(
        v.tree
            .calls()
            .iter()
            .filter(|(op, _)| *op == "opendir")
            .count(),
        1
    );
    assert!(!v.tree.opened()[0].closed);
    v.tree.clear_hook();
    release.notify_one();
    old.await.unwrap();
    settle().await;
    assert_eq!(v.count(), 1);
    v.assert_size(DiskUsageStatus::Ok, 7, 0);
    assert_eq!(
        v.tree
            .calls()
            .iter()
            .filter(|(op, _)| *op == "opendir")
            .count(),
        2
    );
    assert_eq!(v.tree.max_active(), 1);
    assert!(v.tree.all_closed());
}

#[tokio::test(start_paused = true)]
async fn source_l693_panicking_consumer_does_not_prevent_later_actual_samples() {
    let tree = Tree::new();
    tree.add("a", 7);
    let calls = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&calls);
    let mut value = DiskUsageSampler::new(
        DiskUsageSamplerOptions::new(tree.root.to_string_lossy()),
        Arc::new(move |_| {
            count.fetch_add(1, Ordering::SeqCst);
            panic!("consumer failed");
        }),
    );
    value.fs = Arc::new(ReplayFs(Arc::clone(&tree)));
    let value = Arc::new(value);
    value.sample().await;
    value.sample().await;
    assert_eq!(value.get_snapshot().status, DiskUsageStatus::Ok);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(tree.all_closed());
}

#[tokio::test]
async fn source_l701_real_native_handles_count_hidden_and_logs_but_not_directory_links() {
    let temp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(temp.path()).unwrap();
    std::fs::create_dir(root.join("logs")).unwrap();
    std::fs::write(root.join(".hidden"), "123").unwrap();
    std::fs::write(root.join("logs").join("events.jsonl"), "1234567").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(root.join("logs"), root.join("linked-logs")).unwrap();
    #[cfg(windows)]
    {
        let status = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(root.join("linked-logs"))
            .arg(root.join("logs"))
            .status()
            .unwrap();
        assert!(status.success(), "create real Windows directory junction");
    }
    let sampler = Arc::new(DiskUsageSampler::new(
        DiskUsageSamplerOptions::new(root.to_string_lossy()),
        Arc::new(|_| {}),
    ));
    sampler.sample().await;
    let result = sampler.get_snapshot();
    assert_eq!(result.status, DiskUsageStatus::Ok);
    assert_eq!(result.data_bytes, Some(10));
    assert_eq!(result.logs_bytes, Some(7));
    assert!(!sampler
        .opened_directories()
        .iter()
        .any(|p| p.ends_with("linked-logs")));
}
