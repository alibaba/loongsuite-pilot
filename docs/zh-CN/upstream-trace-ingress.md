# 把 Web 请求和 Agent 执行串成一条 Trace

应用调用 Agent 时，把当前 OpenTelemetry Span 的 `traceparent` 和可选 `tracestate` 一起传过去。Agent 侧记录「这个会话的这一轮属于哪个上游 Span」。Pilot 收到该轮的真实执行数据后，用同一个 Trace ID 生成 ENTRY，并把 ENTRY 放到上游 Span 下面。

```text
Web 请求 Span
└── Pilot ENTRY
    └── AGENT
        └── STEP
            ├── LLM
            └── TOOL（该轮实际调用时）
```

`traceparent` 已含 Trace ID、上游 Span ID 和采样位。完整透传后可以在调用链上看出谁调用了谁。Hook 在 Agent 进程启动或接收 prompt 时拿到原生会话与轮次；它通过调用方明确传到边界的 carrier 取得上游信息。Pilot 在上报前完成父节点关联。

## 准备 Pilot

安装包含此改动的 Pilot，并确认 Agent 正常加载其 Hook、保留可采集的 transcript。在现有配置中启用 `upstreamLink.enabled`，并配置 OTLP 输出。Web 探针和 Pilot 需把数据送到同一套可查询的 Trace 后端。

```json
{
  "upstreamLink": { "enabled": true }
}
```

默认关联文件和 Hook 位于 `~/.loongsuite-pilot`。如果用自定义数据目录，把该路径通过 `LOONGSUITE_PILOT_DATA_DIR` 或绑定参数 `dataDir` 传到 Agent 端，并确保和 collector 配置一致。使用标准的 W3C propagator，把 Web 服务当前 Span 或包围 Agent 调用的 Span 放入 carrier。

| 调用方式 | 调用方传什么 | Agent 侧如何对应当前轮 |
| --- | --- | --- |
| Web → `codex exec` / `codex exec resume` | 子进程环境中的 `TRACEPARENT`、`TRACESTATE`、本次调用的 UUID | `UserPromptSubmit` Hook 用原生 session ID 和 turn ID 认领这次调用 |
| Web → Codex TypeScript SDK | 每次调用创建使用独立 env 的 SDK client | SDK 启动 Codex CLI，使用同一条 Hook 路径 |
| Web → Qoder Agent SDK | 先把 carrier 绑定到此次 SDK 用户消息 UUID，再发送同一 UUID | Qoder transcript 保留用户消息 UUID，Pilot 在收集该轮时匹配 |
| 微服务 → ACP → Codex | 每次 `session/prompt` 在 `params._meta` 带 W3C 字段 | 已接入 Pilot 的 ACP 服务从 Codex app-server 的 `turn/start` 响应取真实 turn ID |

## Web 服务启动一轮 Codex CLI

Python Web 服务在处理请求的函数里调用。Java 的做法相同，用 `W3CTraceContextPropagator` 向新建的 `ProcessBuilder.environment()` 注入当前 `Context`。每次调用生成新的请求 UUID，避免恢复同一会话时复用旧请求的父节点。

```python
import os
import subprocess
from uuid import uuid4
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

def run_codex(prompt, session_id=None):
    carrier = {}
    TraceContextTextMapPropagator().inject(carrier)
    env = {
        key: value for key, value in os.environ.items()
        if key.lower() not in ("traceparent", "tracestate", "loongsuite_pilot_ingress_request_id")
    }
    if "traceparent" in carrier:
        env.update({key.upper(): value for key, value in carrier.items()})
        env["LOONGSUITE_PILOT_INGRESS_REQUEST_ID"] = str(uuid4())
    command = ["codex", "exec", "--json"]
    if session_id:
        command.extend(["resume", session_id])
    return subprocess.run(command + [prompt], env=env, stdin=subprocess.DEVNULL,
                          capture_output=True, text=True, check=True, timeout=120)
```

这三个变量只适合每次启动一个子进程处理一轮外部请求的入口。单独设置 `TRACEPARENT` 保留旧版的会话首轮兼容行为。上述 UUID 只是告诉 Hook 这是哪次子进程调用，Hook 自己会读取真实的 turn ID。Codex 的 `--ephemeral` 会关闭可供 Pilot 读取的会话记录，请使用默认的会话持久化。

## 其他 Agent 的单轮本地调用

同一组子进程变量可用于以下入口。应用为每次调用启动一个子进程，Pilot 的 Hook 或插件把变量绑定到该轮。各 Agent 仍须正常加载对应的采集 Hook 或插件。

| Agent | 入口适配使用的轮次标识 |
| --- | --- |
| Cursor CLI | `beforeSubmitPrompt` 的 `generation_id` |
| Grok Build | `user_prompt_submit` 的 `prompt_id` |
| Claude Code | `UserPromptSubmit` 的 `prompt_id`，依赖 CLI 版本提供该字段 |
| Pi Coding Agent | 扩展在 `before_agent_start` 写入的轮次 ID |
| DeepSeek Harness | `turn/start` 的原生轮次号 |
| OpenClaw | 本地嵌入执行中的原生 `runId` |

常驻进程按每次请求调用 `bindUpstreamTurn`。绑定需要 Agent 侧的原生会话、轮次和本次 W3C 上下文。OpenClaw Gateway 入口可由调用方适配器用已知原生会话和 run ID 登记。环境变量入口用于实际执行 Agent 的新进程。

## Web 服务调用 SDK

**Codex SDK 0.169.0** 每次 `thread.run()` 启动一次 CLI，恢复会话时走 `exec resume`。按上例构造每次调用的 env，传给 `new Codex({ env })`，使用 `startThread()` 或 `resumeThread(sessionId)`。env 会替换继承环境，构造时保留子进程原本需要的 PATH、认证与配置。

**Qoder SDK 1.0.59** 可以在同一个 daemon 里跑多个请求。SDK 请求中的 UUID 与该请求 carrier 一起绑定，daemon 的 env 保持稳定。下面的 `carrier` 是 Web 服务本次调用时用 W3C propagator 注入得到的对象。

```js
import { randomUUID } from 'node:crypto';
import { query, qodercliAuth } from '@qoder-ai/qoder-agent-sdk';
import { bindUpstreamTurn } from '/path/to/pilot/hooks/shared/upstream-ingress.mjs';

export function runQoder(prompt, carrier, sessionId = randomUUID(), resume = false) {
  const uuid = randomUUID();
  bindUpstreamTurn({ agentId: 'qoder-cli', sessionId, nativeTurnId: uuid, carrier });
  async function* messages() {
    yield {
      type: 'user', uuid, session_id: sessionId, parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    };
  }
  return query({ prompt: messages(), options: {
    auth: qodercliAuth(),
    ...(resume ? { resume: sessionId } : { sessionId }),
  } });
}
```

上例沿用 CLI 登录。生产应用使用自己已配置的 SDK 认证，并保留 Pilot Stop Hook 所在的 settings 来源。将 Hook 装到项目级或通过 SDK 注册时，保证实际 Stop 回调能触发 Pilot 的 Qoder Hook。每次 `query` 继续按 SDK 契约消费结果。此入口以 Qoder CLI 1.1.81 的真实 transcript 为验证范围。

**Claude Agent SDK** 可以在每请求的 `UserPromptSubmit` 回调中调用 `bindUpstreamTurn({ agentId: 'claude-code', sessionId: input.session_id, nativeTurnId: input.prompt_id, carrier })`。这一方式依赖真实 Hook 的 `prompt_id` 与 transcript 对齐，并需要正常运行 Pilot 的采集 Hook。缺 ID 时按独立 Trace 上报。共享 client 应保留每次请求与回调的可靠映射。Claude 保留此接入契约，本次原生实测使用 Codex SDK 与 Qoder SDK。

Java/Python 可以执行 `node <Pilot 数据目录>/hooks/shared/upstream-ingress-cli.mjs`，从 stdin 传 JSON `{ agentId, sessionId, nativeTurnId, carrier }`。检查 stdout 的 `recorded` 字段，给子进程设超时。绑定失败时应用照常调用 Agent。

## 微服务通过 ACP 调用

调用方使用 ACP 1，在每次 prompt 上带当前调用的 carrier。用 `session/new` 返回的会话 ID 发起请求。

```js
await acp.prompt({
  sessionId,
  prompt: [{ type: 'text', text: prompt }],
  _meta: { ...carrier }, // W3C traceparent and optional tracestate
});
```

接收方需要部署带有入口适配的 Codex ACP。对此次验证的 Codex ACP 2.6.0，使用[适配补丁](../../examples/upstream-trace-ingress/codex-acp-2.6.0.patch)和下面的命令。目录和 Codex 可执行文件换成实际位置。

```sh
git clone https://github.com/agentclientprotocol/codex-acp.git
cd codex-acp
git checkout 656765115f82253c79f87918abb77189c114a799
git apply /path/to/loongsuite-pilot/examples/upstream-trace-ingress/codex-acp-2.6.0.patch
npm ci
npm run build
export LOONGSUITE_PILOT_DATA_DIR=/path/to/pilot-data
export LOONGSUITE_PILOT_INGRESS_MODULE="$LOONGSUITE_PILOT_DATA_DIR/hooks/shared/upstream-ingress.mjs"
export CODEX_PATH=/path/to/codex
node dist/index.js
```

接收端把 carrier 保存在这次调用的闭包中。Codex 返回真实 turn ID 后才写入绑定。采集器遇到明确的待绑定标记，最多会为该轮等待三次，每次默认 100 ms。标记只控制等待，不用于推断父节点。ACP 的 JSON-RPC 请求 ID 与原生 turn ID 是不同的字段。跨主机部署时，ACP 服务与 Pilot 在 Agent 侧共享关联目录。

## 验证步骤

1. 用已接入 OTel 的服务向同一 Agent 会话连续发送两次请求，可以使用相同文本。保持每次请求独立的 Web Span。
2. 分别拿到两次 Web 请求的 Trace ID，在后端打开完整调用链。确认两条链路的 Pilot ENTRY 都是对应 Web Span 的直接子节点。
3. 只有 Web Span 时，核对 Agent 是否执行了 Hook、collector 能否读到该轮 transcript，以及两端是否用了同一数据目录和同一个 OTLP 后端。Agent 另起 Trace 时，核对调用边界传入的 carrier、真实 session/turn 和采集前的绑定文件。采样位为 `00` 时，默认采样器可能不导出子 Span。

原生绑定以 Agent ID、原生 session ID、原生 turn ID 为键。相同绑定可重试，不同父节点会返回 `conflict`。过期文件由 Pilot 定期清理。缺失或非法上下文继续独立采集。此处的链路止于 Pilot 采集到的 Agent 执行。

参考：[W3C Trace Context](https://www.w3.org/TR/trace-context/)、[Python OTel 传播](https://opentelemetry.io/docs/languages/python/propagation/)、[Codex SDK](https://github.com/openai/codex/tree/main/sdk/typescript)、[ACP 扩展规范](https://agentclientprotocol.com/protocol/v1/extensibility)。
