# 按次自定义属性（候选 POC）

按次属性属于一次原生调用，不属于会话、Agent 进程或者 Trace ID。一个常驻宿主的不同请求可以用不同的属性。业务调用方在已验证的调用上下文中准备属性；适配器负责把它们和本次原生执行绑定；Collector 负责投影到事件，原有 `otlpTrace.spanAttributePassthroughPrefixes` 决定哪些业务字段进入 Span。

## 选哪条路

| 运行方式 | 如何传 | 什么时候需要框架适配 |
|---|---|---|
| 每次新建支持透传的 Agent 子进程 | 调用方在创建子进程时传自己的 `LOONGSUITE_PILOT_SPAN_ATTRIBUTES`；Hook/Plugin 写入事件 | 已支持的启动路径不需要新增适配。固定启动的桌面端可用作固定标签，不是逐次切换 |
| 长驻 Gateway / SDK，调用方和采集器都能拿到同一个调用 ID | 调用方把属性登记到 Pilot 本地，使用共享的原生消息 UUID 或原生回合身份绑定 | 如果当前 Input 已经保留相同的会话/回合键，只需要配置；如果 ID 不同或丢失，补一段从原生边界到公共键的桥接 |
| 受控原生请求明确允许传当次业务元数据 | 由调用入口筛选并保存这一次的属性，生成事件时交给公共校验/投影 | 需要对接官方支持的请求字段或生命周期回调，不假定每个 Agent 都有通用 `meta` 参数 |
| 被动采集桌面端，调用方拿不到稳定、唯一的调用身份 | 保留原采集和固定标签 | 不能证明某个外部请求对应哪条原生回合，不能按内容、顺序或时间猜测 |

这是本地旁路登记，不会把属性塞进 prompt、向模型厂商发送业务字段，或要求上游 Trace 串联。详见 [POC 入口矩阵](./invocation-attributes-poc-matrix.md)；其中夹具通过不等于实际宿主完成联调。

## 长驻宿主接入

Gateway 先从自己的已认证业务上下文取属性，比如 `{"memory.user_id":"tenant:A","memory.attempt":2}`。不要直接相信最终用户请求中可自填的身份。调用侧和 Collector 以同一受信任服务身份访问同一个本地目录。以下是候选构建的 Pilot 配置示例：

```json
{
  "invocationAttributes": {
    "root": "/path/to/pilot-private-invocations",
    "sources": {
      "qoder-trace": { "scope": "agent-gateway", "selector": "message", "attributePrefixes": ["memory."] },
      "codex-transcript": { "scope": "agent-gateway", "waitMs": 1500, "attributePrefixes": ["memory."] },
      "openclaw-plugin-log": { "scope": "agent-gateway", "attributePrefixes": ["memory."] }
    }
  },
  "otlpTrace": { "spanAttributePassthroughPrefixes": ["memory."] }
}
```

- `sources` 的键是 Pilot Input ID，不是客户 ID，也不一定与事件的 `gen_ai.agent.type` 相同。一个 source 只选一种选择器，默认用 `turn`。
- `scope` 是部署/隔离域，由可信调用侧和 Pilot 约定；默认 `default`。它与事件的 Agent 变体、选择器共同组成登记键。不能用业务用户 ID、Prompt 或 Trace ID 代替原生选择器。
- 设置 `attributePrefixes` 后，这些命名空间只认精确登记；找不到匹配或显式登记 `{}` 时，不继承旧的事件级属性。省略该选项则只填未占用字段。不要把同一个前缀同时配置成全局 Span 属性，否则全局补齐规则仍可能给 Span 填值。
- `waitMs` 默认 0，上限 5000。晚返回 ID 时可给首次遥测处理留短暂的绑定窗口；不会让模型/Agent 等待，但同一采集批次可能稍晚导出。无有效绑定时原遥测继续，超时封存的回合不补贴、不重传。
- 存储是本机 SQLite，需要支持 `node:sqlite` 的 Pilot Node 运行时。默认路径为 `<dataDir>/state/invocation-attributes`，可用 `LOONGSUITE_PILOT_ATTRIBUTION_ROOT` 或显式 `root`；Unix 下目录/文件只能由部署身份访问。未提供跨主机注册服务。

已经知道原生选择器时，调用前用 `register` 原子登记。下面以已验证版本的 OpenClaw `agent` RPC 为例，`turnId` 是本次 RPC 使用的 `idempotencyKey` 对应的实际 `runId`：

```sh
node /path/to/pilot/dist/invocation-attributes.js register --root /path/to/pilot-private-invocations <<'JSON'
{
  "scope": "agent-gateway",
  "agent": "openclaw",
  "invocationId": "gateway-request-A",
  "selector": { "kind": "turn", "sessionId": "native-session-A", "turnId": "native-run-A" },
  "attributes": { "memory.user_id": "tenant:A", "memory.attempt": 2 }
}
JSON
```

再发正常 RPC：`sessionId=native-session-A`、`idempotencyKey=native-run-A`。不要给 RPC 增加未声明的 `attributes` 参数。B 即使发送同样的文本，也用另一个原生回合 ID 和自己的属性。

- **Qoder SDK**：常驻 SDK 可以发送带客户预生成 UUID 的 user message。先用 `agent: "qoder-cli"` 和 `{ "kind": "message", "messageId": "<同一个 UUID>" }` 登记，再发消息。Pilot 从原生 transcript 的 user row 拿 UUID；业务方不用知道 Pilot 派生的回合 ID。内部 Runtime 的旧命令不是这个候选 CLI。
- **Codex App Server**：调用前使用 `put`（`scope/agent/invocationId/attributes`，不带选择器）；`turn/start` 确认后用同一 `invocationId`、`bind`，选择器为 `sessionId=thread.id`、`turnId=thread.id + ":" + turn.id`（候选当前的规范 ID）。向已有 turn steer 输入不产生可另外登记的新回合。
- **Hermes Python SDK**：`run_conversation` 没有通用属性参数。自有启动器可以用请求局部上下文保存本次属性，在原生 `pre_llm_call` 收到 `session_id/turn_id` 后登记，配置 `hermes-agent-log`、事件 Agent 为 `hermes`。没有自有调用入口或 Hook 桥接的远端 Gateway，不会自行传出业务属性。

JS 调用方也可以从构建产物 `dist/invocation-attributes-api.js` 导入 `InvocationAttributeStore`，使用相同的 `register/put/bind`。相同内容重试幂等，不同内容或将不同调用绑定到同一原生身份会报冲突。登记须在原生回合首批输出前有效；默认 TTL 48 小时，最长 7 天，过期登记和已决结果按有限恢复窗口保留。已知会话占位值及回退用的 `turnId == sessionId` 不视作独立回合。

### Hermes：在调用代码里怎么设置

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

## 直接携带属性的适配器

如果原生运行时明确在每次调用携带属性，而不是让 Collector 旁路关联，可复用 `assets/hooks/shared/invocation-attributes.mjs`：

1. 在真实原生调用开始时取得专属元数据，或者用可复核的原生消息 UUID 读取事先登记的快照。不能按 prompt、会话最近一轮、到达顺序或全局 env 匹配。
2. 在生命周期内为同一次调用保存独立快照。Node producer 可用 `parseInvocationAttributes()` 校验。在受控 producer → Input 的内部记录里使用 `INVOCATION_ATTRIBUTES_FIELD`（`pilot.invocation.attributes`）。
3. Canonical Input 显式设置 `preserveInvocationAttributes: true`，或取出载体、走现有原生归一化后调用 `projectInvocationAttributes(entry, snapshot)`。不要把整个载体、源请求或未经选择的 metadata 输出。投影不会覆盖已存在的原生字段。
4. 采用字符串、有限 number（整数不超过安全整数范围）、boolean；最多 32 项、16 KiB JSON，键最长 128 ASCII 字符，字符串最长 512 UTF-16 单元。非法/超限组不部分投影，`{}` 是明确没有本轮属性。保留、结构及常见敏感字段名不能用作自定义键。值使用业务选定的非敏感 ID，键名校验不代替应用权限或值脱敏。

这是生产者与 Collector 的公共契约，不是给所有原生 Agent 增加了新 RPC 参数。SDK、Hook 或 App 仍须有真实可观察的本次执行边界。可独立于上游 Trace 串联使用；本能力不创建、提取或改写父上下文。
