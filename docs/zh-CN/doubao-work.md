# 豆包工作任务级可观测（实验性）

`doubao-work` 被动读取 macOS 豆包工作的前端日志，不向客户端注入 Hook、插件或连接器，不修改登录状态和设置。协议基线为 DoubaoWork 2.33.10；普通豆包、Windows 和云端内部执行不在本阶段支持范围内。

## 能力范围

Pilot 关联客户端消息提交和结束事件，输出同一会话、轮次下的一对任务边界事件（`other`）和 ENTRY → AGENT Trace。边界采用源提交时间和客户端会话结束日志时间，Span 转换精度为毫秒。它表示客户端请求轮次，不能用来声称云端任务及其内部步骤已全部完成。

首版不提取 Prompt、回答、reasoning、工具参数/结果，也不生成 LLM/TOOL Span、模型、Token、成本或模型 TTFT。`自动` 模型选项不是真实模型 ID。日志里的 SSE/render 首输出延迟不是模型原生 TTFT。

客户端可在返回算力/订阅限制通知后仍记录 `session_success=1`。因此对所有轮次保留 `business_outcome=unknown`，正常接收的根 Span 使用 UNSET 状态；源端明确报告客户端失败或取消时，根 Span 标为 ERROR。这不是对业务任务成功率的推断。

标准事件与 OTLP Resource 包含这些低基数属性：

| 属性 | 值 |
|---|---|
| `loongsuite.doubao_work.observation_scope` | `client_message` |
| `loongsuite.doubao_work.business_outcome` | `unknown` |
| `loongsuite.doubao_work.client_outcome` | `received`、`ended`、`error` 或 `cancelled` |

Agent type/framework 为 `doubao-work`，Agent system 为 `doubao`，provider 为 `bytedance.doubao`。会话使用源 `conversation_id`，轮次使用源请求会话 ID；不将设备或缓存目录标识当作用户 ID，沿用 Pilot 配置身份和 hostname 兜底。

## 配置与发现

默认数据源：`~/Library/Application Support/DoubaoWork/sdk_storage/log/saman_frontend_YYYY.MMDD.N.log`。客户端须已产生该日志；Pilot 不自动启用调试日志。首次启用跳过已有历史，此后仅采集新增且起止均被观察到的轮次。

```json
{
  "agents": { "doubao-work": { "enabled": true } },
  "listeners": { "doubao-work": { "enabled": true, "pollInterval": 10000 } }
}
```

`listeners.doubao-work.logDir` 可覆盖只读源日志目录（支持 `~`），用于自定义本机安装目录。该目录与 Pilot 的输出 `dataDir` 不同。`agents.d` 使用 `detection-only`，没有需要安装、修复或卸载的宿主 Hook；停用 listener 或 Agent 即停止采集。

使用目录变更唤醒和轮询兜底。checkpoint 保留完整行 offset、文件边界指纹、待关联请求和已完成轮次。支持半行、重启、轮转、原地截断后增长和临时不可读；首次启用前的请求不从单独结束事件重建。单次读取最多 1 MiB，每轮最多 8 MiB，最多读取最新 128 个日志文件；超长行跳过至换行。待关联请求最多 512 个/24 小时，完成去重最多 4096 个/7 天。超出边界不承诺完整采集或 exactly-once。

日志缺失、协议变更或无稳定关联/时间时，不生成猜测的 Trace。适配器只保留受限身份与状态字段，不读取浏览器 Cookie、认证缓存、消息数据库或用户工作文件。仍遵循统一身份处理与脱敏配置。

验收使用真实 GUI 新交互，设置 `E2E_JSONL_STRICT=1` 和 `E2E_JSONL_AGENT_FILTER=doubao-work`。任务级校验通过不代表完整 LLM/工具接入通过；云端回读与本机源、事件、Span 和接收端验证分别记录。
