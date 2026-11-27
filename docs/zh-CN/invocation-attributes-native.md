# 按框架选择接入方式

[快速接入](./invocation-attributes.md) 有 OpenClaw、Qoder SDK、Codex App Server 和独立启动 Claude Code / Qwen Code CLI 的调用代码。长驻入口的属性都通过同一个 Pilot 登记接口写入，不要往 Agent 请求里追加业务 `meta`。下面是各框架在哪一步拿到可用的调用 ID。

## 参数速查

| 已验证入口 | 请求带什么 / 从哪拿 ID | Pilot Input / agent / 选择器 | 如何登记 |
| --- | --- | --- | --- |
| OpenClaw 2026.6.5 `agent` RPC | 传原生 `sessionId` 和 `idempotencyKey`（本次 run ID） | `openclaw-plugin-log` / `openclaw` / turn | 发送前 `register` |
| Qoder SDK 1.0.56 / worker 1.1.79-hotfix.19 | 传 SDK 用户消息的 `uuid` | `qoder-trace` / `qoder-cli` / message | 发送前 `register` |
| Codex App Server 0.169.0-alpha.11.1 | `turn/start` 回执返回原生 `turn.id` | `codex-transcript` / `codex` / turn | 先 `put`，收到回执立即按 `threadId:turn.id` 绑定。steer 不开新轮 |
| Claude Code 2.1.330 / Qwen Code CLI 0.28.4 | 每次新起子进程，设置本次调用 ID 和属性 env | 提交 Hook + Stop | Hook 按原生 prompt ID 记录，无需调用方 `register` |
| Hermes Python SDK 0.16.0 | 传 `task_id`；`pre_llm_call` 提供真实 session/turn | `hermes-agent-log` / `hermes` / turn | 示例插件在回调里登记 |
| DeepSeek Harness SDK 0.2.1rc2 | 从本次 SDK `run` 回调取 `session.event / turn/start` | `dsh-log` / `dsh` / turn | 先 `put`，再按回调里的回合绑定 |
| GitHub Copilot SDK 2.0.3 / CLI 1.0.116 | 传 `clientTurnId`；对应 `user.message` 回显它并给出 `interactionId` | `copilot-log` / `copilot` / turn | 先 `put`，再用 `interactionId` 绑定 |
| Pi Coding Agent SDK 0.73.1 | Pilot 扩展给 SDK 调用方 `onInvocationStart` 回调 | `pi-coding-agent-log` / `pi-coding-agent` / turn | 在回调里登记 |
| OpenCode 1.14.29 serve / V1 插件 | 传原生 `messageID`，响应的 `info.parentID` 回显该 ID | `opencode-log` / `opencode` / message | 发送前 `register` |
| MiMo Code 0.1.17 serve | 传原生 `messageID`，响应的 `info.parentID` 回显该 ID | `mimo-code-log` / `mimo-code` / message | 发送前 `register` |

## Pi：受控的 Node SDK 用户

在创建 Pi SDK 会话时，只加载一份 Pilot 扩展。使用 [Pi 接入示例](../examples/pi-invocation-attributes.mjs)，把 `bridge.extension` 传入该会话的 `DefaultResourceLoader({ extensionFactories: [...] })`。Pilot 扩展在 `before_agent_start` 分配本轮键后交给调用方，回调只做本地登记，不改变模型请求。普通 `pi` CLI 不会自动获得这个 SDK 调用方作用域。

```js
const bridge = createPiInvocationBridge({ createPiTelemetryExtension, store, scope });
// 初始化 SDK 时用 extensionFactories: [bridge.extension] 加载这份扩展。
await bridge.run({
  sessionId: sessionManager.getSessionId(),
  attributes: { "memory.user_id": "tenant:A", "memory.attempt": 1 },
}, () => session.prompt(prompt));
```

回调应同步、短小。Pilot 不等待调用方返回的 Promise，也不会因为登记失败重试 Agent 请求。不能把网络查询塞进这里。

## OpenCode：V1 插件 + 常驻 HTTP server

1. 按已验证版本为本次用户消息生成新的原生 `msg_…` ID；保持 OpenCode 的原生 ID 排序格式。不要用随机 UUID 或外部用户自选值替代它。
2. 调用 [OpenCode 接入示例](../examples/opencode-invocation-attributes.mjs)，用该 ID 登记；把正常请求正文原样发送到 **1.14.29 的** `POST /session/:id/message`，正文内仍叫 `messageID`。
3. 测试时核对返回的 `response.info.parentID === body.messageID`。Pilot V1 的 `chat.message` 用原生 `out.message.id` 取它；原有的 `opencode.message.id` 是 assistant 消息 ID，不能拿来登记。

```js
const body = { messageID, model, parts: [{ type: "text", text: prompt }] };
const { response, attributeStatus } = await withOpenCodeInvocation({
  store, scope, body, attributes: { "memory.user_id": "tenant:A" },
}, req => postJson(`/session/${sessionId}/message`, req));
```

配置 `sources["opencode-log"]` 使用 `selector: "message"`。V1 每个 session 仅支持串行消息；当前活动回合尚未释放时，不使用新消息进行按次关联。此桥接**不声明兼容 V2 插件或新版 HTTP API**。不同版本用目标宿主自己的协议和 ID 格式。

## MiMo Code：同一种 message 选择器，原生 ID 格式不同

启动原生 0.1.17 `mimo serve` 并启用 Pilot 插件。调用方生成该版本原生的 `msg_g…` 用户消息 ID 后，按 `agent: "mimo-code"`、`selector: {kind: "message", messageId: messageID}` 先登记。发送普通 `POST /session/:id/message`，请求体使用 `{messageID, model, parts}`，并验证 assistant 的 `info.parentID` 与发送的 ID 相等；不用新增业务属性入参。

插件将本次原生用户 ID 交给 `mimo-code-log`，Collector 用同一 message join。实测宿主会在 idle 之后重放旧 user update；活跃进程在最近保留的 session/用户消息 ID 窗口内按**原生 ID**去重，不靠文本。同会话新 ID 仍产生新回合。不是跨进程重启的全量去重保证。

## Hermes：Python SDK + 原生 hook

将 [示例插件](../examples/hermes-invocation-attributes) 放入 `$HERMES_HOME/plugins/hermes-invocation-attributes`，追加到 Hermes 配置的 `plugins.enabled`；同时保留 Pilot 的采集插件。在服务启动时把 `PILOT_INVOCATION_ATTRIBUTE_CLI` 指向本候选的 `dist/invocation-attributes.js`，用 `PILOT_INVOCATION_NODE` 指定 Pilot 的 Node 路径。示例默认使用 `agent-gateway` scope，可用 `PILOT_INVOCATION_SCOPE` 调整。若配置了专用登记根，调用端的 `LOONGSUITE_PILOT_ATTRIBUTION_ROOT` 要与 Collector 相同。

```python
from uuid import uuid4
from hermes_plugins.hermes_invocation_attributes import request_attributes

task_id = str(uuid4())
with request_attributes(session_id=agent.session_id, task_id=task_id,
                        attributes={"memory.user_id": "tenant:A"}):
    result = agent.run_conversation(prompt, task_id=task_id)
```

在实际运行 `run_conversation` 的 worker 内打开这个作用域。多个请求若使用线程池，不要指望父线程的 ContextVar 自动跨线程传播，也不要并发复用有可变会话状态的同一个 Agent 实例。这个示例只用 `task_id` 确认 Hook 归属；绑定的仍是真正的原生 session/turn。Hook 返回 `None`，不会把业务属性写进模型 prompt。这里是接入示例，不是 Hermes 或 Pilot 内置的通用请求参数。

补充实测：同一 Hermes 0.16.0 Python 宿主内，两个 session 的同文 A/B 并发，再在 A session 发空属性与换值轮。原生模型是 Model Studio `qwen-plus`，请求正文中没有任何测试属性；本地事件、OTLP 和 CMS 的属性一致。

## DeepSeek Harness：只响应自己的 run 通知

调用前用独立 invocation ID `put`。随后执行 `harness.run(prompt, session_id=sid, on_notification=on_notification)`。回调必须同时满足：

- 该通知来自**这次 SDK `run`** 的回执作用域，方法名 `session.event`，payload 的 `sessionId == sid`。
- `payload.event.type == "turn/start"` 且 `payload.event.data.turn` 是非负整数。
- 对第一次匹配的原生 turn 执行 `bind({kind: "turn", sessionId: sid, turnId: f"{sid}:{turn}"})`（同一轮重复通知不重新换属性）。

不同 SDK session 可并发；同 session 一次仅一个请求。如果 SDK 只给全局 broadcast 而没有本次请求的作用域，不能照抄“同 session 下第一个事件”的做法。

## Copilot：区分调用方的 clientTurnId 与真正的 interactionId

在长期 session 上**先**注册 `session.on("user.message", callback)`。调用前，以新的 `clientTurnId` 对本次属性进行 `put`，然后正常调 `session.sendAndWait({ prompt, clientTurnId }, timeoutMs)`。回调只处理匹配该次 `event.data.clientTurnId` 的事件，从 `event.data.interactionId` 获得原生身份，以 `session.sessionId` 和 `copilot:${session.sessionId}:${interactionId}` 做 `bind`。

不要直接把自造的 `clientTurnId` 当作 Pilot 的 turn ID，也不把会话 summary 归到某一次请求。已验证上述 SDK/CLI 一对版本的同会话连续调用；未把它外推到其它 SDK RPC 版本。

[开发与验证记录](./invocation-attributes-poc-matrix.md) 保留其他入口的验证边界，以及等待时间、命名空间和字段限制等配置细节。
