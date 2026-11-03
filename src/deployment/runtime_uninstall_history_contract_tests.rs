use super::*;

#[derive(Default)]
struct WindowsRegistry {
    env: Mutex<BTreeMap<String, String>>,
    calls: Mutex<Vec<Command>>,
}
impl Backend for WindowsRegistry {
    fn run(&self, command: Command) -> BoxFut<Result<String, String>> {
        self.calls.lock().unwrap().push(command.clone());
        let result = match command.program {
            "reg.exe" if command.args[0] == "query" => self
                .env
                .lock()
                .unwrap()
                .get(&command.args[3])
                .map(|value| format!("    {}    REG_SZ    {value}\r\n", command.args[3]))
                .ok_or_else(|| "absent".into()),
            "reg.exe" if command.args[0] == "delete" => {
                self.env.lock().unwrap().remove(&command.args[3]);
                Ok(String::new())
            }
            "powershell.exe" => Ok(String::new()),
            _ => panic!("unexpected runtime installation effect: {command:?}"),
        };
        Box::pin(async move { result })
    }
}
#[tokio::test]
async fn cleanup_l959_real_uninstall_preserves_the_separate_default_install_and_only_retires_current_data(
) {
    if std::env::var_os(CHILD).is_some() {
        let home = PathBuf::from(std::env::var_os("HOME").unwrap());
        let legacy_data = home.join(".loongsuite-pilot");
        fs::create_dir_all(legacy_data.join("versions/other-live")).unwrap();
        fs::create_dir_all(legacy_data.join("hooks")).unwrap();
        fs::write(legacy_data.join("current"), "other-live\n").unwrap();
        let legacy = wrapper(&legacy_data.to_string_lossy());
        fs::write(&legacy, "separate default install runtime").unwrap();
        for host in [Host::Mac, Host::Windows] {
            for ownership in ["current", "default", "mixed", "foreign"] {
                let f = Fixture::new(&home);
                f.install_wrapper();
                let windows = Arc::new(WindowsRegistry::default());
                let mut expected = BTreeMap::new();
                let mut original_plists = Vec::new();
                for (index, def) in definitions(host).iter().enumerate() {
                    let path = match ownership {
                        "current" => f.wrapper(),
                        "default" => legacy.clone(),
                        "mixed" if index == 0 => f.wrapper(),
                        "mixed" => legacy.clone(),
                        _ => home
                            .join("vendor-loongsuite-pilot/runtime.mjs")
                            .to_string_lossy()
                            .into_owned(),
                    };
                    if path != f.wrapper() {
                        expected.insert(def.env_name.to_owned(), path.clone());
                    }
                    if host == Host::Mac {
                        f.backend
                            .env
                            .lock()
                            .unwrap()
                            .insert(def.env_name.to_owned(), path.clone());
                        let bytes = historical(def, &path).into_bytes();
                        fs::write(f.plist(def), &bytes).unwrap();
                        original_plists.push((f.plist(def), bytes, path == f.wrapper()));
                    } else {
                        windows
                            .env
                            .lock()
                            .unwrap()
                            .insert(def.env_name.to_owned(), path);
                    }
                }
                let context = if host == Host::Mac {
                    f.context()
                } else {
                    Context {
                        host,
                        home: home.clone(),
                        backend: windows.clone(),
                    }
                };
                let result = super::super::super::native_uninstall::run_with_retirement(
                    json!({"dataDir":f.data,"pilotDir":env!("CARGO_MANIFEST_DIR")}),
                    context,
                )
                .await
                .unwrap();
                let result: Value = serde_json::from_str(&result).unwrap();
                assert_eq!(result["ok"], true);
                let actual = if host == Host::Mac {
                    f.backend.env.lock().unwrap().clone()
                } else {
                    windows.env.lock().unwrap().clone()
                };
                assert_eq!(actual, expected, "host={host:?} ownership={ownership}");
                for (path, bytes, owned) in original_plists {
                    if owned {
                        assert!(!path.exists());
                    } else {
                        assert_eq!(fs::read(path).unwrap(), bytes);
                    }
                }
                assert_eq!(
                    fs::read(&legacy).unwrap(),
                    b"separate default install runtime"
                );
                assert_eq!(
                    fs::read(legacy_data.join("current")).unwrap(),
                    b"other-live\n"
                );
                assert!(Path::new(&f.wrapper()).is_file());
            }
        }
        return;
    }
    isolated_entry("deployment::runtime_retirement::installer_history_tests::uninstall_history_contract_tests::cleanup_l959_real_uninstall_preserves_the_separate_default_install_and_only_retires_current_data").await;
}
