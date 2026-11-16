# 上游应用 → Agent / Pilot：W3C 上下文入站

本文仅实现入站关联：上游 Span → Pilot ENTRY → AGENT → STEP → LLM / TOOL。不修改 Agent 发出的 HTTP/MCP 请求，不依赖 `propagateToTools`。Pilot 是旁路重建器，不会给 Agent 安装一个全局 OTel active context。

## 已有能力与补齐

[Claude Code 下游传播](claude-code-downstream-trace-propagation.md)主要处理 Claude → Bash/模型网关，但已有上游 `TRACEPARENT` 环境桥接。共享 Hook helper 保存 session 记录，通用 collector 绑定首轮。旧版只保留 Trace ID / Parent Span ID；本次补齐 W3C sampling flags 和 `tracestate`，新增无需输入文本的原生逐轮绑定。

开启既有开关并配置 OTLP 输出：

```json
{ "upstreamLink": { "enabled": true } }
```

## 新建子进程：环境桥接

Java/Python 探针用现有 OTel propagator 将当前 Context inject 到 carrier，再将 `traceparent` / `tracestate` 映射到子进程环境 `TRACEPARENT` / `TRACESTATE`。每次调用构建自己的 env 副本，不修改宿主全局环境：

```python
import os
import subprocess
from opentelemetry.propagate import inject

carrier = {}
inject(carrier)
child_env = dict(os.environ)
child_env.pop("TRACEPARENT", None)
child_env.pop("TRACESTATE", None)
for field in ("traceparent", "tracestate"):
    if field in carrier:
        child_env[field.upper()] = carrier[field]
subprocess.run(["claude", "-p", "介绍项目结构"], env=child_env, check=True)
```

Claude Pilot 在 `UserPromptSubmit` 提前保存环境上下文，Stop 保留兼容兜底；没有 Bash 调用也可关联。升级后确认 Claude 加载新 Hook。Codex、Qoder、Qwen Code 继续通过既有共享 helper 读取 env；其他框架需适配其生命周期入口。

**静态 env 只绑定首次采集的有输入轮次，不适用于共享长驻会话逐轮请求。** 恢复旧会话或历史积压时，不应将新请求的 env 当作既有首轮上下文，使用显式逐轮方式。

## SDK / Plugin：原生逐轮绑定

通用 API 在安装包 `assets/hooks/shared/upstream-ingress.mjs`（部署后也在数据目录 `hooks/shared/`）。请求派发前捕获 carrier，在能够取得原生 session/turn ID 的回调中调用：

```js
import { propagation } from '@opentelemetry/api';
import { bindUpstreamTurn } from './assets/hooks/shared/upstream-ingress.mjs';

const carrier = {};
propagation.inject(carrier);
const bindRequest = input => {
  const result = bindUpstreamTurn({
    agentId: 'claude-code', sessionId: input.session_id,
    nativeTurnId: input.prompt_id, carrier,
  });
  if (!result.recorded) console.warn('Pilot ingress skipped:', result.reason);
  return {};
};
```

Claude Agent SDK 的 `options.hooks.UserPromptSubmit` 可注册这个回调，签名按所用版本适配。SDK callback 在调用方进程执行，carrier 可经闭包携带；命令 Hook 的 JSON 不会凭空包含 OTel Context。`prompt_id` 必须由实际版本提供；缺失返回 `invalid`，不能用业务 ID 或 prompt 文本伪造。

Java/Python 无需实现文件格式，可调用 `node assets/hooks/shared/upstream-ingress-cli.mjs`，通过 stdin 发送同样的 JSON，检查 stdout `{ "recorded": true }` 或失败原因。CLI 退出码为 0 不代表已记录；输入上限 8 KiB，等待 stdin 上限 2 秒。调用方还需设 timeout，遥测失败不阻塞或重复执行业务。Python SDK 示例：

```python
import asyncio
import json
from opentelemetry.propagate import inject
from claude_agent_sdk import ClaudeAgentOptions, HookMatcher, query

async def invoke_agent(prompt, pilot_cli, pilot_data_dir):
    carrier = {}
    inject(carrier)

    async def bind_request(input_data, tool_use_id, context):
        process = None
        try:
            payload = {
                "agentId": "claude-code",
                "sessionId": input_data.get("session_id"),
                "nativeTurnId": input_data.get("prompt_id"),
                "carrier": carrier, "dataDir": pilot_data_dir,
            }
            process = await asyncio.create_subprocess_exec(
                "node", pilot_cli, stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            output, _ = await asyncio.wait_for(
                process.communicate(json.dumps(payload).encode()), timeout=3
            )
            if not json.loads(output).get("recorded"):
                print("Pilot ingress was not recorded")
        except Exception:
            if process is not None and process.returncode is None:
                process.kill()
                await process.wait()
        return {}

    options = ClaudeAgentOptions(
        hooks={"UserPromptSubmit": [HookMatcher(hooks=[bind_request])]},
        env={"LOONGSUITE_PILOT_DATA_DIR": pilot_data_dir},
    )
    async for message in query(prompt=prompt, options=options):
        yield message
```

每个请求独立捕获 carrier，回调只服务该请求；不要让自主启动的后续 turn 复用旧闭包。共享 client 同时执行多个请求时，调用方必须可靠映射对应 callback，不能选“最近请求”。

绑定按 **Agent ID + 原生 session ID + 原生 turn ID** 隔离，重复输入并发不依赖文本。同上下文重试幂等，不同上下文返回 `conflict`；不可覆盖既有记录。断点重放复用绑定，过期由既有 `upstreamLink.ttlMs` 清理。调用方和 collector 需要共享可读数据目录与同一用户权限。`dataDir` 默认取 `LOONGSUITE_PILOT_DATA_DIR` 或 `~/.loongsuite-pilot`。

## 框架薄适配契约

在首个输入边界前完成绑定，在本轮 `other` 输入事件输出 `agent.pilot.correlation.native_turn_id`，推荐所有本轮记录携带。值必须与 writer 的原生 turn ID 一致，不修改 `gen_ai.turn.id`。Claude 使用 transcript `promptId`（单轮缺失时用已有 Stop fallback）。其他框架能复用通用 API/collector，但本 PR 不代表已安装它们的 SDK 适配。

优先级：原生子 Agent/锁定上下文保留；否则原生 turn → ACP hash/prefix → 首轮 env → 本地上下文。缺少可靠原生 ID 可暂用[既有逐轮协议](upstream-trace-correlation.md)，但重复 prompt 并发仍有顺序歧义。绑定在数据发布前完成，不回写已导出的 Span。文件读写失败保持采集；精确记录读取有大小上限，不跟随符号链接。

转换器用官方 `W3CTraceContextPropagator.extract()` 恢复 remote Context，在创建 ENTRY 前传入 SDK，batch 和 streaming 均适用。默认 parent-based sampler 对 `00` 父请求不导出采样 Span，`01` 保留状态；显式 `OTEL_TRACES_SAMPLER` 仍服从 SDK 策略。无效 `tracestate` 按官方 parser 丢弃。关闭正文不影响关联，最终导出继续关闭消息内容。

## 三种上游调用场景的实际支持范围

以下边界按本 PR 和 2026-11-16 核对的公开 SDK/ACP 源码描述。公共转换器测试中的人工 `native_turn_id` 只能证明公共能力，不能证明对应框架已经接好原生适配。

| 调用场景 | 本 PR 的能力 | 客户需要做什么 |
| --- | --- | --- |
| Web 请求 → 新进程、新会话 CLI | Claude/Codex 已有 env 入口；仅该会话首次采集的输入轮次 | 在当前请求 Context 下 inject，以独立子进程 env 传入完整 W3C carrier；确保实际 CLI 加载 Pilot Hook |
| 官方 SDK → CLI | 取决于 SDK 的进程生命周期，不能按“底层是 CLI”统一承诺 | 新进程、新会话可以使用 SDK env；长驻或恢复会话需要请求级绑定/关联桥接 |
| 微服务 → ACP → Agent | 可复用关联存储和转换器；本 PR 没有 ACP 接收器 | 发送 `params._meta` carrier，接收端提取并在 Agent 所在机器绑定原生身份，再执行该轮请求 |

三种路径都必须开启 `upstreamLink.enabled`、配置 Pilot 输出，并确认接收/绑定端和 collector 使用同一数据目录。只在远程调用方写本地文件、只把 trace ID 放入 prompt、或只给已启动的进程修改环境，都不会完成关联。

### 1. Web 服务直接调用 CLI

HTTP 请求的 Java/Python server instrumentation 应先 extract 请求头并建立当前 server Context。在派发 CLI 时用 propagator inject；也可以在应用中创建包围 CLI 调用的 client/internal Span，再 inject 该 Span。不要仅把收到的原始请求头复制过去，否则可能跳过当前 Web server Span。

前面的 `subprocess.run` 示例适用于每次新建进程且新建原生会话。将命令换为 `codex exec` 时仍要检查该版本是否触发 Pilot 的 SessionStart/UserPromptSubmit Hook、是否保留可采集 transcript。环境传递由调用方补一层，不需要修改 Agent 二进制。

**新进程不等于新会话。** `codex exec resume`、Claude resume、长驻 CLI 服务等不能靠每次换 env 正确关联后续轮次。已有 session env 不会逐请求更新；应在派发前写[既有逐轮关联记录](upstream-trace-correlation.md)，或接入满足原生身份契约的精确绑定。

### 2. 官方 SDK

**Claude Agent SDK**：当前官方文档和 Python/TypeScript 实现有 active Context → subprocess env 的自动注入，显式 SDK env 可覆盖它。自动注入发生在子进程启动时，不是对长驻 client 每次 query 自动改 parent。Python env 合并继承环境，TypeScript 显式 env 替换继承环境，需保留 PATH/HOME/认证等原有变量。不同版本应核对实际行为。

新进程、新会话可以使用 env；复用会话时使用前面的请求级 `UserPromptSubmit` callback + `bindUpstreamTurn`，并确认实际 `prompt_id` 存在且与 transcript `promptId` 一致。共享 client 的 hooks 通常在连接时注册，不能把每请求创建的 closure 示例直接当成共享 client 适配；须明确维护请求到 callback 的映射，不能按“最近请求”猜测。Pilot Hook/transcript 采集仍需启用；SDK 原生 OTel 与 Pilot 重建不是同一条链路。核对的当前 SDK 中省略 setting sources 会加载默认来源，`[]` 会禁用文件 settings；不应为追踪而无条件启用不可信 project/local hooks。

**Codex TypeScript SDK 0.169.0**：`CodexOptions.env` 是 constructor 级配置，并替换环境继承；每次 `thread.run()` 启动 `codex exec`，复用 thread 时使用 `exec resume`。同一个 client 的 env 不会自动随当前 HTTP 请求更新。每请求构造 client 并传入独立 env 可解决传输，但 resume 后仍受 Pilot 首轮语义限制。

本 PR 的 Codex transcript producer 只有 `agent.codex.transcript_turn_id`，没有输出通用 `agent.pilot.correlation.native_turn_id`，所以**仅调用新 bind API 不会让当前 Codex 适配命中**。复用会话暂用已有 session + 输入 hash 协议，或后续补原生 turn alias 和能在发布前取得 turn ID 的调用侧桥接；业务 request ID 不能代替 native turn ID。

**Qoder TypeScript SDK 1.0.59**：公开包已改成默认 process-wide daemon，`query()` 不再每请求创建 CLI。`env` 是 daemon 配置；相同配置复用 daemon，不同配置被 `DaemonConfigurationConflictError` 拒绝。因此不能把每个 Web 请求的 `TRACEPARENT` 放进 `query.options.env` 当成通用方案，也不建议在共享 daemon 启动 env 中放入某个业务请求的 parent。

现阶段可在请求级 Hook/派发桥接中用真实原生 session ID 与原始输入 hash 写逐轮记录。同一 session 的重复输入并发有顺序歧义，需串行或补精确原生身份适配。本 PR 的 Qoder producer 同样没有通用 native alias，公开 `UserPromptSubmit` 类型也没有承诺 prompt/turn ID；不能照搬 Claude 的 `input.prompt_id` 示例。当前 Qoder checkpoint 只持久化 trace/parent IDs，已发布并锁定的工作恢复路径不保留完整 carrier，不能承诺所有 Qoder 委派/恢复路径保留采样位和 tracestate。这是待补的适配验收缺口。

### 3. ACP 调用

当前 [ACP extensibility](https://agentclientprotocol.com/protocol/extensibility) 已建议将 `_meta` 根层 `traceparent`、`tracestate`、`baggage` 留给 W3C Context；以下字段有规范参考，不需把 trace 信息混入模型正文：

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "session/prompt",
  "params": {
    "sessionId": "native-session",
    "prompt": [{ "type": "text", "text": "请介绍项目结构" }],
    "_meta": {
      "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "tracestate": "vendor=value"
    }
  }
}
```

协议允许携带不等于适配器自动消费。核对的 `claude-agent-acp` 和 `codex-acp` 请求处理没有 W3C `_meta` → Pilot 的桥接：前者维护 SDK query/输入队列，后者使用长驻 Codex app-server；都不适合只靠进程 env 做逐轮传播。

客户 ACP client 应从当前 Context inject 到每次 `session/prompt` 的 `params._meta`；Agent 端 ACP adapter/gateway 需在派发前读取它，并完成以下桥接之一：

1. 有可靠原生 session/turn ID 和已接好 alias 的框架，调用 `bindUpstreamTurn`；Claude 可在对应 SDK callback 中绑定。
2. 尚无精确身份适配时，使用原生 session ID + 与 Pilot 输入一致的文本 hash 写既有逐轮记录；重复输入并发、附件展开/提示改写须单独处理，不能宣称任意 ACP 内容都已支持。

ACP JSON-RPC `id`、业务会话 ID、客户端消息 ID不自动等于 Agent 原生 turn ID。即使 ACP `session/new` 的 ID 在某适配器中与原生 session 一致，也需对照 Pilot 事件确认。跨主机部署在接收 Agent 的一端写记录；HTTP 入口头需由 gateway extract/重注入，stdio 上没有 HTTP header，使用 JSON-RPC `_meta`。

### 本次证据与未覆盖项

使用已发布 Codex/Qoder SDK 配合替身 CLI 核对实际子进程 env、resume 参数及 daemon 配置行为，没有调用模型。真实 Codex builder + linker 验证了首轮 env 成功、后续轮次不复用、显式 hash 文件桥接成功、未适配 native bind 和无接收器 `_meta` 不命中。真实 Qoder collector 合成 transcript 测试验证普通逐轮文件关联；prepareWork/decorate 的模拟锁定 checkpoint 恢复验证了完整 carrier 缺口。

这些是 SDK 传输与组件验证，**不是三个场景的原生 CLI/SDK/ACP 端到端验收**。当前 PR 是可复用入站基础与 Claude 薄适配，不是三种调用途径/所有框架零改造支持。

## 为什么不用只有 traceId

Java/Python 已能 inject 完整 `traceparent`，真实 Parent Span ID 就在其中，无需主动丢弃。只有 traceId 能并入同一查询集合，却无法说明调用关系和采样决策。本次只接受有效 W3C carrier，不伪造 parent；trace-ID-only links/root 降级如需支持应单独设计。

## 公开参考

- [W3C Trace Context](https://www.w3.org/TR/trace-context/)、[OTel Java](https://opentelemetry.io/docs/languages/java/api/#context-propagation)、[OTel Python](https://opentelemetry.io/docs/languages/python/propagation/)：inject/extract 模式，Context 本身不能跨进程共享。
- [Claude SDK telemetry](https://code.claude.com/docs/en/agent-sdk/observability) 与 [SDK Hooks](https://code.claude.com/docs/en/agent-sdk/hooks)：当前文档描述自动将 active Context 注入 CLI subprocess env，应用 callback 可携带请求闭包；具体支持随 SDK/CLI 版本变化。Claude 原生 telemetry 与 Pilot Hook 重建是独立链路，文档不能代替安装态验收。
- [Codex SDK](https://github.com/openai/codex/tree/main/sdk/typescript)、[Qoder SDK 1.0.59](https://www.npmjs.com/package/@qoder-ai/qoder-agent-sdk/v/1.0.59)、[ACP extensibility](https://agentclientprotocol.com/protocol/extensibility)、[Claude ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp)、[Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp)：SDK env 生命周期和 ACP 接收端桥接的参考，固定版本/提交证据见验收记录。

本次不新增出站注入、baggage、全局 active Context、MCP transport 或 Span ID 预留，留给下一阶段。
