# 给一次 Agent 调用加自定义 Span 属性

**业务属性（如 `memory.user_id`）写给 Pilot，不用加到 Agent 请求的 `meta` 里。** Agent 请求照常发，Pilot 从 Hook、插件或 transcript 读到同一个原生调用 ID，再把这一轮的属性加到 Span。不用修改 prompt 或配置 Span 前缀。A、B 共用一个会话也可以各带自己的值。

安装支持按次属性的 Pilot，启用对应 Agent 的采集和 [Trace 输出](./trace-output.md)。

## 长驻宿主接入

在 Pilot 配置里只保留你实际使用的采集源。Codex 的 `waitMs` 给回执后的绑定留时间，不让 Agent 等待。

```json
{
  "invocationAttributes": {
    "sources": {
      "openclaw-plugin-log": { "selector": "turn" },
      "qoder-trace": { "selector": "message" },
      "codex-transcript": { "selector": "turn", "waitMs": 1500 }
    }
  }
}
```

在调用端初始化一次登记接口。使用 Pilot 的 Node 运行时，并与采集器使用同一个本地数据目录（自定义目录时设置 `LOONGSUITE_PILOT_DATA_DIR`）。下方片段择一使用，复用已有的 Agent 客户端和会话。属性取自本次请求的可信业务上下文。

```js
import { randomUUID } from "node:crypto";
import { InvocationAttributeStore } from "/path/to/pilot/dist/invocation-attributes-api.js";

const store = new InvocationAttributeStore();
// 以下是本次调用的值；下一次调用可以不同。
const attributes = { "memory.user_id": "user-a", "memory.request_id": "req-42" };
```

### OpenClaw：`agent` RPC

以已验证的 2026.6.5 为例：先把属性登记到 **原生 `sessionId` + 本次 `runId`**，再把同一个 `runId` 作为 `idempotencyKey` 发给 Gateway。不要用 `sessionKey` 代替 `sessionId`。

```js
const runId = randomUUID();
store.register({
  agent: "openclaw", invocationId: runId, attributes,
  selector: { kind: "turn", sessionId, turnId: runId },
});
await gateway.request("agent", {
  sessionId, sessionKey, idempotencyKey: runId, message: prompt,
});
```

### Qoder CLI：通过 Qoder SDK 发送

先用新 UUID 登记，再把同一个值写到 **SDK 用户消息的 `uuid`**。其余 SDK 选项和流处理不变。

```js
const uuid = randomUUID();
store.register({
  agent: "qoder-cli", invocationId: uuid, attributes,
  selector: { kind: "message", messageId: uuid },
});
async function* input() {
  yield { type: "user", uuid, parent_tool_use_id: null,
          message: { role: "user", content: prompt } };
}
const stream = query({ prompt: input(), options });
```

### Codex：App Server

先保存属性；收到 **`turn/start` 回执里的 `turn.id`** 就绑定，不等整轮结束。这里的 `threadId` 来自 `thread/start` 或已有线程。

```js
const invocationId = randomUUID();
store.put({ agent: "codex", invocationId, attributes });
const { turn } = await rpc("turn/start", {
  threadId, input: [{ type: "text", text: prompt }],
});
store.bind({
  agent: "codex", invocationId,
  selector: { kind: "turn", sessionId: threadId, turnId: `${threadId}:${turn.id}` },
});
```

**其他语言**可将同样的参数以 JSON 传给 `"$PILOT_NODE" "$PILOT_INSTALL_DIR/dist/invocation-attributes.js" register < registration.json`；`put`、`bind` 同理。如果只用于观测，登记失败时记录诊断，仍按原流程调用 Agent。

## Claude Code / Qwen Code CLI：每次启动一个子进程

安装本版本的 `UserPromptSubmit` 和 `Stop` Hook。启动时给**这一个子进程**设置本次 ID 和属性，续聊仍可用 `--resume`，不要改常驻进程的 env。

```bash
LOONGSUITE_PILOT_INVOCATION_ID="$(uuidgen)" \
LOONGSUITE_PILOT_SPAN_ATTRIBUTES='memory.user_id=user-a,memory.request_id=req-42' \
  claude -p "请回复 OK"
```

Qwen Code CLI 把最后一行换为 `qwen "请回复 OK"`。下一轮使用新 ID；没属性时留空。长驻调用也可用 `attributes: {}` 明确不附属性。

**怎么确认：** 在同一个会话发两次相同的消息，分别登记 `user-a` 和 `user-b`，检查两轮 Span 的 `memory.user_id`。不要把逐轮变化的键也设成全局属性。普通桌面 UI 没有可用的回合 ID 入口时，继续使用已有的固定属性配置。

版本、其他入口和示例见 [各框架接入](./invocation-attributes-native.md)；字段限制见 [登记契约](./invocation-attributes-poc-matrix.md#登记配置与适配器契约)。
