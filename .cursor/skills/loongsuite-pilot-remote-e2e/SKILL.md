---
name: loongsuite-pilot-remote-e2e
description: >-
  通过 SSH 在 Linux 开发机 / ECS 上运行 LoongSuite-Pilot 远程 E2E：
  安装/卸载 pilot、矩阵式 CLI ensure + 四路 Agent 探针（Codex / Claude / Cursor / Qoder），
  可选将 SLS 配置传播到远端。当用户提到 loongsuite-pilot e2e、远程集成测试、SSH 安装冒烟、
  7U/8U/ECS 验证、agent-matrix 探针时务必使用本 Skill，即使只问"怎么跑"也应触发。
---

# LoongSuite-Pilot 远程 E2E

入口脚本：[`scripts/e2e/run-remote-e2e.mjs`](../../../scripts/e2e/run-remote-e2e.mjs)；Agent 矩阵定义：[`scripts/e2e/agent-matrix.json`](../../../scripts/e2e/agent-matrix.json)。

## 工作流

1. 设置必填 env（`E2E_SSH_TARGET`、`E2E_USER_ID`），按需加 API key 变量。
2. 执行 `npm run test:e2e:remote`。
3. 脚本依序：SSH preflight → install-smoke → ensure CLIs → 四路 Agent 探针。
4. 到 SLS 控制台，按远端 `~/.loongsuite-pilot/config.json → sls` 的 project/logstore 查日志。脚本不轮询 Logstore。

## 最简示例（install-smoke + 矩阵探针）

```bash
export E2E_SSH_TARGET='you@host'
export E2E_USER_ID='你的工号'
export E2E_SCENARIO=install-smoke
export E2E_USE_MATRIX_PROBE=1
export E2E_WRITE_REMOTE_CODEX_CONFIG=1
export E2E_CODEX_OPENAI_API_KEY='Dashscope compatible-mode Key'
export E2E_CLAUDE_BAILIAN=1
export E2E_CLAUDE_BAILIAN_API_KEY='百炼 Key（走 …/apps/anthropic）'
export E2E_WRITE_REMOTE_CLAUDE_ONBOARDING_SKIP=1
export E2E_QODER_PERSONAL_ACCESS_TOKEN='你的测试 PAT'
npm run test:e2e:remote
```

## 常见问题

**Cursor `GLIBC_2.xx not found`**：官方 Agent CLI 需要较新 glibc。设 `E2E_PROFILE=linux-7u`（脚本自动改用 watzon AppImage），或直接 `E2E_CURSOR_INSTALL_STRATEGY=watzon`。若机器上残留旧 AppImage 但 glibc 仍不满足，ensure 阶段会检测运行失败并自动跳过（`E2E_CURSOR_SKIP_IF_INCOMPAT=1` 默认开启），probe 打印 `cursor skipped: host glibc too old`；设为 `0` 则 probe 以 exit 78 失败。

**SLS 只有 Codex 数据**：Claude 未设 API key 时 `claude -p` 输出 `Not logged in`；百炼须用 `…/apps/anthropic` 端点（非 `compatible-mode/v1`）。Qoder 需要 `E2E_QODER_PERSONAL_ACCESS_TOKEN` 才能产生模型事件（`--version` 不上报）。Cursor 只有 `--version` 不会产生 cursor-hook 事件。

**Codex SLS 数据消失**：勿长期开 `E2E_CODEX_FORCE_ENSURE=1`；若整文件覆盖过 `~/.codex/config.toml`，重跑 pilot 安装恢复 OTel 段落。

**矩阵只有输出，没看到分段**：每段前后有 `[e2e-probe] >>> start:` / `<<< end:`，翻回终端往上看。

## 环境变量

### SSH

| 变量 | 说明 |
|------|------|
| `E2E_SSH_TARGET` | `user@host`，必填（或 `E2E_SSH_USER` + `E2E_SSH_HOST`） |
| `E2E_SSH_IDENTITY` | `ssh -i` 路径；不存在则忽略 |
| `E2E_SSH_PASSWORD_AUTH` | `1`：交互密码 |
| `E2E_SSH_EXTRA_OPTS` | 附加 ssh 参数 |
| `E2E_SCENARIO` | `preflight` \| `install-smoke` \| `uninstall` |
| `E2E_USER_ID` | install-smoke 必填 |
| `E2E_PROFILE` | `linux-8u`（默认）\| `linux-7u` \| `alios7` 等；影响 Cursor 默认安装策略 |
| `E2E_ARTIFACT_DIR` | 产物目录（可选） |

### Cursor

| 变量 | 说明 |
|------|------|
| `E2E_CURSOR_INSTALL_STRATEGY` | `official`（默认）\| `watzon`；旧 glibc profile 自动选 watzon |
| `E2E_CURSOR_ENSURE_INSTALL_SH` | 整段替换 Cursor ensure bash |
| `E2E_CURSOR_SKIP_IF_INCOMPAT` | `1`（默认）：glibc 不兼容时 probe skip；`0`：exit 78 |
| `E2E_CURSOR_JSDELIVR_BASE` / `E2E_CURSOR_RAW_BASE` | watzon 策略的下载 URL |
| `E2E_CURSOR_API_KEY` | 可选注入 `CURSOR_API_KEY` |

### Codex

| 变量 | 说明 |
|------|------|
| `E2E_WRITE_REMOTE_CODEX_CONFIG` | `1`：写入远端 `~/.codex/config.toml`（Dashscope，合并已有 OTel 段落） |
| `E2E_WRITE_REMOTE_CODEX_CONFIG_REPLACE` | `1`：整文件覆盖（不合并） |
| `E2E_CODEX_OPENAI_API_KEY` | 注入远端 `CODEX_OPENAI_API_KEY` |
| `E2E_CODEX_FORCE_ENSURE` | `1`：强制 `npm install -g @openai/codex`（SLS 断档时慎用） |
| `E2E_CODEX_NPM_SPEC` | npm 包说明符（默认 `@openai/codex`） |

### Claude Code

| 变量 | 说明 |
|------|------|
| `E2E_CLAUDE_BAILIAN` | `1`：注入百炼 `ANTHROPIC_BASE_URL`（`…/apps/anthropic`）+ key + model |
| `E2E_CLAUDE_BAILIAN_API_KEY` / `_BASE_URL` / `_MODEL` | 百炼配置；未设 key 则跳过 |
| `E2E_ANTHROPIC_API_KEY` / `E2E_CLAUDE_API_KEY` | 官方 Anthropic key（百炼开启时被覆盖） |
| `E2E_WRITE_REMOTE_CLAUDE_ONBOARDING_SKIP` | `1`：写入 `~/.claude.json` 跳过引导 |
| `E2E_WRITE_REMOTE_CLAUDE_PROXY_CONFIG` | `1`：写入 `~/.config/claude-code-proxy/config.json`（需 `E2E_CLAUDE_PROXY_API_KEY`） |

### Qoder

| 变量 | 说明 |
|------|------|
| `E2E_QODER_PERSONAL_ACCESS_TOKEN` | 注入远端 `QODER_PERSONAL_ACCESS_TOKEN`；缺失时矩阵跳过 `qodercli -p` |

### 矩阵 / SLS 传播

| 变量 | 说明 |
|------|------|
| `E2E_USE_MATRIX_PROBE` | `1`：按 agent-matrix.json 跑四路探针 |
| `E2E_ENSURE_AGENT_CLIS` | `1` / `0`：强制执行 / 跳过 ensure；默认随 matrix probe 自动开 |
| `E2E_EXTRA_ENSURE_BASH` | 追加到 ensure 脚本 |
| `E2E_AGENT_PROBE_CMD` | 自定义探针（与矩阵二选一；`---` 分段隔离） |
| `E2E_SLS_PROJECT` / `E2E_SLS_LOGSTORE` | 传播 SLS 配置（同时设才生效） |
| `E2E_SLS_ENDPOINT` / `E2E_SLS_ACCESS_KEY_ID` / `_SECRET` | 自建 SLS 参数 |
| `E2E_PROPAGATE_SLS_INSTALL` | `0`：关闭 SLS 配置传播 |

## 场景说明

| `E2E_SCENARIO` | 行为 |
|----------------|------|
| `preflight` | SSH 连通性检测 |
| `install-smoke` | 安装 pilot → ensure CLIs → 探针 |
| `uninstall` | 卸载 pilot |

## 契约

事件字段见 [`src/types/events.ts`](../../../src/types/events.ts)。
