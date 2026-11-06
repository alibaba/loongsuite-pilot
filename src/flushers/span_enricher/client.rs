//! Async parent of a persistent native worker; no external language runtime.
use super::{SpanEnricherContext, SpanView};
use serde_json::{json, Map, Value};
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const BUDGET: std::time::Duration = std::time::Duration::from_secs(5);
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
struct Worker {
    _scope: crate::utils::candidate_process::CandidateChild,
    input: tokio::process::ChildStdin,
    output: BufReader<tokio::process::ChildStdout>,
}
impl Worker {
    fn spawn(path: &Path, executable: Option<&Path>) -> io::Result<Self> {
        let executable = match executable {
            Some(path) => path.to_owned(),
            None => std::env::current_exe()?,
        };
        let mut command = Command::new(executable);
        command
            .arg("internal-span-enricher")
            .arg(path)
            .arg(std::process::id().to_string())
            .env("TOKIO_WORKER_THREADS", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut scope = crate::utils::candidate_process::CandidateChild::spawn(&mut command)?;
        let input = tokio::process::ChildStdin::from_std(
            scope
                .take_stdin()
                .ok_or_else(|| io::Error::other("Missing worker stdin"))?,
        )?;
        let output = tokio::process::ChildStdout::from_std(
            scope
                .take_stdout()
                .ok_or_else(|| io::Error::other("Missing worker stdout"))?,
        )?;
        Ok(Self {
            _scope: scope,
            input,
            output: BufReader::new(output),
        })
    }
    async fn read(&mut self) -> io::Result<Value> {
        let mut bytes = Vec::new();
        loop {
            let available = self.output.fill_buf().await?;
            if available.is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Worker closed",
                ));
            }
            let complete = available.iter().position(|byte| *byte == b'\n');
            let count = complete.map_or(available.len(), |index| index + 1);
            if bytes.len().saturating_add(count) > MAX_RESPONSE_BYTES {
                return Err(io::Error::other("Worker response exceeds frame limit"));
            }
            bytes.extend_from_slice(&available[..count]);
            self.output.consume(count);
            if complete.is_some() {
                break;
            }
        }
        serde_json::from_slice(&bytes).map_err(|_| io::Error::other("Invalid worker response"))
    }
    async fn call(&mut self, view: &SpanView, context: &SpanEnricherContext) -> io::Result<Value> {
        let mut bytes=serde_json::to_vec(&json!({
            "span":{"name":view.name,"traceId":view.trace_id,"spanId":view.span_id,"attributes":view.attributes},
            "context":{"agentType":context.agent_type,"serviceName":context.service_name}
        })).map_err(io::Error::other)?;
        bytes.push(b'\n');
        self.input.write_all(&bytes).await?;
        self.input.flush().await?;
        self.read().await
    }
}
pub(super) struct ScriptPlugin {
    path: PathBuf,
    process: tokio::sync::Mutex<Option<Worker>>,
    warned: AtomicBool,
}
impl ScriptPlugin {
    pub(super) fn new(path: PathBuf) -> Self {
        Self {
            path,
            process: tokio::sync::Mutex::new(None),
            warned: AtomicBool::new(false),
        }
    }
    pub(super) async fn load(&self, executable: Option<&Path>) {
        let mut slot = self.process.lock().await;
        // Keep ownership in this future until the handshake completes:
        // cancellation drops CandidateChild and reaps this exact worker tree.
        let result = async {
            let mut worker = Worker::spawn(&self.path, executable)?;
            let ready = worker.read().await?;
            if ready["ok"] != true {
                return Err(io::Error::other("Cannot load plugin"));
            }
            Ok::<_, io::Error>(worker)
        };
        match tokio::time::timeout(BUDGET, result).await {
            Ok(Ok(worker)) => *slot = Some(worker),
            _ => self.warn("Cannot load span enricher; skipping"),
        }
    }
    pub(super) async fn enrich(
        &self,
        view: &SpanView,
        context: &SpanEnricherContext,
    ) -> Option<Map<String, Value>> {
        let call = async {
            let mut slot = self.process.lock().await;
            // Taking ownership makes cancellation safe. If the budget expires
            // during I/O, CandidateChild drops and reaps that exact worker tree.
            let Some(mut worker) = slot.take() else {
                return Ok(None);
            };
            let response = worker.call(view, context).await?;
            *slot = Some(worker);
            if response["ok"] == true {
                if response["patch"].is_null() {
                    return Ok(None);
                }
                if let Some(patch) = response["patch"].as_object() {
                    return Ok(Some(patch.clone()));
                }
            }
            Err(io::Error::other("Invalid plugin patch"))
        };
        match tokio::time::timeout(BUDGET, call).await {
            Ok(Ok(patch)) => patch,
            _ => {
                self.warn("Span enricher failed; ignoring its patch (further errors suppressed)");
                None
            }
        }
    }
    pub(super) async fn stop(&self) {
        self.process.lock().await.take();
    }
    pub(super) fn warn_patch(&self) {
        self.warn("Span enricher failed; ignoring its patch (further errors suppressed)");
    }
    fn warn(&self, message: &str) {
        if self.warned.swap(true, Ordering::SeqCst) {
            return;
        }
        crate::utils::create_logger("span-enricher").warn(
            message,
            json!({"path":self.path.to_string_lossy()}).as_object(),
        );
    }
}
