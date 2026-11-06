# Rust 构建与发布

Pilot 2.0.0 的采集器、CLI 和 updater 使用 Rust。安装后的核心不依赖 Node/npm/Python；Agent 宿主插件与 Swift UI 保留各自运行环境。

## 构建依赖

工具链固定 Rust 1.99.1。Cargo.lock 保留，构建与测试使用 `--locked`。

首次构建前执行：

```bash
python3 scripts/build/prepare-rust-dependencies.py
cargo build --locked --release
```

Windows 可用 `python` 替代 `python3`。Python 只准备开发依赖，不进入 Pilot 运行包。

Boa 0.22.0 的两份源码从 crates.io 官方归档下载，校验固定 SHA-256，仅把原有 ICU 约束从 `~2.3.0` 改为 `~2.4.0`，不修改 Rust 源码、不降低依赖版本。配方位于 `scripts/build/rust-dependencies.json`，源码缓存到忽略的 `.build/rust-deps/`。归档缓存于 `.build/rust-archives/`，源码与归档都独立于 Cargo 构建缓存清理。许可证保留于 `licenses/`。

后续构建验证并复用缓存。离线构建须先准备缓存，然后执行：

```bash
python3 scripts/build/prepare-rust-dependencies.py --offline
cargo build --locked --offline --release
```

`--offline` 的 Cargo 构建还要求其余 registry 依赖已有缓存。CI 自动准备并缓存 Boa 源码，无须把第三方整份源码提交到仓库。

## 质量门禁

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --locked --all-features
```

测试使用隔离 HOME，保留 CARGO_HOME/RUSTUP_HOME；真实用户配置和采集状态不作为测试资源。默认与 all-features 构建避免并发共用相同输出路径。

GitHub Actions 每个任务上限为 60 分钟，尽量通过缓存和减少重复构建缩短实际耗时。不得为了满足时限减少有效断言、跳过运行测试或放宽单个行为测试的预算。

Node/Python 仅用于可选宿主插件的开发测试。CI 保留快捷方式、Node Worker、Hermes 和 OpenCode 的实际宿主测试。

## 平台与包

发布目标为 Linux GNU x64/ARM64、macOS x64/ARM64、Windows MSVC x64/ARM64；不支持 musl。GNU 产物保留 glibc 2.34 验证基线，测试辅助镜像见 `scripts/testing/containers/glibc234.Dockerfile`。

候选包由 `xtask package` 生成并执行包内预检。清单与摘要、Hook 资源、安装激活、旧配置/未知字段保留、回滚和安全卸载仍由现有功能测试与发布校验负责。

正式 tag/Release、资产上传和更新渠道切换须按发布流程执行。本轮仓库清理不构成正式发布。

## 记录和未完成验收

运行日志、CI 结果、迁移审计账本和中间快照不再作为源码提交；本轮删除前的内容可从 Git 历史 `48c40f94` 恢复。运行输出保存在忽略目录或 CI artifacts。

保留实际回归测试及其必要夹具。测试源码不因名称包含 history、contract 或 migration 就被删除；只删除退休审计工具自身的测试。

CI 成功不代替所有真实 Agent、真实个人资料和桌面环境验收。此前保留的千问真实个人资料场景及完整 macOS 快捷方式交互验收，未取得新证据时继续视为未完成。
