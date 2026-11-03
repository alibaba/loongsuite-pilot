//! 安装器内部协议；JSON 走有界 stdin 或进程环境，不把凭据放进 argv 或诊断。

use anyhow::{bail, ensure, Context, Result};
use clap::{Arg, ArgAction, ArgMatches, Command};
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::path::Path;

use super::installer_config::{changed_fields, merge, validate_probes, Options, ENV_OPTIONS};
use crate::utils::runtime_paths::runtime_metadata;

const MAX_BYTES: u64 = 4 * 1024 * 1024;
const INPUT_ENV: &str = "LOONGSUITE_PILOT_INSTALL_INPUT";

fn input_command(name: &'static str) -> Command {
    Command::new(name).arg(
        Arg::new("input-env")
            .long("input-env")
            .action(ArgAction::SetTrue),
    )
}
pub(crate) fn command() -> Command {
    Command::new("installer-helper")
        .hide(true)
        .subcommand_required(true)
        .subcommands(
            [
                "write-config",
                "config-diffs",
                "validate-config",
                "check-config",
            ]
            .map(|name| {
                input_command(name).arg(
                    Arg::new("from-env")
                        .long("from-env")
                        .action(ArgAction::SetTrue)
                        .conflicts_with("input-env"),
                )
            }),
        )
        .subcommands(["probe-count", "probe-detected"].map(input_command))
        .subcommands(
            [
                "stage-package",
                "sync-service",
                "publish-package",
                "rollback-package",
            ]
            .map(|name| {
                let command = input_command(name).arg(
                    Arg::new("from-env")
                        .long("from-env")
                        .action(ArgAction::SetTrue)
                        .conflicts_with("input-env"),
                );
                if matches!(name, "sync-service" | "rollback-package") {
                    command
                } else {
                    command
                        .arg(
                            Arg::new("with-config")
                                .long("with-config")
                                .action(ArgAction::SetTrue)
                                .requires("from-env"),
                        )
                        .arg(
                            Arg::new("deploy-hooks")
                                .long("deploy-hooks")
                                .action(ArgAction::SetTrue),
                        )
                }
            }),
        )
        .subcommand(
            input_command("cleanup-agents")
                .arg(
                    Arg::new("data-dir")
                        .long("data-dir")
                        .conflicts_with("input-env"),
                )
                .arg(Arg::new("pilot-dir").long("pilot-dir").requires("data-dir"))
                .arg(
                    Arg::new("purge")
                        .long("purge")
                        .action(ArgAction::SetTrue)
                        .requires("data-dir"),
                )
                .arg(
                    Arg::new("check-only")
                        .long("check-only")
                        .action(ArgAction::SetTrue)
                        .requires("data-dir"),
                ),
        )
        .subcommand(
            input_command("probe-menu").arg(
                Arg::new("lang")
                    .long("lang")
                    .value_parser(["zh", "en"])
                    .default_value("en"),
            ),
        )
        .subcommand(
            input_command("probe-select")
                .arg(Arg::new("selection").long("selection").default_value("")),
        )
        .subcommand(
            Command::new("read-user-id")
                .arg(Arg::new("config").long("config").required(true))
                .arg(
                    Arg::new("ascii-json")
                        .long("ascii-json")
                        .action(ArgAction::SetTrue),
                ),
        )
        .subcommand(
            Command::new("json-argv").arg(
                Arg::new("values")
                    .last(true)
                    .num_args(0..)
                    .allow_hyphen_values(true),
            ),
        )
}

pub(super) fn parse_json(raw: &str) -> Result<Value> {
    ensure!(raw.len() as u64 <= MAX_BYTES, "安装输入超过大小上限");
    // serde 的错误可能引用输入内容；只暴露位置，不携带错误链或原文。
    serde_json::from_str(raw.strip_prefix('\u{feff}').unwrap_or(raw)).map_err(|error| {
        anyhow::anyhow!(
            "安装 JSON 无效（行 {}，列 {}）；未修改文件",
            error.line(),
            error.column()
        )
    })
}
fn input(args: &ArgMatches) -> Result<Value> {
    let raw = if args.get_flag("input-env") {
        std::env::var(INPUT_ENV).context("缺少安装输入环境变量")?
    } else {
        let mut raw = String::new();
        std::io::stdin()
            .lock()
            .take(MAX_BYTES + 1)
            .read_to_string(&mut raw)
            .context("无法读取安装 stdin")?;
        raw
    };
    parse_json(&raw)
}
fn options(args: &ArgMatches) -> Result<Options> {
    if !args.get_flag("from-env") {
        return Options::new(input(args)?);
    }
    let mut values = serde_json::Map::new();
    for (key, env) in ENV_OPTIONS {
        if let Ok(value) = std::env::var(env) {
            values.insert((*key).into(), json!(value));
        }
    }
    if let Ok(value) = std::env::var("LP_EXCLUDE_WORKSPACES") {
        if !value.is_empty() {
            values.insert("excludeWorkspaces".into(), parse_json(&value)?);
        }
    }
    values.insert("probeResult".into(), input(args)?);
    Options::new(Value::Object(values))
}

pub(crate) async fn run(args: &ArgMatches) -> Result<i32> {
    let (name, args) = args.subcommand().context("缺少安装辅助操作")?;
    let output = match name {
        "cleanup-agents" => {
            let value = if let Some(data) = args.get_one::<String>("data-dir") {
                let mut value = json!({"dataDir":data,"purge":args.get_flag("purge"),"checkOnly":args.get_flag("check-only")});
                if let Some(root) = args.get_one::<String>("pilot-dir") {
                    value["pilotDir"] = json!(root);
                }
                value
            } else {
                input(args)?
            };
            super::native_uninstall::run(value).await?
        }
        "stage-package" | "sync-service" | "publish-package" | "rollback-package" => {
            let mut value = if args.get_flag("from-env") {
                let mut values = serde_json::Map::new();
                for (key, env) in [
                    ("sourceDir", "LP_SOURCE_DIR"),
                    ("cacheDir", "LP_CACHE_DIR"),
                    ("dataDir", "LP_DATA_DIR"),
                    ("configPath", "LP_CONFIG_PATH"),
                    ("binDir", "LP_BIN_DIR"),
                ] {
                    if let Ok(value) = std::env::var(env) {
                        values.insert(key.into(), json!(value));
                    }
                }
                Value::Object(values)
            } else {
                input(args)?
            };
            ensure!(value.is_object(), "原生安装路径参数必须为对象");
            if matches!(name, "stage-package" | "publish-package") {
                if args.get_flag("with-config") {
                    value["configOptions"] = Value::Object(options(args)?.0);
                }
                if args.get_flag("deploy-hooks") {
                    value["deployHooks"] = json!(true);
                }
            }
            super::native_install::run(name, value).await?
        }
        "check-config" => {
            let options = options(args)?;
            let path = options.text("configPath");
            ensure!(Path::new(&path).is_absolute(), "configPath 必须为绝对路径");
            let config = read_config(Path::new(&path))?.1;
            ensure!(
                !config.get("sls").is_some_and(Value::is_array),
                "Multiple SLS flushers found; 配置包含多个 SLS flusher；安装器不支持修改，请手动编辑 config.json"
            );
            String::new()
        }
        "write-config" | "config-diffs" | "validate-config" => {
            let options = options(args)?;
            let config = options.text("configPath");
            let path = Path::new(&config);
            ensure!(path.is_absolute(), "configPath 必须为绝对路径");
            if name == "write-config" {
                write_config(path, &options).await?;
                String::new()
            } else {
                let old = read_config(path)?.1;
                let merged = merge(&old, &options)?;
                if name == "validate-config" {
                    String::new()
                } else {
                    changed_fields(&old, &merged)
                }
            }
        }
        "read-user-id" => {
            let path = Path::new(args.get_one::<String>("config").context("缺少配置路径")?);
            ensure!(path.is_absolute(), "配置路径必须为绝对路径");
            let config = read_config(path)?.1;
            let user_id = config
                .get("userId")
                .or_else(|| config.get("user.id"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if args.get_flag("ascii-json") {
                // Windows PowerShell 5.1 decodes native stdout using its console
                // code page. JSON Unicode escapes survive that boundary in CLM
                // without changing global console encoding or writing secrets.
                let json = serde_json::to_string(user_id)?;
                let mut ascii = String::with_capacity(json.len());
                for ch in json.chars() {
                    if ch.is_ascii() {
                        ascii.push(ch);
                    } else {
                        use std::fmt::Write;
                        for unit in ch.encode_utf16(&mut [0; 2]) {
                            write!(&mut ascii, "\\u{unit:04x}")?;
                        }
                    }
                }
                ascii
            } else {
                user_id.to_owned()
            }
        }
        "json-argv" => serde_json::to_string(
            &args
                .get_many::<String>("values")
                .map(|v| v.collect::<Vec<_>>())
                .unwrap_or_default(),
        )?,
        "probe-count" | "probe-detected" | "probe-menu" | "probe-select" => {
            let probes = validate_probes(input(args)?)?;
            match name {
                "probe-count" => probes.len().to_string(),
                "probe-menu" => menu(
                    &probes,
                    args.get_one::<String>("lang").is_some_and(|v| v == "zh"),
                ),
                "probe-select" => selection(
                    &probes,
                    args.get_one::<String>("selection")
                        .map(String::as_str)
                        .unwrap_or(""),
                )?,
                _ => selection(&probes, "")?,
            }
        }
        _ => bail!("未知安装辅助操作"),
    };
    if !output.is_empty() {
        println!("{output}");
    }
    Ok(0)
}

fn selection(probes: &[Value], raw: &str) -> Result<String> {
    let mut indices = std::collections::BTreeSet::new();
    if raw.trim().is_empty() {
        for (i, probe) in probes.iter().enumerate() {
            if probe["detected"] == true {
                indices.insert(i);
            }
        }
    } else {
        for part in raw
            .split(|c: char| c.is_whitespace() || ",，、；".contains(c))
            .filter(|p| !p.is_empty())
        {
            let number = part
                .parse::<usize>()
                .ok()
                .filter(|n| *n > 0 && *n <= probes.len())
                .context("Agent 选择包含无效编号")?;
            indices.insert(number - 1);
        }
    }
    Ok(indices
        .into_iter()
        .filter_map(|i| probes[i]["id"].as_str())
        .collect::<Vec<_>>()
        .join(","))
}
fn menu(probes: &[Value], chinese: bool) -> String {
    let mut result = String::new();
    let mut defaults = Vec::new();
    for (i, probe) in probes.iter().enumerate() {
        let detected = probe["detected"] == true;
        let status = match (chinese, detected) {
            (true, true) => "已检测到",
            (true, false) => "未检测到",
            (false, true) => "detected",
            (false, false) => "not detected",
        };
        let clean = |key| {
            probe
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .chars()
                .filter(|c| !c.is_control())
                .take(512)
                .collect::<String>()
        };
        result.push_str(&format!(
            "    [{}] {:16}({}: {})\n",
            i + 1,
            clean("displayName"),
            status,
            clean("reason")
        ));
        if detected {
            defaults.push((i + 1).to_string());
        }
    }
    if chinese {
        result.push_str(&format!("\n    默认选择已检测到的 Agent: {}\n    输入要启用的编号 (逗号分隔)，直接回车使用默认:", defaults.join(",")));
    } else {
        result.push_str(&format!("\n    Default selection (detected): {}\n    Enter numbers to enable (comma-separated), press Enter for default:", defaults.join(",")));
    }
    result
}

pub(crate) fn read_config(path: &Path) -> Result<(Option<Vec<u8>>, Value)> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((None, json!({}))),
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    let metadata = runtime_metadata(path)?;
    ensure!(
        metadata.is_file() && metadata.len() <= MAX_BYTES,
        "配置必须为大小受限的普通文件"
    );
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    ensure!(metadata.is_file(), "配置不是普通文件");
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        ensure!(
            metadata.file_attributes() & 0x400 == 0,
            "配置不能为 reparse point"
        );
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= MAX_BYTES, "配置超过大小上限");
    let text = std::str::from_utf8(&bytes).context("配置不是 UTF-8")?;
    let value = parse_json(text)?;
    ensure!(value.is_object(), "配置必须为 JSON 对象；保留原文件");
    Ok((Some(bytes), value))
}

pub(crate) fn encode_config(original: Option<&[u8]>, old: &Value, next: &Value) -> Result<Vec<u8>> {
    if old == next {
        if let Some(bytes) = original {
            return Ok(bytes.to_vec());
        }
    }
    let mut bytes = if original.is_some_and(|bytes| bytes.starts_with(b"\xef\xbb\xbf")) {
        vec![0xef, 0xbb, 0xbf]
    } else {
        Vec::new()
    };
    bytes.extend(serde_json::to_vec_pretty(next)?);
    bytes.push(b'\n');
    ensure!(bytes.len() as u64 <= MAX_BYTES, "合并后的配置超过大小上限");
    Ok(bytes)
}

async fn write_config(path: &Path, options: &Options) -> Result<()> {
    // 在创建目录和锁之前验证已有配置与全部选项。
    merge(&read_config(path)?.1, options)?;
    with_config_lock(path, || async {
        update_config_locked(path, |old| merge(old, options))?;
        Ok(())
    })
    .await
}

/// 安装和更新共用同一路径锁；锁顺序为 update → service → config。
pub(crate) async fn with_config_lock<T, Fut>(path: &Path, body: impl FnOnce() -> Fut) -> Result<T>
where
    Fut: std::future::Future<Output = Result<T>>,
{
    ensure!(path.is_absolute(), "配置路径必须为绝对路径");
    let parent = path.parent().context("配置缺少父目录")?;
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(parent)?;
    let lock = path.with_extension("json.lock");
    super::with_deployed_state_lock(lock.to_str().context("锁路径编码无效")?, body, 5_000).await
}

/// 调用方必须持有 config 锁；不能在已持锁的激活流程内再次获取同一锁。
pub(crate) fn update_config_locked(
    path: &Path,
    apply: impl FnOnce(&Value) -> Result<Value>,
) -> Result<Value> {
    let (original, old) = read_config(path)?;
    let next = apply(&old)?;
    ensure!(next.is_object(), "配置必须为 JSON 对象");
    if original.is_some() && old == next {
        return Ok(next);
    }
    let parent = path.parent().context("配置缺少父目录")?;
    let bytes = encode_config(original.as_deref(), &old, &next)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    if original.is_some() {
        let permissions = runtime_metadata(path)?.permissions();
        ensure!(!permissions.readonly(), "配置为只读；保留原文件");
        temporary.as_file().set_permissions(permissions)?;
    }
    temporary.write_all(&bytes)?;
    temporary.as_file().sync_all()?;
    ensure!(
        read_config(path)?.0 == original,
        "配置被并发修改；已中止写入"
    );
    temporary.persist(path).map_err(|error| error.error)?;
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probes_are_strict_and_selection_normalizes_chinese_punctuation() {
        let probes = validate_probes(
            json!([{"id":"cursor", "detected":true}, {"id":"codex", "detected":false}]),
        )
        .unwrap();
        assert_eq!(selection(&probes, "").unwrap(), "cursor");
        assert_eq!(selection(&probes, "2，1；2").unwrap(), "cursor,codex");
        assert!(selection(&probes, "3").is_err());
        assert!(selection(&probes, "typo").is_err());
        for bad in [
            json!({}),
            json!([{}]),
            json!([{"id":"x","detected":"true"}]),
            json!([{"id":"x","detected":true},{"id":"x","detected":false}]),
        ] {
            assert!(validate_probes(bad).is_err());
        }
    }

    #[tokio::test]
    async fn config_is_atomic_private_idempotent_and_preserves_corruption() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("数据 O'Brien 🚀/config.json");
        let options =
            Options::new(json!({"dataDir":path.parent().unwrap(), "userId":"研发 🚀"})).unwrap();
        write_config(&path, &options).await.unwrap();
        let first = fs::read(&path).unwrap();
        write_config(&path, &options).await.unwrap();
        assert_eq!(first, fs::read(&path).unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        }
        fs::write(&path, b"\xef\xbb\xbf{\"custom\":\"keep\"}").unwrap();
        write_config(&path, &options).await.unwrap();
        assert!(fs::read(&path).unwrap().starts_with(b"\xef\xbb\xbf"));
        assert_eq!(read_config(&path).unwrap().1["custom"], "keep");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o640
            );
        }
        for broken in ["{\"secret\":\"do-not-print\",broken}", "[]", ""] {
            fs::write(&path, broken).unwrap();
            let error = write_config(&path, &options).await.unwrap_err();
            assert!(!format!("{error:#}").contains("do-not-print"));
            assert_eq!(fs::read_to_string(&path).unwrap(), broken);
        }
    }

    #[tokio::test]
    async fn concurrent_config_updates_keep_both_changes() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("config.json");
        let a = Options::new(json!({"dataDir":root.path(), "userId":"a"})).unwrap();
        let b = Options::new(json!({"dataDir":root.path(), "logLevel":"debug"})).unwrap();
        let (a, b) = tokio::join!(write_config(&path, &a), write_config(&path, &b));
        a.unwrap();
        b.unwrap();
        let result = read_config(&path).unwrap().1;
        assert_eq!(result["userId"], "a");
        assert_eq!(result["logLevel"], "debug");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlink_config_is_rejected_without_touching_its_target() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("user.json");
        let path = root.path().join("config.json");
        fs::write(&target, "{}").unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        let options = Options::new(json!({"dataDir":root.path()})).unwrap();
        assert!(write_config(&path, &options).await.is_err());
        assert_eq!(fs::read_to_string(target).unwrap(), "{}");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
    }
}
