# Agent 配置

[English](../agents.md) | 简体中文

本文说明如何选择 Pilot 要采集哪些 AI Coding Agent，以及是否采集敏感消息内容。

## 支持的 Agent ID

这些 ID 用于标识受支持的集成。大多数 ID 可直接用于安装参数、
`agent-control.json` 和 `config.json`；复用采集链路或输出类型不同的情况会在说明中标出。

| Agent | ID | 说明 |
|-------|----|------|
| Claude Code | `claude-code` | Hook 集成。 |
| Codex | `codex` | Hook 集成。 |
| Cursor | `cursor` | Hook 集成。 |
| Cursor CLI | `cursor-cli` | 独立检测并输出为 `cursor-cli`，但复用 Cursor 已安装的 Hook/Input 链路，不会独立部署另一套 Hook；输出内容策略使用 `cursor-cli`。 |
| DeepSeek Harness | `dsh` | 用户级 YAML patch 插件与本地 per-session JSONL 轮询；采集原生 LLM、reasoning、工具、Token 和 TTFT 数据。 |
| Grok Build | `grok-build` | 四个 fail-open Hook 与本地 session 日志融合，采集 LLM、Token、工具、取消和失败生命周期。 |
| Hermes Agent | `hermes-agent` | 原生目录插件和本地 session 文件采集；输出记录使用 `gen_ai.agent.type=hermes`。 |
| Kiro CLI | `kiro-cli` | Hook 集成，并延迟采集本地 SQLite/session 数据；源端暂不提供 Token 用量。 |
| MiMo Code | `mimo-code` | 插件注入，采集 LLM、工具和 Token 生命周期事件。 |
| OpenClaw | `openclaw` | 注入插件，支持 OpenClaw 2026.3.8 及以上版本；自动适配新旧 Hook，5.12 之前的模型调用时间为推定值。 |
| OpenCode | `opencode` | 插件注入。 |
| Pi Coding Agent | `pi-coding-agent` | 注入 Pi Extension，采集 LLM 与工具生命周期事件。 |
| Qoder | `qoder` | Hook 集成。 |
| Qoder CN | `qoder-cn` | Hook 集成。 |
| Qoder for JetBrains | `qoder-jetbrains` | 部署/检测专用 ID。`agent-control.json` 中采集开关为 `qoder`；`config.json` 中内容策略为 `qoder-idea`。 |
| Qoder CLI | `qoder` | 复用 Qoder Agent 定义，使用 Hook / session 数据源。 |
| Qoder Work | `qoder-work` | Hook 和本地数据源。 |
| Qoder Work CN | `qoder-work-cn` | Hook 和本地数据源。 |
| Qwen Code CLI | `qwen-code-cli` | Hook 集成；Stop 时解析 qwen-code transcript JSONL。 |
| Qwen Work CN | `qwen-work-cn` | Hook 和本地数据源。 |
| Wukong | `wukong` | 运行时自动发现并通过本地 `wukong-cli` 进行 CLI API 轮询；它不是 `agents.d` 安装选择项。 |
| WorkBuddy | `workbuddy` | 结构化 Hook 和文件变化触发即时采集，本地 transcript 每 30 秒轮询兜底；已在 macOS WorkBuddy Desktop 5.2.6 和 Windows 11 WorkBuddy Desktop 5.3.5.0 验证。 |

Windows 验证使用安装后的 Pilot 产物，在 `PATH` 中没有 Node 的情况下从安装器固定的
`node-bin` 解析 Node，并用真实 WorkBuddy transcript 通过严格 JSONL 校验。

Codex 使用 transcript 作为采集事实源。Pilot 通过轻量的
`SessionStart` 和 `UserPromptSubmit` Hook 发现当前实际生效的
`CODEX_HOME`（包括编排器为单个任务创建的独立目录），并采集该 session
根目录下最近活跃的 rollout 文件。`Stop` 仅作为尽力而为的唤醒信号，
目录发现不依赖它。

## Grok Build 采集与生命周期

Pilot 通过 `~/.grok` 检测 Grok Build，并在
`~/.grok/hooks/loongsuite-pilot.json` 中安装四个 fail-open Hook：
`stop`、`stop_failure`、`user_prompt_submit` 和 `session_end`。当前明确
不安装、不采集 subagent Hook。

每个已完成 turn 由 Grok 自身的三类 JSONL 数据融合生成：

- session 目录下的 `chat_history.jsonl` 提供消息、模型元数据、
  工具参数、工具结果和 system instruction。
- session 目录下的 `updates.jsonl` 提供真实 prompt ID、turn 终态、
  取消或失败状态以及工具状态。
- `~/.grok/logs/unified.jsonl` 提供模型时间、Token、工具执行时间
  和成功状态。

采集从安装后观测到的当前 turn 开始，不回放更早的 session 历史。
由于 Grok 会异步持久化取消终态，取消 turn 可能在下一次
`user_prompt_submit` 或 `session_end` 时补采。将
`agents["grok-build"].captureMessageContent` 设置为 `false`，会同时清除
user、assistant、system 内容、工具参数、工具结果和原始错误详情。

安装产物同时包含 POSIX 和 PowerShell 启动器。Grok 专用 watchdog
检查会修复缺失或被修改的 Pilot Hook 资产和配置；卸载只删除
Pilot 所有的 Grok Hook 条目，保留第三方 Hook。

## DeepSeek Harness 采集与生命周期

Pilot 会为检测和部署解析同一个准确的 Harness home：已部署过的补丁路径
用于后续修复和清理，其次依次检查本地 Agent 定义中显式设置的 `patchPath`、
Pilot 服务进程的 `DSH_HOME`，以及 Linux 上唯一、同用户运行中 DSH 进程的
`DSH_HOME`；标准的 `~/.dsh` 目录和 `dsh` 命令仍作为兜底。Pilot 不会扫描
临时目录或假定某个固定的非默认 home；若初次发现时同时存在多个不同的运行中
home，会报告歧义而不会静默选择其中一个。

启用 `dsh` 后，Pilot 会在解析出的 `<DSH_HOME>/cordis.patch.yml` 中追加一个
带 marker 的 Pilot 专属 block，用于加载
`$PILOT_DATA/plugins/dsh/plugin.mjs`；marker 外的用户及第三方内容保持原样。
首次启用或重新安装后，需要启动新的 DSH 进程，使宿主加载当前 patch。

插件将 append-only 原生事件写入
`$PILOT_DATA/logs/dsh/dsh-<session-id>.jsonl`。在 POSIX 系统上，目录权限为
`0700`，文件权限为 `0600`。这些源文件包含归一化所需的原生消息和
工具数据，应当作敏感数据保护；插件在落盘前会过滤类似凭据的 key。
`captureMessageContent` 只控制归一化输出，不会删除这些源日志中的内容。
Pilot 使用原生请求边界到首个 reasoning、text 或 tool-call stream delta
的时间差计算 LLM TTFT，并以纳秒写入
`gen_ai.response.time_to_first_token`。

`agent-control.json` 和 `config.json` 中的采集开关均使用 ID `dsh`。
禁用采集时，Pilot 会先删除 enable marker，使已加载的插件停止写入，
再只删除 Pilot 所属的 YAML block。DSH 保持启用时，运行时 watchdog
会修复该 block。卸载会在删除插件资产之前执行相同的属主清理，并保留
无关 YAML 内容。如果源事件缺少请求边界或输出 delta，Pilot 会省略 TTFT，
不会伪造为 0。

## OpenClaw 兼容性与生命周期

Pilot 支持 OpenClaw `>=2026.3.8`。在写入宿主配置之前，Pilot 使用进程内文件
操作读取选中安装实例的 `package.json`，用户无需传入版本。版本探测不会启动
OpenClaw、shell、which 或 npm 子进程。`OPENCLAW_CLI_PATH` 为可选覆盖项，不再必填。

入口按以下优先级解析：

1. 显式指定的绝对路径 `OPENCLAW_CLI_PATH`。
2. 安装器保存在 Pilot 配置中的 `agents.openclaw.cliPath`。
3. 自动探测当前 OpenClaw 包工作目录中的 `openclaw.mjs`、固定的 `./openclaw` 子目录中的包、标准
   `~/.openclaw-bundle`（或 `OPENCLAW_BUNDLE_ROOT`）内的安装，以及 PATH 上首个
   OpenClaw 命令。指向同一包的软链接会去重；发现不同安装实例时不猜测，版本相同也视为冲突。

对于 `WORKDIR /app`、`node openclaw.mjs gateway ...` 的源码容器，在 `/app` 下安装，
探测无冲突时无需手动传入路径或版本。PATH 或标准 Bundle 暴露的共享安装也支持自动识别。
对于 `WORKDIR /app`、`node openclaw/openclaw.mjs gateway ...`，在 `/app` 下安装也会检查
`/app/openclaw/package.json` 和 `/app/openclaw/openclaw.mjs`。只增加这一固定子目录，
不递归搜索任意目录；当前目录和子目录中的不同安装仍按冲突处理。
父目录的 `package.json` 损坏或不可读时，仅在父目录 `openclaw.mjs` 确认不存在的情况下
继续检查固定子包，且必须找到有效子包，不会仅凭 PATH 回退。已确认不支持的父 OpenClaw、
损坏的子包或无法确认的目录访问异常仍阻止自动选择，并报告失败路径。
启用 OpenClaw 时，安装器保存选中的入口，而非缓存版本。后台 collector/watchdog 即使
工作目录、PATH 或服务环境改变，也会从 Pilot 配置重新读取入口并验证当前版本。
自定义配置位置遵循 `AGENT_DATA_COLLECTION_CONFIG`；公共安装器会自动将 `--data-dir`
对应的配置路径传给探测器。

仅在多套安装冲突或非标准目录无法自动识别时，才需要在安装时指定实际 Gateway 入口。
显式入口失效时不回退；后台 collector/watchdog 对失效的已保存入口也不会静默改绑。
仅公共安装器启用恢复：确认旧入口已不存在且发现唯一有效新安装后，选择 OpenClaw
（包括接受默认选择）才保存新入口；探测结果显示旧路径，探测本身不修改配置。
入口仍存在但版本不支持、不可读或候选冲突时不恢复。隐式 HOME Bundle 的固定入口
确已不存在时按残留跳过，不删除文件；完整旧版、不可读 Bundle 或无效的显式
`OPENCLAW_BUNDLE_ROOT` 仍阻止自动选择。配置路径与主配置加载器使用相同的 home
展开规则，包括 Windows `~\\` 和系统 home 兜底。
未知或不受支持的版本保持非就绪、可重试。
`OPENCLAW_SERVICE_VERSION`、`OPENCLAW_BUNDLED_VERSION`、`OPENCLAW_VERSION`
等版本标签不能单独作为配置能力依据。重装采用自动/默认选择时，探测失败会保留已有
OpenClaw 启用状态和入口；显式 `--agents` 或菜单选择仍可以禁用。重复部署不重写已正确的
配置。不扫描进程、不缓存版本、不执行 Gateway 重载命令。
首次注入、明确禁用或确有配置/兼容性变化时，Gateway 自身仍可能因配置变化重载/重启；
请在 Gateway 启动前安装，或为这些变更安排维护窗口。

| 宿主版本 | 采集适配器 | `hooks.allowConversationAccess` |
| --- | --- | --- |
| 2026.3.8～2026.4.23 | Legacy 增强兼容 | 不写入，清除 Pilot 条目中残留的该字段 |
| 2026.4.24～2026.5.11 | Legacy 增强兼容 | 启用 |
| 2026.5.12+ | Modern | 启用 |

部署和 watchdog 修复会重新读取版本，因此升级/降级后会重新选择配置。
插件启动时独立使用 `api.runtime.version` 选择适配器。该字段缺失、为空或为
`unknown` 时（包括官方 2026.3.8 npm 包），沿当前 Node 进程入口的真实路径，
在限定深度和读取大小内查找最近的 OpenClaw `package.json`。运行时回退不搜索
PATH/工作目录，不执行 CLI，也不使用用户传入的版本；明确不支持的版本仍拒绝注册。
配置路径遵循
`OPENCLAW_CONFIG_PATH` 和 `OPENCLAW_STATE_DIR`。支持会话权限的宿主使用以下条目：

```json
{
  "plugins": {
    "entries": {
      "loongsuite-pilot-openclaw": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

Legacy 适配器以 `llm_input`、AssistantMessage 的 `before_message_write`、
工具 Hook 和 `llm_output` 重建链路，保留真实输出、toolCallId 与逐次 Token。
run 汇总用量只作诊断，不叠加到 LLM 用量。模型请求开始时间按输入或最后一个工具结果
持久化边界推定，标记 `agent.openclaw.timing.inferred=true` 和
`agent.openclaw.timing.source`；该时间包含编排开销，不能视为精确 Provider 延迟。
缺失的 TTFT、传输指标和未持久化的重试不补造。失败 run 可通过 `agent_end` 立即收尾，
无需等待可能不会出现的 `llm_output`。同 session 并发且持久化 Hook 无 runId 时，
会跳过有歧义的持久化消息，并在聚合事件标记
`agent.openclaw.correlation.ambiguous=true`，直到冲突的 run 全部结束。
若 Provider fallback 在失败已收尾后复用 runId，新尝试会使用独立 turn/trace，
并通过 `agent.openclaw.run_id` 保留原生 ID。

低于 1ms 的推断区间按当前转换器的 1ms 精度量化，并标记
`agent.openclaw.timing.quantized_ms=1`；后续工具和父级终端使用同一逻辑时钟，
保持嵌套边界，观测时间单独保留。优先淘汰已结束 run；容量淘汰、session 结束、
歧义失败或孤立状态过期（空闲 30 分钟，新输入时检查）使用 `legacy_cleanup`
和 `gen_ai.turn.end=true` 收口，标记 `agent.openclaw.collection.incomplete=true`，
不猜测模型成功/失败。结构去重限于 64Ki 字符/1024 个节点；超限时优先使用有界的
原生 responseId/时间戳，无可靠原生标识的超限消息仍采集但不去重，
不使用截断内容 hash 误合并不同消息。

2026.3.8 已知限制：持久化 Hook 关联需要原生 `sessionKey`，例如 Gateway 会话，
或 `agent --local --agent main`。只传一个未绑定 Agent/会话存储的新 `--session-id`
时缺少该键，Pilot 保留 run 级事件，不猜测逐次调用归属。另外，3.8 对非 OpenAI 官方
Chat Completions 端点关闭流式请求的 `include_usage` 选项，DashScope 在该路径可能
产生原生零 Token 记录，Pilot 无法据此还原真实用量。这取决于 Provider：真实 Gateway
调用 DeepSeek 时已获得正值原生用量，并完成逐次调用及缓存 Token 对账。

2026.3.8 暂不支持原生 sender 提取：旧 Hook 未提供新版的发送者身份。Pilot 保留
配置/环境提供的用户身份，不从消息正文或 session 名称猜测 sender。
`AGENTTEAMS_WORKER_NAME` 仍可使用，需在启动 Gateway 前设置，修改后重启 Gateway。
worker 标识与 sender 身份是两回事。

迁移旧版插件数组配置前，Pilot 会创建
权限受限的备份。升级时会把 Pilot 旧的单文件加载路径替换为插件包目录；
卸载会同时清理新旧两种路径和 Pilot 自己的条目，并保留其他插件及其配置。

注入的插件会把 append-only 源事件写入
`~/.loongsuite-pilot/logs/openclaw/`。在 POSIX 系统上，目录权限为 `0700`，
文件权限为 `0600`。Provider 错误或取消调用可能没有输出消息或 Token 用量；
Pilot 会上报原生 finish reason 与可获得的时间边界，不会伪造消息或补零 Token。
关闭内容采集时也会删除可能包含用户内容的错误消息。

[真实 Provider Gateway 验证入口](../../scripts/e2e/openclaw-compat.md) 仅允许在一次性
Linux 容器中运行，使用实际 Pilot 安装器与采集进程，检查原生 Token、链路结构、worker、
重启去重、内容关闭、watchdog 修复、重复安装与卸载。精确 OpenClaw 版本仅用于测试断言，
不会传入 Pilot 的版本探测逻辑。本地通过不替代 SLS/ARMS 独立回查或客户 EDR 环境验证。

## 安装时选择 Agent

使用 `--agents` 跳过交互选择：

```bash
bash /tmp/loongsuite-pilot-installer.sh install --agents "claude-code,codex,cursor,dsh"
```

安装器仍会检查所选 Agent 是否存在于当前机器上，再部署对应采集能力。

## 安装后启停 Agent

使用 `~/.loongsuite-pilot/agent-control.json` 控制准入：

```json
{
  "version": 3,
  "tools": {
    "claude-code": "on",
    "cursor": "auto",
    "dsh": "on",
    "qoder": "off"
  }
}
```

| 模式 | 含义 |
|------|------|
| `on` | 当数据源存在时强制启用该 Agent。 |
| `off` | 禁用该 Agent。 |
| `auto` | 使用默认自动检测行为。 |

修改后重启：

```bash
loongsuite-pilot restart
```

## 按 Agent 配置内容采集

如果需要控制消息内容采集，使用 `config.json`：

```json
{
  "agents": {
    "claude-code": { "enabled": true, "captureMessageContent": false },
    "codex": { "enabled": true, "captureMessageContent": false },
    "dsh": { "enabled": true, "captureMessageContent": false },
    "openclaw": { "enabled": true, "captureMessageContent": false },
    "cursor": { "enabled": true, "captureMessageContent": true }
  }
}
```

| 配置项 | 说明 |
|--------|------|
| `enabled` | 设置为 `false` 可从配置层禁用该 Agent。 |
| `captureMessageContent` | 设置为 `false` 可避免采集完整 Prompt、Completion、工具参数和工具结果，前提是对应集成支持该策略。 |
| `multimodal.uploadMode` | **实验性。** 多模态上传策略。`none`（默认）关闭；`input` / `tool` / `output` / `both` 控制转换表面。详见 [多模态采集](multimodal.md)。 |
| `multimodal.allowedRootPaths` | 额外本地根目录，与 Agent 默认根合并后供 `pathToUri` 使用。`~` 会展开。工作区图片需要把项目目录写在这里。详见 [多模态采集](multimodal.md#allowedrootpaths)。 |

敏感环境建议同时设置 `captureMessageContent: false` 和 [数据脱敏](masking.md)。需要提取多模态数据时，见 [多模态采集](multimodal.md)（当前仅图像；已实现 `codex` 与 `qoder` IDE/CLI）。

## 验证 Agent 采集

```bash
loongsuite-pilot status
ls ~/.loongsuite-pilot/logs/output
tail -f ~/.loongsuite-pilot/logs/output/*.jsonl
```

如果预期 Agent 没有数据：

- 确认 Agent 已安装且至少使用过一次。
- 确认 `agent-control.json` 中没有设置为 `off`。
- 确认 `config.json` 中没有设置 `"enabled": false`。
- 修改配置后重启 Pilot。
