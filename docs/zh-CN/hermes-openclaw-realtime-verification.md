# Hermes / OpenClaw 请求上下文写出验证（2026-10-19）

## 结论与范围

客户需要在每次 LLM / 工具出站请求发送前取得其 trace 上下文，以关联成本。
Hermes 原实现到回合结束才构建并追加事件，这确实无法满足请求前读取。
但“JSONL 与云端 Hermes LLM SpanID 必然不同”的解释不符合本次基线：
现有 collector 已有 producer SpanID 复用机制，修改前真实测试的 Hermes
v2026.6.5 为 7/7、新版为 6/6 一致。OpenClaw modern 请求缺少 SpanID 是独立缺口。

本修复让 Hermes 在 `pre_api_request` 追加当前请求，响应和工具事件增量追加；
OpenClaw modern 在 `model_call_started` 分配模型 SpanID。collector 继续使用原有
SpanID 复用逻辑，不新增一套独立的网关 OTel span 树。

Hermes `pre_llm_call` 仍早于请求分配。同一回合可有多次 API 请求，客户若只在
这里缓存一次，后续请求仍会用错上下文。双方联调应确认消费端在 Pilot 写出之后、
每次实际发送之前，按 session/turn 和 Hermes request ID 或 OpenClaw step/call ID
匹配；不读取全局最后一条记录。增量 Hermes 插件与对应 collector 应一起部署。
客户未提供传播器源码，本次发送前验证使用独立测试消费端，不代表客户 patch 原样通过。

OpenClaw 尚未完成父上下文关联的子 Agent 事件保留有界缓冲；工具拦截策略仍先执行。
本修复不承诺这些事件在父上下文未知或策略判定前写出。追加后跨进程可见不等同于
每事件 `fsync`，也不等同于远端数据立刻可查。

## 精确版本

Pilot 基线：`ff5256e0`，直接基于 `alibaba/loongsuite-pilot`。

| Agent | 来源 / 版本 | 验证结果 |
|---|---|---|
| Hermes-Agent v2026.6.5 | 官方仓库 tag，`3c231eb3979ab9c57d5cd6d02f1d577a3b718b43` | 真实 CLI、工具、会话恢复及云端读回通过 |
| 新版 Hermes-Agent | 官方仓库 `5fc490e2b34123212d73ef316086f939567a725a`，显示 `2026.9.24` | 真实 gateway/CLI、工具、会话恢复及云端读回通过 |
| OpenClaw v2026.6.5 | 官方 npm `openclaw@2026.6.5` | 真实 Gateway RPC、文本/工具调用及云端读回通过 |
| OpenClaw v2026.6.10 | 官方 npm `openclaw@2026.6.10` | 真实 Gateway RPC、文本/工具调用及云端读回通过 |
| OpenClaw 2026.10.5 | 官方 npm 包已下载 | 本机启动遭 `SIGKILL`，未通过真实网关验收；不能宣称最新版通过 |

collector 和旧版 OpenClaw 使用 Pilot 管理的 Node `22.22.2`。OpenClaw 2026.10.5
要求 Node `>=24.16.0 <25 || >=26.1.0`，分别尝试本机 Node `26.12.0` 和另行下载的
`24.16.0`，均在插件运行前被终止；清理环境变量、关闭 compile cache 的尝试仍失败。
这只是本机启动限制，尚不能归因为 Pilot 兼容缺陷，也不能据此确认其兼容性。
安装最新包时还遇到 koffi 原生构建缺少 CMake；后续隔离安装了构建工具并尝试重建，
Node 进程仍被终止。需在能正常启动该版本的主机补跑。

## 真实调用与 CMS 读回

测试使用隔离的 Pilot 数据目录和真实 DashScope `qwen-plus`，使用用户指定的
ARMS 工作区，通过 `aliyun --profile arms cms2 trace search` 按精确 TraceID 查询。
未把上报 HTTP 成功当作读回成功。根据 `gen_ai.span.kind=LLM` 和
`gen_ai.response.id` 匹配云端 LLM，避免把 ENTRY/AGENT span 当成 LLM span。

| 场景 | trace | LLM 请求/响应配对 | JSONL→规范化→CMS ID 一致 | token 一致 | TTFT 一致 | 工具 SpanID 一致 |
|---|---:|---:|---:|---:|---:|---:|
| Hermes v2026.6.5 | 3 | 6 | 6/6 | 6/6 | 6/6 | 3/3 |
| 新版 Hermes | 3 | 6 | 6/6 | 6/6 | 6/6 | 3/3 |
| OpenClaw v2026.6.5 | 2 | 3 | 3/3 | 3/3 | 3/3 | 2/2 |
| OpenClaw v2026.6.10 | 2 | 3 | 3/3 | 3/3 | 3/3 | 2/2 |

新版 Hermes 的 TTFT 有两个适配点：lazy-forward facade 后的原生 streaming helper；
以及 bounded hook 在独立 `copy_context` 工作线程中执行，导致 hook 中设置的
`ContextVar` 不会返回调用线程。后者按原生 Agent 的 session + turn/task 精确匹配
唯一未完成请求；没有明确身份或存在歧义时不填 TTFT，不能取“最新请求”猜测。

发送前证据来自独立进程读取源 JSONL，并由测试消费端在真实 httpx / undici 发送边界
写入 `traceparent`。两个 Hermes 版本各 6 次、两个 OpenClaw 版本各 3 次，
均在发送前读到匹配请求，且 header 中的 ID 与实际 CMS LLM span 一致。
Hermes 测试以请求 body 指纹关联；新版 relay 改写请求时，顺序验收场景只接受唯一未完成
请求，存在多个候选即拒绝注入。此兜底只用于该顺序测试，不作为生产传播器方案。
OpenClaw 同样只在顺序测试有唯一未完成请求时注入，不能证明并发传播器正确。
并发身份隔离由回归测试覆盖，客户消费端仍需自行使用明确请求身份。

## 回归与证据

全量回归为 379 个文件通过、5 个跳过，5,389 项测试通过、65 项跳过；类型检查和构建通过。
最终工具部分写入重试修复后，Hermes 专项 62 项测试通过。
回归覆盖首请求尚无文件、多次模型调用、工具调用/返回、错误重试、未完成请求、
写入失败保留状态重试、回合结束去重、同会话交错回合、父子 Agent、身份继承、
TTFT 回调及复制上下文丢失/身份歧义。旧版仅在最终 history 才提供内容的 fixtures
按事件时间验证最终语义；单独的 realtime suite 按实际追加顺序和跨进程可见性断言。

本地证据根目录（含受保护配置，勿整体上传）：
`$APSARA_APM_AGENT_WORKSPACE_DIR/pilot-realtime-context-e2e/`。

- `cloud-verification.json`：逐 LLM JSONL/CMS ID、token、TTFT 比对。
- `outbound-verification.json`：逐请求发送前 header 与源 JSONL、CMS 的关联比对。
- `<runtime>/evidence/cloud-spans.json`：CMS 实际查询结果。
- `<runtime>/evidence/timing.jsonl`、`outbound-audit.jsonl`：源文件与发送边界证据。
- `full-tests-final.log`、`final-targeted-tests.log`、`typecheck-final.log`：自动化检查。
- 原始环境准备/TTFT 修复前的数据单独保留，未计入上表正式验收。

四个通过真实验收的运行目录均通过仓库严格 JSONL validator：无解析、必填字段、
模型/工具配对、重复 event ID 或回合边界错误。配置和凭证不提交到仓库。

严格校验曾在分批采集时发现响应和终止记录同时被标成 turn end：归一化层原有的
finish-reason 兜底抢先为 `stop` / `error` 补了结束边界。现已与 flusher 一起遵循
`realtime-v1` 显式结束协议，新增跨批次回归，并使用最终 collector 重新运行上表全部场景。
旧的本地证据保留在 `evidence-before-boundary-fix` 和 `logs.before-boundary-fix`，不计入上表。

最终 npm 包 SHA256：`dc6202dcc71b93ee4017c139f6e02dc0351e9fe2c7a96354da7c6fe699537a05`。
已逐字节核对包内 collector 构建产物与两个插件同本次验证使用的文件一致。
