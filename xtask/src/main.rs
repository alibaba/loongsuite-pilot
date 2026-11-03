//! 仓库工具入口；测试子进程不继承用户的 Agent 配置和遥测凭据。

mod field_coverage;
mod hooks;
mod injection_reports;
mod jsonl_validate;
mod migration;
mod package;
mod release;
mod swift;
mod trace_validate;
mod validation_rules;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use serde::Serialize;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::time::{Duration, Instant};

#[derive(Parser)]
#[command(name = "xtask", about = "LoongSuite Pilot Rust 开发工具")]
struct Args {
    #[command(subcommand)]
    command: Task,
}

#[derive(Subcommand)]
enum Task {
    /// 按指定 target 生成白名单候选包，并执行包内原生预检。
    Package(package::Options),
    /// 核对六平台候选并生成发布资产；默认 dry-run，--publish 才写 GitHub。
    Release(release::Options),
    /// 检查 JSONL 字段填充率；验收门禁使用 --strict。
    FieldCoverage(field_coverage::Options),
    /// 原生 JSONL 字段、类型、配对及轮次边界校验；验收使用 --strict。
    ValidateJsonl(jsonl_validate::Options),
    /// 校验 Trace 结构、时间、属性、消息 Schema 及语义；错误返回非零。
    ValidateTrace(trace_validate::Options),
    /// 从本地或远程 GenAI 规范生成规则；--diff 只读，--strict 校验完整性。
    UpdateValidationRules(validation_rules::Options),
    /// 在 macOS 构建预编译菜单栏 UI，并运行 Swift 测试。
    BuildStatusBar {
        #[arg(long, value_enum)]
        arch: Option<swift::Arch>,
        #[arg(long)]
        output: Option<PathBuf>,
        #[arg(long)]
        skip_tests: bool,
    },
    /// 输出固定六平台与全部 Agent/场景清单，不执行注入。
    Matrix,
    /// 严格核对注入报告、构建提交与候选包摘要；缺失、失败和跳过均拒绝。
    CheckReports {
        #[arg(long)]
        reports_root: PathBuf,
        #[arg(long)]
        packages: PathBuf,
        #[arg(long)]
        commit: String,
    },
    /// 生成原生 Hook 薄入口，或只读检查生成结果。
    SyncHookWrappers {
        #[arg(long)]
        check: bool,
    },
    /// 检查固定历史基线的测试映射，输出未承接项；不删除文件。
    MigrationAudit {
        #[arg(long, default_value = "target/migration-audit")]
        output: PathBuf,
        #[arg(long)]
        require_complete: bool,
        /// 保留测试的 Vitest 收集与执行报告。
        #[arg(long)]
        retained_report: Option<PathBuf>,
    },
    /// 在隔离目录运行质量门禁，保存逐命令结果与日志。
    Baseline {
        #[arg(long, default_value = "target/ci-baseline")]
        output: PathBuf,
        #[arg(long, default_value_t = 1800)]
        timeout_seconds: u64,
        /// 使用串行测试建立基线，避免遗留环境变量测试相互污染。
        #[arg(long)]
        serial: bool,
    },
}

#[derive(Serialize)]
struct CheckResult {
    args: Vec<String>,
    success: bool,
    exit_code: Option<i32>,
    timed_out: bool,
    elapsed_ms: u128,
    log: String,
}

fn main() -> Result<ExitCode> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .context("workspace 根目录缺失")?;
    match Args::parse().command {
        Task::FieldCoverage(options) => return Ok(ExitCode::from(field_coverage::run(options))),
        Task::ValidateJsonl(options) => return Ok(ExitCode::from(jsonl_validate::run(options))),
        Task::ValidateTrace(options) => {
            return Ok(ExitCode::from(trace_validate::run(root, options)))
        }
        Task::UpdateValidationRules(options) => {
            return Ok(ExitCode::from(validation_rules::run(root, options)))
        }
        Task::Package(options) => package::build(root, options),
        Task::Release(options) => release::run(root, options),
        Task::BuildStatusBar {
            arch,
            output,
            skip_tests,
        } => swift::build(root, arch, output.as_deref(), skip_tests),
        Task::Matrix => injection_reports::matrix(root),
        Task::CheckReports {
            reports_root,
            packages,
            commit,
        } => injection_reports::check_reports(root, &reports_root, &packages, &commit),
        Task::SyncHookWrappers { check } => hooks::sync(root, check),
        Task::MigrationAudit {
            output,
            require_complete,
            retained_report,
        } => migration::audit(root, &output, require_complete, retained_report.as_deref()),
        Task::Baseline {
            output,
            timeout_seconds,
            serial,
        } => baseline(root, &output, Duration::from_secs(timeout_seconds), serial),
    }
    .map(|()| ExitCode::SUCCESS)
}

fn baseline(root: &Path, output: &Path, timeout: Duration, serial: bool) -> Result<()> {
    let output = root.join(output);
    fs::create_dir_all(output.join("home"))?;
    let output = fs::canonicalize(output)?;
    let mut checks: Vec<Vec<&str>> = vec![
        vec!["fmt", "--all", "--", "--check"],
        vec![
            "clippy",
            "--workspace",
            "--all-targets",
            "--all-features",
            "--locked",
            "--",
            "-D",
            "warnings",
        ],
        vec!["test", "--workspace", "--locked"],
        vec!["test", "--workspace", "--locked", "--all-features"],
        vec!["build", "--workspace", "--release", "--locked"],
        vec![
            "build",
            "--workspace",
            "--release",
            "--locked",
            "--all-features",
        ],
    ];
    if serial {
        for check in &mut checks {
            if check[0] == "test" {
                check.extend(["--", "--test-threads=1"]);
            }
        }
    }
    let mut results = Vec::new();
    for (index, args) in checks.iter().enumerate() {
        let log = format!("{index}-{}.log", args[0]);
        let stdout = File::create(output.join(&log))?;
        let stderr = stdout.try_clone()?;
        let mut command = Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()));
        command.current_dir(root).args(args).env_clear();
        // 工具链和系统最小环境可继承；所有 Agent/输出凭据均不继承。
        for key in [
            "PATH",
            "CARGO_HOME",
            "RUSTUP_HOME",
            "RUSTUP_TOOLCHAIN",
            "RUSTUP_DIST_SERVER",
            "RUSTUP_UPDATE_ROOT",
            "CARGO_NET_OFFLINE",
            "SystemRoot",
            "WINDIR",
            "COMSPEC",
            "PATHEXT",
            "TEMP",
            "TMP",
            "TMPDIR",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        for key in ["HOME", "USERPROFILE"] {
            command.env(key, output.join("home"));
        }
        for key in [
            "APPDATA",
            "LOCALAPPDATA",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "XDG_CACHE_HOME",
        ] {
            let directory = output.join("home").join(key.to_lowercase());
            fs::create_dir_all(&directory)?;
            command.env(key, directory);
        }
        command.stdin(Stdio::null()).stdout(stdout).stderr(stderr);
        let start = Instant::now();
        let mut child = command
            .spawn()
            .with_context(|| format!("无法运行 cargo {}", args.join(" ")))?;
        let (status, timed_out) = loop {
            if let Some(status) = child.try_wait()? {
                break (status, false);
            }
            if start.elapsed() >= timeout {
                child.kill()?;
                break (child.wait()?, true);
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        results.push(CheckResult {
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            success: status.success() && !timed_out,
            exit_code: status.code(),
            timed_out,
            elapsed_ms: start.elapsed().as_millis(),
            log,
        });
        fs::write(
            output.join("results.json"),
            serde_json::to_vec_pretty(&results)?,
        )?;
        eprintln!(
            "cargo {}: {}",
            args.join(" "),
            if status.success() && !timed_out {
                "通过"
            } else {
                "失败"
            }
        );
    }
    if results.iter().any(|result| !result.success) {
        bail!(
            "基线有失败项，详见 {}",
            output.join("results.json").display()
        );
    }
    Ok(())
}
