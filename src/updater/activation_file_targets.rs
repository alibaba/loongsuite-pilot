//! Physical target binding shared by resource preparation and durable file recovery.
use anyhow::{ensure, Context, Result};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) const RESOURCE_PREFIX: &str = "runtime-resource:";
pub(crate) const DSH_MARKER: &str = "runtime-resource:plugins/dsh/.collection-enabled";

pub(crate) fn bind(path: &Path) -> Result<PathBuf> {
    ensure!(path.is_absolute(), "更新目标必须为绝对路径");
    let leaf = path.file_name().context("更新目标缺少文件名")?.to_owned();
    let mut parent = path.parent().context("更新目标缺少父目录")?;
    let mut tail = Vec::new();
    let mut bound = loop {
        match fs::canonicalize(parent) {
            Ok(bound) => break bound,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                tail.push(
                    parent
                        .file_name()
                        .context("更新路径含无法绑定的祖先")?
                        .to_owned(),
                );
                parent = parent.parent().context("更新路径缺少可绑定祖先")?;
            }
            Err(error) => return Err(error.into()),
        }
    };
    for component in tail.into_iter().rev() {
        bound.push(component);
    }
    bound.push(leaf);
    Ok(bound)
}

fn identity(path: &Path) -> Vec<String> {
    #[cfg(windows)]
    {
        let raw = path.to_string_lossy().replace('/', "\\");
        let raw = raw
            .strip_prefix("\\\\?\\UNC\\")
            .map(|tail| format!("\\\\{tail}"))
            .unwrap_or_else(|| raw.strip_prefix("\\\\?\\").unwrap_or(&raw).to_owned());
        return Path::new(&raw)
            .components()
            .map(|part| {
                let value = part.as_os_str().to_string_lossy().into_owned();
                if value.len() == 2 && value.ends_with(':') {
                    value.to_ascii_uppercase()
                } else {
                    value
                }
            })
            .collect();
    }
    #[cfg(not(windows))]
    path.components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect()
}

pub(crate) fn same(left: &Path, right: &Path) -> bool {
    identity(left) == identity(right)
}
pub(crate) fn ensure_bound(path: &Path) -> Result<()> {
    ensure!(
        same(path, &bind(path)?),
        "更新目标祖先已变化，保留恢复材料：{}",
        path.display()
    );
    Ok(())
}

pub(crate) fn bind_all(paths: BTreeMap<String, PathBuf>) -> Result<BTreeMap<String, PathBuf>> {
    paths
        .into_iter()
        .map(|(key, path)| Ok((key, bind(&path)?)))
        .collect()
}

pub(crate) fn validate(paths: &BTreeMap<String, PathBuf>, journal: &Path) -> Result<()> {
    let paths: Vec<_> = paths.values().collect();
    let journal: Vec<_> = identity(journal)
        .into_iter()
        .map(|part| part.to_lowercase())
        .collect();
    for (index, path) in paths.iter().enumerate() {
        let path: Vec<_> = identity(path)
            .into_iter()
            .map(|part| part.to_lowercase())
            .collect();
        ensure!(
            !path.starts_with(&journal) && !journal.starts_with(&path),
            "文件目标与恢复记录重叠"
        );
        for other in &paths[..index] {
            let other: Vec<_> = identity(other)
                .into_iter()
                .map(|part| part.to_lowercase())
                .collect();
            ensure!(
                !path.starts_with(&other) && !other.starts_with(&path),
                "更新文件目标身份重复或存在祖先重叠"
            );
        }
    }
    Ok(())
}

/// Check write permission explicitly; uid 0 must not bypass a deliberate read-only parent.
pub(crate) fn writable_parent(path: &Path) -> Result<()> {
    let mut parent = path.parent().context("更新文件缺少父目录")?;
    loop {
        match fs::symlink_metadata(parent) {
            Ok(_) => {
                let meta = crate::utils::runtime_paths::runtime_metadata(parent)?;
                ensure!(
                    meta.is_dir() && !meta.permissions().readonly(),
                    "更新父目录为只读或类型无效：{}",
                    parent.display()
                );
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                parent = parent.parent().context("更新文件没有可写祖先")?
            }
            Err(error) => return Err(error.into()),
        }
    }
}

pub(crate) fn resource_lock(paths: &BTreeMap<String, PathBuf>) -> Result<Option<fs::File>> {
    let mut data = None::<PathBuf>;
    for (key, path) in paths {
        let Some(relative) = key.strip_prefix(RESOURCE_PREFIX) else {
            continue;
        };
        let mut root = path.clone();
        for expected in relative.split('/').rev() {
            ensure!(
                !expected.is_empty()
                    && expected != "."
                    && expected != ".."
                    && !expected.contains(['\\', ':']),
                "运行资源角色无效"
            );
            ensure!(root.pop(), "资源角色路径无效");
        }
        ensure!(
            same(path, &bind(&root.join(relative))?),
            "运行资源角色与目标路径不匹配"
        );
        if let Some(data) = &data {
            ensure!(same(data, &root), "运行资源不属于同一个数据根");
        } else {
            data = Some(root);
        }
    }
    let Some(data) = data else {
        return Ok(None);
    };
    let lock = data.join(".plugin-assets.lock");
    ensure_bound(&lock)?;
    writable_parent(&lock)?;
    fs::create_dir_all(&data)?;
    let started = std::time::Instant::now();
    loop {
        if let Some(file) = crate::deployment::open_state_lock(&lock)? {
            match fs2::FileExt::try_lock_exclusive(&file) {
                Ok(()) => return Ok(Some(file)),
                Err(error)
                    if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {}
                Err(error) => return Err(error.into()),
            }
        }
        ensure!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "运行资源锁等待超时"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}
