//! Rust 独立更新渠道；旧 Node 清单和无平台通用包不能进入更新流程。

use crate::utils::runtime_paths::SUPPORTED_TARGETS;
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ArchiveFormat {
    #[serde(rename = "tar.gz")]
    TarGz,
    #[serde(rename = "zip")]
    Zip,
}

impl ArchiveFormat {
    pub fn for_target(target: &str) -> Self {
        if target.contains("windows") {
            Self::Zip
        } else {
            Self::TarGz
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReleaseAsset {
    pub url: String,
    pub format: ArchiveFormat,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct VersionManifest {
    pub version: String,
    pub git_commit: String,
    pub assets: BTreeMap<String, ReleaseAsset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub released_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rollout_percentage: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hotfix_version: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LatestManifest {
    pub schema: u32,
    pub runtime: String,
    pub edition: String,
    pub stable: VersionManifest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canary: Option<VersionManifest>,
}

impl LatestManifest {
    pub fn validate(&self, edition: &str) -> Result<()> {
        ensure!(
            self.schema == 1 && self.runtime == "rust",
            "只接受 schema=1 的 Rust 更新清单"
        );
        ensure!(
            matches!(edition, "opensource" | "proprietary") && self.edition == edition,
            "更新清单 edition 不匹配"
        );
        self.stable.validate()?;
        ensure!(
            self.stable.rollout_percentage.is_none() && self.stable.hotfix_version.is_none(),
            "稳定渠道不能含灰度字段"
        );
        if let Some(canary) = &self.canary {
            canary.validate()?;
            ensure!(
                canary.rollout_percentage.is_some(),
                "灰度渠道缺少 rollout_percentage"
            );
        }
        Ok(())
    }
}

impl VersionManifest {
    pub fn validate(&self) -> Result<()> {
        ensure!(valid_version(&self.version), "更新版本号无效");
        ensure!(
            hex_digest(&self.git_commit, 40),
            "更新清单必须包含完整提交 SHA"
        );
        ensure!(
            self.assets.len() == SUPPORTED_TARGETS.len(),
            "更新清单必须包含完整六平台资产"
        );
        for target in SUPPORTED_TARGETS {
            let asset = self
                .assets
                .get(target)
                .with_context(|| format!("缺少平台资产：{target}"))?;
            ensure!(
                asset.format == ArchiveFormat::for_target(target),
                "归档格式与平台不匹配：{target}"
            );
            ensure!(
                hex_digest(&asset.sha256, 64),
                "平台资产 SHA-256 无效：{target}"
            );
            let url = reqwest::Url::parse(&asset.url).context("平台资产 URL 无效")?;
            ensure!(
                url.scheme() == "https"
                    && url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.fragment().is_none(),
                "平台资产必须使用无内嵌凭据的 HTTPS URL"
            );
        }
        if let Some(percentage) = self.rollout_percentage {
            ensure!(
                percentage.is_finite() && (0.0..=100.0).contains(&percentage),
                "灰度百分比无效"
            );
        }
        Ok(())
    }

    pub fn asset(&self, target: &str) -> Result<&ReleaseAsset> {
        self.validate()?;
        self.assets
            .get(target)
            .with_context(|| format!("不支持的更新平台：{target}"))
    }
}

fn hex_digest(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_version(version: &str) -> bool {
    // 版本还会用于版本目录名，禁止路径分隔符、控制字符和任意路径组件。
    version.len() <= 128 && semver::Version::parse(version).is_ok()
}

#[cfg(test)]
pub(crate) fn fixture(version: &str, commit: &str) -> VersionManifest {
    VersionManifest {
        version: version.into(),
        git_commit: commit.into(),
        released_at: None,
        rollout_percentage: None,
        hotfix_version: None,
        assets: SUPPORTED_TARGETS
            .into_iter()
            .map(|target| {
                (
                    target.into(),
                    ReleaseAsset {
                        url: format!("https://example.invalid/{version}/{target}"),
                        format: ArchiveFormat::for_target(target),
                        sha256: "a".repeat(64),
                    },
                )
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn latest() -> LatestManifest {
        LatestManifest {
            schema: 1,
            runtime: "rust".into(),
            edition: "opensource".into(),
            stable: fixture("1.2.0", &"a".repeat(40)),
            canary: None,
        }
    }

    #[test]
    fn rejects_legacy_generic_and_incomplete_platform_manifests() {
        assert!(serde_json::from_value::<LatestManifest>(json!({
            "version": "1.2.0", "git_commit": "abc", "package_url": "https://example.invalid/pkg.tar.gz"
        })).is_err());
        let value = latest();
        value.validate("opensource").unwrap();
        for target in SUPPORTED_TARGETS {
            let mut missing = value.clone();
            missing.stable.assets.remove(target);
            assert!(missing.validate("opensource").is_err());
            let mut wrong = value.clone();
            wrong.stable.assets.get_mut(target).unwrap().sha256.clear();
            assert!(wrong.validate("opensource").is_err());
        }
        let mut wrong = value.clone();
        wrong
            .stable
            .assets
            .get_mut(SUPPORTED_TARGETS[0])
            .unwrap()
            .format = ArchiveFormat::Zip;
        assert!(wrong.validate("opensource").is_err());
        assert!(value.validate("proprietary").is_err());
    }

    #[test]
    fn accepts_semver_prerelease_and_build_metadata() {
        for version in ["1.2.3", "0.0.0", "1.2.3-alpha.1", "1.2.3-rc.1+build.001"] {
            assert!(valid_version(version), "{version}");
        }
    }

    #[test]
    fn rejects_paths_credentials_wrong_runtime_and_bad_rollout() {
        for version in [
            "../1.2.0",
            "C:\\x",
            "1.2",
            "01.2.3",
            "1.2.3/other",
            "1.2.3\n",
            "1.2.3-",
            "1.2.3+",
            "1.2.3-01",
            "1.2.3-a..b",
            "1.2.3+x+y",
        ] {
            let mut value = latest();
            value.stable.version = version.into();
            assert!(value.validate("opensource").is_err(), "{version}");
        }
        for url in [
            "file:///tmp/a",
            "http://example.com/a",
            "https://user:pass@example.com/a",
            "https://example.com/a#fragment",
        ] {
            let mut value = latest();
            value
                .stable
                .assets
                .get_mut(SUPPORTED_TARGETS[0])
                .unwrap()
                .url = url.into();
            assert!(value.validate("opensource").is_err());
        }
        let mut value = latest();
        value.runtime = "node".into();
        assert!(value.validate("opensource").is_err());
        let mut value = latest();
        value.canary = Some(value.stable.clone());
        value.canary.as_mut().unwrap().rollout_percentage = Some(101.0);
        assert!(value.validate("opensource").is_err());
    }
}
