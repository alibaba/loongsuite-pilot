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

[InputManager](../../src/core/input-manager.ts)、[StateStore](../../src/checkpoints/state-store.ts) 将输入游标保存与输出持久接收串联。失败冻结共享 checkpoint；修复存储或输出后重启恢复。多目标部分成功及不确定网络回执仍可能重发稳定 ID；不承诺端到端恰好一次。

恢复路径复用当前 workspace 过滤、内容开关和脱敏策略，不直接回放过期策略的日志。journal 按组增量读取；读取失败阻止启动，写入失败不推进游标。关联状态保存标识/指纹，密文仅做 opaque 指纹比较，不解密，不额外保存工作正文；journal 属于受数据目录保护的遥测持久状态，仍受内容采集配置影响。

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
| 定向回归 | 42 个不同测试文件、654 个测试全部通过；包括 Codex、flusher、checkpoint、Schema、JSONL validator、Orchestrator 启动顺序与内容策略 |
| 跨输出集成 | Codex 新增跨输出场景单独运行 11/11 通过，已计入上述回归；使用测试接收端/夹具验证，不代表生产云端到达 |
| 真实安装态 | 本次开源候选未重新安装、触发真实 Agent 场景 |
| 云端回读 | 本次开源候选未重新执行，不复用旧报告作为通过证明 |

真实安装态与云端回读仍需独立执行、明确报告。历史数据不自动修复，其他 Agent 仍由各自任务推进。
