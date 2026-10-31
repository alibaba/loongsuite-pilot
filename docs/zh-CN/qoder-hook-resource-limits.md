# Qoder Hook 资源保护

`qoder-hook-processor.mjs` 同时用于 Qoder 和 Qoder CN。长会话的 transcript 会持续增长；
逐事件全量读取、解析并启动无限后继重试，会放大内存压力。本修复提供有界处理和明确的降级行为。

## 资源边界

| 项目 | 上限 / 行为 |
| --- | --- |
| 同时解析 transcript 的进程 | 同一 Pilot 数据目录合计 2 个，包含普通调用和后台重试 |
| 后台重试 | 同一数据目录合计 4 个，在创建子进程之前预留名额 |
| 重复重试 | 相同 agent、transcript 路径、session、触发行号只保留一份；不同轮次分别占用名额 |
| 单个后台进程 | 最多尝试 3 次，60 秒调度预算；不再派生后继重试进程 |
| 重试延迟 | 默认 5 秒；`HOOK_RETRY_DELAY` 可设置 0–10000 毫秒，重试间隔递增且最多 10 秒 |
| 后台进程 V8 old-space | 256 MiB；这是堆的一部分，不是进程总 RSS 的硬上限 |
| transcript | 最多 32 MiB、100000 行，单行最多 4 MiB |
| 读取 | 64 KiB 分块，保留解析结果，不保留整份原始文本和拆行副本；读取期间不追赶新追加内容 |
| 高频事件 | 已部署的 PreToolUse、PostToolUse、UserPromptSubmit 不再触发 transcript 解析；Stop 保持采集 |
| transcript 互斥锁 | 持锁进程存活时不因超过 60 秒而抢占；死亡进程的锁允许恢复 |

名额和去重记录位于 `$PILOT_DATA/state/hooks/qoder-resource-guards/`，退出时释放，
异常退出留下的记录会在后续申请时检查 PID 并回收。旧版 transcript 锁路径保持兼容。
60 秒是重试调度预算，不是操作系统对同步文件 I/O 的硬超时；存活但卡住的进程仍占用名额，
其他进程不会为了接管它而突破并发上限。

## 降级与数据完整性

这是一版资源保护修复，**尚未改成按持久化字节游标读取长会话**。限制以内仍会遍历整个文件。
文件超限时整次解析退出，不提交部分解析结果，也不推进采集游标；文件持续超限时该会话会持续
暂停 Hook 采集。需要保留原 transcript，再通过源端的会话轮换或后续增量读取实现恢复，不能删除
原始文件或直接推进游标来消除告警。

解析名额或重试名额耗尽时，本次调用快速退出且不推进游标。它不是持久化任务队列：如果没有
后续事件，最后一轮可能不会补采。后续事件也继续遵循现有冷启动 / Qoder CN 的轮次选择规则，
不能承诺所有被限流的历史轮次自动回放。

诊断写入 `$PILOT_DATA/logs/<agent>/debug/`：

- `transcript-byte-limit`、`transcript-line-byte-limit`、`transcript-line-count-limit`：输入超限。
- `Parser capacity unavailable`：正在解析的进程已达上限。
- `Retry coalesced or capacity unavailable`：重复触发已合并，或后台名额不足。
- `Retry budget exhausted`：锁竞争或输出失败重试到期，无后继进程。

本修复不会替换已经启动的旧版进程；验证安装态时应核对实际部署的脚本及后台进程启动版本。

## 验证

`tests/unit/hooks/qoder-resource-bounds.test.mjs` 覆盖大文件、长行、多行、UTF-8 分块、持续追加、
游标不推进、真实多进程争抢、重复合并、父子进程名额交接、锁争抢和输出失败重试到期。
原有 Qoder 多轮、去重、身份和时间边界测试继续验证正常数据语义。

内存对比使用 `node tests/performance/qoder-hook-processor.perf.mjs [原版处理器绝对路径]`，
对相同的 8 / 32 / 64 MiB 合成文件分别创建独立进程，输出 RSS 和解析时间。
合成数据的内存结果不能代替故障机器的 transcript、进程数量及 watchdog/panic 证据。

2026-10-31 使用 macOS 上的 Node v22.22.2，对比修复前处理器（与 GitHub `main` 的
`f84e3881958b39c5c7cbe8a035f50ccd80a25783` 中的处理器内容相同），
开启内容哈希、每组独立进程，单次快照解析结束时测得：

| 合成 transcript | 原版 RSS | 修复版 RSS | 修复版结果 |
| --- | --- | --- | --- |
| 约 8 MiB | 94 MiB | 69 MiB | 完整解析 2051 行 |
| 约 32 MiB | 240 MiB | 107 MiB | 完整解析 8204 行 |
| 约 64 MiB | 402 MiB | 51 MiB | 读取内容前拒绝，游标不推进 |

这是读取函数的对比，不是整个 Hook 生命周期的峰值测量；64 MiB 两列的采集结果不同，
不能将拒绝解析的内存结果表述为相同采集能力下的性能提升。

补充执行 `node tests/performance/qoder-hook-processor.perf.mjs --large-only`：
128 MiB、512 MiB、1 GiB 的稀疏文件均在读取内容前返回 `transcript-byte-limit`，
独立进程 RSS 约 51 MiB，函数耗时约 0.2–0.4 毫秒。稀疏文件只用于验证文件大小拒绝路径，
**不代表成功采集了同等大小的真实 transcript**。

资源保护测试扩展至 29 项，包括 32 MiB − 1 字节 / 恰好 32 MiB 的合法 JSONL 完整解析、
32 MiB + 1 字节至 1 GiB 的内容零读取、普通和重试入口保留原游标、真实 4 MiB 单行和
100000 行边界。

发布前仍需结合实际工作负载评估阈值，并验证高密度对象 / 多模态记录、多会话事件突发、
慢磁盘与长时间锁竞争、进程崩溃恢复，以及限流后没有后续事件的补采语义。
若验收要求 128 MiB–1 GiB 历史会话不断采，应实现并测试按游标读取与有界轮次处理，
不能用“大文件拒绝成功”替代“大文件完整采集成功”。
