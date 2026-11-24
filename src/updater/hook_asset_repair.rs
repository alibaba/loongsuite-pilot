//! Collector-side integrity checks and updater-owned Hook asset restoration.
use crate::deployment::hook_assets::{read_hook_manifest, safe_destination};
use crate::utils::runtime_paths::{resource_file, runtime_metadata, sha256_file};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const REQUEST: &str = "hook-restore-request.json";
const MAX_ASSET: u64 = 4 * 1024 * 1024;
const MAX_REQUEST: u64 = 64 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Request {
    schema: u8,
    pub pilot_dir: PathBuf,
    pub paths: Vec<String>,
}

fn expected_assets(pilot: &Path) -> Result<BTreeMap<String, String>> {
    let mut assets = BTreeMap::new();
    for resource in read_hook_manifest(pilot)?.resources {
        let Some(name) = resource.path.strip_prefix("assets/hooks/") else {
            continue;
        };
        if !matches!(
            Path::new(name).extension().and_then(|ext| ext.to_str()),
            Some("sh" | "ps1")
        ) {
            continue;
        }
        ensure!(
            resource.sha256.len() == 64
                && resource.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "invalid Hook asset hash"
        );
        ensure!(
            assets.insert(name.to_owned(), resource.sha256).is_none(),
            "duplicate Hook asset"
        );
    }
    Ok(assets)
}

fn active(pilot: &Path, cache: &Path) -> bool {
    resource_file(cache, "current")
        .ok()
        .filter(|path| fs::metadata(path).is_ok_and(|meta| meta.len() < 4096))
        .and_then(|path| fs::read_to_string(path).ok())
        .is_some_and(|name| pilot.file_name().is_some_and(|file| file == name.trim()))
}

fn bounded_hash(path: &Path) -> Result<String> {
    let stat = runtime_metadata(path)?;
    ensure!(
        stat.is_file() && stat.len() <= MAX_ASSET,
        "invalid Hook asset size or type"
    );
    sha256_file(path)
}

fn healthy(path: &Path, expected: &str) -> bool {
    if !bounded_hash(path).is_ok_and(|actual| actual.eq_ignore_ascii_case(expected)) {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).is_ok_and(|meta| meta.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    true
}

/// Detect deleted scripts for installed agents and modifications to deployed scripts.
pub(crate) async fn report(pilot: &Path, data: &Path, managed: &BTreeSet<String>) -> Result<bool> {
    let Some(versions) = pilot.parent().filter(|parent| parent.ends_with("versions")) else {
        return Ok(false);
    };
    let Some(cache) = versions.parent() else {
        return Ok(false);
    };
    if !active(pilot, cache) {
        return Ok(false);
    }
    crate::deployment::with_deployed_state_lock(
        &cache.join("update.lock").to_string_lossy(),
        || async {
            let mut paths = Vec::new();
            for (name, expected) in expected_assets(pilot)? {
                let Ok(path) = safe_destination(data, &name) else {
                    continue;
                };
                if (path.exists() || managed.contains(&name)) && !healthy(&path, &expected) {
                    paths.push(name);
                }
            }
            if paths.is_empty() || !active(pilot, cache) {
                return Ok(false);
            }
            let request = Request {
                schema: 1,
                pilot_dir: pilot.into(),
                paths,
            };
            let value = serde_json::to_string(&request)?;
            crate::utils::write_text_file_atomic(
                cache
                    .join(REQUEST)
                    .to_str()
                    .context("invalid Hook restore request path")?,
                &value,
                &crate::utils::AtomicTextWriteOptions {
                    mode: Some(0o600),
                    ..Default::default()
                },
            )
            .await?;
            tracing::warn!(paths = ?request.paths, "Hook asset repair requested");
            Ok(true)
        },
        25,
    )
    .await
}

pub(super) fn request(cache: &Path) -> Result<Option<Request>> {
    let request_path = cache.join(REQUEST);
    match fs::symlink_metadata(&request_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        info => {
            info?;
        }
    }
    let path = resource_file(cache, REQUEST)?;
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(MAX_REQUEST + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_REQUEST,
        "Hook restore request is too large"
    );
    let request: Request = serde_json::from_slice(&bytes)?;
    ensure!(request.schema == 1, "invalid Hook restore request schema");
    Ok(Some(request))
}

pub(super) fn settle(cache: &Path) -> Result<()> {
    match fs::remove_file(cache.join(REQUEST)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn write_script(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let directory = path
        .parent()
        .context("Hook asset has no parent directory")?;
    let mut temp = tempfile::NamedTempFile::new_in(directory)?;
    temp.write_all(bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(0o755))?;
    }
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|error| error.error)?;
    Ok(())
}

pub(super) async fn restore(
    request: &Request,
    data: &Path,
    recovered_package: Option<&Path>,
) -> Result<bool> {
    let pilot = &request.pilot_dir;
    let expected = expected_assets(pilot)?;
    let lock = data.join(".hook-assets.lock");
    crate::deployment::with_deployed_state_lock(
        lock.to_str().context("invalid Hook asset lock")?,
        || async {
            let mut complete = true;
            for name in &request.paths {
                let Some(hash) = expected.get(name) else {
                    continue;
                };
                let target = safe_destination(data, name)?;
                if healthy(&target, hash) {
                    continue;
                }
                let relative = format!("assets/hooks/{name}");
                let installed = resource_file(pilot, &relative);
                let (source, rebuild_installed) = match (installed, recovered_package) {
                    (Ok(path), _)
                        if bounded_hash(&path)
                            .is_ok_and(|actual| actual.eq_ignore_ascii_case(hash)) =>
                    {
                        (path, false)
                    }
                    (_, Some(package)) => (resource_file(package, &relative)?, true),
                    _ => {
                        complete = false;
                        continue;
                    }
                };
                let bytes = fs::read(&source)?;
                use sha2::{Digest, Sha256};
                ensure!(
                    bytes.len() as u64 <= MAX_ASSET
                        && hex::encode(Sha256::digest(&bytes)).eq_ignore_ascii_case(hash),
                    "Hook asset changed during read"
                );
                if rebuild_installed {
                    let root = pilot.join("assets");
                    let installed = safe_destination(&root, name)?;
                    fs::create_dir_all(installed.parent().context("Hook resource has no parent")?)?;
                    write_script(&safe_destination(&root, name)?, &bytes)?;
                }
                fs::create_dir_all(target.parent().context("Hook asset has no parent")?)?;
                write_script(&safe_destination(data, name)?, &bytes)?;
                tracing::warn!(path = name, "Hook asset restored");
            }
            Ok(complete)
        },
        5000,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn collector_reports_and_updater_restores_only_managed_missing_or_changed_files() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = tmp.path().join("cache");
        let pilot = cache.join("versions/2.0.0-example");
        let data = tmp.path().join("data");
        let original = b"#!/bin/sh\n# Pilot Hook fixture\n";
        let changed = data.join("hooks/changed.sh");
        let restored = data.join("hooks/restored.sh");
        let unused = data.join("hooks/unused.sh");
        fs::create_dir_all(pilot.join("assets/hooks")).unwrap();
        fs::create_dir_all(data.join("hooks")).unwrap();
        fs::write(cache.join("current"), "2.0.0-example").unwrap();
        let mut resources = Vec::new();
        for name in ["changed.sh", "restored.sh", "unused.sh"] {
            let path = format!("assets/hooks/{name}");
            fs::write(pilot.join(&path), original).unwrap();
            resources.push(crate::utils::runtime_paths::RuntimeResource {
                sha256: sha256_file(&pilot.join(&path)).unwrap(),
                path,
            });
        }
        fs::write(
            pilot.join("runtime-manifest.json"),
            serde_json::to_vec(&crate::utils::runtime_paths::RuntimeManifest {
                schema: 1,
                runtime: "rust".into(),
                version: env!("CARGO_PKG_VERSION").into(),
                git_commit: "1234567890".into(),
                target: crate::utils::runtime_paths::build_target().into(),
                edition: crate::utils::runtime_paths::build_edition().into(),
                binary: "loongsuite-pilot".into(),
                resources,
            })
            .unwrap(),
        )
        .unwrap();
        fs::write(&changed, b"# changed").unwrap();
        let managed = BTreeSet::from(["restored.sh".into()]);
        assert!(report(&pilot, &data, &managed).await.unwrap());
        assert_eq!(fs::read(&changed).unwrap(), b"# changed");
        assert!(!restored.exists());

        let pending = request(&cache).unwrap().unwrap();
        assert_eq!(pending.paths, ["changed.sh", "restored.sh"]);
        assert!(restore(&pending, &data, None).await.unwrap());
        settle(&cache).unwrap();
        assert_eq!(fs::read(&changed).unwrap(), original);
        assert_eq!(fs::read(&restored).unwrap(), original);
        assert!(!unused.exists());
        assert!(!report(&pilot, &data, &managed).await.unwrap());
        assert!(request(&cache).unwrap().is_none());
    }
}
