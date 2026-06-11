# LoongSuite Pilot 本地端到端测试指南

## 概述

本指南介绍如何在本地环境中对 loongsuite-pilot 进行端到端验证 —— 从构建、安装、启动服务、触发真实 Agent 活动，到验证输出正确性的完整流程。

> **核心原则：** 每次完整 E2E 验证必须对每个已安装的 Agent 触发至少一次真实对话（或模拟 hook 调用），然后验证 output JSONL 中出现了对应的**新增**条目。仅验证基础设施（启动、注册、watchdog 健康）不足以发现采集链路中的 bug（如 hook 脚本异常、processor 格式变更、normalization 回归等）。不能用历史数据替代验证。

## 0. 快速验证（推荐先跑）

如果你只想验证"当前分支代码能装起来 + 4 个 agent 的数据能采到"，跳过下面的手动步骤：

    cp .env.e2e.example .env.e2e
    # 填 8 个 env（cursor 默认跳过）
    bash scripts/e2e/run-e2e.sh

详见 [docs/E2E-REMOTE-TEST-GUIDE.md 的 L1 章节](../docs/E2E-REMOTE-TEST-GUIDE.md#l1-快速验证docker当前分支代码)。下面 1-N 节是手动调试 / 单组件验证流程。

## 前置条件

- Node.js >= 18, npm >= 8
- 至少安装了一个 AI Agent（Qoder CLI、Qoder Work、Claude Code、Codex CLI、Cursor 等）
- 干净或已存在的 `~/.loongsuite-pilot/` 数据目录

## 1. 构建与打包

### 1.1 开发构建

```bash
npm install
npm run build        # TypeScript → dist/
npm run typecheck    # 仅类型检查（快速）
```

### 1.2 完整打包（模拟发布）

```bash
bash deploy/package.sh
# 产出: loongsuite-pilot.tar.gz
# 包含: dist/, assets/, scripts/, plugins/, package.json, VERSION
```

## 2. 本地安装与部署

### 2.1 开发模式（直接运行源码编译产物）

直接从项目目录运行编译产物：

```bash
npm run build
node dist/index.js
```

此方式使用 `~/.loongsuite-pilot/config.json` 中的本地配置。

### 2.2 模拟正式安装

```bash
bash deploy/package.sh
# 然后像生产环境一样解压并安装：
bash deploy/installer.sh install --local ./loongsuite-pilot.tar.gz
```

关键安装步骤说明：部署到 `~/.loongsuite-pilot/versions/{ver}_{commit}/`，执行 postinstall（部署 hooks），更新 `current` 指针，注册自动启动。

### 2.3 关键配置

`~/.loongsuite-pilot/config.json` 示例：

```json
{
  "enabled": true,
  "dataDir": "/Users/<username>/.loongsuite-pilot",
  "userId": "<your-user-id>",
  "autoUpdate": { "enabled": false }
}
```

测试时常用的环境变量：

- `LOONGSUITE_PILOT_ENABLED=true`
- `LOONGSUITE_PILOT_DATA_DIR=~/.loongsuite-pilot`
- `LOG_LEVEL=debug`（测试时推荐使用，输出更详细的日志）
- `JSONL_ENABLED=true`（确保本地 JSONL 输出已开启）
- `LOONGSUITE_PILOT_AUTO_UPDATE_ENABLED=false`（开发期间禁用自动更新）
- `LOONGSUITE_SLS_ACCESS_KEY_ID` / `LOONGSUITE_SLS_ACCESS_KEY_SECRET`（可选，用于 SLS 测试）

## 3. 启动服务

### 3.1 开发模式启动

```bash
LOG_LEVEL=debug JSONL_ENABLED=true node dist/index.js
```

### 3.2 通过 CLI 启动（已安装情况）

```bash
loongsuite-pilot start
loongsuite-pilot status   # 检查运行状态
loongsuite-pilot log      # 查看服务日志
```

### 3.3 验证启动成功

检查服务日志 `~/.loongsuite-pilot/logs/loongsuite-pilot-service.log`（日志为 pino 结构化 JSON 格式）：

- 应看到 `"msg":"orchestrator started"`
- 应看到 Agent 发现消息：`"msg":"agent detected and started"`，Agent 标识在 `"id"` 字段中（如 `"id":"qoder-cli-hook"`）
- 应看到输入源已注册

## 4. 触发 Agent 活动

本节覆盖所有已支持的 Agent 类型。每种 Agent 的采集机制不同，触发方式也不同。

> **安装提示**：agent-matrix.json（`scripts/e2e/agent-matrix.json`）中记录了每种 Agent CLI 的 npm 包名和安装命令，可参考其中的 `ensureInstallSh` 字段。

### 4.1 Qoder CLI

Qoder CLI 的实际可执行文件名为 `qodercli`（npm 包 `@qoder-ai/qodercli`）。安装后可能需要手动创建 `qoder` 软链接：

```bash
# 安装（如尚未安装）
npm install -g @qoder-ai/qodercli

# 确认可用
qodercli --version
```

触发一次对话（需要 `QODER_PERSONAL_ACCESS_TOKEN`）：

```bash
# >= 0.2.12 版本
qodercli --print --yolo --cwd "$HOME" "你好" </dev/null

# < 0.2.12 旧版本
qodercli -p "你好" --max-turns 1 --yolo -w "$HOME" </dev/null
```

对话结束时，`~/.qoder/settings.json` 中配置的 `Stop` hook 会调用 `~/.loongsuite-pilot/hooks/qoder-loongsuite-pilot-hook.sh`，进而调用 `hook-processor.mjs`。

### 4.2 Qoder Work

Qoder Work 使用独立的配置目录 `~/.qoderwork/`，目前没有公开的独立 CLI，无法通过命令行自动触发。

**需要人工操作：** 请在 IDE 中打开 Qoder Work 并完成一次对话（发送任意消息并等待回复结束）。对话结束时 `~/.qoderwork/settings.json` 中配置的 `Stop` hook 会调用 `~/.loongsuite-pilot/hooks/qoderwork-loongsuite-pilot-hook.sh`。

> **卡点：** 请确认已在 Qoder Work 中完成一次对话后再继续后续验证步骤。

### 4.3 Claude Code

Claude Code 通过 `otel-claude-hook` 插件（`~/.cache/opentelemetry.instrumentation.claude/`）采集数据，hook 配置在 `~/.claude/settings.json` 中。

```bash
# 触发一次对话
claude -p "你好" --dangerously-skip-permissions
```

对话过程中的各种事件（`pre-tool-use`、`post-tool-use`、`stop` 等）会通过 otel hook 写入 `~/.loongsuite-pilot/logs/claude-code/` 目录。

### 4.4 Codex CLI

Codex CLI（npm 包 `@openai/codex`）通过 `otel-codex-hook` 插件（`~/.cache/opentelemetry.instrumentation.codex/`）采集数据，hook 配置在 `~/.codex/hooks.json` 中。

```bash
# 安装（如尚未安装）
npm install -g @openai/codex

# 触发一次对话（需要 CODEX_OPENAI_API_KEY 或 OPENAI_API_KEY）
codex exec "你好" --skip-git-repo-check </dev/null
```

事件通过 otel hook 写入 `~/.loongsuite-pilot/logs/codex/` 目录。

### 4.5 Cursor

Cursor 提供了 `cursor agent` 子命令，支持命令行触发对话（需要 `CURSOR_API_KEY` 或已登录）：

```bash
# 触发一次非交互式对话
cursor agent -p "你好" --yolo
```

对话过程中 `~/.cursor/hooks.json` 中的 hook 配置会触发 `cursor-loongsuite-pilot-hook.sh`，进而调用 `cursor-hook-processor.mjs`。

也可以通过 GUI 方式：打开 Cursor IDE 并与 AI 助手交互。

### 4.6 采集链路端到端验证检查表

触发每个 Agent 对话后，**必须**验证新数据出现在 output JSONL 中，且**必须**确认新增条目确实来自刚触发的对话（通过 session ID 交叉验证），而非历史残留数据。

| Agent | 触发方式 | Session ID 来源 | 标准化输出文件 |
|-------|---------|----------------|--------------|
| Qoder CLI | `qodercli --print --yolo --cwd "$HOME" "hello" </dev/null` | CLI 输出中的 `session:` 行 | `output/qoder-cli-{date}.jsonl` |
| Qoder Work | IDE 中完成一次对话（无 CLI） | hook 日志中 `gen_ai.session.id` | `output/qoder-work-{date}.jsonl` |
| Claude Code | `claude -p "hello" --dangerously-skip-permissions` | CLI 启动时的 session ID | `output/claude-code-{date}.jsonl` |
| Codex | `codex exec "list files in /tmp" --skip-git-repo-check </dev/null` | CLI 输出中的 `session id:` 行 | `output/codex-{date}.jsonl` |
| Cursor | `cursor agent -p "hello" --yolo` | hook 日志中 `gen_ai.session.id` | `output/cursor-{date}.jsonl` |

#### 验证流程（每个 Agent 必须执行）

```bash
OUTPUT=~/.loongsuite-pilot/logs/output/{agent}-$(date +%Y-%m-%d).jsonl

# Step 1: 记录触发前的行数
BEFORE=$(wc -l "$OUTPUT" 2>/dev/null | awk '{print $1}')
BEFORE=${BEFORE:-0}

# Step 2: 触发对话，捕获 session ID
# 示例（Qoder CLI）：
SESSION_ID=$(qodercli --print --yolo --cwd "$HOME" "hello" </dev/null 2>&1 | grep -o 'session:[^ ]*' | cut -d: -f2)
# 示例（Codex）：
SESSION_ID=$(codex exec "hello" --skip-git-repo-check </dev/null 2>&1 | grep 'session id:' | awk '{print $NF}')
# 示例（Cursor）：
cursor agent -p "hello" --yolo
# cursor 的 session ID 需从 hook 日志中提取：
SESSION_ID=$(tail -1 ~/.loongsuite-pilot/logs/cursor/history/cursor-*.jsonl | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('gen_ai.session.id',''))")

# Step 3: 等待轮询周期（默认 30-60s）
sleep 60

# Step 4: 验证行数增长
AFTER=$(wc -l "$OUTPUT" 2>/dev/null | awk '{print $1}')
AFTER=${AFTER:-0}
[ "$AFTER" -gt "$BEFORE" ] || { echo "❌ No new data collected"; exit 1; }

# Step 5: 验证新增条目包含本次触发的 session ID
NEW_ENTRIES=$(tail -n +$((BEFORE+1)) "$OUTPUT")
echo "$NEW_ENTRIES" | grep -q "$SESSION_ID" || { echo "❌ New entries don't match triggered session"; exit 1; }

echo "✅ ${agent}: $((AFTER-BEFORE)) new entries, session $SESSION_ID confirmed"
```

#### 为什么必须验证 Session ID？

仅检查"行数增加了"不够严谨：
- 可能是其他后台进程（IDE 自动补全、定时任务）产生的数据
- 可能是上一次未处理的积压数据被轮询读取
- 只有确认 session ID 匹配，才能证明**触发→hook 执行→日志写入→标准化输出**完整链路正确

## 5. 观察与验证输出

### 5.1 查看原始 Hook 日志

```bash
# Qoder CLI hook 历史：
cat ~/.loongsuite-pilot/logs/qoder/history/qoder-$(date +%Y-%m-%d).jsonl

# Qoder Work hook 历史：
cat ~/.loongsuite-pilot/logs/qoder-work/history/qoder-work-$(date +%Y-%m-%d).jsonl

# Cursor hook 历史：
cat ~/.loongsuite-pilot/logs/cursor/history/cursor-$(date +%Y-%m-%d).jsonl

# Claude Code otel hook 历史：
ls ~/.loongsuite-pilot/logs/claude-code/history/

# Codex otel hook 历史：
ls ~/.loongsuite-pilot/logs/codex/history/
```

### 5.2 查看标准化输出（核心验证点）

```bash
# JSONL 输出（标准化条目）：
cat ~/.loongsuite-pilot/logs/output/qoder-$(date +%Y-%m-%d).jsonl | jq .
cat ~/.loongsuite-pilot/logs/output/qoder-work-$(date +%Y-%m-%d).jsonl | jq .
cat ~/.loongsuite-pilot/logs/output/cursor-$(date +%Y-%m-%d).jsonl | jq .
cat ~/.loongsuite-pilot/logs/output/claude-code-$(date +%Y-%m-%d).jsonl | jq .
cat ~/.loongsuite-pilot/logs/output/codex-$(date +%Y-%m-%d).jsonl | jq .
```

### 5.3 输出格式验证

输出 JSONL 的每一行应为一个符合 AgentActivityEntry 格式的 JSON 对象：

```json
{
  "time_unix_nano": "1778586618041000000",
  "event.id": "40069de9-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "event.name": "llm.request",
  "user.id": "220159",
  "gen_ai.session.id": "bcc62bf3-...",
  "gen_ai.agent.type": "qoder-cli",
  "gen_ai.request.model": "qwen-max",
  "gen_ai.provider.name": "qwen"
}
```

需要验证的关键字段：

- `time_unix_nano` — Unix 纳秒时间戳（数字字符串）
- `event.id` — UUID v4
- `event.name` — 取值范围：`llm.request`、`llm.response`、`tool.call`、`tool.result`、`skill.use` 等
- `gen_ai.agent.type` — Agent 类型（cursor、qoder、qoder-cli、qoder-work、claude-code、codex）
- `gen_ai.session.id` — 会话标识符

### 5.4 使用合约测试验证输出

```bash
# 运行合约模式测试以验证输出格式：
npx vitest run tests/contract/agent-activity-entry.test.ts
```

### 5.5 使用 jq 进行快速验证

```bash
# 检查所有条目是否包含必需字段：
cat ~/.loongsuite-pilot/logs/output/qoder-$(date +%Y-%m-%d).jsonl | \
  jq -e '."time_unix_nano" and ."event.id" and ."event.name" and ."gen_ai.agent.type"' > /dev/null && \
  echo "✅ All entries valid" || echo "❌ Invalid entries found"

# 按事件类型统计条目数量：
cat ~/.loongsuite-pilot/logs/output/*.jsonl | jq -r '."event.name"' | sort | uniq -c | sort -rn

# 查看最新条目（最近 5 分钟）：
cat ~/.loongsuite-pilot/logs/output/qoder-$(date +%Y-%m-%d).jsonl | \
  jq -r '."time_unix_nano"' | tail -5
```

## 6. 状态持久化验证

### 6.1 验证偏移量追踪

```bash
# 检查状态存储：
cat ~/.loongsuite-pilot/logs/input-state.json | jq .
```

应显示每个输入源的 offset/rowid 值。

### 6.2 验证重启不重复

1. 停止服务：`loongsuite-pilot stop` 或 Ctrl+C
2. 记录输出行数：`wc -l ~/.loongsuite-pilot/logs/output/*.jsonl`
3. 重启：`loongsuite-pilot start` 或 `LOG_LEVEL=debug node dist/index.js`
4. 等待一个轮询周期（默认 60 秒）
5. 验证行数未变（无重复数据）：`wc -l ~/.loongsuite-pilot/logs/output/*.jsonl`

## 7. 运行时 Agent 发现验证

验证 pilot 在运行过程中能够自动发现新安装的 Agent 并执行部署。此测试利用 `agents.d.local/` 目录注入一个假 Agent 定义，模拟"用户新安装软件后被 pilot 自动发现"的场景。

### 7.1 准备假 Agent

```bash
# 创建工作目录和 tarball
mkdir -p /tmp/e2e-fake-agent/tar-src/scripts

cat > /tmp/e2e-fake-agent/tar-src/scripts/install.sh << 'SCRIPT'
#!/bin/bash
echo "installed at $(date -u +%Y-%m-%dT%H:%M:%SZ)" > /tmp/e2e-fake-agent/installed.txt
echo "PILOT_DATA_DIR=$PILOT_DATA_DIR" >> /tmp/e2e-fake-agent/installed.txt
echo "PILOT_NODE_BIN=$PILOT_NODE_BIN" >> /tmp/e2e-fake-agent/installed.txt
exit 0
SCRIPT

tar -czf /tmp/e2e-fake-agent/plugin.tar.gz -C /tmp/e2e-fake-agent/tar-src .
```

```bash
# 创建 Agent 定义（detection path 指向尚不存在的目录）
mkdir -p ~/.loongsuite-pilot/agents.d.local

cat > ~/.loongsuite-pilot/agents.d.local/e2e-fake-agent.json << 'EOF'
{
  "id": "e2e-fake-agent",
  "displayName": "E2E Fake Agent",
  "deployMode": "plugin-probe",
  "detection": { "paths": ["/tmp/e2e-fake-agent-home"], "commands": [] },
  "pluginProbe": {
    "source": {
      "type": "tar",
      "tarball": "/tmp/e2e-fake-agent/plugin.tar.gz",
      "destDir": "/tmp/e2e-fake-agent/dest"
    },
    "mountType": "wrapper"
  }
}
EOF
```

### 7.2 启动服务（加速轮询）

```bash
# 将 discovery 轮询间隔缩短至 3 秒（默认 5 分钟）
LOONGSUITE_PILOT_DISCOVERY_INTERVAL_MS=3000 LOG_LEVEL=debug node dist/index.js &
```

启动后应看到：
- `AgentDefLoader` 加载了 6 个定义（5 builtin + 1 local）
- `DeploymentManager` 对 `e2e-fake-agent` 输出 `"agent not detected, skipping"`
- `AgentDiscoveryService` 对 `deploy:e2e-fake-agent` 输出 `"agent skipped"`, `available: false`

### 7.3 模拟用户安装新 Agent

```bash
# 创建 detection path，模拟用户安装了新软件
mkdir /tmp/e2e-fake-agent-home
```

### 7.4 验证自动发现与部署

等待约 5 秒（一个轮询周期 + 部署时间），然后从三个维度验证：

#### 验证点 1：服务日志证据链

服务日志（注意可能 rotate 到 `.log.YYYY-MM-DD.N` 文件）中应能看到完整的发现→部署链路：

```bash
# 在所有日志文件中搜索 fake agent 相关条目
grep 'e2e-fake-agent' ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log* | grep -v 'available":false'
```

预期日志时序：

| 时间 | 组件 | 消息 | 含义 |
|------|------|------|------|
| T+0 | DeploymentManager | `"agent not detected, skipping"` | 启动时检测路径不存在，skip |
| T+0~T+N | AgentDiscoveryService | `"agent skipped", available: false` | 每 3 秒轮询，持续不可用 |
| T+N | AgentDiscoveryService | `"starting agent"` | 检测路径出现，触发部署 |
| T+N | Orchestrator | `"new agent discovered, deploying"` | 编排器收到发现事件 |
| T+N | DeploymentManager | `"deploying agent", deployMode: "plugin-probe"` | 开始部署 |
| T+N | PluginProbeStrategy | `"script succeeded"`, scriptPath: `.../install.sh` | install.sh 执行成功 |
| T+N | PluginProbeStrategy | `"plugin deployed"` | 部署完成 |
| T+N | Orchestrator | `"agent detected and started"` | 发现流程结束 |

如果链路中断（例如只看到 `"deploying agent"` 但没有 `"script succeeded"`），说明部署过程出了问题，需要检查更详细的错误日志。

#### 验证点 2：marker 文件（install.sh 执行证据）

```bash
# ✅ marker 文件存在（install.sh 被执行）
cat /tmp/e2e-fake-agent/installed.txt

# ✅ 环境变量正确传递
grep PILOT_DATA_DIR /tmp/e2e-fake-agent/installed.txt
grep PILOT_NODE_BIN /tmp/e2e-fake-agent/installed.txt
```

预期：marker 文件包含安装时间戳，且 `PILOT_DATA_DIR` 和 `PILOT_NODE_BIN` 值正确。

#### 验证点 3：deployed-agents.json（持久化状态）

```bash
# ✅ deployed-agents.json 中出现新条目
cat ~/.loongsuite-pilot/deployed-agents.json | python3 -m json.tool | grep -A5 'e2e-fake-agent'
```

预期：`e2e-fake-agent` 条目包含 `deployMode: "plugin-probe"`、`deployedAt` 时间戳、`sourceHash`。

### 7.5 Plugin 更新验证

验证当 tarball 内容变化后，pilot 重启时能检测到更新并执行 uninstall→重新部署流程。

> **前置：** 需要先完成 §7.1-7.4（假 Agent 已部署成功），服务已停止。

```bash
# 1. 为已部署的 dest 添加 uninstall.sh（模拟旧版带卸载逻辑）
mkdir -p /tmp/e2e-fake-agent/dest/scripts
cat > /tmp/e2e-fake-agent/dest/scripts/uninstall.sh << 'SCRIPT'
#!/bin/bash
echo "uninstalled at $(date -u +%Y-%m-%dT%H:%M:%SZ)" > /tmp/e2e-fake-agent/uninstalled.txt
exit 0
SCRIPT
chmod +x /tmp/e2e-fake-agent/dest/scripts/uninstall.sh

# 2. 创建新版 tarball（内容与旧版不同 → sourceHash 变化）
rm -rf /tmp/e2e-fake-agent/tar-src-v2
mkdir -p /tmp/e2e-fake-agent/tar-src-v2/scripts
cat > /tmp/e2e-fake-agent/tar-src-v2/scripts/install.sh << 'SCRIPT'
#!/bin/bash
echo "v2 installed at $(date -u +%Y-%m-%dT%H:%M:%SZ)" > /tmp/e2e-fake-agent/installed-v2.txt
exit 0
SCRIPT
tar -czf /tmp/e2e-fake-agent/plugin.tar.gz -C /tmp/e2e-fake-agent/tar-src-v2 .

# 3. 记录当前 sourceHash（用于对比）
cat ~/.loongsuite-pilot/deployed-agents.json | python3 -m json.tool | grep -A5 'e2e-fake-agent'

# 4. 重启服务
LOG_LEVEL=debug node dist/index.js &
```

#### 验证点

```bash
# ✅ uninstall.sh 被执行（旧版卸载）
cat /tmp/e2e-fake-agent/uninstalled.txt

# ✅ v2 install.sh 被执行（新版安装）
cat /tmp/e2e-fake-agent/installed-v2.txt

# ✅ sourceHash 已更新
cat ~/.loongsuite-pilot/deployed-agents.json | python3 -m json.tool | grep -A5 'e2e-fake-agent'
```

预期日志：
- `PluginProbeStrategy` 输出 `"running uninstall script before update"`
- `PluginProbeStrategy` 输出 `"script succeeded"` (uninstall)
- `PluginProbeStrategy` 输出 `"script succeeded"` (install)
- `PluginProbeStrategy` 输出 `"plugin deployed"`
- `deployed-agents.json` 中 `sourceHash` 值与之前不同

### 7.6 destDir 缺失重新部署验证

验证当部署记录存在但 destDir 被删除时，pilot 重启时能自动重新部署。

> **前置：** 假 Agent 已部署成功（`deployed-agents.json` 中有记录），服务已停止。

```bash
# 1. 删除 destDir（模拟文件被意外清除）
rm -rf /tmp/e2e-fake-agent/dest

# 2. 确认 deployed-agents.json 记录仍存在
cat ~/.loongsuite-pilot/deployed-agents.json | python3 -m json.tool | grep -A5 'e2e-fake-agent'

# 3. 重启服务
LOG_LEVEL=debug node dist/index.js &
```

#### 验证点

```bash
# ✅ destDir 被重建
ls /tmp/e2e-fake-agent/dest/

# ✅ install.sh 被重新执行
cat /tmp/e2e-fake-agent/installed-v2.txt  # 时间戳应更新

# ✅ 日志中出现 "destDir missing, re-deploy needed"
grep 'destDir missing' ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log*
```

### 7.7 Hook 自愈验证

验证当 hook 类型 Agent 的 settings 被其他进程覆盖后，`HookWatchdog` 能在运行时自动恢复。

> **动机：** 线上遇到过其他后台进程覆盖 hook settings 文件，导致 pilot 写入的 hook 丢失、数据采集中断。此测试覆盖运行时自愈能力。

```bash
# 1. 停止之前的服务
kill %1 2>/dev/null

# 2. 创建假 hook agent 定义
cat > ~/.loongsuite-pilot/agents.d.local/e2e-fake-hook-agent.json << 'EOF'
{
  "id": "e2e-fake-hook-agent",
  "displayName": "E2E Fake Hook Agent",
  "deployMode": "hook",
  "detection": { "paths": ["/tmp/e2e-fake-hook-agent-home"], "commands": [] },
  "hook": {
    "settingsPath": "/tmp/e2e-fake-hook-agent/settings.json",
    "events": ["stop", "preToolUse"],
    "hookCommand": "$PILOT_DATA/hooks/e2e-fake-hook-agent-loongsuite-pilot-hook.sh",
    "format": "flat"
  }
}
EOF

# 3. 创建 detection path 和 settings 目录
mkdir -p /tmp/e2e-fake-hook-agent-home
mkdir -p /tmp/e2e-fake-hook-agent

# 4. 启动服务（加速 watchdog 轮询，缩短至 5 秒）
LOONGSUITE_PILOT_DISCOVERY_INTERVAL_MS=3000 \
LOONGSUITE_PILOT_HOOK_WATCHDOG_INTERVAL_MS=5000 \
LOG_LEVEL=debug node dist/index.js &

# 等待启动完成和首次部署
sleep 5
```

#### 验证点 1：初始 hook 部署成功

```bash
# ✅ settings.json 中包含 hook 条目
cat /tmp/e2e-fake-hook-agent/settings.json | python3 -m json.tool
```

预期：`hooks.stop` 和 `hooks.preToolUse` 存在，且 command 中包含 `loongsuite-pilot-hook.sh`。

#### 验证点 2：模拟 hook 被覆盖

```bash
# 清空 settings.json（模拟被其他进程覆盖）
echo '{}' > /tmp/e2e-fake-hook-agent/settings.json

# 等待 watchdog 轮询（约 5-10 秒）
sleep 10
```

#### 验证点 3：hook 自动恢复

```bash
# ✅ settings.json 中 hook 被恢复
cat /tmp/e2e-fake-hook-agent/settings.json | python3 -m json.tool

# ✅ 日志中出现 watchdog repair 信息
grep 'hook-watchdog.repair' ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log* | grep 'e2e-fake-hook-agent'
```

预期日志：
- `HookWatchdog` 输出 `"hook-watchdog.repair"`, `agent: "e2e-fake-hook-agent"`, `action: "hook-manager"`, `missing: ["stop", "preToolUse"]`
- 之后下一次轮询应报告 `healthy: true`

#### 说明

- `HookWatchdog` 同时监控 plugin 类型（claude-code、codex）和 hook 类型（cursor、qoder 等）Agent
- Plugin 类型通过 spawn 外部命令修复，hook 类型通过 `DeploymentManager.deploySingle()` → `HookStrategy.deploy()` 修复
- Watchdog 有冷却机制（默认 10 分钟），同一 Agent 不会被频繁重复修复
- 轮询间隔通过 `LOONGSUITE_PILOT_HOOK_WATCHDOG_INTERVAL_MS` 环境变量调整（默认 1 分钟）

### 7.8 清理

```bash
# 停止服务
kill %1  # 或 kill <PID>

# 删除假 Agent 定义和临时文件
rm ~/.loongsuite-pilot/agents.d.local/e2e-fake-agent.json
rm ~/.loongsuite-pilot/agents.d.local/e2e-fake-hook-agent.json 2>/dev/null
rm -rf /tmp/e2e-fake-agent /tmp/e2e-fake-agent-home
rm -rf /tmp/e2e-fake-hook-agent /tmp/e2e-fake-hook-agent-home

# 从 deployed-agents.json 中移除假 Agent 条目
python3 -c "
import json, os
p = os.path.expanduser('~/.loongsuite-pilot/deployed-agents.json')
d = json.load(open(p))
d.pop('e2e-fake-agent', None)
d.pop('e2e-fake-hook-agent', None)
json.dump(d, open(p, 'w'), indent=2)
"
```

### 7.9 说明

- `agents.d.local/` 是本地 Agent 定义覆盖目录，其中的 JSON 会合并/覆盖 `agents.d/` 中的内置定义
- `AgentDiscoveryService` 通过轮询或 `fs.watch` 检测 detection path 变化，默认间隔 5 分钟，可通过 `LOONGSUITE_PILOT_DISCOVERY_INTERVAL_MS` 环境变量调整
- 发现新 Agent 后，`Orchestrator` 通过 `DeploymentManager.deploySingle()` 触发部署
- 对于 `plugin-probe` 类型，`PluginProbeStrategy` 解压 tarball 后按约定执行 `scripts/install.sh`
- 对于 `hook` 类型，`HookStrategy` 通过 `HookManager` 写入 settings 文件，并由 `HookWatchdog` 提供运行时自愈

## 8. Monitor Dashboard 验证

```bash
# 启动监控面板：
loongsuite-pilot monitor start

# 或手动启动：
node scripts/serve-loongsuite-pilot-monitor.mjs
```

打开 `http://127.0.0.1:8765/` 可查看：

- 进程指标（CPU、内存、运行时间）
- 按 Agent 类型分类的事件吞吐量
- 输入源状态

## 9. 常见问题排查

### 9.1 服务无法启动

- 检查 `~/.loongsuite-pilot/logs/loongsuite-pilot-service.log`
- 确认 `~/.loongsuite-pilot/config.json` 是有效的 JSON
- 使用 `LOG_LEVEL=debug` 运行以获得详细输出

### 9.2 Hook 不触发

- 确认 hook 脚本存在：`ls ~/.loongsuite-pilot/hooks/`
- 确认 Agent 配置中包含 hook 条目：
  - Qoder CLI：`cat ~/.qoder/settings.json | jq .hooks`
  - Qoder Work：`cat ~/.qoderwork/settings.json | jq .hooks`
  - Cursor：`cat ~/.cursor/hooks.json`
  - Claude Code：`cat ~/.claude/settings.json | jq .hooks`
  - Codex：`cat ~/.codex/hooks.json | jq .hooks`
- 确认 otel hook 插件已安装（Claude Code / Codex）：
  - `ls ~/.cache/opentelemetry.instrumentation.claude/hook-entry.sh`
  - `ls ~/.cache/opentelemetry.instrumentation.codex/hook-entry.sh`
- 确认 hook 脚本具有可执行权限：`chmod +x ~/.loongsuite-pilot/hooks/*.sh`

### 9.3 输出文件无新数据

- 检查服务是否运行：`loongsuite-pilot status`
- 查看服务日志中的错误：`tail -50 ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log`
- 确认输入轮询是否活跃（在 debug 日志中查找 "polling" 或 "tick"）
- 检查 `input-state.json` 中的 offset 是否在前进
- 确认 `JSONL_ENABLED` 没有被设为 `false`

### 9.4 数据格式不符合预期

- 运行合约测试：`npx vitest run tests/contract/`
- 检查 `src/normalization/entry-builder.ts` 中的标准化逻辑
- 使用 `jq` 检查单个条目是否有缺失或格式错误的字段

## 10. 测试清理

```bash
# 停止所有服务：
loongsuite-pilot stop

# 重置状态（重新开始采集）：
rm ~/.loongsuite-pilot/logs/input-state.json
rm ~/.loongsuite-pilot/logs/snapshot-store.json

# 清空输出（删除已采集的数据）：
rm ~/.loongsuite-pilot/logs/output/*.jsonl

# 完全卸载（如果测试安装器）：
bash deploy/installer.sh uninstall --purge
```

## 11. 自动化测试脚本示例

以下是一个简单的 shell 脚本示例，用于自动化基础 E2E 验证：

```bash
#!/bin/bash
# e2e-verify.sh — 基础端到端验证脚本
# 注意：macOS 未自带 timeout 命令。如需使用 timeout，请先安装 coreutils：
#   brew install coreutils
# 然后使用 gtimeout 替代 timeout，例如：gtimeout 30 some_command
set -e

echo "=== Building ==="
npm run build

echo "=== Starting service (background) ==="
LOG_LEVEL=debug JSONL_ENABLED=true node dist/index.js &
PID=$!
sleep 3

echo "=== Checking service is running ==="
kill -0 $PID 2>/dev/null || { echo "❌ Service failed to start"; exit 1; }
echo "✅ Service running (PID: $PID)"

echo "=== Checking log output ==="
if [ -f ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log ]; then
  echo "✅ Service log exists"
  grep -q "orchestrator" ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log && \
    echo "✅ Orchestrator started" || echo "⚠️ Orchestrator not detected in logs"
fi

echo "=== Waiting for first poll cycle (10s) ==="
sleep 10

echo "=== Checking output directory ==="
OUTPUT_DIR=~/.loongsuite-pilot/logs/output
if ls $OUTPUT_DIR/*.jsonl 1>/dev/null 2>&1; then
  echo "✅ Output JSONL files exist:"
  ls -la $OUTPUT_DIR/*.jsonl
  echo ""
  echo "=== Sample output entry ==="
  head -1 $OUTPUT_DIR/*.jsonl | jq . 2>/dev/null || head -1 $OUTPUT_DIR/*.jsonl
else
  echo "⚠️ No output files yet (trigger agent activity to generate)"
fi

echo "=== Stopping service ==="
kill $PID 2>/dev/null
wait $PID 2>/dev/null

echo "=== Running contract tests ==="
npx vitest run tests/contract/

echo "=== Done ==="
```

## 12. SLS 双写（dual-write）场景验证

从 v1.1 开始，loongsuite-pilot 支持将 Agent 活动同时发到「用户自建 SLS」与「内置默认 SLS」两个目的地。本节说明如何本地验证三种解析场景：

| 场景 | `--sls-*` 参数 | `destinationOverride` | 结果 |
|------|------------|----------------------|------|
| **Case A** | 未传 | N/A | 仅写内置目的地 |
| **Case B** | 传入 | 默认 / `true` | 用户目的地替换内置 | 
| **Case C** | 传入 | `false` | 双写到用户 + 内置两个目的地 |

### 12.1 准备：需要的信息

最少需要以下信息才能跳转到 Case B / C：

- `--sls-endpoint`（如 `https://cn-hangzhou.log.aliyuncs.com`）
- `--sls-project` 与 `--sls-logstore`　← 两者必须同时提供，缺一就会被视为 Case A
- 模式选择：
  - **webtracking**（匿名写入）：仅需 logstore 开启 WebTracking；AK 可以留空。
  - **ak**：传入 `LOONGSUITE_SLS_ACCESS_KEY_ID` / `LOONGSUITE_SLS_ACCESS_KEY_SECRET`（环境变量优先）或 `--sls-ak-id`/`--sls-ak-secret`。

### 12.2 准备隔离的测试环境

如果你本地已装了一个运行的正式安装（读取 `~/.loongsuite-pilot/`），推荐临时停掉它以避免两个 collector 同时读取同一个 hook history。

```bash
# 临时停止正式服务（测试后重启）
loongsuite-pilot stop

# 可选：备份当前配置
cp ~/.loongsuite-pilot/config.json ~/.loongsuite-pilot/config.json.bak
```

### 12.3 配置 Case C」双写

在 `~/.loongsuite-pilot/config.json` 中加入 `sls` 节点：

```json
{
  "enabled": true,
  "dataDir": "/Users/<username>/.loongsuite-pilot",
  "userId": "<your-user-id>",
  "sls": {
    "endpoint": "https://cn-hangzhou.log.aliyuncs.com",
    "project": "<你的 project>",
    "logstore": "<你的 logstore>",
    "destinationOverride": false
  },
  "autoUpdate": { "enabled": false }
}
```

关键点：

- `destinationOverride: false` 是双写的**唯一开关**。省略或设为 `true` 都会退化为 Case B（仅写用户目的地）。
- 不填 `accessKeyId` / `accessKeySecret` 时默认 webtracking。需 logstore 后台开启 WebTracking。
- AK 模式下，建议用环境变量避免明文入盘：
  ```bash
  export LOONGSUITE_SLS_ACCESS_KEY_ID="..."
  export LOONGSUITE_SLS_ACCESS_KEY_SECRET="..."
  ```

### 12.4 启动开发版 collector

```bash
npm run build
LOG_LEVEL=debug JSONL_ENABLED=true node dist/index.js
```

启动后从服务日志中检查：

1. **启动行**：`{"tag":"Main","flushers":["sls","jsonl"],"msg":"AI Agent Input is running"}`　← 表示 sls flusher 已启用（注意：即使双写，`flushers` 里也只出现一个 `sls`，多 endpoint 是 flusher 内部调度的。）
2. **首次轮询后的批量发送日志**（debug 级别）应同时出现两条：
   ```json
   // 用户侧（AK 模式为例）
   {"tag":"SlsFlusher","endpoint":"user-sls","project":"<你的 project>","logstore":"<你的 logstore>","count":N,"msg":"batch sent via ak"}
   // 内置侧（webtracking）
   {"tag":"SlsFlusher","project":"ai-coding-devops","logstore":"loongsuite_pilot_for_ai_coding","count":N,"msg":"batch sent via webtracking"}
   ```

两侧的 `count` 应严格相等。只出现一侧、或 count 不一致，检查：

- `destinationOverride` 是否为 `false`
- `project` 和 `logstore` 是否同时填写
- 用户与内置的 `(URL, project, logstore)` 三元组是否重复（发生去重，只会看到一侧）
- webtracking 失败会走 `"webtracking retrying" → "send failed after retries"`。AK 失败会走 `"ak send retrying"`。

### 12.5 触发 Agent 活动

使用任意已安装的 Agent 触发一次对话：

```bash
# Qoder CLI（需要 QODER_PERSONAL_ACCESS_TOKEN）
qodercli --print --yolo --cwd "$HOME" "hello, dual-write smoke test" </dev/null

# 或 Claude Code
claude -p "hello, dual-write smoke test" --dangerously-skip-permissions

# 或 Codex CLI（需要 CODEX_OPENAI_API_KEY）
codex exec "hello, dual-write smoke test" --skip-git-repo-check </dev/null

# 或 Cursor Agent（需要 CURSOR_API_KEY 或已登录）
cursor agent -p "hello, dual-write smoke test" --yolo
```

然后等待一个轮询周期（默认 60s）。

### 12.6 验证 SLS 发送路径

#### 验证点 1：本地 JSONL 应存在条目

```bash
ls -la ~/.loongsuite-pilot/logs/output/qoder-cli-$(date +%Y-%m-%d).jsonl
wc -l ~/.loongsuite-pilot/logs/output/qoder-cli-$(date +%Y-%m-%d).jsonl
```

#### 验证点 2：`sls-failed-logs/` 应为空（双写都成功）

```bash
ls -la ~/.loongsuite-pilot/sls-failed-logs/
# 期望：空目录，或只有老文件
```

若中化路失败，会生成 `sls-failed-logs/<endpoint.name>.jsonl`：

- `sls-failed-logs/user-sls.jsonl` → 用户 SLS 失败
- `sls-failed-logs/internal-sls.jsonl` → 内置 SLS 失败

#### 验证点 3：服务日志中的调试输出

```bash
# webtracking 路径会走 fetch：
grep -E 'sls.*(webtracking|posted|sent|fail)' ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log | tail -20

# AK 路径会调用 @alicloud/log：
grep -E 'sls.*(postLogStoreLogs|ak)' ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log | tail -20
```

#### 验证点 4：SLS 控制台交叉验证

在阿里云 SLS 控制台中查询：

- 用户项目 `<你的 project>` / logstore `<你的 logstore>` 应能看到刚刚触发 Agent 产生的条目
- 内置项目（参考 `src/internal/sls-destination.ts`）也应看到同一批条目
- 两边的 `event.id` / `time_unix_nano` 应一致

### 12.7 Case B / Case A 验证

- **Case B**：把上面 config 中的 `destinationOverride: false` 删掉（或改为 `true`）重启，应只看到一条 endpoint（`agent-activity`）。SLS 控制台仅用户 logstore 有数据。
- **Case A**：完全删除 `sls` 节点。应只看到一条 endpoint（`internal-default`）。

### 12.8 去重验证点

为验证去重：设置 `sls.endpoint` / `project` / `logstore` 为内置默认值（参考 `src/internal/sls-destination.ts` 中的 `INTERNAL_SLS_DESTINATION`），同时保留 `destinationOverride: false`。本应双写但会被去重为一条（name 为 `user-sls`，用户侧胜出）。

### 12.9 测试后恢复

```bash
# 停掉 dev collector（Ctrl+C）
# 恢复原配置
mv ~/.loongsuite-pilot/config.json.bak ~/.loongsuite-pilot/config.json

# 重启正式服务
loongsuite-pilot start
loongsuite-pilot status
```

### 12.10 通过安装脚本验证双写

安装器提供了 `--default-sls-override` 参数控制是否双写：

```bash
# Case C：双写
bash deploy/installer.sh install \
  --local ./loongsuite-pilot.tar.gz \
  --sls-endpoint "https://cn-hangzhou.log.aliyuncs.com" \
  --sls-project "<你的 project>" \
  --sls-logstore "<你的 logstore>" \
  --default-sls-override=false

# Case B（默认）：仅用户目的地
bash deploy/installer.sh install \
  --local ./loongsuite-pilot.tar.gz \
  --sls-endpoint "https://cn-hangzhou.log.aliyuncs.com" \
  --sls-project "<你的 project>" \
  --sls-logstore "<你的 logstore>"
```

安装后检查写入的 `~/.loongsuite-pilot/config.json` 是否包含 `"destinationOverride": false`（Case C）或 `"destinationOverride": true`（Case B）。

## 附录：数据目录结构参考

```
~/.loongsuite-pilot/
├── config.json                         # 主配置文件
├── agent-control.json                  # Agent 准入策略
├── hooks/                              # Hook 脚本
│   ├── qoder-loongsuite-pilot-hook.sh
│   ├── qoderwork-loongsuite-pilot-hook.sh
│   ├── cursor-loongsuite-pilot-hook.sh
│   ├── hook-processor.mjs              # Qoder/QoderWork 共用
│   ├── cursor-hook-processor.mjs
│   └── agent-event-normalizer.mjs
├── logs/
│   ├── loongsuite-pilot-service.log   # 服务运行日志
│   ├── input-state.json               # 输入源偏移量状态
│   ├── snapshot-store.json            # IDE 快照去重缓存
│   ├── output/                        # 标准化输出（核心验证点）
│   │   ├── qoder-YYYY-MM-DD.jsonl
│   │   ├── qoder-work-YYYY-MM-DD.jsonl
│   │   ├── cursor-YYYY-MM-DD.jsonl
│   │   ├── claude-code-YYYY-MM-DD.jsonl
│   │   └── codex-YYYY-MM-DD.jsonl
│   ├── qoder-cli/history/             # Qoder CLI hook 原始日志
│   ├── qoder-work/history/            # Qoder Work hook 原始日志
│   ├── cursor/history/                # Cursor hook 原始日志
│   ├── claude-code/history/           # Claude Code otel hook 原始日志
│   ├── codex/history/                 # Codex otel hook 原始日志
│   └── process-monitor/               # Monitor 指标缓存
├── versions/                          # 版本目录（正式安装时）
│   └── {version}_{commit}/
└── sls-failed-logs/                   # SLS 发送失败的缓存
```
