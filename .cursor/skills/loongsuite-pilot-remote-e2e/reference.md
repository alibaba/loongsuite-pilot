# LoongSuite-Pilot 远程 E2E — 参考

## 环境矩阵（分阶段）

| 阶段 | 环境 | 说明 |
|------|------|------|
| Phase 1 | Linux 开发机（x86 / arm64） | 优先跑通 `install-smoke`；**默认** `E2E_PROFILE=linux-8u` 仅表示「**不做** Node 22 + patchelf 引导」，**不等于**发行版一定是「8U」 |
| Phase 2 | Linux ECS | 干净镜像、systemd、sudo；脚本与开发机共用 |
| Phase 3 | Linux 7U / **AliOS 7** 等旧 glibc | 若需 **Node 22 + patchelf**，设 **`E2E_PROFILE=linux-7u`**（或 **`alios7`**） |
| 后置 | macOS | launchd、`~/.local/bin`；与 Linux 分支在脚本外交付 |

**说明**：同一台机器可能 **内核显示 AliOS 7** 但 **Node 18** 已能跑安装器 —— 可用默认 `linux-8u`；**仅当**要走官方 7U 补丁路径时再切 `linux-7u` / `alios7`。

## Linux 7U / AliOS 7：远端引导（安装 Pilot 之前）

在目标机上一次执行（**仅当需要 patchelf 路径时**）：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
# 重新登录 shell 或 source ~/.nvm/nvm.sh 后：
nvm install 22
curl -fsSL https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite/loongsuite-pilot/patchelf_node_for_7u.sh | bash
node -v
```

本仓库脚本在 **`E2E_PROFILE=linux-7u`**、**`7u`**、**`alios7`**、**`linux-alios7`** 时会在 `install-smoke` 安装前自动执行上述引导（需远端可访问对应 URL）。

## Agent / CLI 代表版本与 ensure

权威列表见仓库 [`scripts/e2e/agent-matrix.json`](../../../scripts/e2e/agent-matrix.json)。每条可含 **`binary`**、**`slsAgentTypeHint`**（与 [`src/types/client-type.ts`](../../../src/types/client-type.ts) 对齐）、**`ensureInstallSh`**（缺二进制时在远端执行的安装片段）、**`defaultProbeSh`**（与 **`E2E_USE_MATRIX_PROBE=1`** 配套的非交互探针）。

官方 **loongsuite-pilot 安装器** 主要部署 **hook/插件**（如 Claude、Codex），**不会**自动把矩阵里全部 CLI 装进 PATH；CLI 由 E2E **`[e2e-ensure]`** 按矩阵补齐。**Cursor**：staging 安装脚本 + **`--extract`**；若 shim 下载失败则 **`ln -sf`** 指向 **`~/.local/share/cursor/cursor/usr/bin/cursor`**。**Qoder** 在 Logstore 出现模型类事件需 **`E2E_QODER_PERSONAL_ACCESS_TOKEN`**（本地注入远端），仅用 `--version` 不会产生上报。

在 **SLS 控制台** 过滤 **`gen_ai.agent.type`** 时可对照矩阵中的 **`slsAgentTypeHint`**。

## IDE 自动化（调研项）

Cursor / Qoder **桌面端** 的完整会话自动化可能不稳定；**CLI + hook 路径**更适合作为 E2E 探针；IDE 深度场景可保留手工回归。

## 高成本场景

- **整机重启验证自启动**：默认不放在 `install-smoke`；建议在 ECS 上单独 nightly。
- **多 Unix 用户**：需两个 SSH target 或同一主机两次 `su - user`；当前以文档说明为主。
