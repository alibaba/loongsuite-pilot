# Codex 子 Agent 实现与验证入口

本文说明本次 Codex 采集实现及可复查入口。目标契约见[子 Agent 数据模型](subagent-data-model.md)。不覆盖其他 Agent 的实现，也不提供展示层逻辑。

## 数据来源与关联

本次不修改 `assets/hooks/codex-loongsuite-pilot-hook.sh`、`assets/hooks/codex-hook-processor.mjs` 或 `agents.d/codex.json`。已有 Hook 保存 transcript 位置与生命周期唤醒信息；业务事实来自 collector 增量读取的原生 rollout JSONL。

- [extractor](../../src/inputs/codex-transcript/codex-transcript-extractor.ts)：owning session、turn、模型波次、工具及输出、token、原生结束/中断；复制的父历史不作为子新工作。
- [linker](../../src/inputs/codex-transcript/codex-subagent-linker.ts)：委派描述符、明确 child thread、task/activity、新工作匹配及持久工作绑定。incoming 按工作传播，不固化为 session 永久属性。
- [input](../../src/inputs/codex-transcript/codex-transcript-input.ts)：增量完整行读取、父 invoke/result、子 incoming、晚到结果重试和 checkpoint。挂载父 Trace 不覆盖子 session/turn/step。
- [Codex 转换边界](../../src/flushers/codex-turn-converter.ts)：独立子轮次转换，子 ENTRY 透明，子 AGENT 连接实际父工具，子内部层级保留。
- [事件兼容边界](../../src/flushers/trace-event-compat.ts)：模型/工具名称适配及委派审计事件排除。Hermes/OpenClaw 使用的公共 delegated-turn converter 是设计参考，不是 Codex 实际调用链。

invocation 为 SHA-256(`['codex-delegation', parentSession, parentTurn, toolCallId, workIndex]`) 的前 32 个十六进制字符。批量每项使用不同 workIndex；重放同一原生事实 ID 不变。新工作、重试采集、取消/等待是不同语义，不能都当成新委派。

`FINAL_ANSWER` 是 Codex 内部结果交付消息类型，解析成标准 `gen_ai.agent.result` 前仍需唯一 invocation 关联与去重。工具受理、子本地完成、父实际收到结果不是同一边界。暂时无法关联的 FINAL_ANSWER 保存文件范围，后续只重试结果审计，不重复模型/工具日志。

## Agent 名称

子侧 `gen_ai.agent.name` 表示当前执行者；父侧 `gen_ai.agent.invoke/result` 的 `gen_ai.agent.peer.name` 表示目标子 Agent 的真实名称（如 `Newton`）。名称来自派发回执 `nickname` 或可靠关联的子会话 `agent_nickname`，沿用现有工作/子会话状态支持复用与重启。嵌套调用分别保留当前名称和目标名称，不用 task path 猜名称；无可靠名称则省略。名称晚到不重发已输出的 invoke，也不延迟首次委派事件。此补充只填已有标准字段，不增加加密状态或任务属性。

## 委派内容字段

| 事件 | 内容字段 | 内容语义 |
| --- | --- | --- |
| `gen_ai.agent.invoke` | `gen_ai.input.messages` | 本次交给目标 Agent 的任务及显式传入的上下文 |
| `gen_ai.agent.result` | `gen_ai.output.messages` | 实际交付给调用方的结果 |

Codex 从派发工具参数的 `message`、`prompt` 或 `input` 读取可读内容，复用原生消息转换，写为 `[{role: "user", parts: [{type: "text", content: "任务内容"}]}]`；多段文本保留各自的 part。批量 `agents` / `tasks` 按原始工作序号分别填充，不复制整个批次、不串入其他工作。缺少可读内容时省略字段，不用父会话输入代替，不解密密文，也不补造隐式继承的上下文。

原始工具参数仍在 `tool.call` 的 `gen_ai.tool.call.arguments`，invoke 不再重复携带这个工具内容字段。result 使用 assistant 消息。内容开关与脱敏策略同时作用于这些消息；invocation、event ID 和 Trace 身份不因字段映射变化而改变。历史已采集事件不自动回填。

## 什么时候发送

| 对象 | 条件 |
| --- | --- |
| 普通日志 | 已闭合模型波次增量发送；有效 token 与工具返回/下一波次提供闭合证据，剩余片段由原生 turn 终态收尾 |
| invoke | 识别逻辑委派即可，不等子模型或结果 |
| result | 已观测真实结果/失败，能够确定 invocation，且未重复记录 |
| OTLP | 按当前 session+turn 独立缓冲，等自己的原生 completed/interrupted 终态 |
| 输入 checkpoint | 已配置输出完成持久接收；OTLP 未完成前缀已写 journal，Codex SLS/HTTP 等实际发送成功 |

父 turn 结束不强制关闭子 turn。无可靠挂载的子工作仍独立采集；已导出的 Trace 不靠重发补挂。仅有模型 `finish_reason=stop` 不关闭整个 turn。

## 持久化与隐私边界

[OTLP flusher](../../src/flushers/otlp-trace-flusher.ts) 与 [journal](../../src/flushers/codex-turn-journal.ts) 将未完成 Codex 轮次前缀持久保存在数据目录的 `logs/codex-pending-turns/`；完整导出成功后先写确认再清理 pending，最近 10,000 轮确认用于抑制重放。退出、内存 buffer 淘汰均不导出伪造半轮。

[InputManager](../../src/core/input-manager.ts)、[StateStore](../../src/checkpoints/state-store.ts) 将输入游标保存与输出持久接收串联。HTTP 暂时失败由已有 flush 定时器重试同一批次，等待其远端 ACK 后才释放 checkpoint，无需重启；其他持久接收失败仍冻结共享 checkpoint，修复存储或输出后重启恢复。多目标部分成功及不确定网络回执仍可能重发稳定 ID；不承诺端到端恰好一次。

恢复路径复用当前 workspace 过滤、内容开关和脱敏策略，不直接回放过期策略的日志。journal 按组增量读取；读取失败阻止启动，写入失败不推进游标。关联状态保存标识/指纹，密文仅做 opaque 指纹比较，不解密，不额外保存工作正文；journal 属于受数据目录保护的遥测持久状态，仍受内容采集配置影响。

### 持久接收与原生终态

公共 `send` / `sendBatch` 都等待启动恢复并持久接收自身记录；journal 恢复走内部追加路径，不以全局“正在恢复/批处理”标志跳过其他调用的持久化。准备前缀与追加期间暂缓 buffer 淘汰，避免只导出后缀后确认整轮。

Codex 只用显式 `gen_ai.turn.end` 收尾，`agent.codex.turn_status=interrupted` 本身不关闭轮次，因为该状态可能出现在分批输出的每条记录上。HTTP 网络失败保留同一批次及接收等待，重试不重新派发到已成功的其他输出。停止输入或 collector 时取消 HTTP 等待和在途请求，未确认的批次不推进 checkpoint；取消造成的失败仍保持冻结到 collector 重启，不通过后续任意一次成功清除全局失败。编排器在发现服务排空之前发出取消；BaseInput 停止时只解除对共享 checkpoint 的等待，仍完整等待 collect、onStart 和 onStop。其他不可恢复的输出失败只保留一份失败原因；已结束的接收 Promise 从等待集合移除，避免持续失败时不断积累。

## 可执行回归入口

在已安装仓库依赖的开发环境运行：

```bash
npm run typecheck
npx vitest run tests/unit/inputs/codex-transcript/codex-subagent-linker.test.ts tests/unit/inputs/codex-transcript/codex-transcript-input.test.ts
npx vitest run tests/integration/codex-subagent-lifecycle.test.ts tests/integration/codex-subagent-converter.test.ts tests/integration/codex-standard-event-output.test.ts tests/integration/codex-aborted-turn-converter.test.ts
```

另需覆盖 flusher、InputManager、StateStore、标准事件 Schema 与验证器相关回归；具体本次执行清单及结果由 PR 验证记录提供，不以文档中的命令示例冒充已执行。

真实安装态应从候选源码构建独立安装产物，确认运行进程使用该产物，再执行[设计矩阵](subagent-data-model.md#8-验收矩阵)。至少实测后台晚到、同一子 session 复用、嵌套与 collector 运行中重启。记录原生工具/线程/轮次、稳定 event ID、invocation 与实际 Span，再比较本地 JSONL、HTTP/SLS 接收记录和 OTLP；云端按集合比较缺失、额外、重复及关键字段，不只统计行数。

## 验证证据的边界

移植前开发环境曾报告源码、跨输出以及真实安装态/云端验证。本公开文档没有复制内部原始记录、用户标识、云资源或实验数据，旧报告也不构成本次开源候选已验收的证据。

本次开源移植已执行的验证：

| 层级 | 本次结果 |
| --- | --- |
| 源码检查 | `npm run typecheck` 通过；4 个相关脚本的 Node 语法检查通过 |
| 构建 | `npm run build` 完整通过，含 Swift 产物 |
| 定向回归 | 43 个不同测试文件、677 个测试全部通过；包括 Codex、flusher、checkpoint、Schema、JSONL validator、Orchestrator 启动顺序与内容策略 |
| 跨输出集成 | Codex 新增跨输出场景单独运行 11/11 通过，已计入上述回归；使用测试接收端/夹具验证，不代表生产云端到达 |
| 真实安装态 | 本次开源候选未重新安装、触发真实 Agent 场景 |
| 云端回读 | 本次开源候选未重新执行，不复用旧报告作为通过证明 |

真实安装态与云端回读仍需独立执行、明确报告。历史数据不自动修复，其他 Agent 仍由各自任务推进。

## HTTP 断网恢复与停机回归（2026-10-20）

配置 HTTP 输出时，暂时断网、连接拒绝或服务端 503 不结束本批的持久接收等待；已有 flush 定时器继续重试原序列化批次，成功 ACK 后输入 checkpoint 自动保存，其他已成功输出不重发。每批 ACK 独立，重试与显式 flush 共用单个在途任务。

停止输入/collector 时取消 HTTP 接收等待与在途请求，未确认的游标不推进；因取消终止的接收仍需 collector 重启从已持久化游标恢复，不以任意后续成功清除全局失败。不承诺无首次持久游标的新文件一定能靠重启补回，也不改变启动 baseline 策略。停机只解除对输出确认的等待，正在写盘的 checkpoint 及 collect/onStart/onStop 仍等待完成。

本轮源码回归 38 个测试文件、582 项全部通过，typecheck 与完整构建通过。其中 6 项真实 localhost 集成覆盖 503 恢复、连接拒绝恢复、HTTP/JSONL 身份与重复检查、无响应请求停机、正常停启及非 Codex 输入受共享 checkpoint 阻塞时的停止。测试使用隔离输入和本地接收端，不构成真实 Agent、生产云端或 UI 验收。
