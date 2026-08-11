# 新 Agent 接入

[English](../agent-onboarding.md) | 简体中文

当你希望 LoongSuite Pilot 采集新的 AI Coding Agent 数据时，使用本文作为接入指南。目标是让新集成在用户视角下和已有 Agent 一样：可自动检测、可配置，并通过同一套事件 Schema 和输出后端导出。

## 选择集成方式

优先选择目标 Agent 支持的最轻量集成方式。

| 集成方式 | 适用场景 |
|----------|----------|
| Hook | Agent 可以在生命周期、Prompt、响应或工具事件上执行命令。 |
| 插件注入 | Agent 可以从配置文件加载本地插件。 |
| 原生目录插件 | Agent 会扫描包含清单和可执行模块的插件目录。 |
| 本地日志或 session 轮询 | Agent 已经写入结构化本地文件。 |
| SQLite 轮询 | Agent 将活动存储在本地 SQLite 数据库。 |
| CLI 或 API 轮询 | Agent 暴露本地命令或 API 可读取活动数据。 |

如果 Hook 或插件可以输出结构化事件，优先使用它们。这通常更容易归一化，也更容易覆盖工具调用和 token 用量。

## 注册基于 PI 高层 SDK 的自研 Agent

使用 `@earendil-works/pi-coding-agent` 高层 SDK 构建的自研 Agent 不需要新增
Pilot Hook 或在应用代码中引入 Pilot。先确保应用通过
`createAgentSession({ agentDir })` 使用标准 `DefaultResourceLoader`（或等价地继续加载
`agentDir/settings.json` 中的 `extensions`），然后执行一次注册：

```bash
loongsuite-pilot agent register pi-sdk \
  --id acme-code \
  --name "Acme Code Agent" \
  --agent-dir ~/.acme/pi-agent \
  --detect-path ~/.acme \
  --detect-command acme-code
```

`--detect-path` 和 `--detect-command` 都可重复提供，但至少需要一个。注册命令会：

- 在 Pilot 数据目录生成只携带该 Agent 身份的 PI extension 包装器；
- 将包装器注入指定 `agentDir/settings.json` 的 `extensions`；
- 在 `agents.d.local` 持久化定义，供启动检测、watchdog、升级和卸载使用；
- 由服务 CLI 在 collector 已运行时自动重启 collector。

如果自研 Agent 已经创建了 `AgentSession`，注册后需要重启 Agent，或调用
`session.reload()` 重新加载 extensions。日常启动和使用 Agent 的方式不变。

`agentDir` 必须是该自研 Agent 独享的目录：不能使用内置 PI CLI 的
`~/.pi/agent`，不同自研 Agent 之间也不能共用。PI 会加载目录中配置的全部
extensions；共用目录会导致重复采集以及 Agent 身份串标。该约束不改变自研
Agent 原有的启动命令和 SDK 调用方式。

管理命令：

```bash
loongsuite-pilot agent list
loongsuite-pilot agent doctor acme-code
loongsuite-pilot agent unregister acme-code
```

注册身份会输出为自研 Agent 自己的 `gen_ai.agent.type/id/name`，同时输出
`gen_ai.agent.system=pi` 和 `gen_ai.framework=pi`。直接使用 `pi-agent-core`、内存
settings 或不会加载 PI extensions 的自定义 ResourceLoader 不在该注册能力的覆盖范围内。

## 必要组成

一个新的 Agent 集成通常需要：

1. `agents.d/<agent-id>.json` 中的 Agent 定义。
2. 产生活动记录的 Hook、插件或轮询数据源。
3. 将源记录转换为 `AgentActivityEntry` 的 Input 实现。
4. 新 Agent 对应的 `ClientType` 值。
5. 如果不是完全通用的输入，还需要在 collector 启动路径中注册。
6. 测试或 fixture，证明规范化输出符合 [输出事件 Schema](output-event-schema.md)。

## Agent 定义

Agent 定义描述 Pilot 如何检测和部署集成。内置定义从 `agents.d/*.json` 加载；运行时本地定义可以从 `~/.loongsuite-pilot/agents.d.local/` 覆盖内置定义。

Hook 示例：

```json
{
  "id": "my-agent",
  "displayName": "My Agent",
  "deployMode": "hook",
  "detection": {
    "paths": ["~/.my-agent"],
    "commands": ["my-agent"]
  },
  "hook": {
    "settingsPath": "~/.my-agent/settings.json",
    "events": ["Stop", "PreToolUse", "PostToolUse"],
    "hookCommand": "$PILOT_DATA/hooks/my-agent-loongsuite-pilot-hook.sh",
    "format": "nested",
    "matcher": "*"
  },
  "input": {
    "type": "hook-jsonl",
    "logDir": "$PILOT_DATA/logs/my-agent"
  }
}
```

插件注入示例：

```json
{
  "id": "my-agent",
  "displayName": "My Agent",
  "deployMode": "plugin-inject",
  "detection": {
    "paths": ["~/.config/my-agent"],
    "commands": ["my-agent"]
  },
  "pluginInject": {
    "configPaths": [
      "~/.config/my-agent/config.json"
    ],
    "pluginSpec": "file://$PILOT_DATA/plugins/my-agent/plugin.mjs",
    "pluginId": "loongsuite-pilot-my-agent"
  },
  "input": {
    "type": "hook-jsonl",
    "logDir": "$PILOT_DATA/logs/my-agent"
  }
}
```

关键字段：

| 字段 | 作用 |
|------|------|
| `id` | 稳定 Agent ID，用于配置、输出和准入控制。 |
| `displayName` | 用户可读 Agent 名称。 |
| `deployMode` | `hook`、`plugin-inject`、`directory-plugin` 或 `plugin-probe`。 |
| `detection.paths` | 可用于判断 Agent 是否安装的本地路径。 |
| `detection.commands` | 可用于判断 Agent 是否安装的命令。 |
| `hook` | Hook settings 路径、事件、命令和格式。Hook 模式必填。 |
| `pluginInject` | 配置路径和插件 spec。插件注入模式必填。 |
| `directoryPlugin` | Pilot 管理的源目录和目标目录。原生目录插件模式必填。 |
| `input` | collector input 使用的数据源类型和位置。 |

`pluginInject.configKey` 可指定默认 `plugin` / `plugins` 之外的数组字段，
例如 Pi Coding Agent 使用 `extensions`。目标 Agent 支持空设置文件时，可设置
`pluginInject.createIfMissing`，在配置不存在时自动创建第一个候选 JSON 文件。

> 新增 `plugin-inject` 类型 agent 时，请同时在卸载脚本（`deploy/installer-opensource.sh` / `.ps1`）中登记，确保卸载时移除其注入的 spec。此外 plugin-inject agent 在运行时会由 hook watchdog 自愈：若配置被其它工具覆盖，会自动重新注入 spec。

## 尽早输出规范化记录

对于单写者 Hook 和插件集成，可以让 Hook 或插件将 newline-delimited JSON 写入：

```text
~/.loongsuite-pilot/logs/<agent-id>/<agent-id>-YYYY-MM-DD.jsonl
```

不要让多个 Agent 进程直接追加同一个 JSONL 文件。跨进程 append 并不能充分保证
一条记录不会被拆分或交错。此时应使用[可靠的混合采集](#可靠的混合采集)中描述的
逐事件 spool，或者使用已经明确证明具备进程间安全性的 writer。

尽可能使用 canonical dotted fields：

```json
{
  "time_unix_nano": "1778586618041000000",
  "observed_time_unix_nano": "1778586618041000000",
  "event.id": "event-uuid",
  "event.name": "tool.result",
  "user.id": "user-id",
  "gen_ai.session.id": "session-id",
  "gen_ai.agent.type": "my-agent",
  "gen_ai.provider.name": "openai",
  "gen_ai.tool.name": "bash",
  "gen_ai.tool.call.id": "call-id",
  "gen_ai.tool.call.duration": 423
}
```

Source-specific 字段建议放在 `agent.<agent-id>.*` 下，避免污染公共稳定字段。
这些字段可供归一化和上下文增强内部使用，但默认不会输出到 SLS 和本地 JSONL。

## 实现 Input

根据数据源选择已有输入风格：

| 数据源 | 推荐 Input 风格 |
|--------|-----------------|
| Hook 或插件 JSONL | 继承 `BaseHookInput`；如果源记录已使用 canonical dotted fields，可复用 `transformHookRecord`。 |
| 本地 session 文件 | 继承 `BaseSessionInput`。 |
| SQLite 数据库 | 继承 `BaseSqliteInput`。 |
| IDE history snapshot | 继承 `BaseIdeInput`。 |
| CLI telemetry 文件 | 继承 `BaseCliForwarder`。 |
| 本地 CLI/API | 直接继承 `BaseInput`。 |

Input 应该：

- 只增量读取新记录。
- 在重启后保留 checkpoint。
- 发出 `AgentActivityEntry`。
- 除非策略允许，否则避免导出原始敏感内容。
- 可获取时附加稳定的 session、turn、tool call 和 error 标识。

## 可靠的混合采集

当一个集成同时使用 transcript（或数据库）和生命周期 Hook 时，面对的是两类不同
性质的证据：

- transcript 是消息、模型输出、原生 ID、token 用量和源时间戳的主要语义来源；
- Hook 是对生命周期边界的一次观察，可用于唤醒 collector、封口稳定的 transcript
  区间，以及修补缺失的结构信息，但不能覆盖更强的 transcript 证据。

必须在代码和测试中明确这个优先级。只有当 Hook 与同一个语义边界能够唯一匹配时，
其时间戳才能补充 transcript 缺失的时间；工具名和 call ID 也遵循同一规则。不能从
`completed` 之类通用 Agent 状态推断模型 finish reason；源端提供模型原生 reason
时使用原生值，否则只能使用经过验证的生命周期边界，例如稳定的 `Stop` 事件。

### LLM 与 Tool 的时间边界

`time_unix_nano` 表示语义事件发生时间，不是 Pilot 读取文件的时间；后者应写入
`observed_time_unix_nano`。

LLM span 应遵循：

- 起点是相应的 `llm.request` 边界：首个 step 使用 prompt 提交时间；后续 step
  使用 tool result 使下一次模型输入就绪的时间。
- 终点是配对的 `llm.response` 边界：能够证明该 step 已产生模型输出的最早原生
  时间，包括 reasoning、文本或 tool-call intent。
- transcript 中存在 response 时间时，它优先于更早或更晚观察到的 `Stop` Hook；
  只有 transcript 缺失 response 时间时，才可将 Hook 作为有明确说明的兜底。
- request/response 必须按稳定的 session/turn/step ID 配对，不能仅凭相邻顺序看似
  合理就关联无关记录。

TOOL span 应遵循：

- 起点使用匹配的 `tool.call`/`PreToolUse` 时间，终点使用匹配的
  `tool.result`/`PostToolUse` 时间。
- 使用稳定的 tool-call ID 关联。并行工具调用时，按位置匹配不安全。只有恰好存在
  唯一匹配时，Hook identity 才能修补 transcript 缺失的 identity。
- 仅当两个边界都存在且差值为正时，才将 `结果时间 - 调用时间`（毫秒）写入
  `gen_ai.tool.call.duration`；否则省略 duration。
- 如果无法确定必需的工具名、调用 identity 或事件时间，应省略受影响的 tool
  event，不能输出 `unknown`、零值或猜测值。

验收测试必须把规范化事件转换为 span，并断言 LLM 和 TOOL 的准确起止时间，不能只
检查事件或属性存在。转换器测试应使用接近真实的 Unix epoch；过早的合成时间可能
触发遥测库的时间钳制，掩盖真正的配对问题。

### 临时异常下的 Checkpoint

必须区分“本轮没有观察到数据源”和“数据源已经删除”：

- 每轮采集从上一次已提交 offset 和文件元数据的副本开始。目录扫描、`stat` 或读取
  失败时保留原状态。
- 扫描结果必须携带明确的 complete 状态。未完成扫描返回空列表，不构成删除证据。
- 只有完整枚举成功且路径明确为 not-found 时才能删除文件 checkpoint。权限错误、
  临时卸载、rename 窗口及其他 I/O 错误都必须保留 checkpoint。
- 重置 offset 前使用文件 identity 和 size 判断文件替换或截断；不得越过不完整的
  JSONL 记录推进 offset。
- producer 分块写入一个 turn 时，必须等待稳定的语义边界（例如 `Stop` 后再次观察
  到相同文件快照）再解析并推进 offset。
- 首次发现数据源时，必须明确决定并测试是 baseline 已有历史还是执行回放，不能让
  默认 offset 偶然决定行为。

Pilot 的通用 Input 生命周期在 `BaseInput` 将 batch 发到 `InputManager` 队列后即
认为已接收，随后持久化输入状态，不等待 flusher ack。除非整体交付契约要求，否则
不要为单个集成增加私有 pending-batch 协议或本地 outbox。常规取舍允许进程崩溃
窗口内出现少量重复或丢失，以保持各 Input 的 checkpoint 语义一致。

恢复测试至少覆盖：重启、末尾半条记录、目录临时不可用后恢复、文件截断或替换、以及
确认删除。目录临时不可用的测试必须证明旧 checkpoint 和尚未消费的 Hook 证据都被
保留。

### 多进程 Hook 事件 Spool

Hook 可能在多个 Agent 进程中并发运行时，应将结构化 Hook 证据保存为临时的
per-session spool：

1. 要求稳定的 session ID 和 transcript path。使用“清洗后的可读文本 + hash”生成
   安全的 session 目录名，绝不能把原始 ID 直接当路径。
2. 每个 event 写一个不可变文件，文件名必须具有足够熵，避免跨进程碰撞。
3. 在同一目录中以独占方式创建临时文件，写入一个完整 JSON 对象后原子 rename 到
   正式扩展名。collector 只读取已发布文件，因此不会看到半写记录。
4. Hook 必须 fail-open：日志失败不能改变或阻塞 Agent 行为；平台支持时限制目录和
   文件权限。
5. 按 canonical transcript path 和 session ID 限定匹配范围。Hook 只补充
   transcript，并且只消费能够唯一匹配的结构证据。
6. transcript 区间完成 checkpoint 后删除对应的已发布 event；只有完整扫描确认
   transcript 已删除后，才删除 session spool。废弃临时文件必须等待 grace period
   后清理，避免与仍存活的 writer 竞争。

此 spool 与 transcript 生命周期一致，不是长期 audit log，因此不需要按容量轮转。
它通过及时消费已 checkpoint 的 event、以及删除 transcript 已消失的 session 来
保持有界。

可运行的实现参考见 `assets/hooks/workbuddy-hook-event-writer.mjs`、
`src/inputs/workbuddy/workbuddy-input.ts`，以及
`tests/unit/hooks/workbuddy-hook-event-writer.test.ts` 和
`tests/unit/inputs/workbuddy-input.test.ts`。

## 注册 Agent

需要自定义 input class 时：

1. 在 `src/types/client-type.ts` 增加 Agent。
2. 在 `src/core/orchestrator.ts` 导入并注册 input。
3. 关联 listener ID 与公开 Agent ID，确保 `agent-control.json` 和 `config.agents` 生效。
4. 如果 input 需要轮询，增加默认 listener 配置。
5. 在 `agents.d/` 增加内置 Agent 定义。

如果新集成符合已有 Hook 或插件记录格式，可以复用已有 base input 和 `transformHookRecord`，减少代码变化。但 input 仍然需要在 collector 启动路径中注册。

## 质量验收门禁

只有通过以下全部适用门禁，Agent 集成才能标记为 ready。

### 字段质量

- [输出事件 Schema](output-event-schema.md) 中的 Required 字段填充率必须为 100%；条件成立时，Conditionally Required 字段填充率必须为 100%。
- Recommended 字段按 `event.name` 分别报告填充率。源端不提供字段时应记录实证，不能用 `unknown`、零 token、零 duration 或其他看似有效的默认值凑完整率。
- JSONL 必须保留原生 JSON 类型：数字和布尔值保持标量，消息、工具参数和工具结果按 schema 保持数组或对象。
- 验证 Unix 纳秒时间戳、trace/span 标识、非负 token 和正数毫秒 duration；源端无法证明正耗时时必须省略 duration。

### 事件拓扑与恢复

- 每个模型 step 都有配对的 `llm.request` 和 `llm.response`。
- 使用 `gen_ai.tool.call.id` 关联每个 `tool.call` 和 `tool.result`；并行工具调用不得碰撞。
- session、turn、step 标识必须一致；如果输出 `gen_ai.turn.start/end`，每个 turn 各最多出现一次。
- `event.id` 在本轮内唯一，同一源记录重放时保持确定性。
- checkpoint 在重启后继续生效，只输出追加数据，能容忍半行，且不会无边界重放历史。

### 隐私与 fixture

- 源 Agent 提供相关字段时，Prompt、Completion、reasoning、工具参数和工具结果必须支持 `captureMessageContent: false`。
- 除非必须并可被脱敏，否则不要将密钥放入 source-specific 扩展字段。
- 验证 `mask.mode: all` 能在输出中脱敏已支持的密钥和个人敏感信息。见 [数据脱敏](masking.md)。
- Hook 或插件必须 fail open，遥测失败不能阻塞源 Agent。
- 只提交完全合成的 fixture，不得包含真实 prompt、transcript、用户名、home 路径、仓库路径、session ID 或凭证。
- 使用最少测试覆盖不同语义分支，不为增加测试数量添加重复用例。

### 必测场景

覆盖检测/部署、Hook 或插件记录、checkpoint、关闭内容采集和开启脱敏，并至少验证：

- 纯文本 turn；
- 单次工具调用；
- 并行工具调用及其结果；
- 明确失败或取消；
- 重启重放与增量追加。

### 安装产物最终验收

- 运行 typecheck、完整单元/集成测试、build 和安装包安装。
- 在 probe 前记录目标 JSONL 行数，只分析新交互追加的记录。
- 操作真实 Agent：CLI Agent 使用真实 CLI，GUI Agent 使用 Computer Use。
- 验收报告必须包含事件数量、逐事件字段填充率、关联检查、原生类型检查、隐私检查和有实证的已知缺口。
- 使用 `E2E_JSONL_STRICT=1` 运行 JSONL validator；如果待测 Agent 不在默认
  headless L1 集合中，必须同时用 `E2E_JSONL_AGENT_FILTER=<agent-id>` 明确选择。
  例如 WorkBuddy GUI 验收必须设置 `E2E_JSONL_AGENT_FILTER=workbuddy`。Strict
  是唯一自动质量门禁，不增加 Agent-specific 绕过模式。

## 用户文档清单

新增公开 Agent 时，更新：

- [README](../../README.zh-CN.md) 和 [产品概览](overview.md) 中的支持 Agent 表。
- 如果 Agent 需要特殊配置，更新配置示例。
- 如果 Agent 会输出新的敏感内容字段，更新 [数据脱敏](masking.md)。
- 只有新增稳定公共字段时，才更新 [输出事件 Schema](output-event-schema.md)。
