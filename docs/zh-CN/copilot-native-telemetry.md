# Copilot CLI 原生遥测采集

Copilot CLI 1.0.86 的 `events.jsonl` 提供消息和工具结果，原生 OTel 文件提供单次 LLM 的准确用量、时间和状态。Pilot 通过 `apiCallId` / `gen_ai.response.id` 关联两者，不从会话总量分摊单次 Token。

每个原生 `interactionId` 对应一个 Trace。同一次用户交互中的多个 LLM 和工具往返属于同一 Trace；整个会话通过 `gen_ai.session.id` 关联。`turnId` 只作为交互内部的步骤标识，不能作为会话内唯一键。

安装时，Pilot 在 Bash/Zsh启动配置中维护独立标记块，为新终端设置 `COPILOT_OTEL_FILE_EXPORTER_PATH`。已有文件导出路径、OTLP endpoint、exporter type 或显式 enabled 配置优先；Pilot 不覆盖这些环境变量，也不开启原生遥测正文采集。现有终端需重新打开。非这些 Shell 的启动方式需要显式配置原生文件导出路径。

原生文件默认为 `$PILOT_DATA/state/copilot/otel/*.jsonl`，Hook 记录实际文件路径并唤醒采集。有会话文件导出标记或原生 span 证据时，完整 interaction 必须同时具备已结束的原生 Agent span 和对应消息/LLM span 才会提交。明确无文件导出标记的会话保留 transcript 采集；没有 Hook/native 证据的旧终端在完整交互首次被观察后等待 30 秒，且已发现的源读取完毕后才降级。等待起点持久化，重启不会重新计时。降级记录带 `gen_ai.copilot.telemetry.source=transcript-only`，不伪造缺失用量；超过等待窗口才出现的原生数据不会修订已交付交互。全局 `otel-enabled` 不再作为会话已启用导出的证据。

采集器只在完整交互进入 InputManager 输出队列后保存交互 checkpoint；文件读取偏移、关联源记录与已交付交互分别持久化到 `$PILOT_DATA/state/copilot/source-index.sqlite`，重启从保存偏移继续读取，尚未进入队列的交互由源索引重建。升级时自动导入旧版 v2 交互 checkpoint。遵循项目统一的队列提交边界，不提供下游存储确认或跨进程崩溃的严格 exactly-once 保证。源文件读取失败不会清除交互 checkpoint。

`session.shutdown` 的全部 `modelMetrics` 独立写入 `gen_ai.session.model_metrics`，带 `gen_ai.copilot.session_summary=true`。此事件进入常规事件输出，不额外生成 Trace，也不重复计入 LLM/Agent Token。

输入 Token 已包含 cache-read Token 时不得再次相加；Agent 用量仅由其后代 LLM 汇总。拒绝和取消采用原生错误状态，不把成功执行的非零退出命令误判为工具调用失败。

源文件不再有 64 MiB 总大小限制：按 64 KiB 块增量读取，每文件每轮最多读取 4 MiB；未完成行的分片和扫描位置事务性保存在 SQLite，重启继续读取，完整记录偏移仍停在行首。完整坏行记录位置后隔离，不输出原文；未完成的末行等待后续写入，不阻塞前面已完成的交互。历史记录保存在 SQLite，内存只装载待处理交互；单条巨大记录或巨大交互仍会占用相应内存。索引随保留的源记录增长，确认会话目录删除后清理其索引；不会删除用户或原生遥测文件。不要单独删除索引，否则仍保留的源文件可能被重新采集。

LLM 请求仅通过 `gen_ai.input.messages_delta` 输出当前 interaction 内、相比前一请求新出现的 transcript 消息和工具结果。不会在每次请求中重读整个会话历史，也不会向 response 再复制一份输入。Trace 转换器按交互内请求顺序累积 delta，展示本交互的输入上下文；transcript 并不证明模型实际收到的完整压缩后上下文，因此不把会话历史伪装成完整请求快照。ENTRY/AGENT 仍只包含当前交互的真实用户输入。

首次启用此采集策略时，默认以该次启用时间为事件时间边界，不回放边界之前已开始的交互。升级时旧索引中尚未交付的早期交互也会被跳过，包括升级前已开始、升级后才完成的交互。历史排除记录与 `delivered` 分开保存，不把跳过的数据记成已上报。旧会话目录仍可继续使用：边界之后新增的用户交互正常采集，不能仅凭文件修改时间或整个 session 的开始时间决定是否跳过。

边界保存在 `$PILOT_DATA/state/copilot/collection-policy.json`，并在 SQLite 中留有副本；正常重启不会推进边界，因此仍会恢复启用后尚未交付的交互。只重建 SQLite 也不会重新打开安装前历史。边界文件损坏或与索引不一致时停止该 Input 的采集并记录错误，不静默重置。调用 `CopilotLogInput` 的受控集成可在首次启用前显式传入 `historyStartTimeMs` 选择更早的边界；这不是用户配置或环境变量开关，既有边界不能通过重启覆盖。

时间边界优先使用 transcript 的真实 `user.message` 时间。原生数据先到、其时间早于边界而尚无用户证据时，只保留源文件身份及字节区间等轻量定位信息；后续新用户消息确认该交互属于采集范围后，再恢复匹配的原生 span。恢复有每轮读取预算，临时不可读保留定位以重试，文件替换或确认会话删除时清理旧定位。不会为等待关联而复制全部历史 native 正文。

首次仍需按现有分块预算读取旧源文件来识别 session 与后续新交互，策略限制的是历史输出和历史正文入库，不是直接跳过全部源字节。排除旧记录后 SQLite 空闲页可复用；不会自动执行需要额外磁盘空间的整库 VACUUM。

Copilot 退出后仍可补齐边界之后的尾部交互；已交付数据由 SQLite 去重。历史排空且源文件不再变化后不会持续产生事件。[本地输出](local-jsonl-output.md) 按大小分片，并由保留策略治理当天封存分片和超过 3 GiB 的异常本地日志。该清理不删除 Copilot 自己的源会话、原生 OTel 文件或 checkpoint。

ENTRY 和 AGENT 的 `gen_ai.input.messages` 来自当前 interaction 的真实 `user.message`，按原始时间排序，不复制 LLM 的历史上下文；经过统一消息处理与脱敏流程。主分支已统一始终采集消息正文，旧 `captureMessageContent` 配置不再关闭正文。

当前支持 Unix Bash/Zsh 自动部署。Windows 自动部署显式禁用；保留旧安装的尽力清理，但不会因 Copilot 清理错误中断公共卸载。子 Agent 并发和外部父 Trace 不在本轮支持范围内。禁用会移除插件注册、资产与托管 shell 块，清理失败保留部署记录以重试；watchdog 会修复启用状态下丢失的注册和资产。
