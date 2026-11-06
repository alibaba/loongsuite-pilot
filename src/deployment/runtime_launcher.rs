//! Explicit Docker runtime binding for this install; immutable package ELF stays unchanged.
use crate::utils::runtime_paths::runtime_metadata;
use anyhow::{ensure, Context, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RuntimeLauncher {
    schema: u8,
    container_id: String,
    image: String,
    docker_binary: PathBuf,
    launcher_path: PathBuf,
    cache_dir: PathBuf,
    data_dir: PathBuf,
    config_path: PathBuf,
    uid: u32,
    gid: u32,
    #[serde(default)]
    start_updater: bool,
}
fn ordinary(path: &Path) -> Result<Option<std::fs::Metadata>> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(Some(runtime_metadata(path)?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
fn same_path(a: &Path, b: &Path) -> Result<bool> {
    Ok(std::fs::canonicalize(a)? == std::fs::canonicalize(b)?)
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
impl RuntimeLauncher {
    pub(super) fn read(cache: &Path, data: &Path) -> Result<Option<Self>> {
        let path = cache.join("container-runtime.json");
        let Some(metadata) = ordinary(&path)? else {
            return Ok(None);
        };
        ensure!(
            cfg!(target_os = "linux"),
            "Container runtime launcher requires Linux"
        );
        ensure!(
            metadata.is_file() && metadata.len() <= 16 * 1024,
            "Invalid container runtime descriptor"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            ensure!(
                metadata.uid() == unsafe { libc::geteuid() }
                    && metadata.permissions().mode() & 0o022 == 0,
                "Container descriptor ownership or permissions changed"
            );
        }
        let descriptor: Self = serde_json::from_slice(&std::fs::read(&path)?).map_err(|_| {
            anyhow::anyhow!("Invalid container runtime descriptor; installed entry preserved")
        })?;
        ensure!(
            descriptor.schema == 1,
            "Unsupported container runtime schema"
        );
        ensure!(
            descriptor.container_id.len() == 64
                && descriptor
                    .container_id
                    .bytes()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "Invalid full container identity"
        );
        let digest = descriptor
            .image
            .strip_prefix("sha256:")
            .or_else(|| {
                descriptor
                    .image
                    .split_once("@sha256:")
                    .filter(|(repository, _)| !repository.is_empty())
                    .map(|(_, digest)| digest)
            })
            .context("Pinned runtime image ID or digest required")?;
        ensure!(
            digest.len() == 64 && digest.bytes().all(|c| c.is_ascii_hexdigit()),
            "Invalid runtime image digest"
        );
        for p in [
            &descriptor.docker_binary,
            &descriptor.launcher_path,
            &descriptor.cache_dir,
            &descriptor.data_dir,
            &descriptor.config_path,
        ] {
            ensure!(
                p.is_absolute() && !p.to_string_lossy().chars().any(char::is_control),
                "Invalid absolute runtime path"
            );
        }
        ensure!(
            !descriptor.image.chars().any(char::is_control),
            "Invalid runtime image"
        );
        ensure!(
            same_path(&descriptor.cache_dir, cache)? && same_path(&descriptor.data_dir, data)?,
            "Container descriptor belongs to another installation"
        );
        ensure!(
            descriptor
                .launcher_path
                .file_name()
                .is_some_and(|name| name == "loongsuite-pilot"),
            "Container launcher must be the managed bootstrap"
        );
        ensure!(
            !descriptor.launcher_path.starts_with(cache.join("versions")),
            "Container launcher cannot replace a version ELF"
        );
        if let Some(metadata) = ordinary(&descriptor.launcher_path)? {
            ensure!(
                metadata.is_file(),
                "Container launcher is not an ordinary file"
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::{MetadataExt, PermissionsExt};
                ensure!(
                    metadata.uid() == descriptor.uid && metadata.permissions().mode() & 0o022 == 0,
                    "Container launcher ownership or permissions changed"
                );
            }
        }
        #[cfg(unix)]
        {
            ensure!(
                descriptor.uid == unsafe { libc::geteuid() }
                    && descriptor.gid == unsafe { libc::getegid() },
                "Container runtime UID/GID differs from installation owner"
            );
        }
        Ok(Some(descriptor))
    }
    fn installed_helper(&self, package: &Path, activate_source: bool) -> Result<PathBuf> {
        let versions = self.cache_dir.join("versions");
        ensure!(
            package.is_absolute()
                && ordinary(&versions)?.is_some_and(|m| m.is_dir())
                && ordinary(package)?.is_some_and(|m| m.is_dir()),
            "Container control helper source must be an installed package directly in this cache/versions"
        );
        let package = std::fs::canonicalize(package)?;
        let versions = std::fs::canonicalize(&versions)?;
        ensure!(package.parent() == Some(versions.as_path()),
            "Container control helper source must be an installed package directly in this cache/versions");
        let name = package
            .file_name()
            .and_then(|name| name.to_str())
            .context("Invalid installed container package name")?;
        ensure!(
            crate::utils::runtime_paths::safe_component(name),
            "Invalid installed container package name"
        );
        if !activate_source {
            let current = super::native_install::read_pointer(&self.cache_dir.join("current"))?;
            let previous = super::native_install::read_pointer(&self.cache_dir.join("previous"))?;
            ensure!(
                current.as_deref() == Some(name) || previous.as_deref() == Some(name),
                "Container service sync source must be retained by current or previous"
            );
        }
        let helper = crate::utils::runtime_paths::resource_file(&package, "bin/loongsuite-pilot")?;
        ensure!(
            !helper.to_string_lossy().chars().any(char::is_control),
            "Invalid container helper path"
        );
        Ok(helper)
    }

    pub(super) fn bind(
        &self,
        source: &str,
        destination: &Path,
        config: &Path,
        package: &Path,
        activate_source: bool,
    ) -> Result<String> {
        ensure!(
            self.launcher_path == destination && self.config_path == config,
            "Container launcher/config binding differs from this installation"
        );
        let (_, body) = source.split_once('\n').context("Missing service shebang")?;
        ensure!(
            body.matches("# ---- Dispatch ----").count() == 1,
            "Unknown service dispatch layout"
        );
        let helper = self.installed_helper(package, activate_source)?;
        let mut prefix=String::from("#!/bin/bash\n# Managed Docker runtime; original version ELF and user config preserved.\n");
        for (name, value) in [
            ("LP_RUNTIME_ID", self.container_id.clone()),
            ("LP_RUNTIME_HELPER", helper.to_string_lossy().into_owned()),
            ("LP_RUNTIME_IMAGE", self.image.clone()),
            (
                "LP_RUNTIME_DOCKER",
                self.docker_binary.to_string_lossy().into_owned(),
            ),
            (
                "LP_RUNTIME_LAUNCHER",
                self.launcher_path.to_string_lossy().into_owned(),
            ),
            (
                "LP_RUNTIME_DATA",
                self.data_dir.to_string_lossy().into_owned(),
            ),
            (
                "LP_RUNTIME_CACHE",
                self.cache_dir.to_string_lossy().into_owned(),
            ),
            (
                "LP_RUNTIME_CONFIG",
                self.config_path.to_string_lossy().into_owned(),
            ),
            ("LP_RUNTIME_UID", self.uid.to_string()),
            ("LP_RUNTIME_GID", self.gid.to_string()),
            (
                "LP_RUNTIME_START_UPDATER",
                if self.start_updater {
                    "1".to_owned()
                } else {
                    "0".to_owned()
                },
            ),
        ] {
            prefix.push_str(&format!("{name}={}\n", quote(&value)));
        }
        prefix.push_str(include_str!("runtime_launcher_head.sh"));
        prefix.push_str(&body.replacen(
            "# ---- Dispatch ----",
            &format!(
                "{}\n# ---- Dispatch ----",
                include_str!("runtime_launcher_tail.sh")
            ),
            1,
        ));
        Ok(prefix)
    }
}
pub(super) fn hook_binary(data: &Path) -> Result<PathBuf> {
    let cache = std::env::var_os("LOONGSUITE_PILOT_CACHE_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| data.to_owned());
    Ok(match RuntimeLauncher::read(&cache, data)? {
        Some(runtime) => runtime.launcher_path,
        None => std::env::current_exe()?,
    })
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::os::unix::fs::PermissionsExt;
    fn descriptor(root: &Path) -> serde_json::Value {
        json!({"schema":1,"containerId":"a".repeat(64),"image":format!("quay.io/rockylinux/rockylinux@sha256:{}","b".repeat(64)),
            "dockerBinary":"/usr/bin/docker","launcherPath":root.join("bin/loongsuite-pilot"),"cacheDir":root.join("cache"),
            "dataDir":root.join("data"),"configPath":root.join("data/config.json"),
            "uid":unsafe{libc::geteuid()},"gid":unsafe{libc::getegid()}})
    }
    fn prepare(root: &Path, value: &serde_json::Value) {
        for dir in ["cache", "data", "bin"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        let file = root.join("cache/container-runtime.json");
        std::fs::write(&file, value.to_string()).unwrap();
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600)).unwrap();
        let package = root.join("cache/versions/fixture");
        std::fs::create_dir_all(package.join("bin")).unwrap();
        std::fs::write(
            package.join("bin/loongsuite-pilot"),
            b"render-only ELF fixture",
        )
        .unwrap();
        std::fs::set_permissions(
            package.join("bin/loongsuite-pilot"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        std::fs::write(root.join("cache/current"), b"fixture\n").unwrap();
    }
    #[test]
    fn missing_descriptor_preserves_native_bootstrap_and_does_not_create_state() {
        let root = tempfile::tempdir().unwrap();
        assert!(
            RuntimeLauncher::read(&root.path().join("cache"), &root.path().join("data"))
                .unwrap()
                .is_none()
        );
        assert!(!root.path().join("cache").exists());
    }
    #[test]
    fn descriptor_checks_full_identity_install_paths_and_owner_before_render() {
        let root = tempfile::tempdir().unwrap();
        let valid = descriptor(root.path());
        prepare(root.path(), &valid);
        assert!(
            RuntimeLauncher::read(&root.path().join("cache"), &root.path().join("data"))
                .unwrap()
                .is_some()
        );
        for (key, value) in [
            ("containerId", json!("short")),
            ("schema", json!(2)),
            ("image", json!("rockylinux:9")),
            (
                "launcherPath",
                json!(root.path().join("cache/versions/v/bin/loongsuite-pilot")),
            ),
        ] {
            let mut changed = valid.clone();
            changed[key] = value;
            prepare(root.path(), &changed);
            assert!(
                RuntimeLauncher::read(&root.path().join("cache"), &root.path().join("data"))
                    .is_err(),
                "{key}"
            );
        }
        prepare(root.path(), &valid);
        std::fs::set_permissions(
            root.path().join("cache/container-runtime.json"),
            std::fs::Permissions::from_mode(0o666),
        )
        .unwrap();
        assert!(
            RuntimeLauncher::read(&root.path().join("cache"), &root.path().join("data")).is_err()
        );
    }
    #[test]
    fn rendered_service_keeps_pid_and_restart_contracts_without_touching_host_init_state() {
        let root = tempfile::tempdir().unwrap();
        prepare(root.path(), &descriptor(root.path()));
        let runtime = RuntimeLauncher::read(&root.path().join("cache"), &root.path().join("data"))
            .unwrap()
            .unwrap();
        let source = include_str!("../../scripts/loongsuite-pilot.sh");
        let bound = runtime
            .bind(
                source,
                &root.path().join("bin/loongsuite-pilot"),
                &root.path().join("data/config.json"),
                &root.path().join("cache/versions/fixture"),
                false,
            )
            .unwrap();
        let helper = root
            .path()
            .join("cache/versions/fixture/bin/loongsuite-pilot");
        assert!(bound.contains(&format!(
            "LP_RUNTIME_HELPER={}\n",
            quote(helper.to_str().unwrap())
        )));
        assert!(!bound.contains(&format!(
            "LP_RUNTIME_HELPER={}\n",
            quote(std::env::current_exe().unwrap().to_str().unwrap())
        )));
        assert!(bound.starts_with("#!/bin/bash\n"));
        assert!(bound.contains("docker") && bound.contains("container-supervise"));
        assert!(bound.contains("process_matches_installed_entry"));
        assert!(bound.contains("write_restart_failure"));
        assert!(bound.contains("INIT_TYPE_FILE=\"$LP_RUNTIME_STATE/init-type\""));
        assert!(runtime
            .bind(
                source,
                &root.path().join("other"),
                &root.path().join("data/config.json"),
                &root.path().join("cache/versions/fixture"),
                false,
            )
            .is_err());
        assert!(!root.path().join("data/init-type").exists());
    }

    #[test]
    fn helper_pin_rejects_temporary_and_unretained_sources() {
        let root = tempfile::tempdir().unwrap();
        prepare(root.path(), &descriptor(root.path()));
        let runtime = RuntimeLauncher::read(&root.path().join("cache"), &root.path().join("data"))
            .unwrap()
            .unwrap();
        let temporary = root.path().join("temporary-unpacked");
        std::fs::create_dir_all(temporary.join("bin")).unwrap();
        std::fs::write(temporary.join("bin/loongsuite-pilot"), b"fixture").unwrap();
        assert!(runtime.installed_helper(&temporary, false).is_err());
        assert!(runtime.installed_helper(&temporary, true).is_err());
        let orphan = root.path().join("cache/versions/pending");
        std::fs::create_dir_all(orphan.join("bin")).unwrap();
        std::fs::write(orphan.join("bin/loongsuite-pilot"), b"fixture").unwrap();
        assert!(runtime.installed_helper(&orphan, false).is_err());
        assert!(runtime.installed_helper(&orphan, true).is_ok());
        std::fs::write(root.path().join("cache/previous"), b"pending\n").unwrap();
        assert!(runtime.installed_helper(&orphan, false).is_ok());
    }

    #[test]
    fn local_immutable_image_ids_and_explicit_updater_roles_are_preserved() {
        let root = tempfile::tempdir().unwrap();
        let mut value = descriptor(root.path());
        value["image"] = json!(format!("sha256:{}", "b".repeat(64)));
        for enabled in [false, true] {
            value["startUpdater"] = json!(enabled);
            prepare(root.path(), &value);
            let runtime =
                RuntimeLauncher::read(&root.path().join("cache"), &root.path().join("data"))
                    .unwrap()
                    .unwrap();
            let rendered = runtime
                .bind(
                    include_str!("../../scripts/loongsuite-pilot.sh"),
                    &root.path().join("bin/loongsuite-pilot"),
                    &root.path().join("data/config.json"),
                    &root.path().join("cache/versions/fixture"),
                    false,
                )
                .unwrap();
            assert!(rendered.contains(if enabled {
                "LP_RUNTIME_START_UPDATER='1'"
            } else {
                "LP_RUNTIME_START_UPDATER='0'"
            }));
        }
        value.as_object_mut().unwrap().remove("startUpdater");
        prepare(root.path(), &value);
        assert!(
            !RuntimeLauncher::read(&root.path().join("cache"), &root.path().join("data"))
                .unwrap()
                .unwrap()
                .start_updater
        );
    }
    #[test]
    fn descriptor_and_managed_launcher_symlinks_remain_rejected() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        prepare(root.path(), &descriptor(root.path()));
        let path = root.path().join("cache/container-runtime.json");
        std::fs::rename(&path, root.path().join("saved")).unwrap();
        symlink(root.path().join("saved"), &path).unwrap();
        assert!(
            RuntimeLauncher::read(&root.path().join("cache"), &root.path().join("data")).is_err()
        );
        std::fs::remove_file(&path).unwrap();
        prepare(root.path(), &descriptor(root.path()));
        symlink(
            root.path().join("saved"),
            root.path().join("bin/loongsuite-pilot"),
        )
        .unwrap();
        assert!(
            RuntimeLauncher::read(&root.path().join("cache"), &root.path().join("data")).is_err()
        );
    }
}
