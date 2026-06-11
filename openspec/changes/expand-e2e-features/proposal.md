## Why

现有 E2E L1（Docker 场景）仅覆盖基础安装/卸载和 JSONL 数据产出验证。以下 5 个核心运行时能力缺乏端到端回归保护：

1. **Agent 动态探测** — `AgentDiscoveryService` 轮询发现新 agent 的能力
2. **自动升级** — `Updater` 从 manifest 下载新版本并 hot-swap 的能力
3. **自动回退** — 升级失败时 installer 调用 `loongsuite-pilot rollback` 恢复旧版本
4. **双发** — `SlsFlusher` 同时向多个 endpoint 推送数据（含 per-endpoint redact）
5. **脱敏** — `src/mask/` 模块对 JSONL 输出中敏感数据的正则脱敏

CI 中缺少这些场景意味着回归风险高——任何改动可能静默破坏这些功能。

## What Changes

### E2E 测试框架

新增 `E2E_SCENARIO=expand-features` scenario，包含 5 个 phase：

| Phase | 功能 | 验证方式 |
|-------|------|---------|
| 1 | Agent 动态探测 | 卸载 agent → 启动 pilot → 重装 → 等 discovery interval → assert 日志 |
| 2 | 自动升级 | Mock HTTP manifest + tar.gz → updater pull → assert `current` pointer 更新 |
| 3 | 自动回退 | Mock broken version → installer upgrade → rollback → assert `current` 恢复 |
| 4 | 双发 | Mock 2 个 webtracking HTTP server → config 2 endpoints → assert 两端均收到数据 |
| 5 | 脱敏 | config mask=all → trigger probe with known sensitive patterns → assert JSONL masked |

### 新增文件

- `scripts/e2e/lib/expand-features.mjs` — 5 个 phase 的 script builder 函数
- `scripts/e2e/lib/mock-server.mjs` — 容器内 Node.js mock HTTP server helper

### 修改文件

- `scripts/e2e/run-l1.mjs` — 添加 `expandFeaturesScenario()` dispatch
- `scripts/e2e/lib/l1-env.mjs` — 添加 `expand-features` 到 `L1_SCENARIOS` + 环境变量
- `tests/e2e-docker/docker-compose.l1.yml` — 确保 env 透传

### 不变

- 现有 `install-smoke`、`uninstall`、`preflight` scenario 行为不变
- Pilot 运行时代码不修改（仅验证已有功能）
- Remote E2E 不受影响

## Affected Baseline Modules

- `docs/modules/updater.md` — 升级/回退流程
- `docs/modules/deployment.md` — agent 探测/发现
- `docs/modules/flushers.md` — SLS 双发/multi-endpoint
- `docs/modules/mask.md` — 脱敏规则引擎

本变更**不修改**任何 baseline 模块的行为或接口，仅新增 E2E 测试覆盖。

## Capabilities

### New Capabilities
- `e2e-expand-features`: Docker L1 场景下对 5 个核心运行时功能的端到端回归测试
- `e2e-mock-server`: 容器内轻量 HTTP mock server，支持 manifest 服务和 webtracking POST 收集

### Modified Capabilities
- `e2e-l1-env`: 新增 scenario 注册 + 相关环境变量默认值
