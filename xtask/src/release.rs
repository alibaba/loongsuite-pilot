//! 六平台轻发布门禁；默认仅准备资产，远端写入需要显式 --publish。

use anyhow::{ensure, Context, Result};
use clap::Args;
use loongsuite_pilot::updater::{
    unpack_release_archive, ArchiveFormat, LatestManifest, ReleaseAsset, VersionManifest,
};
use loongsuite_pilot::utils::runtime_paths::{
    resource_file, sha256_file, validate_runtime, SUPPORTED_TARGETS,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

#[derive(Args)]
pub struct Options {
    #[arg(long)]
    packages: PathBuf,
    #[arg(long)]
    output: PathBuf,
    #[arg(long)]
    commit: String,
    #[arg(long)]
    repository: String,
    #[arg(long)]
    tag: Option<String>,
    /// 默认无远端写操作；CI 仅在 tag 事件并经 Environment 保护后传入。
    #[arg(long)]
    publish: bool,
}

pub fn run(root: &Path, options: Options) -> Result<()> {
    ensure!(
        options.commit.len() == 40 && options.commit.bytes().all(|b| b.is_ascii_hexdigit()),
        "需要完整提交 SHA"
    );
    ensure!(
        regex::Regex::new(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")?.is_match(&options.repository),
        "仓库必须为 owner/repo"
    );
    let version = crate::swift::workspace_version(root)?;
    let parsed = semver::Version::parse(&version)?;
    ensure!(parsed.build.is_empty(), "发行版本不能带 build metadata");
    let prerelease = !parsed.pre.is_empty();
    let tag = format!("v{version}");
    ensure!(
        options.tag.as_ref().is_none_or(|value| value == &tag),
        "tag 与 Cargo 版本不符"
    );
    ensure!(
        !options.publish || options.tag.is_some(),
        "正式发布必须显式指定已有 tag"
    );
    let temporary = tempfile::tempdir()?;
    let mut git = Command::new("git");
    git.current_dir(root).args(["rev-parse", "HEAD"]);
    ensure!(
        crate::package::run_bounded(&mut git, temporary.path(), Duration::from_secs(30))?.trim()
            == options.commit,
        "源码 HEAD 与提交不符"
    );
    let mut status = Command::new("git");
    status
        .current_dir(root)
        .args(["status", "--porcelain", "--untracked-files=normal"]);
    ensure!(
        crate::package::run_bounded(&mut status, temporary.path(), Duration::from_secs(30))?
            .trim()
            .is_empty(),
        "发布源码必须干净，安装脚本不能来自未提交修改"
    );
    let source = fs::canonicalize(&options.packages)?;
    let parent = options.output.parent().context("输出缺少父目录")?;
    fs::create_dir_all(parent)?;
    ensure!(!options.output.exists(), "拒绝覆盖已有发布目录");
    let stage = tempfile::tempdir_in(parent)?;
    let staged = stage.path().join("assets");
    fs::create_dir(&staged)?;
    let mut seen = BTreeSet::new();
    let mut assets = BTreeMap::new();
    let mut candidates = Vec::new();
    for entry in fs::read_dir(&source)? {
        let entry = entry?;
        ensure!(entry.file_type()?.is_dir(), "候选根只能包含平台目录");
        let directory = entry.path();
        let candidate: Value =
            serde_json::from_slice(&fs::read(resource_file(&directory, "candidate.json")?)?)?;
        let (target, filename) = validate_candidate(&candidate, &version, &options.commit)?;
        ensure!(seen.insert(target.to_owned()), "重复平台");
        let name = format!("loongsuite-pilot-{version}-{target}");
        let archive = resource_file(&directory, &filename)?;
        ensure!(
            fs::metadata(&archive)?.len() <= 512 * 1024 * 1024,
            "归档超限"
        );
        let digest = sha256_file(&archive)?;
        ensure!(candidate["sha256"] == digest, "归档摘要不匹配：{target}");
        let unpacked = unpack_release_archive(
            &fs::read(&archive)?,
            ArchiveFormat::for_target(target),
            temporary.path(),
            &name,
        )?;
        let manifest = validate_runtime(&unpacked.root, &version, target, "opensource")?;
        ensure!(
            manifest.git_commit == options.commit,
            "归档内提交不匹配：{target}"
        );
        fs::copy(&archive, staged.join(&filename))?;
        assets.insert(
            target.to_owned(),
            ReleaseAsset {
                url: format!(
                    "https://github.com/{}/releases/download/{tag}/{filename}",
                    options.repository
                ),
                format: ArchiveFormat::for_target(target),
                sha256: digest,
            },
        );
        candidates.push(candidate);
    }
    validate_targets(&seen)?;
    let manifest = VersionManifest {
        version: version.clone(),
        git_commit: options.commit.clone(),
        assets,
        released_at: None,
        rollout_percentage: None,
        hotfix_version: None,
    };
    manifest.validate()?;
    if prerelease {
        fs::write(
            staged.join("prerelease-rust.json"),
            serde_json::to_vec_pretty(&manifest)?,
        )?;
    } else {
        let latest = LatestManifest {
            schema: 1,
            runtime: "rust".into(),
            edition: "opensource".into(),
            stable: manifest,
            canary: None,
        };
        latest.validate("opensource")?;
        fs::write(
            staged.join("latest-rust.json"),
            serde_json::to_vec_pretty(&latest)?,
        )?;
    }
    candidates.sort_by(|a, b| a["target"].as_str().cmp(&b["target"].as_str()));
    fs::write(
        staged.join("release-summary.json"),
        serde_json::to_vec_pretty(&json!({
            "schema": 1, "version": version, "commit": options.commit, "gate": "build-and-package-preflight",
            "agentInjection": "deferred", "platformLifecycle": "not-verified", "candidates": candidates
        }))?,
    )?;
    fs::copy(
        root.join("deploy/installer-opensource.sh"),
        staged.join("installer.sh"),
    )?;
    fs::copy(
        root.join("deploy/installer-opensource.ps1"),
        staged.join("installer.ps1"),
    )?;
    let checksums = asset_digests(&staged)?
        .into_iter()
        .map(|(name, digest)| format!("{digest}  {name}\n"))
        .collect::<String>();
    fs::write(staged.join("SHA256SUMS"), checksums)?;
    fs::rename(staged, &options.output)?;
    if options.publish {
        publish(&options, &tag, &parsed, temporary.path())?;
    } else {
        println!(
            "dry-run：六平台轻门禁通过，资产位于 {}；未创建 Release/tag",
            options.output.display()
        );
    }
    Ok(())
}

fn validate_candidate<'a>(
    candidate: &'a Value,
    version: &str,
    commit: &str,
) -> Result<(&'a str, String)> {
    let target = candidate["target"].as_str().context("候选缺少 target")?;
    ensure!(SUPPORTED_TARGETS.contains(&target), "未知平台");
    let extension = if target.contains("windows") {
        "zip"
    } else {
        "tar.gz"
    };
    let filename = format!("loongsuite-pilot-{version}-{target}.{extension}");
    ensure!(
        candidate["schema"] == 1
            && candidate["version"] == version
            && candidate["commit"] == commit
            && candidate["edition"] == "opensource"
            && candidate["dirty"] == false
            && candidate["archive"] == filename,
        "候选版本、提交、edition 或干净状态无效：{target}"
    );
    let preflight = &candidate["preflight"];
    ensure!(
        preflight["schema"] == 1
            && preflight["ok"] == true
            && preflight["runtime"] == "rust"
            && preflight["version"] == version
            && preflight["target"] == target
            && preflight["edition"] == "opensource"
            && preflight["check"]["details"]["gitCommit"] == commit,
        "包内预检不匹配：{target}"
    );
    Ok((target, filename))
}

fn validate_targets(seen: &BTreeSet<String>) -> Result<()> {
    ensure!(
        *seen == SUPPORTED_TARGETS.into_iter().map(str::to_owned).collect(),
        "必须包含完整六平台，不允许缩小集合发布"
    );
    Ok(())
}

fn asset_digests(directory: &Path) -> Result<BTreeMap<String, String>> {
    let mut assets = BTreeMap::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        ensure!(entry.file_type()?.is_file(), "发布资产只能为普通文件");
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("资产名必须为 UTF-8"))?;
        assets.insert(name, sha256_file(&entry.path())?);
    }
    Ok(assets)
}

fn gh(repository: &str, args: &[String], temporary: &Path) -> Result<String> {
    let mut command = Command::new("gh");
    command
        .args(args)
        .env("GH_REPO", repository)
        .env("GH_PROMPT_DISABLED", "1");
    crate::package::run_bounded(&mut command, temporary, Duration::from_secs(900))
}

fn verify_remote_tag(options: &Options, tag: &str, temporary: &Path) -> Result<()> {
    let reference: Value = serde_json::from_str(&gh(
        &options.repository,
        &[
            "api".into(),
            format!("repos/{}/git/ref/tags/{tag}", options.repository),
        ],
        temporary,
    )?)?;
    ensure!(
        reference["ref"] == format!("refs/tags/{tag}"),
        "远端 tag 引用不匹配"
    );
    resolve_tag_commit(reference["object"].clone(), &options.commit, |sha| {
        let annotation: Value = serde_json::from_str(&gh(
            &options.repository,
            &[
                "api".into(),
                format!("repos/{}/git/tags/{sha}", options.repository),
            ],
            temporary,
        )?)?;
        Ok(annotation["object"].clone())
    })
}

fn resolve_tag_commit(
    mut object: Value,
    commit: &str,
    mut annotation: impl FnMut(&str) -> Result<Value>,
) -> Result<()> {
    for _ in 0..8 {
        let sha = object["sha"].as_str().context("远端 tag 缺少 SHA")?;
        ensure!(
            sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit()),
            "远端 tag SHA 无效"
        );
        match object["type"].as_str() {
            Some("commit") => {
                ensure!(sha == commit, "远端 tag 指向其它提交，拒绝发布");
                return Ok(());
            }
            Some("tag") => {
                object = annotation(sha)?;
            }
            _ => anyhow::bail!("远端 tag 必须指向 commit"),
        }
    }
    anyhow::bail!("远端 tag 嵌套过深")
}

fn publish(
    options: &Options,
    tag: &str,
    version: &semver::Version,
    temporary: &Path,
) -> Result<()> {
    ensure!(
        std::env::var_os("GH_TOKEN").is_some(),
        "正式发布需要 GH_TOKEN"
    );
    verify_remote_tag(options, tag, temporary)?;
    let prerelease = !version.pre.is_empty();
    let releases: Vec<Vec<Value>> = serde_json::from_str(&gh(
        &options.repository,
        &[
            "api".into(),
            format!("repos/{}/releases?per_page=100", options.repository),
            "--paginate".into(),
            "--slurp".into(),
        ],
        temporary,
    )?)?;
    for release in releases.iter().flatten() {
        ensure!(
            release["tag_name"] != tag,
            "已有同名 Release（包括 draft），拒绝覆盖；请人工核对后处理"
        );
        if !prerelease && release["draft"] == false && release["prerelease"] == false {
            if let Some(old) = release["tag_name"]
                .as_str()
                .and_then(|v| v.strip_prefix('v'))
                .and_then(|v| semver::Version::parse(v).ok())
            {
                ensure!(version > &old, "拒绝旧版本覆盖较新的稳定渠道");
            }
        }
    }
    // --verify-tag 防止 gh 隐式创建 tag；创建 draft 后任何失败都保留未公开状态。
    let notes = temporary.join("notes.txt");
    fs::write(&notes, format!("Rust 原生发行 {tag}\n\n提交：{}\n六平台构建与包内预检通过。完整 Agent 注入及平台安装生命周期验收暂缓；详见 release-summary.json。\n", options.commit))?;
    let mut create = vec![
        "release".into(),
        "create".into(),
        tag.into(),
        "--verify-tag".into(),
        "--draft".into(),
        "--title".into(),
        tag.into(),
        "--target".into(),
        options.commit.clone(),
        "--notes-file".into(),
        notes.to_string_lossy().into_owned(),
    ];
    if prerelease {
        create.push("--prerelease".into());
    }
    gh(&options.repository, &create, temporary)?;
    let expected = asset_digests(&options.output)?;
    let mut upload = vec!["release".into(), "upload".into(), tag.into()];
    upload.extend(
        expected
            .keys()
            .map(|name| options.output.join(name).to_string_lossy().into_owned()),
    );
    gh(&options.repository, &upload, temporary)?;
    let remote: Value = serde_json::from_str(&gh(
        &options.repository,
        &[
            "api".into(),
            format!("repos/{}/releases/tags/{tag}", options.repository),
        ],
        temporary,
    )?)?;
    ensure!(
        remote["draft"] == true && remote["tag_name"] == tag,
        "远端 draft 状态异常"
    );
    let mut actual = BTreeMap::new();
    for asset in remote["assets"].as_array().context("远端缺少资产列表")? {
        let name = asset["name"].as_str().context("远端资产名缺失")?;
        let digest = asset["digest"]
            .as_str()
            .and_then(|v| v.strip_prefix("sha256:"))
            .context("GitHub 未返回资产 SHA-256，保留 draft")?;
        ensure!(
            asset["state"] == "uploaded"
                && actual.insert(name.to_owned(), digest.to_owned()).is_none(),
            "远端资产状态或唯一性错误"
        );
    }
    ensure!(actual == expected, "远端资产全集或摘要不符，保留 draft");
    verify_remote_tag(options, tag, temporary)?;
    gh(
        &options.repository,
        &[
            "release".into(),
            "edit".into(),
            tag.into(),
            "--draft=false".into(),
            format!("--latest={}", !prerelease),
        ],
        temporary,
    )?;
    println!("已发布 {tag}：{} 个经过摘要核对的资产", expected.len());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";

    fn candidate(target: &str) -> Value {
        let extension = if target.contains("windows") {
            "zip"
        } else {
            "tar.gz"
        };
        json!({
            "schema": 1, "version": "1.2.0", "commit": COMMIT, "target": target,
            "edition": "opensource", "dirty": false,
            "archive": format!("loongsuite-pilot-1.2.0-{target}.{extension}"),
            "preflight": {"schema": 1, "ok": true, "runtime": "rust", "version": "1.2.0",
                "target": target, "edition": "opensource", "check": {"details": {"gitCommit": COMMIT}}}
        })
    }

    #[test]
    fn removed_musl_candidates_cannot_enter_the_six_target_release_set() {
        for target in ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"] {
            assert!(validate_candidate(&candidate(target), "1.2.0", COMMIT).is_err());
            let mut seen = SUPPORTED_TARGETS
                .into_iter()
                .map(str::to_owned)
                .collect::<BTreeSet<_>>();
            seen.insert(target.into());
            assert!(validate_targets(&seen).is_err());
        }
    }

    #[test]
    fn accepts_all_targets_and_rejects_incomplete_set() {
        let mut seen = BTreeSet::new();
        for target in SUPPORTED_TARGETS {
            let candidate = candidate(target);
            assert_eq!(
                validate_candidate(&candidate, "1.2.0", COMMIT).unwrap().0,
                target
            );
            seen.insert(target.to_owned());
        }
        validate_targets(&seen).unwrap();
        seen.remove(SUPPORTED_TARGETS[0]);
        assert!(validate_targets(&seen).is_err());
        seen.insert("unknown-target".into());
        assert!(validate_targets(&seen).is_err());
    }

    #[test]
    fn rejects_invalid_identity_dirty_and_failed_preflight() {
        for (pointer, value) in [
            ("/schema", json!(2)),
            ("/version", json!("9.0.0")),
            ("/commit", json!("other")),
            ("/target", json!("unknown")),
            ("/edition", json!("proprietary")),
            ("/dirty", json!(true)),
            ("/dirty", Value::Null),
            ("/archive", json!("../wrong.tar.gz")),
            ("/preflight/ok", json!(false)),
            ("/preflight/runtime", json!("node")),
            ("/preflight/target", json!(SUPPORTED_TARGETS[1])),
            ("/preflight/check/details/gitCommit", json!("other")),
        ] {
            let mut candidate = candidate(SUPPORTED_TARGETS[0]);
            *candidate.pointer_mut(pointer).unwrap() = value;
            assert!(
                validate_candidate(&candidate, "1.2.0", COMMIT).is_err(),
                "{pointer}"
            );
        }
    }

    #[test]
    fn tag_must_resolve_to_exact_commit() {
        let commit = json!({"type": "commit", "sha": COMMIT});
        resolve_tag_commit(commit.clone(), COMMIT, |_| {
            panic!("轻量 tag 不查 annotation")
        })
        .unwrap();
        let tag = json!({"type": "tag", "sha": "a".repeat(40)});
        resolve_tag_commit(tag.clone(), COMMIT, |_| Ok(commit.clone())).unwrap();
        assert!(resolve_tag_commit(commit, &"b".repeat(40), |_| unreachable!()).is_err());
        assert!(resolve_tag_commit(tag.clone(), COMMIT, |_| Ok(tag.clone())).is_err());
        assert!(resolve_tag_commit(
            json!({"type": "blob", "sha": COMMIT}),
            COMMIT,
            |_| unreachable!()
        )
        .is_err());
    }

    #[test]
    fn asset_digests_rejects_directories() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("asset"), b"abc").unwrap();
        let digests = asset_digests(temp.path()).unwrap();
        assert_eq!(
            digests["asset"],
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        fs::create_dir(temp.path().join("unexpected")).unwrap();
        assert!(asset_digests(temp.path()).is_err());
    }
}
