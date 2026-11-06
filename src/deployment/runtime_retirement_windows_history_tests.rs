//! Windows retirement policies with an isolated registry protocol backend.
//! Native OS adapter coverage below rewrites every registry key to private scope.
use super::*;
use std::collections::BTreeMap;
use std::sync::Mutex;

#[derive(Default)]
struct Registry {
    values: Mutex<BTreeMap<String, String>>,
    calls: Mutex<Vec<Command>>,
    denied_delete: Mutex<Option<String>>,
    denied_broadcast: Mutex<bool>,
    warnings: Mutex<Vec<(String, serde_json::Value)>>,
    publication: Mutex<Option<(PathBuf, String, PathBuf)>>,
}
impl Backend for Registry {
    fn run(&self, command: Command) -> BoxFut<Result<String, String>> {
        if let Some((current, name, service)) = &*self.publication.lock().unwrap() {
            assert_eq!(std::fs::read_to_string(current).unwrap().trim(), name);
            assert!(
                service.is_file(),
                "Windows retirement must follow committed service publication"
            );
        }
        assert_eq!(command.timeout_ms, Some(10_000));
        assert!(command.windows_hide);
        self.calls.lock().unwrap().push(command.clone());
        let result = match command.program {
            "reg.exe" => {
                assert_eq!(command.args[1], r"HKCU\Environment");
                assert_eq!(command.args[2], "/v");
                let name = &command.args[3];
                assert!(WIN_DEFS.iter().any(|def| def.env_name == name));
                match command.args[0].as_str() {
                    "query" => self
                        .values
                        .lock()
                        .unwrap()
                        .get(name)
                        .map(|value| {
                            format!(
                                "    {}    REG_EXPAND_SZ    {value}\r\n",
                                name.to_ascii_lowercase()
                            )
                        })
                        .ok_or("not present".into()),
                    "delete" => {
                        assert_eq!(command.args[4], "/f");
                        if self.denied_delete.lock().unwrap().as_deref() == Some(name) {
                            Err("private registry deletion refused".into())
                        } else {
                            self.values.lock().unwrap().remove(name);
                            Ok(String::new())
                        }
                    }
                    _ => panic!("retirement must never set/add an override"),
                }
            }
            "powershell.exe" => {
                assert!(command.args.contains(&"-NoProfile".into()));
                assert!(command.args.contains(&"-NonInteractive".into()));
                let script = command.args.last().unwrap();
                assert!(script.contains("SetEnvironmentVariable"));
                assert!(script.contains("$null, 'User'"));
                assert_eq!(command.env.len(), 1);
                assert_eq!(command.env[0].0, "LOONGSUITE_PILOT_RUNTIME_ENV_NAME");
                if *self.denied_broadcast.lock().unwrap() {
                    Err("blocked private broadcast".into())
                } else {
                    Ok(String::new())
                }
            }
            _ => panic!("unexpected Windows retirement command"),
        };
        Box::pin(async move { result })
    }
    fn warn(&self, message: &str, fields: serde_json::Value) {
        self.warnings
            .lock()
            .unwrap()
            .push((message.to_owned(), fields));
    }
}
fn context(home: &Path, backend: Arc<Registry>) -> Context {
    Context {
        host: Host::Windows,
        home: home.into(),
        backend,
    }
}
#[tokio::test]
async fn windows_cleanup_history_all_rows_query_both_names_without_app_selection_or_wrapper_gates()
{
    for row in ["missing", "current", "legacy", "mixed", "foreign"] {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("absent home");
        let data = root.path().join("custom Unicode 用户 [runtime]🚀");
        let backend = Arc::new(Registry::default());
        let ctx = context(&home, backend.clone());
        let current = wrapper(&data.to_string_lossy());
        let old = wrapper(&home.join(".loongsuite-pilot").to_string_lossy());
        for (index, def) in WIN_DEFS.iter().enumerate() {
            let value = match row {
                "missing" => None,
                "current" => Some(current.to_uppercase()),
                "legacy" => Some(old.clone()),
                "mixed" if index == 0 => Some(current.clone()),
                "mixed" => Some(
                    root.path()
                        .join("foreign-loongsuite-pilot/runtime.mjs")
                        .to_string_lossy()
                        .into_owned(),
                ),
                _ => Some("C:\\third-party\\loongsuite-pilot\\runtime.mjs".into()),
            };
            if let Some(value) = value {
                backend
                    .values
                    .lock()
                    .unwrap()
                    .insert(def.env_name.into(), value);
            }
        }
        cleanup_all(&data.to_string_lossy(), &ctx).await.unwrap();
        let calls = backend.calls.lock().unwrap();
        let queries = calls
            .iter()
            .filter(|call| call.program == "reg.exe" && call.args[0] == "query")
            .collect::<Vec<_>>();
        assert_eq!(queries.len(), 2);
        for def in WIN_DEFS {
            assert!(queries.iter().any(|call| call.args[3] == def.env_name));
        }
        let expected = match row {
            "current" | "legacy" => 0,
            "mixed" => 1,
            "foreign" => 2,
            _ => 0,
        };
        assert_eq!(backend.values.lock().unwrap().len(), expected, "{row}");
        assert!(
            !home.exists() && !data.exists(),
            "retirement must not probe/create app/config/wrapper roots"
        );
    }
}
#[tokio::test]
async fn windows_cleanup_history_uninstall_keeps_other_install_and_preserves_wrappers() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("private home");
    let data = root.path().join("custom data");
    let current = wrapper(&data.to_string_lossy());
    let old = wrapper(&home.join(".loongsuite-pilot").to_string_lossy());
    std::fs::create_dir_all(Path::new(&current).parent().unwrap()).unwrap();
    std::fs::write(&current, "private wrapper bytes preserved").unwrap();
    let backend = Arc::new(Registry::default());
    let ctx = context(&home, backend.clone());
    backend
        .values
        .lock()
        .unwrap()
        .insert(WIN_DEFS[0].env_name.into(), current.to_uppercase());
    backend
        .values
        .lock()
        .unwrap()
        .insert(WIN_DEFS[1].env_name.into(), old.clone());
    cleanup_uninstall(&data.to_string_lossy(), &ctx)
        .await
        .unwrap();
    assert_eq!(
        backend.values.lock().unwrap().get(WIN_DEFS[1].env_name),
        Some(&old)
    );
    assert!(!backend
        .values
        .lock()
        .unwrap()
        .contains_key(WIN_DEFS[0].env_name));
    assert_eq!(
        std::fs::read(&current).unwrap(),
        b"private wrapper bytes preserved"
    );
}
#[tokio::test]
async fn windows_cleanup_history_delete_failure_continues_other_name_and_broadcast_failure_is_warning(
) {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("private data");
    let backend = Arc::new(Registry::default());
    let ctx = context(&root.path().join("private home"), backend.clone());
    for def in WIN_DEFS {
        backend
            .values
            .lock()
            .unwrap()
            .insert(def.env_name.into(), wrapper(&data.to_string_lossy()));
    }
    *backend.denied_delete.lock().unwrap() = Some(WIN_DEFS[0].env_name.into());
    let error = cleanup_uninstall(&data.to_string_lossy(), &ctx)
        .await
        .unwrap_err();
    assert!(error.contains("private registry deletion refused"));
    assert!(backend
        .values
        .lock()
        .unwrap()
        .contains_key(WIN_DEFS[0].env_name));
    assert!(!backend
        .values
        .lock()
        .unwrap()
        .contains_key(WIN_DEFS[1].env_name));
    *backend.denied_delete.lock().unwrap() = None;
    *backend.denied_broadcast.lock().unwrap() = true;
    cleanup_uninstall(&data.to_string_lossy(), &ctx)
        .await
        .unwrap();
    assert!(backend.values.lock().unwrap().is_empty());
    let warnings = backend.warnings.lock().unwrap();
    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].0.contains("broadcast failed"));
    assert!(warnings[0].1["action"]
        .as_str()
        .unwrap()
        .contains("sign out and back in"));
}

#[cfg(windows)]
struct PrivateKey {
    path: String,
}
#[cfg(windows)]
impl PrivateKey {
    fn new(id: &str) -> Self {
        assert!(!id.contains(['\\', '/']));
        Self {
            path: format!(
                r"HKCU\Software\LoongSuitePilot.NativeHistory\{}-{id}",
                std::process::id()
            ),
        }
    }
}
#[cfg(windows)]
impl Drop for PrivateKey {
    fn drop(&mut self) {
        assert!(self
            .path
            .starts_with(r"HKCU\Software\LoongSuitePilot.NativeHistory\"));
        let program = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32")
            .join("reg.exe");
        let mut command = std::process::Command::new(program);
        command
            .args(["delete", &self.path, "/f"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        if let Ok(mut child) = command.spawn() {
            let start = std::time::Instant::now();
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => {}
                    Err(_) => break,
                }
                if start.elapsed() > std::time::Duration::from_secs(3) {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
    }
}
#[cfg(windows)]
struct PrivateNative {
    key: Arc<PrivateKey>,
    calls: Arc<Mutex<Vec<Command>>>,
    broadcasts: std::sync::atomic::AtomicUsize,
}
#[cfg(windows)]
impl Backend for PrivateNative {
    fn run(&self, mut command: Command) -> BoxFut<Result<String, String>> {
        self.calls.lock().unwrap().push(command.clone());
        if command.program == "powershell.exe" {
            assert_eq!(command.env[0].0, "LOONGSUITE_PILOT_RUNTIME_ENV_NAME");
            assert!(WIN_DEFS.iter().any(|def| def.env_name == command.env[0].1));
            assert!(command.args.last().unwrap().contains("$null, 'User'"));
            self.broadcasts
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            return Box::pin(async {
                Err("private test blocks all real User Environment broadcasts".into())
            });
        }
        assert_eq!(command.program, "reg.exe");
        assert_eq!(
            command.args[1], r"HKCU\Environment",
            "only exact production Env key can be redirected"
        );
        assert!(matches!(command.args[0].as_str(), "query" | "delete"));
        assert_eq!(command.args[2], "/v");
        assert!(WIN_DEFS.iter().any(|def| def.env_name == command.args[3]));
        assert_eq!(
            command.args.len(),
            if command.args[0] == "query" { 4 } else { 5 }
        );
        command.args[1] = self.key.path.clone();
        let key = self.key.clone();
        Box::pin(async move {
            let _private_scope = key;
            Native.run(command).await
        })
    }
    fn warn(&self, _message: &str, _fields: serde_json::Value) {}
}
#[cfg(windows)]
#[tokio::test]
async fn windows_native_registry_unicode_cleanup_uses_only_private_key_and_never_user_environment()
{
    let run = async {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("用户 O'Brien [runtime]🚀");
        let data = home.join("custom data");
        let value = wrapper(&data.to_string_lossy());
        std::fs::create_dir_all(Path::new(&value).parent().unwrap()).unwrap();
        std::fs::write(&value, "private wrapper must remain").unwrap();
        let key = Arc::new(PrivateKey::new(
            root.path().file_name().unwrap().to_str().unwrap(),
        ));
        let backend = Arc::new(PrivateNative {
            key: key.clone(),
            calls: Arc::new(Mutex::new(Vec::new())),
            broadcasts: std::sync::atomic::AtomicUsize::new(0),
        });
        for def in WIN_DEFS {
            // This setup command targets only the private Software key. The
            // actual cleanup adapter can never receive an add command.
            Native
                .run(Command::windows(
                    "reg.exe",
                    &[
                        "add",
                        &key.path,
                        "/v",
                        def.env_name,
                        "/t",
                        "REG_SZ",
                        "/d",
                        &value,
                        "/f",
                    ],
                ))
                .await
                .unwrap();
        }
        for def in WIN_DEFS {
            let observed = Native
                .run(Command::windows(
                    "reg.exe",
                    &["query", &key.path, "/v", def.env_name],
                ))
                .await
                .unwrap();
            assert_eq!(
                parse_windows_user_env(&observed, def.env_name),
                value,
                "private native query must return the exact Unicode registry value"
            );
        }
        let context = Context {
            host: Host::Windows,
            home: home.clone(),
            backend: backend.clone(),
        };
        cleanup_all(&data.to_string_lossy(), &context)
            .await
            .unwrap();
        let calls = backend.calls.lock().unwrap().clone();
        for def in WIN_DEFS {
            assert!(calls.iter().any(|call| call.program == "reg.exe"
                && call.args[0] == "query"
                && call.args[3] == def.env_name));
            assert!(
                calls.iter().any(|call| call.program == "reg.exe"
                    && call.args[0] == "delete"
                    && call.args[3] == def.env_name),
                "actual native Unicode query must recognize owned value and delete it"
            );
            assert!(Native
                .run(Command::windows(
                    "reg.exe",
                    &["query", &key.path, "/v", def.env_name]
                ))
                .await
                .is_err());
        }
        assert_eq!(
            backend.broadcasts.load(std::sync::atomic::Ordering::SeqCst),
            2
        );
        assert_eq!(
            std::fs::read(&value).unwrap(),
            b"private wrapper must remain"
        );
        // All real queries/deletes above use the private Software key; every
        // production User Environment broadcast is intercepted, never executed.
    };
    tokio::time::timeout(std::time::Duration::from_secs(15), run)
        .await
        .expect("original historical 15s budget");
}

#[tokio::test]
async fn windows_native_install_and_upgrade_retire_only_after_publication_before_return_to_start() {
    const TEST: &str = "deployment::runtime_retirement::installer_history_tests::windows_history_tests::windows_native_install_and_upgrade_retire_only_after_publication_before_return_to_start";
    if std::env::var_os(CHILD).is_none() {
        isolated_entry(TEST).await;
        return;
    }
    let home = PathBuf::from(std::env::var_os("HOME").unwrap());
    let f = Fixture::new(&home);
    f.install_wrapper();
    std::fs::create_dir_all(&f.data).unwrap();
    std::fs::write(f.data.join("config.json"), "{}").unwrap();
    let backend = Arc::new(Registry::default());
    let context = Context {
        host: Host::Windows,
        home: home.clone(),
        backend: backend.clone(),
    };
    for commit in ['a', 'b'] {
        for def in WIN_DEFS {
            backend
                .values
                .lock()
                .unwrap()
                .insert(def.env_name.into(), f.wrapper());
        }
        let before = backend.calls.lock().unwrap().len();
        let source = f.package(commit);
        let name = crate::deployment::native_install::run_with_retirement(
            "stage-package",
            f.options(&source),
            context.clone(),
        )
        .await
        .unwrap();
        assert_eq!(
            backend.calls.lock().unwrap().len(),
            before,
            "staging must not retire a runtime override"
        );
        *backend.publication.lock().unwrap() =
            Some((f.cache.join("current"), name.clone(), f.service()));
        let staged = f.cache.join("versions").join(&name);
        crate::deployment::native_install::run_with_retirement(
            "publish-package",
            f.options(&staged),
            context.clone(),
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(f.cache.join("current"))
                .unwrap()
                .trim(),
            name
        );
        assert!(f.service().is_file());
        assert!(backend.values.lock().unwrap().is_empty());
        let calls = backend.calls.lock().unwrap();
        assert_eq!(
            calls[before..]
                .iter()
                .filter(|call| call.program == "reg.exe" && call.args[0] == "query")
                .count(),
            2
        );
        assert_eq!(
            calls[before..]
                .iter()
                .filter(|call| call.program == "reg.exe" && call.args[0] == "delete")
                .count(),
            2
        );
    }
    assert!(
        Path::new(&f.wrapper()).is_file(),
        "retirement leaves the old wrapper resource available"
    );
}

#[cfg(windows)]
#[tokio::test]
async fn windows_native_registry_foreign_unicode_expand_and_non_string_values_remain_private_and_untouched(
) {
    let run =
        async {
            let root = tempfile::tempdir().unwrap();
            let home = root.path().join("用户 O'Brien [foreign]🚀");
            let data = home.join("current data");
            for (index, (kind, value)) in [
                (
                    "REG_SZ",
                    root.path()
                        .join("foreign 用户🚀/runtime.mjs")
                        .to_string_lossy()
                        .into_owned(),
                ),
                (
                    "REG_EXPAND_SZ",
                    r"%USERPROFILE%\loongsuite-pilot\runtime.mjs".to_owned(),
                ),
                ("REG_DWORD", "17".to_owned()),
            ]
            .into_iter()
            .enumerate()
            {
                let key = Arc::new(PrivateKey::new(&format!(
                    "{}-negative-{index}",
                    root.path().file_name().unwrap().to_str().unwrap()
                )));
                let backend = Arc::new(PrivateNative {
                    key: key.clone(),
                    calls: Arc::new(Mutex::new(Vec::new())),
                    broadcasts: std::sync::atomic::AtomicUsize::new(0),
                });
                for def in WIN_DEFS {
                    Native
                        .run(Command::windows(
                            "reg.exe",
                            &[
                                "add",
                                &key.path,
                                "/v",
                                def.env_name,
                                "/t",
                                kind,
                                "/d",
                                &value,
                                "/f",
                            ],
                        ))
                        .await
                        .unwrap();
                }
                let context = Context {
                    host: Host::Windows,
                    home: home.clone(),
                    backend: backend.clone(),
                };
                cleanup_all(&data.to_string_lossy(), &context)
                    .await
                    .unwrap();
                let calls = backend.calls.lock().unwrap().clone();
                assert_eq!(calls.len(), 2);
                assert!(calls.iter().all(|command| command.program == "reg.exe"
                    && command.args[0] == "query"
                    && command.args[1] == r"HKCU\Environment"));
                assert_eq!(
                    backend.broadcasts.load(std::sync::atomic::Ordering::SeqCst),
                    0
                );
                for def in WIN_DEFS {
                    let observed = Native
                        .run(Command::windows(
                            "reg.exe",
                            &["query", &key.path, "/v", def.env_name],
                        ))
                        .await;
                    if kind == "REG_DWORD" {
                        assert!(
                            observed.is_err(),
                            "non-string registry data must never become an owned path"
                        );
                    } else {
                        assert_eq!(parse_windows_user_env(&observed.unwrap(),def.env_name),value,
                        "foreign Unicode and unexpanded literals must remain exact after cleanup");
                    }
                }
            }
            assert!(
                !home.exists(),
                "registry-only refusal must not create or remove wrappers"
            );
        };
    tokio::time::timeout(std::time::Duration::from_secs(15), run)
        .await
        .expect("original historical15s budget");
}
