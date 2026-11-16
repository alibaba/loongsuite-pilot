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

## 为什么不用只有 traceId

Java/Python 已能 inject 完整 `traceparent`，真实 Parent Span ID 就在其中，无需主动丢弃。只有 traceId 能并入同一查询集合，却无法说明调用关系和采样决策。本次只接受有效 W3C carrier，不伪造 parent；trace-ID-only links/root 降级如需支持应单独设计。

## 公开参考

- [W3C Trace Context](https://www.w3.org/TR/trace-context/)、[OTel Java](https://opentelemetry.io/docs/languages/java/api/#context-propagation)、[OTel Python](https://opentelemetry.io/docs/languages/python/propagation/)：inject/extract 模式，Context 本身不能跨进程共享。
- [Claude SDK telemetry](https://code.claude.com/docs/en/agent-sdk/observability) 与 [SDK Hooks](https://code.claude.com/docs/en/agent-sdk/hooks)：当前文档描述自动将 active Context 注入 CLI subprocess env，应用 callback 可携带请求闭包；具体支持随 SDK/CLI 版本变化。Claude 原生 telemetry 与 Pilot Hook 重建是独立链路，文档不能代替安装态验收。

本次不新增出站注入、baggage、全局 active Context、MCP transport 或 Span ID 预留，留给下一阶段。
