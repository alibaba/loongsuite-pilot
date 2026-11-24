mod hub;
mod native;

use crate::hook_process::trae_cn::content_enabled;
use crate::inputs::base::InputRuntimeInfo;
use crate::inputs::rest_support::{
    box_collect, box_hook, transform_hook_record, PollLoop, SessionInputOptions, SessionJsonlInput,
};
use crate::types::{AgentActivityEntry, AgentEventName, ClientType, CollectionMethod};
use crate::utils::{
    create_logger, resolve_home, resolve_poll_interval_ms, DEFAULT_POLL_INTERVAL_MS,
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const LISTENER: &str = "trae-cn-log";
const AGENT: &str = "trae-cn";
const DIRECTORY: &str = "~/.loongsuite-pilot/logs/trae-cn/history";

pub struct TraeCnLogInput {
    rows: Arc<SessionJsonlInput>,
    sources: Arc<Sources>,
    poll: PollLoop,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

struct Sources {
    env: std::collections::HashMap<String, String>,
    agent_dir: PathBuf,
    hub_dir: PathBuf,
    native_dir: PathBuf,
    usage: Mutex<(hub::Hub, native::NativeIndex)>,
}

impl TraeCnLogInput {
    pub fn new(options: SessionInputOptions, data_dir: &str) -> Self {
        let home = PathBuf::from(resolve_home("~"));
        let agent_dir = home.join(".trae-cn");
        let platform = if cfg!(target_os = "macos") {
            home.join("Library/Application Support")
        } else {
            let key = if cfg!(target_os = "windows") {
                "APPDATA"
            } else {
                "XDG_CONFIG_HOME"
            };
            std::env::var_os(key)
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".config"))
        };
        let mut env: std::collections::HashMap<_, _> = std::env::vars().collect();
        env.insert("LOONGSUITE_PILOT_DATA_DIR".into(), data_dir.into());
        let sources = Arc::new(Sources {
            env,
            hub_dir: agent_dir.join("hub_event_cache/TraeCode"),
            agent_dir,
            native_dir: platform.join("Trae CN/logs"),
            usage: Mutex::new((hub::Hub::default(), native::NativeIndex::default())),
        });
        let poll = PollLoop::new(
            resolve_poll_interval_ms(options.poll_interval_ms, DEFAULT_POLL_INTERVAL_MS),
            create_logger("TraeCnLogInput"),
            Arc::clone(&options.state_store),
        );
        let rows = Arc::new(SessionJsonlInput::new(
            "TraeCnLogInput",
            LISTENER,
            ClientType::TraeCn,
            DIRECTORY,
            "trae-cn-*.jsonl",
            options,
            Arc::new(|record, _path| {
                Box::pin(
                    async move { transform_hook_record(&record, ClientType::TraeCn, AGENT).await },
                )
            }),
        ));
        Self {
            rows,
            sources,
            poll,
            watcher: Mutex::new(None),
        }
    }

    pub fn collection_method(&self) -> CollectionMethod {
        CollectionMethod::HookJsonl
    }
    pub fn runtime_info(&self) -> InputRuntimeInfo {
        InputRuntimeInfo {
            poll_interval_ms: self.poll.interval_ms(),
            source_paths: vec![
                self.rows.session_dir().into(),
                self.sources.hub_dir.to_string_lossy().into_owned(),
            ],
        }
    }
    pub fn running(&self) -> bool {
        self.poll.running()
    }
    pub fn on_entries(&self, listener: impl Fn(&[AgentActivityEntry]) + Send + Sync + 'static) {
        self.poll.on_entries(listener);
    }

    pub async fn start(&self) {
        {
            let mut slot = self.watcher.lock().expect("TRAE Hub watcher");
            if slot.is_none() {
                let sources = Arc::clone(&self.sources);
                if let Ok(mut watcher) =
                    notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                        if event.is_ok_and(|event| {
                            event.paths.iter().any(|path| {
                                path.starts_with(&sources.hub_dir)
                                    || sources.hub_dir.starts_with(path)
                            })
                        }) {
                            sources.capture_hub();
                        }
                    })
                {
                    let root = if self.sources.hub_dir.is_dir() {
                        &self.sources.hub_dir
                    } else {
                        &self.sources.agent_dir
                    };
                    if watcher.watch(root, RecursiveMode::Recursive).is_ok() {
                        *slot = Some(watcher);
                    }
                }
            }
        }
        let rows = Arc::clone(&self.rows);
        let sources = Arc::clone(&self.sources);
        self.poll
            .start(
                box_hook(|| async {}),
                box_collect(move || collect(Arc::clone(&rows), Arc::clone(&sources))),
                box_hook(|| async {}),
            )
            .await;
    }

    pub async fn stop(&self) {
        let watcher = self.watcher.lock().expect("TRAE Hub watcher").take();
        drop(watcher);
        self.poll.stop().await;
        let mut usage = self.sources.usage.lock().expect("TRAE usage");
        *usage = (hub::Hub::default(), native::NativeIndex::default());
    }

    #[cfg(test)]
    async fn collect_entries(&self) -> Result<Vec<AgentActivityEntry>, String> {
        collect(Arc::clone(&self.rows), Arc::clone(&self.sources)).await
    }
}

impl Sources {
    fn capture_hub(&self) {
        if let Ok(mut usage) = self.usage.try_lock() {
            usage.0.refresh(&self.hub_dir, content_enabled(&self.env));
        }
    }
}

async fn collect(
    rows: Arc<SessionJsonlInput>,
    sources: Arc<Sources>,
) -> Result<Vec<AgentActivityEntry>, String> {
    let capture_source = Arc::clone(&sources);
    tokio::task::spawn_blocking(move || capture_source.capture_hub())
        .await
        .map_err(|error| error.to_string())?;
    let mut entries = rows.collect_entries().await?;
    let capture = content_enabled(&sources.env);
    if !capture {
        for entry in &mut entries {
            crate::normalization::agent_content_policy::strip_agent_message_content(entry);
        }
    }
    if !entries
        .iter()
        .any(|entry| entry.event_name == Some(AgentEventName::LlmResponse))
    {
        return Ok(entries);
    }
    tokio::task::spawn_blocking(move || {
        let mut usage = sources.usage.lock().expect("TRAE usage");
        let (hub, native) = &mut *usage;
        native.refresh(&sources.native_dir);
        hub.refresh(&sources.hub_dir, capture);
        let mut output = Vec::with_capacity(entries.len());
        for mut entry in entries {
            output.extend(hub.enrich(&mut entry, native, capture));
            output.push(entry);
        }
        output
    })
    .await
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests;
