//! Grok Build is the only hook integration with a multi-file runtime check.

use crate::utils::write_text_file_atomic;
use crate::utils::AtomicTextWriteOptions;
use std::path::Path;

pub const GROK_BUILD_HOOK_ASSETS: &[&str] = &[
    "grok-build-loongsuite-pilot-hook.sh",
    "grok-build-loongsuite-pilot-hook.ps1",
    "shared/native.ps1",
    "shared/native.sh",
];

async fn same_file(source: &Path, target: &Path) -> bool {
    let Ok(source_bytes) = tokio::fs::read(source).await else {
        return false;
    };
    let Ok(target_bytes) = tokio::fs::read(target).await else {
        return false;
    };
    if source_bytes != target_bytes {
        return false;
    }
    if cfg!(unix) && source.to_string_lossy().ends_with(".sh") {
        let Ok(meta) = tokio::fs::metadata(target).await else {
            return false;
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            return meta.permissions().mode() & 0o111 != 0;
        }
        #[cfg(not(unix))]
        {
            let _ = meta;
        }
    }
    true
}

pub async fn are_grok_build_hook_assets_healthy(pilot_dir: &str, data_dir: &str) -> bool {
    let source_root = Path::new(pilot_dir).join("assets").join("hooks");
    let target_root = Path::new(data_dir).join("hooks");
    for relative in GROK_BUILD_HOOK_ASSETS {
        if !same_file(&source_root.join(relative), &target_root.join(relative)).await {
            return false;
        }
    }
    true
}

pub async fn restore_grok_build_hook_assets(pilot_dir: &str, data_dir: &str) -> Result<(), String> {
    let source_root = Path::new(pilot_dir).join("assets").join("hooks");
    let target_root = Path::new(data_dir).join("hooks");
    for relative in GROK_BUILD_HOOK_ASSETS {
        let source = source_root.join(relative);
        let target = target_root.join(relative);
        tokio::fs::metadata(&source)
            .await
            .map_err(|err| err.to_string())?;
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|err| err.to_string())?;
        }
        let content = tokio::fs::read_to_string(&source)
            .await
            .map_err(|err| err.to_string())?;
        write_text_file_atomic(
            &target.to_string_lossy(),
            &content,
            &AtomicTextWriteOptions::default(),
        )
        .await
        .map_err(|err| err.to_string())?;
        let mode = if relative.ends_with(".sh") {
            0o755
        } else {
            0o644
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode));
        }
        #[cfg(not(unix))]
        {
            let _ = mode;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn restores_exact_bytes_and_shell_permission() {
        let root = tempfile::tempdir().unwrap();
        let pilot = root.path().join("pilot");
        let data = root.path().join("data");
        for relative in GROK_BUILD_HOOK_ASSETS {
            let source = pilot.join("assets").join("hooks").join(relative);
            std::fs::create_dir_all(source.parent().unwrap()).unwrap();
            std::fs::write(&source, format!("asset:{relative}\n")).unwrap();
        }
        let pilot_dir = pilot.to_string_lossy().into_owned();
        let data_dir = data.to_string_lossy().into_owned();
        assert!(!are_grok_build_hook_assets_healthy(&pilot_dir, &data_dir).await);
        restore_grok_build_hook_assets(&pilot_dir, &data_dir)
            .await
            .unwrap();
        assert!(are_grok_build_hook_assets_healthy(&pilot_dir, &data_dir).await);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let shell = data
                .join("hooks")
                .join("grok-build-loongsuite-pilot-hook.sh");
            assert_ne!(
                std::fs::metadata(shell).unwrap().permissions().mode() & 0o111,
                0
            );
        }
        let processor = data
            .join("hooks")
            .join("grok-build-loongsuite-pilot-hook.ps1");
        std::fs::write(&processor, "corrupt").unwrap();
        assert!(!are_grok_build_hook_assets_healthy(&pilot_dir, &data_dir).await);
        restore_grok_build_hook_assets(&pilot_dir, &data_dir)
            .await
            .unwrap();
        assert!(are_grok_build_hook_assets_healthy(&pilot_dir, &data_dir).await);
    }
}
