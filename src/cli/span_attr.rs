//! 自定义 Trace 属性的原生管理入口，读操作不创建目录或锁。

use anyhow::{bail, ensure, Context, Result};
use serde_json::{Map, Value};
use std::fs;
use std::io::{Read, Write};
use std::path::Path;

use crate::deployment::with_deployed_state_lock;
use crate::normalization::is_reserved_key;
use crate::utils::runtime_paths::runtime_metadata;

const MAX_BYTES: u64 = 4 * 1024 * 1024;

fn read(path: &Path) -> Result<Map<String, Value>> {
    match fs::symlink_metadata(path) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(err) => return Err(err.into()),
        Ok(_) => {}
    }
    let metadata = runtime_metadata(path)?;
    ensure!(
        metadata.is_file() && metadata.len() <= MAX_BYTES,
        "属性文件无效或过大"
    );
    let mut text = String::new();
    fs::File::open(path)?
        .take(MAX_BYTES + 1)
        .read_to_string(&mut text)?;
    ensure!(text.len() as u64 <= MAX_BYTES, "属性文件过大");
    let value: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .context("属性文件 JSON 无效；保留原文件，请修复或显式 clear")?;
    value
        .as_object()
        .cloned()
        .context("属性文件必须为 JSON 对象")
}

fn write(path: &Path, data: &Map<String, Value>) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(data)?;
    bytes.push(b'\n');
    ensure!(bytes.len() as u64 <= MAX_BYTES, "属性文件过大");
    let mut temporary = tempfile::NamedTempFile::new_in(path.parent().context("属性目录缺失")?)?;
    if path.exists() {
        temporary
            .as_file()
            .set_permissions(runtime_metadata(path)?.permissions())?;
    }
    temporary.write_all(&bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path)?;
    Ok(())
}

pub(crate) async fn run(args: &clap::ArgMatches) -> Result<i32> {
    let path = Path::new(&crate::utils::resolve_data_dir(None)).join("span-attributes.json");
    let (operation, values) = args.subcommand().context("缺少属性操作")?;
    let key = if matches!(operation, "set" | "unset") {
        values.get_one::<String>("key").map(String::as_str)
    } else {
        None
    };
    let value = if operation == "set" {
        values.get_one::<String>("value").map(String::as_str)
    } else {
        None
    };
    println!("{}", apply(&path, operation, key, value).await?);
    Ok(0)
}

async fn apply(
    path: &Path,
    operation: &str,
    key: Option<&str>,
    value: Option<&str>,
) -> Result<String> {
    // 先验证参数，避免失败请求也留下锁或空目录。
    match operation {
        "set" => {
            let key = key.filter(|key| !key.is_empty()).context("缺少属性键")?;
            ensure!(!is_reserved_key(key), "属性键使用了保留前缀：{key}");
            ensure!(value.is_some(), "缺少属性值");
        }
        "unset" => {
            ensure!(key.is_some_and(|key| !key.is_empty()), "缺少属性键");
        }
        "list" => {
            let data = read(path)?;
            return Ok(if data.is_empty() {
                "(no custom span attributes)".into()
            } else {
                data.iter()
                    .map(|(key, value)| {
                        format!(
                            "{key}={}",
                            value
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| value.to_string())
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            });
        }
        "clear" => {}
        _ => bail!("未知属性操作"),
    }
    let parent = path.parent().context("属性目录缺失")?;
    fs::create_dir_all(parent)?;
    let lock = path.with_extension("json.lock");
    with_deployed_state_lock(
        lock.to_str().context("属性锁路径编码无效")?,
        || async {
            if operation == "clear" {
                match fs::symlink_metadata(path) {
                    Ok(_) => {
                        ensure!(runtime_metadata(path)?.is_file(), "属性文件不是普通文件");
                        fs::remove_file(path)?;
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                    Err(err) => return Err(err.into()),
                }
                return Ok(format!(
                    "cleared custom span attributes ({})",
                    path.display()
                ));
            }
            let mut data = read(path)?;
            let key = key.context("缺少属性键")?;
            if operation == "set" {
                let value = value.context("缺少属性值")?;
                data.insert(key.into(), Value::String(value.into()));
                write(path, &data)?;
                Ok(format!("set {key}={value}"))
            } else if data.shift_remove(key).is_some() {
                write(path, &data)?;
                Ok(format!("unset {key}"))
            } else {
                Ok(format!("(no such key: {key})"))
            }
        },
        5_000,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn roundtrip_unicode_empty_values_reserved_keys_and_read_only_list() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("属性 🚀/span-attributes.json");
        assert_eq!(
            apply(&path, "list", None, None).await.unwrap(),
            "(no custom span attributes)"
        );
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
        assert!(apply(&path, "set", Some("gen_ai.name"), Some("坏"))
            .await
            .is_err());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
        apply(&path, "set", Some("team"), Some("研发🚀"))
            .await
            .unwrap();
        apply(&path, "set", Some("empty"), Some("")).await.unwrap();
        assert_eq!(
            apply(&path, "list", None, None).await.unwrap(),
            "team=研发🚀\nempty="
        );
        apply(&path, "unset", Some("team"), None).await.unwrap();
        assert_eq!(read(&path).unwrap().len(), 1);
        apply(&path, "clear", None, None).await.unwrap();
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn corrupt_files_are_preserved_and_parallel_writers_merge() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("span-attributes.json");
        fs::write(&path, "broken").unwrap();
        assert!(apply(&path, "set", Some("team"), Some("x")).await.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "broken");
        apply(&path, "clear", None, None).await.unwrap();
        let (a, b) = tokio::join!(
            apply(&path, "set", Some("a"), Some("1")),
            apply(&path, "set", Some("b"), Some("2")),
        );
        a.unwrap();
        b.unwrap();
        assert_eq!(read(&path).unwrap().len(), 2);
    }
}
