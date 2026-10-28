# Copilot CLI 原生遥测采集

Copilot CLI 1.0.86 的 `events.jsonl` 提供消息和工具结果，原生 OTel 文件提供单次 LLM 的准确用量、时间和状态。Pilot 通过 `apiCallId` / `gen_ai.response.id` 关联两者，不从会话总量分摊单次 Token。

每个原生 `interactionId` 对应一个 Trace。同一次用户交互中的多个 LLM 和工具往返属于同一 Trace；整个会话通过 `gen_ai.session.id` 关联。`turnId` 只作为交互内部的步骤标识，不能作为会话内唯一键。

安装时，Pilot 在 Bash/Zsh启动配置中维护独立标记块，为新终端设置 `COPILOT_OTEL_FILE_EXPORTER_PATH`。已有文件导出路径、OTLP endpoint、exporter type 或显式 enabled 配置优先；Pilot 不覆盖这些环境变量，也不开启原生遥测正文采集。现有终端需重新打开。非这些 Shell 的启动方式需要显式配置原生文件导出路径。

原生文件默认为 `$PILOT_DATA/state/copilot/otel/*.jsonl`，Hook 记录实际文件路径并唤醒采集。有会话文件导出标记或原生 span 证据时，完整 interaction 必须同时具备已结束的原生 Agent span 和对应消息/LLM span 才会提交。明确无文件导出标记的会话保留 transcript 采集；没有 Hook/native 证据的旧终端在完整交互首次被观察后等待 30 秒，且已发现的源读取完毕后才降级。等待起点持久化，重启不会重新计时。降级记录带 `gen_ai.copilot.telemetry.source=transcript-only`，不伪造缺失用量；超过等待窗口才出现的原生数据不会修订已交付交互。全局 `otel-enabled` 不再作为会话已启用导出的证据。

采集器只在完整交互进入 InputManager 输出队列后保存交互 checkpoint；文件读取偏移、关联源记录与已交付交互分别持久化到 `$PILOT_DATA/state/copilot/source-index.sqlite`，重启从保存偏移继续读取，尚未进入队列的交互由源索引重建。升级时自动导入旧版 v2 交互 checkpoint。遵循项目统一的队列提交边界，不提供下游存储确认或跨进程崩溃的严格 exactly-once 保证。源文件读取失败不会清除交互 checkpoint。

`session.shutdown` 的全部 `modelMetrics` 独立写入 `gen_ai.session.model_metrics`，带 `gen_ai.copilot.session_summary=true`。此事件进入常规事件输出，不额外生成 Trace，也不重复计入 LLM/Agent Token。

输入 Token 已包含 cache-read Token 时不得再次相加；Agent 用量仅由其后代 LLM 汇总。拒绝和取消采用原生错误状态，不把成功执行的非零退出命令误判为工具调用失败。

源文件不再有 64 MiB 总大小限制：按 64 KiB 块增量读取，每文件每轮最多读取 4 MiB；未完成行的分片和扫描位置事务性保存在 SQLite，重启继续读取，完整记录偏移仍停在行首。完整坏行记录位置后隔离，不输出原文；未完成的末行等待后续写入，不阻塞前面已完成的交互。历史记录保存在 SQLite，内存只装载待处理交互及其消息上下文；单条巨大记录或巨大 LLM 上下文仍会占用相应内存。索引随保留的源记录增长，确认会话目录删除后清理其索引；不会删除用户或原生遥测文件。不要单独删除索引，否则仍保留的源文件可能被重新采集。

ENTRY 和 AGENT 的 `gen_ai.input.messages` 来自当前 interaction 的真实 `user.message`，按原始时间排序，不复制 LLM 的历史上下文；经过统一消息处理与脱敏流程。主分支已统一始终采集消息正文，旧 `captureMessageContent` 配置不再关闭正文。

当前支持 Unix Bash/Zsh 自动部署。Windows 自动部署显式禁用；保留旧安装的尽力清理，但不会因 Copilot 清理错误中断公共卸载。子 Agent 并发和外部父 Trace 不在本轮支持范围内。禁用会移除插件注册、资产与托管 shell 块，清理失败保留部署记录以重试；watchdog 会修复启用状态下丢失的注册和资产。
