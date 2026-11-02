//! Cleanup-only migration of the two retired worker runtime overrides.
//! Env ownership is an exact current-data or known old HOME path. Plists also match
//! the actual historical producer; a filename alone is not ownership evidence.
type BoxFut<T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send>>;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::AsyncReadExt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Host {
    Mac,
    Windows,
    Other,
}
impl Host {
    fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Mac
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Other
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Definition {
    pub id: &'static str,
    pub env_name: &'static str,
    pub plist_label: Option<&'static str>,
}
pub(crate) const MAC_DEFS: [Definition; 2] = [
    Definition {
        id: "qoderwork-env",
        env_name: "QODER_WORKER_RUNTIME_PATH",
        plist_label: Some("com.loongsuite-pilot.qoderwork-env"),
    },
    Definition {
        id: "qwenworkcn-env",
        env_name: "QW_QODER_WORKER_RUNTIME_PATH",
        plist_label: Some("com.loongsuite-pilot.qwenworkcn-env"),
    },
];
pub(crate) const WIN_DEFS: [Definition; 2] = [
    Definition {
        id: "qoderwork-win-env",
        env_name: "QODER_WORKER_RUNTIME_PATH",
        plist_label: None,
    },
    Definition {
        id: "qwenworkcn-win-env",
        env_name: "QW_QODER_WORKER_RUNTIME_PATH",
        plist_label: None,
    },
];
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Command {
    pub program: &'static str,
    pub args: Vec<String>,
    pub timeout_ms: Option<u64>,
    pub env: Vec<(String, String)>,
    pub windows_hide: bool,
}
impl Command {
    fn mac(args: &[&str]) -> Self {
        Self {
            program: "launchctl",
            args: args.iter().map(|s| (*s).into()).collect(),
            timeout_ms: None,
            env: Vec::new(),
            windows_hide: false,
        }
    }
    fn windows(program: &'static str, args: &[&str]) -> Self {
        Self {
            program,
            args: args.iter().map(|s| (*s).into()).collect(),
            timeout_ms: Some(10_000),
            env: Vec::new(),
            windows_hide: true,
        }
    }
}
pub(crate) trait Backend: Send + Sync {
    fn permits_cleanup(&self) -> bool {
        true
    }
    fn run(&self, command: Command) -> BoxFut<Result<String, String>>;
    fn warn(&self, message: &str, fields: serde_json::Value) {
        crate::utils::create_logger("RuntimeRetirement").warn(message, fields.as_object());
        // Installer stdout can be intentionally discarded; stderr keeps the
        // ownership/broadcast diagnostic visible to the invoking user.
        eprintln!("[runtime-retirement] {message}: {fields}");
    }
}
struct Native;
async fn read_capped(stream: impl tokio::io::AsyncRead + Unpin) -> Result<Vec<u8>, String> {
    const MAX: u64 = 1024 * 1024; // execFile's default maxBuffer in frozen main.
    let mut bytes = Vec::new();
    stream
        .take(MAX + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX {
        return Err("runtime cleanup command exceeded output budget".into());
    }
    Ok(bytes)
}
impl Backend for Native {
    fn permits_cleanup(&self) -> bool {
        // Unit callers may use the public current-host factory for metadata.
        // OS effects require an explicitly injected isolated backend in tests.
        !cfg!(test)
    }

    fn run(&self, spec: Command) -> BoxFut<Result<String, String>> {
        Box::pin(async move {
            let program = match spec.program {
                "launchctl" if cfg!(target_os = "macos") => PathBuf::from("/bin/launchctl"),
                "reg.exe" | "powershell.exe" if cfg!(windows) => {
                    let system =
                        std::env::var_os("SystemRoot").ok_or("Windows SystemRoot is missing")?;
                    PathBuf::from(system).join(if spec.program == "reg.exe" {
                        "System32/reg.exe"
                    } else {
                        "System32/WindowsPowerShell/v1.0/powershell.exe"
                    })
                }
                _ => return Err("runtime cleanup command is unsupported on this host".into()),
            };
            let mut command = tokio::process::Command::new(program);
            command
                .args(&spec.args)
                .envs(spec.env)
                .kill_on_drop(true)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            #[cfg(not(windows))]
            let _ = spec.windows_hide;
            #[cfg(windows)]
            if spec.windows_hide {
                command.creation_flags(0x0800_0000);
            }
            let execute = async move {
                let mut child = command.spawn().map_err(|e| e.to_string())?;
                let stdout = child.stdout.take().unwrap();
                let stderr = child.stderr.take().unwrap();
                let (out, err, status) =
                    tokio::try_join!(read_capped(stdout), read_capped(stderr), async {
                        child.wait().await.map_err(|e| e.to_string())
                    })?;
                if !status.success() {
                    return Err(format!(
                        "{} exited {status}: {}",
                        spec.program,
                        String::from_utf8_lossy(&err).trim()
                    ));
                }
                Ok(String::from_utf8_lossy(&out).into_owned())
            };
            if let Some(ms) = spec.timeout_ms {
                tokio::time::timeout(std::time::Duration::from_millis(ms), execute)
                    .await
                    .map_err(|_| "runtime cleanup command timed out".to_owned())?
            } else {
                execute.await
            }
        })
    }
}
#[derive(Clone)]
pub(crate) struct Context {
    pub host: Host,
    pub home: PathBuf,
    pub backend: Arc<dyn Backend>,
}
impl Context {
    pub fn native() -> Self {
        Self {
            host: Host::current(),
            home: PathBuf::from(crate::utils::resolve_home("~")),
            backend: Arc::new(Native),
        }
    }
}
fn wrapper(data_dir: &str) -> String {
    Path::new(data_dir)
        .join("hooks")
        .join("qoderwork-runtime-wrapper.mjs")
        .to_string_lossy()
        .into_owned()
}
fn owned_paths(context: &Context, current: &str) -> [String; 2] {
    [
        current.to_owned(),
        wrapper(&context.home.join(".loongsuite-pilot").to_string_lossy()),
    ]
}
fn owned_environment(context: &Context, current: &str, expected: &str) -> bool {
    owned_paths(context, expected)
        .iter()
        .any(|owned| match context.host {
            Host::Windows => current.to_lowercase() == owned.to_lowercase(),
            Host::Mac => current == owned,
            Host::Other => false,
        })
}

pub(crate) fn definitions(host: Host) -> &'static [Definition] {
    match host {
        Host::Mac => &MAC_DEFS,
        Host::Windows => &WIN_DEFS,
        Host::Other => &[],
    }
}
pub(crate) async fn cleanup_definition(
    data_dir: &str,
    context: &Context,
    def: Definition,
) -> Result<(), String> {
    cleanup(context, def, &wrapper(data_dir)).await
}
pub(crate) async fn cleanup_all(data_dir: &str, context: &Context) -> Result<(), String> {
    let mut failures = Vec::new();
    for def in definitions(context.host) {
        if let Err(error) = cleanup_definition(data_dir, context, *def).await {
            failures.push(format!("{}: {error}", def.id));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}
async fn cleanup(context: &Context, def: Definition, wrapper: &str) -> Result<(), String> {
    if !context.backend.permits_cleanup() {
        return Ok(());
    }
    match context.host {
        Host::Windows => {
            let current = context
                .backend
                .run(Command::windows(
                    "reg.exe",
                    &["query", "HKCU\\Environment", "/v", def.env_name],
                ))
                .await
                .unwrap_or_default();
            let current = parse_windows_user_env(&current, def.env_name);
            if current.is_empty() || !owned_environment(context, &current, wrapper) {
                return Ok(());
            }
            context
                .backend
                .run(Command::windows(
                    "reg.exe",
                    &["delete", "HKCU\\Environment", "/v", def.env_name, "/f"],
                ))
                .await?;
            let mut broadcast=Command::windows("powershell.exe",
                &["-NoProfile","-NonInteractive","-Command",
                "$ErrorActionPreference = 'Stop'; try { [Environment]::SetEnvironmentVariable($env:LOONGSUITE_PILOT_RUNTIME_ENV_NAME, $null, 'User'); exit 0 } catch { exit 1 }"]);
            broadcast.env.push((
                "LOONGSUITE_PILOT_RUNTIME_ENV_NAME".into(),
                def.env_name.into(),
            ));
            if context.backend.run(broadcast).await.is_err() {
                context.backend.warn("windows runtime environment persisted but broadcast failed",
                    serde_json::json!({"envName":def.env_name,"action":"sign out and back in to refresh Explorer"}));
            }
            Ok(())
        }
        Host::Mac => {
            let mut failure = None;
            if let Ok(current) = context
                .backend
                .run(Command::mac(&["getenv", def.env_name]))
                .await
            {
                if owned_environment(context, current.trim(), wrapper) {
                    if let Err(error) = context
                        .backend
                        .run(Command::mac(&["unsetenv", def.env_name]))
                        .await
                    {
                        failure = Some(error);
                    }
                }
            }
            if let Some(label) = def.plist_label {
                if let Err(error) = cleanup_plist(context, def, label, wrapper).await {
                    failure = Some(error);
                }
            }
            failure.map_or(Ok(()), Err)
        }
        Host::Other => Ok(()),
    }
}
#[derive(Clone)]
struct Snapshot {
    bytes: Vec<u8>,
    identity: String,
}
async fn snapshot(path: &Path) -> Result<Option<Snapshot>, String> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.to_string()),
        };
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err("not an ordinary plist file".into());
        }
        let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        let id =
            crate::utils::file_identity::identity_from_open(&file).map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        file.take(64 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 64 * 1024 {
            return Err("plist exceeds ownership inspection budget".into());
        }
        Ok(Some(Snapshot {
            bytes,
            identity: format!("{}:{}:{}", id.dev, id.ino, id.birthtime_ms),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}
fn xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
fn owned_xml(bytes: &[u8], label: &str, env: &str, wrapper: &str) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    // Exact historical fields/order, with whitespace allowed only between XML
    // elements. Extra Program keys, duplicate fields and altered argv stay foreign.
    let pattern = format!(
        r#"\A\s*(?:<\?xml\s+version="1\.0"\s+encoding="UTF-8"\s*\?>\s*)?(?:<!DOCTYPE\s+plist\s+PUBLIC\s+"-//Apple//DTD PLIST 1\.0//EN"\s+"http://www\.apple\.com/DTDs/PropertyList-1\.0\.dtd"\s*>\s*)?<plist\s+version="1\.0">\s*<dict>\s*<key>Label</key>\s*<string>{}</string>\s*<key>ProgramArguments</key>\s*<array>\s*<string>/bin/launchctl</string>\s*<string>setenv</string>\s*<string>{}</string>\s*<string>{}</string>\s*</array>\s*<key>RunAtLoad</key>\s*<true\s*/>\s*</dict>\s*</plist>\s*\z"#,
        regex::escape(&xml(label)),
        regex::escape(&xml(env)),
        regex::escape(&xml(wrapper))
    );
    regex::Regex::new(&pattern).is_ok_and(|r| r.is_match(text.trim_start_matches('\u{feff}')))
}
async fn cleanup_plist(
    context: &Context,
    def: Definition,
    label: &str,
    wrapper: &str,
) -> Result<(), String> {
    let path = context
        .home
        .join("Library/LaunchAgents")
        .join(format!("{label}.plist"));
    let first = match snapshot(&path).await {
        Ok(Some(s)) => s,
        Ok(None) => return Ok(()),
        Err(error) => {
            context.backend.warn(
                "retired runtime plist preserved; ownership not verified",
                serde_json::json!({"id":def.id,"path":path,"error":error}),
            );
            return Ok(());
        }
    };
    if !owned_paths(context, wrapper)
        .iter()
        .any(|owned| owned_xml(&first.bytes, label, def.env_name, owned))
    {
        context.backend.warn(
            "retired runtime plist preserved; ownership not verified",
            serde_json::json!({"id":def.id,"path":path}),
        );
        return Ok(());
    }
    let current = snapshot(&path).await?;
    if current
        .as_ref()
        .is_none_or(|s| s.identity != first.identity || s.bytes != first.bytes)
    {
        return Ok(());
    }
    if let Err(error) = context
        .backend
        .run(Command::mac(&["unload", &path.to_string_lossy()]))
        .await
    {
        context.backend.warn(
            "retired runtime plist unload failed; removing verified owned file",
            serde_json::json!({"id":def.id,"path":path,"error":error}),
        );
    }
    let current = snapshot(&path).await?;
    if current
        .as_ref()
        .is_none_or(|s| s.identity != first.identity || s.bytes != first.bytes)
    {
        context.backend.warn(
            "retired runtime plist changed during cleanup; preserving current file",
            serde_json::json!({"id":def.id,"path":path}),
        );
        return Ok(());
    }
    tokio::fs::remove_file(path)
        .await
        .map_err(|e| e.to_string())
}

pub(crate) fn parse_windows_user_env(output: &str, env_name: &str) -> String {
    let pattern = regex::Regex::new(r"^\s*(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$").expect("reg");
    for line in output.split(['\n', '\r']) {
        if let Some(caps) = pattern.captures(line) {
            if caps
                .get(1)
                .map(|item| item.as_str().eq_ignore_ascii_case(env_name))
                .unwrap_or(false)
            {
                return caps
                    .get(2)
                    .map(|item| item.as_str().trim().to_string())
                    .unwrap_or_default();
            }
        }
    }
    String::new()
}

#[cfg(test)]
#[path = "runtime_retirement_installer_tests.rs"]
mod installer_history_tests;
