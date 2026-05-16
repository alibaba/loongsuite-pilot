# LoongSuite Pilot 本地端到端测试指南

## 概述

本指南介绍如何在本地环境中对 loongsuite-pilot 进行端到端验证 —— 从构建、安装、启动服务、触发真实 Agent 活动，到验证输出正确性的完整流程。

## 前置条件

- Node.js >= 18, npm >= 8
- 至少安装了一个 AI Agent（Qoder CLI、Cursor 等）
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
bash deploy/loongsuite-pilot-installer.sh install --local ./loongsuite-pilot.tar.gz
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
- `SLS_ACCESS_KEY_ID` / `SLS_ACCESS_KEY_SECRET`（可选，用于 SLS 测试）

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

### 4.1 Qoder CLI

使用 qoder 开始一次对话：

```bash
qoder "hello, just testing"
```

这会触发 `~/.loongsuite-pilot/hooks/qoder-loongsuite-pilot-hook.sh`，进而调用 `hook-processor.mjs`。

### 4.2 Cursor

打开 Cursor IDE 并与 AI 助手交互。`~/.cursor/hooks.json` 中的配置会触发 `cursor-loongsuite-pilot-hook.sh`。

### 4.3 手动模拟 Hook 调用（不依赖真实 Agent）

如果不需要真实 Agent，可以手动调用 hook：

```bash
echo '{"transcript_path":"/tmp/test-transcript.jsonl","session_id":"test-session-123"}' | \
  bash ~/.loongsuite-pilot/hooks/qoder-loongsuite-pilot-hook.sh qoder-cli
```

（注意：需要先创建一个包含有效 JSONL 内容的模拟 transcript 文件）

## 5. 观察与验证输出

### 5.1 查看原始 Hook 日志

```bash
# Qoder CLI hook 历史：
cat ~/.loongsuite-pilot/logs/qoder-cli/history/qoder-cli-$(date +%Y-%m-%d).jsonl

# Cursor hook 历史：
cat ~/.loongsuite-pilot/logs/cursor/history/cursor-$(date +%Y-%m-%d).jsonl
```

### 5.2 查看标准化输出（核心验证点）

```bash
# JSONL 输出（标准化条目）：
cat ~/.loongsuite-pilot/logs/output/qoder-$(date +%Y-%m-%d).jsonl | jq .
cat ~/.loongsuite-pilot/logs/output/cursor-$(date +%Y-%m-%d).jsonl | jq .
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
2. 记录输出行数：`wc -l ~/.loongsuite-pilot/logs/output/qoder-*.jsonl`
3. 重启：`loongsuite-pilot start` 或 `LOG_LEVEL=debug node dist/index.js`
4. 等待一个轮询周期（默认 60 秒）
5. 验证行数未变（无重复数据）：`wc -l ~/.loongsuite-pilot/logs/output/qoder-*.jsonl`

## 7. Monitor Dashboard 验证

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

## 8. 常见问题排查

### 8.1 服务无法启动

- 检查 `~/.loongsuite-pilot/logs/loongsuite-pilot-service.log`
- 确认 `~/.loongsuite-pilot/config.json` 是有效的 JSON
- 使用 `LOG_LEVEL=debug` 运行以获得详细输出

### 8.2 Hook 不触发

- 确认 hook 脚本存在：`ls ~/.loongsuite-pilot/hooks/`
- 确认 Agent 配置中包含 hook 条目：
  - Qoder：`cat ~/.qoder/settings.json | jq .hooks`
  - Cursor：`cat ~/.cursor/hooks.json`
- 手动测试 hook（见 4.3 节）
- 确认 hook 脚本具有可执行权限：`chmod +x ~/.loongsuite-pilot/hooks/*.sh`

### 8.3 输出文件无新数据

- 检查服务是否运行：`loongsuite-pilot status`
- 查看服务日志中的错误：`tail -50 ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log`
- 确认输入轮询是否活跃（在 debug 日志中查找 "polling" 或 "tick"）
- 检查 `input-state.json` 中的 offset 是否在前进
- 确认 `JSONL_ENABLED` 没有被设为 `false`

### 8.4 数据格式不符合预期

- 运行合约测试：`npx vitest run tests/contract/`
- 检查 `src/normalization/entry-builder.ts` 中的标准化逻辑
- 使用 `jq` 检查单个条目是否有缺失或格式错误的字段

## 9. 测试清理

```bash
# 停止所有服务：
loongsuite-pilot stop

# 重置状态（重新开始采集）：
rm ~/.loongsuite-pilot/logs/input-state.json
rm ~/.loongsuite-pilot/logs/snapshot-store.json

# 清空输出（删除已采集的数据）：
rm ~/.loongsuite-pilot/logs/output/*.jsonl

# 完全卸载（如果测试安装器）：
bash deploy/loongsuite-pilot-installer.sh uninstall --purge
```

## 10. 自动化测试脚本示例

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

## 11. SLS 双写（dual-write）场景验证

从 v1.1 开始，loongsuite-pilot 支持将 Agent 活动同时发到「用户自建 SLS」与「内置默认 SLS」两个目的地。本节说明如何本地验证三种解析场景：

| 场景 | `--sls-*` 参数 | `destinationOverride` | 结果 |
|------|------------|----------------------|------|
| **Case A** | 未传 | N/A | 仅写内置目的地 |
| **Case B** | 传入 | 默认 / `true` | 用户目的地替换内置 | 
| **Case C** | 传入 | `false` | 双写到用户 + 内置两个目的地 |

### 11.1 准备：需要的信息

最少需要以下信息才能跳转到 Case B / C：

- `--sls-endpoint`（如 `https://cn-hangzhou.log.aliyuncs.com`）
- `--sls-project` 与 `--sls-logstore`　← 两者必须同时提供，缺一就会被视为 Case A
- 模式选择：
  - **webtracking**（匿名写入）：仅需 logstore 开启 WebTracking；AK 可以留空。
  - **ak**：传入 `SLS_ACCESS_KEY_ID` / `SLS_ACCESS_KEY_SECRET`（环境变量优先）或 `--sls-ak-id`/`--sls-ak-secret`。

### 11.2 准备隔离的测试环境

如果你本地已装了一个运行的正式安装（读取 `~/.loongsuite-pilot/`），推荐临时停掉它以避免两个 collector 同时读取同一个 hook history。

```bash
# 临时停止正式服务（测试后重启）
loongsuite-pilot stop

# 可选：备份当前配置
cp ~/.loongsuite-pilot/config.json ~/.loongsuite-pilot/config.json.bak
```

### 11.3 配置 Case C」双写

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
  export SLS_ACCESS_KEY_ID="..."
  export SLS_ACCESS_KEY_SECRET="..."
  ```

### 11.4 启动开发版 collector

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

### 11.5 触发 Agent 活动

```bash
qoder "hello, dual-write smoke test"
```

然后等待一个轮询周期（默认 60s）。

### 11.6 验证 SLS 发送路径

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

- 用户项目 `<你的 project>` / logstore `<你的 logstore>` 应能看到刚刚调用 qoder 产生的条目
- 内置项目（参考 `src/internal/sls-destination.ts`）也应看到同一批条目
- 两边的 `event.id` / `time_unix_nano` 应一致

### 11.7 Case B / Case A 验证

- **Case B**：把上面 config 中的 `destinationOverride: false` 删掉（或改为 `true`）重启，应只看到一条 endpoint（`agent-activity`）。SLS 控制台仅用户 logstore 有数据。
- **Case A**：完全删除 `sls` 节点。应只看到一条 endpoint（`internal-default`）。

### 11.8 去重验证点

为验证去重：设置 `sls.endpoint` / `project` / `logstore` 为内置默认值（参考 `src/internal/sls-destination.ts` 中的 `INTERNAL_SLS_DESTINATION`），同时保留 `destinationOverride: false`。本应双写但会被去重为一条（name 为 `user-sls`，用户侧胜出）。

### 11.9 测试后恢复

```bash
# 停掉 dev collector（Ctrl+C）
# 恢复原配置
mv ~/.loongsuite-pilot/config.json.bak ~/.loongsuite-pilot/config.json

# 重启正式服务
loongsuite-pilot start
loongsuite-pilot status
```

### 11.10 通过安装脚本验证双写

安装器提供了 `--default-sls-override` 参数控制是否双写：

```bash
# Case C：双写
bash deploy/loongsuite-pilot-installer.sh install \
  --local ./loongsuite-pilot.tar.gz \
  --sls-endpoint "https://cn-hangzhou.log.aliyuncs.com" \
  --sls-project "<你的 project>" \
  --sls-logstore "<你的 logstore>" \
  --default-sls-override=false

# Case B（默认）：仅用户目的地
bash deploy/loongsuite-pilot-installer.sh install \
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
│   ├── cursor-loongsuite-pilot-hook.sh
│   ├── hook-processor.mjs
│   └── cursor-hook-processor.mjs
├── logs/
│   ├── loongsuite-pilot-service.log   # 服务运行日志
│   ├── input-state.json               # 输入源偏移量状态
│   ├── snapshot-store.json            # IDE 快照去重缓存
│   ├── output/                        # 标准化输出（核心验证点）
│   │   ├── cursor-YYYY-MM-DD.jsonl
│   │   ├── qoder-YYYY-MM-DD.jsonl
│   │   └── qoder-work-YYYY-MM-DD.jsonl
│   ├── qoder-cli/history/             # Qoder CLI hook 原始日志
│   ├── cursor/history/                # Cursor hook 原始日志
│   └── process-monitor/               # Monitor 指标缓存
├── versions/                          # 版本目录（正式安装时）
│   └── {version}_{commit}/
└── sls-failed-logs/                   # SLS 发送失败的缓存
```
