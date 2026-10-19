# Hermes / OpenClaw 请求上下文写出验证（2026-10-19）

## Review 从这四处开始

PR 首个提交共 14 个文件：**4 个生产文件、7 个测试文件、3 个文档文件**。
生产变更约 200 行，其余主要是回归和说明。建议先按下表看生产代码，再看相应测试。

| 顺序 | 文件 | 改了什么 / Review 重点 |
|---|---|---|
| 1 | `assets/plugins/openclaw/plugin.mjs` | 每次模型调用分配一个 SpanID，存在该调用的状态里；请求、响应取同一个 ID。检查同一调用 ID 不变、不同调用 ID 不混用。 |
| 2 | `assets/plugins/hermes-agent/loongsuite-pilot/__init__.py` | 在 `pre_api_request` 写请求，完成后写响应/工具结果；结束时只补缺失事件。重点看 `_api_ids`、`_emit_request`、`_write_new_records`、`_flush_turn`：ID 稳定、没有未来响应字段、不会重复追加。 |
| 3 | `src/normalization/turn-boundary-processor.ts` | 收到一次模型的 stop/error 时，先不替整轮问答补结束标记；等待插件自己的结束记录。检查请求、响应、结束记录分不同批次时仍正确。 |
| 4 | `src/flushers/otlp-trace-flusher.ts` | 同样等待显式结束记录再拼完整 trace，避免重试、工具和同会话交错回合被提前截断。旧版插件继续使用旧规则。 |

一轮问答可能包含“模型调用 → 工具 → 再次模型调用”。因此需要同时区分**一次调用完成**
和**整轮问答结束**，后两个文件分别负责归一化边界和 trace 聚合，必须保持一致。

Hermes 文件较长还包含新版 TTFT 的两个适配、旧 hook 的内容补齐、sender 继承、写失败重试。
TTFT 可最后单独 review `_install_first_delta_observer` / `_stream_api_for_agent`：
保留原回调，使用明确身份匹配当前请求，存在歧义时不猜。

### 本地怎样测试

在仓库根目录、Node 22 环境中执行以下专项测试；无需模型密钥或 ARMS 凭证：

```sh
npm test -- \
  tests/unit/hooks/hermes-agent-realtime.test.mjs \
  tests/unit/hooks/hermes-agent-ttft.test.mjs \
  tests/unit/hooks/openclaw/plugin.test.mjs \
  tests/unit/normalization/turn-boundary-processor.test.ts \
  tests/unit/flushers/otlp-trace-flusher/turn-boundary.test.ts
```

验收看四件事：请求未完成时，另一个进程已读到当前请求的 ID；同一请求的响应 ID 不变；
同一轮第二次调用有自己的 ID；重试或回合结束后没有重复事件/重复结束标记。
这些专项还覆盖首请求没有旧文件、漏 hook、写失败、并发回合、TTFT 上下文丢失等情况。

真实测试再增加三步：运行真实 Agent 做文本和工具调用；在每次 HTTP 发送前独立读文件并
记录匹配的 traceparent；完成后按精确 TraceID 从 CMS 读回并对照 LLM/TOOL SpanID、token、TTFT。
“最终文件里有记录”只证明最终写出了；“上报返回成功”只证明请求被接收，均不能代替这三步。

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
| OpenClaw 2026.10.5 | 官方 npm `openclaw@2026.10.5`，显示 `1b58cb9` | 改名运行后，真实 Gateway RPC、文本/工具调用及云端读回通过 |

collector 和旧版 OpenClaw 使用 Pilot 管理的 Node `22.22.2`。OpenClaw 2026.10.5
要求 Node `>=24.16.0 <25 || >=26.1.0`，分别尝试本机 Node `26.12.0` 和另行下载的
`24.16.0`，均在插件运行前被终止；清理环境变量、关闭 compile cache 的尝试仍失败。
后按用户建议，对隔离测试副本改名：将同一份 Node 24.16.0 可执行文件复制为
`pilot-runtime`，逐字节 SHA256 相同；将测试副本 `dist/entry.js` 中唯一一处
`process.title = "openclaw"` 改为 `pilot-gateway-check`。保留官方入口文件、包名、
版本号和模型/工具逻辑。进程表确认显示名为 `pilot-gateway-check`，随后真实验收通过。
仅改名可执行文件时版本命令也已成功，说明先前失败与本机运行方式有关；没有足够证据
认定具体系统组件是原因。改名属于测试环境适配，不是 Pilot 产品修复，也不修改用户日常安装。
改名范围、原文件 hash 和版本命令结果记录在 `gateway-neutral/` 下。

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
| OpenClaw 2026.10.5（改名运行） | 2 | 3 | 3/3 | 3/3 | 3/3 | 2/2 |

新版 Hermes 的 TTFT 有两个适配点：lazy-forward facade 后的原生 streaming helper；
以及 bounded hook 在独立 `copy_context` 工作线程中执行，导致 hook 中设置的
`ContextVar` 不会返回调用线程。后者按原生 Agent 的 session + turn/task 精确匹配
唯一未完成请求；没有明确身份或存在歧义时不填 TTFT，不能取“最新请求”猜测。

发送前证据来自独立进程读取源 JSONL，并由测试消费端在真实 httpx / undici 发送边界
写入 `traceparent`。两个 Hermes 版本各 6 次、三个 OpenClaw 版本各 3 次，
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
- `cloud-verification-latest.json`、`strict-validation-latest.log`：改名运行最新版的补测。
- `outbound-verification.json`：逐请求发送前 header 与源 JSONL、CMS 的关联比对。
- `<runtime>/evidence/cloud-spans.json`：CMS 实际查询结果。
- `<runtime>/evidence/timing.jsonl`、`outbound-audit.jsonl`：源文件与发送边界证据。
- `full-tests-final.log`、`final-targeted-tests.log`、`typecheck-final.log`：自动化检查。
- 原始环境准备/TTFT 修复前的数据单独保留，未计入上表正式验收。

五个通过真实验收的运行目录均通过仓库严格 JSONL validator：无解析、必填字段、
模型/工具配对、重复 event ID 或回合边界错误。配置和凭证不提交到仓库。

严格校验曾在分批采集时发现响应和终止记录同时被标成 turn end：归一化层原有的
finish-reason 兜底抢先为 `stop` / `error` 补了结束边界。现已与 flusher 一起遵循
`realtime-v1` 显式结束协议，新增跨批次回归，并使用最终 collector 重新运行上表全部场景。
旧的本地证据保留在 `evidence-before-boundary-fix` 和 `logs.before-boundary-fix`，不计入上表。

最终 npm 包 SHA256：`dc6202dcc71b93ee4017c139f6e02dc0351e9fe2c7a96354da7c6fe699537a05`。
已逐字节核对包内 collector 构建产物与两个插件同本次验证使用的文件一致。
