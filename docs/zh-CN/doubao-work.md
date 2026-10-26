# 豆包工作任务与本地工具可观测（实验性）

`doubao-work` 被动读取 macOS 豆包工作的前端日志，不向客户端注入 Hook、插件或连接器，不修改登录状态和设置。协议基线为 DoubaoWork 2.33.10；普通豆包、Windows 和云端内部执行不在本阶段支持范围内。

## 能力范围

Pilot 关联客户端消息提交和结束事件，输出同一会话、轮次下的一对任务边界事件（`other`）和 ENTRY → AGENT Trace。边界采用源提交时间和客户端会话结束日志时间；提交时间保留源毫秒精度，日志时间保留源微秒精度。它表示客户端请求轮次，不能用来声称云端任务及其内部步骤已全部完成。

不提取 Prompt、回答、reasoning、工具参数/结果，也不生成 LLM Span、模型、Token、成本或模型 TTFT。`自动` 模型选项不是真实模型 ID。日志里的 SSE/render 首输出延迟不是模型原生 TTFT。

客户端可在返回算力/订阅限制通知后仍记录 `session_success=1`。因此对所有轮次保留 `business_outcome=unknown`，正常接收的根 Span 使用 UNSET 状态；源端明确报告客户端失败或取消时，根 Span 标为 ERROR。这不是对业务任务成功率的推断。

标准事件与 OTLP Resource 包含这些低基数属性：

| 属性 | 值 |
|---|---|
| `loongsuite.doubao_work.observation_scope` | `client_message` |
| `loongsuite.doubao_work.business_outcome` | `unknown` |
| `loongsuite.doubao_work.client_outcome` | `received`、`ended`、`error` 或 `cancelled` |

Agent type/framework 为 `doubao-work`，Agent system 为 `doubao`，provider 为 `bytedance.doubao`。会话使用源 `conversation_id`，轮次使用源请求会话 ID；不将设备或缓存目录标识当作用户 ID，沿用 Pilot 配置身份和 hostname 兜底。

## 工具、技能与子 Agent

| 能力 | 支持边界 |
|---|---|
| 本地工具 | 精确匹配前端 `toolcall` 的 `received` 与 `execution_settled`，输出 `tool.call` / `tool.result` 和 AGENT 下的 TOOL Span；支持并行配对与采集中途重启 |
| 所选技能/伙伴 | 原生 `mention_skill_list` / `mention_partner_list` 的受限标识数组，分别写入 `loongsuite.doubao_work.selected_skills` / `selected_partners`；仅表示该请求的选择上下文 |
| Skill 实际加载 | 当前日志未提供可验证的独立加载起止，不把选中技能解释为 `skill.use` 或 SKILL/TOOL Span |
| 云端工具及子 Agent | 已实测 `create_agent` → organizer → 两个并行子 Agent；本地轨迹有调用与父子 ID，但缺少执行时间及可靠轮次关联，不生成猜测的云端 TOOL/AGENT Span |
| 独立“工作伙伴”页面 | 独立的 aily 云端任务入口；本地客户端消息日志不覆盖其任务生命周期，不声称支持其 Trace |

本地工具时间表示客户端收到调用到本地执行结算的观察区间，包含分发/确认等待，不等于云端模型发起到接收结果的全链路耗时。原生工具名、调用 ID、受限状态与正的毫秒耗时被保留；不读取命令、参数、输出或原始错误。`success` 只表示原生本地执行结算状态，不推断业务结果或 Bash 命令退出码。

TOOL 的 `loongsuite.doubao_work.tool_boundary=client_received_to_execution_settled` 标识这个边界。由于未观察到模型与 React 步骤，Trace 为 ENTRY → AGENT → TOOL，不补造 STEP/LLM。通用 validator 仅针对这个明确标识和 Doubao framework 接受 TOOL 直接挂 AGENT；其他 Agent 的 STEP/LLM 检查保持严格。旧 validator 若只允许 STEP → TOOL，会报告结构不兼容；验收同时保留原始结果与本候选公开契约校验。

缺少一端、ID/工具名冲突、没有唯一请求归属、超出客户端请求时间的后台调用均省略，记录有界告警。云端 `calculator`、`web.fetch`、`create_agent` 等仅在无时间的轨迹中出现时不生成工具耗时。子 Agent 的复用、嵌套、晚到完成和重启不能由普通任务 Trace 证明。

## 配置与发现

默认数据源：`~/Library/Application Support/DoubaoWork/sdk_storage/log/saman_frontend_YYYY.MMDD.N.log`。客户端须已产生该日志；Pilot 不自动启用调试日志。首次启用跳过已有历史，此后仅采集新增且起止均被观察到的轮次。

```json
{
  "agents": { "doubao-work": { "enabled": true } },
  "listeners": { "doubao-work": { "enabled": true, "pollInterval": 10000 } }
}
```

`listeners.doubao-work.logDir` 可覆盖只读源日志目录（支持 `~`），用于自定义本机安装目录。该目录与 Pilot 的输出 `dataDir` 不同。`agents.d` 使用 `detection-only`，没有需要安装、修复或卸载的宿主 Hook；停用 listener 或 Agent 即停止采集。

使用目录变更唤醒和轮询兜底。checkpoint 保留完整行 offset、文件边界指纹、待关联请求和已完成轮次。支持半行、重启、轮转、原地截断后增长和临时不可读；首次启用前的请求不从单独结束事件重建。单次读取最多 1 MiB，每轮最多 8 MiB，最多读取最新 128 个日志文件；超长行跳过至换行。待关联请求最多 512 个/24 小时，工具配对状态最多 4096 个/24 小时，完成去重最多 4096 个/7 天。超出边界不承诺完整采集或 exactly-once。

日志缺失、协议变更或无稳定关联/时间时，不生成猜测的 Trace。适配器只保留受限身份与状态字段，不读取浏览器 Cookie、认证缓存、消息数据库或用户工作文件。仍遵循统一身份处理与脱敏配置。

验收使用真实 GUI 新交互，设置 `E2E_JSONL_STRICT=1` 和 `E2E_JSONL_AGENT_FILTER=doubao-work`。任务及本地工具校验通过不代表云端 LLM、Skill 加载或子 Agent Trace 接入通过；云端回读与本机源、事件、Span 和接收端验证分别记录。
