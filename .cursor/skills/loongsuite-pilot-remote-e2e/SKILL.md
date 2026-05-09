---
name: loongsuite-pilot-remote-e2e
description: >-
  Runs SSH-based end-to-end checks for LoongSuite-Pilot on Linux dev hosts or ECS:
  installer/uninstall, optional agent-matrix CLI ensure + probes. Telemetry is verified manually in the SLS console.
  Use when implementing or debugging remote E2E, release validation on 7U/8U/ECS, or
  when the user mentions loongsuite-pilot e2e, remote integration tests, or SSH install smoke.
---

# LoongSuite-Pilot 远程 E2E

## 何时使用

- 在 **Linux 开发机 / ECS** 上验证官方安装脚本、卸载、可选 **Agent 矩阵 CLI 安装 + 探针**。
- 脚本在 [`scripts/e2e/run-remote-e2e.mjs`](../../../scripts/e2e/run-remote-e2e.mjs)。**不在本机自动轮询 Logstore**；请到 **SLS 控制台** 对照远端 `~/.loongsuite-pilot/config.json` 中的 project/logstore 自行查日志。

## 为何只看到 Codex、别的 Agent 像「没跑」？

1. **矩阵会顺序跑四个 Agent**：每个前后有 **`[e2e-probe] >>> start: …`** 与 **`<<< end: … (exit …)`**；非 0 也会继续（非致命）。若终端里只有 Codex 的长输出，**往上翻**应能看到各段的 start/end。
2. **SLS 里仍可能只有 codex**：**Claude** 未登录时 `claude -p` 往往只打印 **`Not logged in`**，**不会产生**完整会话遥测；**Cursor** 仅 `--version` 或 **无 hook** 时也可能没有 `cursor-hook` 类事件；**Qoder** 需 CLI 真实跑起来才有对应 `gen_ai.agent.type`。
3. **SSH / stdin**：多段探针仍用 **`printf | base64 -d | bash -s`**，避免 Codex 吃掉后续脚本。
4. **Cursor 安装**：`curl install.sh | bash` 时 watzon 的 **`SCRIPT_DIR` 不是真实目录**，脚本会**强制**再从 GitHub 拉 **`cursor.sh`**（易超时/被墙）。E2E 改为把 **`install.sh` + `lib.sh` + `cursor.sh`** 下载到 **`~/.cache/loongsuite-e2e-cursor-install`**（jsDelivr 优先、raw GitHub 兜底），再执行 **`bash ./install.sh stable --extract`**。若 **`shim.sh`** 仍无法从 GitHub 下载，watzon 可能跳过 **`~/.local/bin/cursor`**，但解压产物通常在 **`~/.local/share/cursor/cursor/usr/bin/cursor`**：ensure 会 **`ln -sf`** 补上 **`cursor`**；探针也会在无 PATH 时直接调用该 **`usr/bin/cursor`**。可选再跑一次 **`cursor-installer --extract --update`**（失败也可忽略）。若整套仍失败，设 **`E2E_CURSOR_ENSURE_INSTALL_SH`** 或按 [Cursor 文档](https://cursor.com/docs) 用 apt。
5. **Qoder Logstore**：**`qoder --version` 不会产生上报**。矩阵探针在非交互下跑 **`qodercli -q -p "你好"`**，且需在 **本地** 设置 **`E2E_QODER_PERSONAL_ACCESS_TOKEN`**（[Qoder PAT](https://qoder.com/account/integrations)），由脚本注入远端 **`QODER_PERSONAL_ACCESS_TOKEN`**。若出现 **`invalid personal token format` / 400**：多为 **非 PAT**（例如误用 OpenAI `sk-…`）或复制时带了 **`Bearer `**、外层引号；脚本会做基础规范化并打印 **token 长度**（不打印内容）。SSH 不会自动转发你在终端 `export` 的变量。

## 为何安装器只装「Claude Code / Codex 插件」不装 Qoder、Cursor CLI？

官方 **`loongsuite-pilot-installer-inner.sh`** 内置的是 **OpenTelemetry / hook 插件**（Claude、Codex 等），**不负责**把 `cursor`、`qoder`、`claude`、`codex` **CLI 二进制**装到 PATH。矩阵里的 CLI **按需安装**由本仓库 E2E 的 **`[e2e-ensure]`** 阶段完成（见 [`scripts/e2e/agent-matrix.json`](../../../scripts/e2e/agent-matrix.json) 的 **`ensureInstallSh`**）。

## 环境变量（节选）

| 变量 | 说明 |
|------|------|
| `E2E_USE_MATRIX_PROBE` | 设为 **`1`**：忽略 `E2E_AGENT_PROBE_CMD`，按 **`agent-matrix.json`** 逐个执行 **`defaultProbeSh`**（每段 stdin 隔离）。**默认会先做矩阵 CLI ensure**（见下）。 |
| `E2E_ENSURE_AGENT_CLIS` | **`1`**：强制在探针前执行矩阵 **`ensureInstallSh`**；**`0`**：跳过。**未设置时**：若 **`E2E_USE_MATRIX_PROBE=1`** 则 **默认执行 ensure**；若仅用自定义 `E2E_AGENT_PROBE_CMD` 则 **默认不 ensure**（避免意外 `npm install -g`）。 |
| `E2E_AGENT_MATRIX_PATH` | 可选，覆盖默认 [`scripts/e2e/agent-matrix.json`](../../../scripts/e2e/agent-matrix.json) |
| `E2E_EXTRA_ENSURE_BASH` | 可选，追加到 ensure 脚本（例如内网安装 Qoder 的一条命令） |
| `E2E_AGENT_PROBE_CMD` | 自定义多行探针；**推荐用单独一行的 `---` 分隔**「公共 setup」与「每个 Agent 一段」，每段经 base64 子 bash 执行 |
| `E2E_OPENAI_API_KEY` / `E2E_CODEX_OPENAI_API_KEY` | **仅本地**：注入远端 **`export OPENAI_API_KEY=…`**（供 Codex `env_key`、部分工具链）。勿把密钥写进仓库或聊天记录。 |
| `E2E_ANTHROPIC_API_KEY` / `E2E_CLAUDE_API_KEY` | **仅本地**：注入远端 **`ANTHROPIC_API_KEY`**，便于 **`claude -p`** 走 API 模式（无需 `/login`）。 |
| `E2E_CURSOR_API_KEY` | **仅本地**：可选注入 **`CURSOR_API_KEY`**（若你的 Cursor CLI/集成读该变量）。 |
| `E2E_WRITE_REMOTE_CODEX_CONFIG` | 设为 **`1`**：在探针阶段写入远端 **`~/.codex/config.toml`**（Dashscope 兼容模板；**密钥不进文件**，仍走 **`env_key`** 指向的变量，默认 **`OPENAI_API_KEY`**）。 |
| `E2E_CODEX_MODEL_PROVIDER` / `E2E_CODEX_MODEL` / `E2E_CODEX_BASE_URL` / `E2E_CODEX_ENV_KEY` / `E2E_CODEX_WIRE_API` | 可选，配合上一项覆盖模板字段（默认与 Dashscope OpenAI-compatible 对齐）。 |
| `E2E_CURSOR_JSDELIVR_BASE` / `E2E_CURSOR_RAW_BASE` | 可选，覆盖 staging 用的目录 URL（默认 watzon `cursor-linux-installer@main` 的 jsDelivr / raw GitHub **根路径**，会拉 `install.sh`、`lib.sh`、`cursor.sh`）。 |
| `E2E_CURSOR_INSTALL_SCRIPT_URL` | 可选，若只设此变量（指向 `…/install.sh`），会 **推导** 为 **`E2E_CURSOR_JSDELIVR_BASE`** 的目录。 |
| `E2E_CURSOR_INSTALL_SCRIPT_URL_FALLBACK` | 可选，同理推导 **`E2E_CURSOR_RAW_BASE`**。 |
| `E2E_CURSOR_ENSURE_INSTALL_SH` | 可选，**整段替换** Cursor 的 ensure bash（内网 apt/curl 等）。 |

其余：`E2E_SSH_*`、`E2E_USER_ID`、`E2E_SCENARIO`、`E2E_SLS_*`、`E2E_PROPAGATE_SLS_INSTALL` 等仍见下文表格。

| 变量 | 说明 |
|------|------|
| `E2E_SSH_TARGET` | `user@host`，必填（或 `E2E_SSH_USER` + `E2E_SSH_HOST`） |
| `E2E_SSH_IDENTITY` | 可选，`ssh -i`；文件不存在则忽略 |
| `E2E_SSH_PASSWORD_AUTH` | `1`：交互密码；脚本走 base64 管道 |
| `E2E_SSH_REMOTE_TTY` | `1`：强制 `ssh -tt`（慎用，可能回显 base64） |
| `E2E_SSH_BATCH_MODE` | `0` / `no`：关闭 BatchMode |
| `E2E_SSH_EXTRA_OPTS` | 附加 ssh 参数（空格拆分） |
| `E2E_USER_ID` | **`install-smoke` 必填** |
| `E2E_INSTALLER_URL` | 可选 |
| `E2E_SCENARIO` | `preflight` \| `install-smoke` \| `uninstall` |
| `E2E_ARTIFACT_DIR` | 可选 |
| `E2E_PROFILE` | `linux-8u`（默认）或 `linux-7u` / `alios7` 等 |

**自建 SLS（安装参数）**

| `E2E_SLS_PROJECT` / `E2E_SLS_LOGSTORE` | 同时设置则安装器带 `--sls-project` / `--sls-logstore` |
| `E2E_SLS_ENDPOINT` | 可选 |
| `E2E_SLS_ACCESS_KEY_ID` / `SECRET` | 同时设置则 `--sls-ak-*` |
| `E2E_PROPAGATE_SLS_INSTALL` | `0` 关闭上述传播 |

## 推荐：一键矩阵（安装 + ensure + 四路探针）

```bash
export E2E_SSH_TARGET='you@host'
export E2E_USER_ID='你的工号'
export E2E_SCENARIO=install-smoke
export E2E_USE_MATRIX_PROBE=1
export E2E_WRITE_REMOTE_CODEX_CONFIG=1
export E2E_OPENAI_API_KEY='你的Dashscope/OpenAI兼容Key（勿提交git）'
export E2E_ANTHROPIC_API_KEY='可选-Claude API Key'
# export E2E_CURSOR_API_KEY='可选'
# Qoder 要在 Logstore 里看到非 version 事件：本地设 PAT，脚本会注入远端
export E2E_QODER_PERSONAL_ACCESS_TOKEN='你的测试PAT'
# 可选：自建 Logstore
export E2E_SLS_PROJECT='your-project'
export E2E_SLS_LOGSTORE='your-logstore'
npm run test:e2e:remote
```

- **Qoder**：`npm install -g @qoder-ai/qodercli` + **`qoder` 符号链接**；Logstore 需 **`E2E_QODER_PERSONAL_ACCESS_TOKEN`** 才能跑 **`-q -p`** 产生模型相关事件（见上）。
- **Cursor**：ensure **staging 三文件** + **`--extract`**；补 **`~/.local/bin/cursor`** 与 **`…/share/cursor/cursor/cursor`** 兼容链。矩阵探针为 **`--version`**；完整对话/IDE 常需登录或 **`E2E_CURSOR_API_KEY`**。若 AppImage 下载失败，用 **`E2E_CURSOR_ENSURE_INSTALL_SH`** 或 apt。
- **Codex**：远端 **`~/.codex/config.toml`** 可由 **`E2E_WRITE_REMOTE_CODEX_CONFIG=1`** 写入模板；密钥只用 **`E2E_OPENAI_API_KEY`**（或 **`E2E_CODEX_OPENAI_API_KEY`**）注入环境变量，不进配置文件。
- **Claude Code**：设 **`E2E_ANTHROPIC_API_KEY`** 后远程 **`claude -p`** 可走 API；否则多为 **`Not logged in`**。

## 自定义探针 + `---` 分段（与矩阵二选一）

勿同时依赖矩阵探针；不设 `E2E_USE_MATRIX_PROBE=1` 时生效：

```bash
export E2E_AGENT_PROBE_CMD='set +e
export PATH="$HOME/.local/bin:$PATH"
cd "$HOME"
---
command -v codex >/dev/null && codex exec "你好" --skip-git-repo-check < /dev/null || true
---
command -v claude >/dev/null && claude -p "你好" --dangerously-skip-permissions || true
---
command -v cursor >/dev/null && cursor --version || true
---
command -v qoder >/dev/null && qoder --version || true'
```

若希望在自定义探针前也跑矩阵 ensure：`export E2E_ENSURE_AGENT_CLIS=1`。

## 场景

| `E2E_SCENARIO` | 行为 |
|----------------|------|
| `preflight` | 连通性 |
| `install-smoke` | 安装 pilot → 可选 ensure + 探针 |
| `uninstall` | 卸载 |

## 失败排查

1. SSH / `E2E_ARTIFACT_DIR` 产物。
2. **`[e2e-ensure] missing qoder`**：补 **`ensureInstallSh`** 或 **`E2E_EXTRA_ENSURE_BASH`**。
3. Codex 仍异常：保留 **`---`** 分段与 **`< /dev/null`**。
4. SLS 无数据：远端 **`config.json` → sls**、`sls-failed-logs`。

## 契约

事件字段见 [`src/types/events.ts`](../../../src/types/events.ts)。矩阵权威列表 [`scripts/e2e/agent-matrix.json`](../../../scripts/e2e/agent-matrix.json)。
