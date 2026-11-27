# 按次自定义属性：原生调用入口

**业务属性不用走 Agent 接口。需要逐入口确认的是：调用方与 Pilot 能否识别同一次执行。** 同一个框架可以有多个入口：可控 SDK、独立启动的 CLI、常驻 Gateway 和纯桌面 UI 的结论不一定相同。

1. **新建进程**：Claude Code、Qwen Code CLI 可通过子进程 env 传当次值，再在 `UserPromptSubmit` 按原生 `prompt_id` 登记。Stop 恢复时按每个原生回合查值，不把当前进程的 env 贴给历史回合。
2. **已知本次原生键**：先向 Pilot `register`，再用原生协议发请求。Agent 请求只带原生 ID。
3. **稍后才得到原生键**：调用前 `put`，收到本次调用所属的受理消息或生命周期事件后立即 `bind`。不能等最终输出再作无来源猜测。
4. **现有接口拿不到同一个键**：只补交出或保留该 ID 的薄桥接，再复用同一套登记、字段校验、隔离、脱敏与 Span 透传。
5. **只读取桌面日志**：事后可见 ID 不等于 GUI 支持按次传业务属性。外部调用侧没有可靠的同一调用身份时，不承诺逐次关联。

下文都使用[公共配置与登记接口](./invocation-attributes.md)，例子里 `store` 是同部署域的 `InvocationAttributeStore`，`attrs` 来自可信的业务请求上下文，`scope` 与对应 Input 配置相同。观测用途不需要 `TRACEPARENT`。复用 session 的下一轮无业务属性时，明确登记 `{}`；不同 session 可并发，不假设一个可变会话实例支持重叠执行。

## 原生热 SDK / Gateway

| 已验证入口 | 正常调用中的身份 | Pilot 选择器 | 需要的开发 |
| --- | --- | --- | --- |
| Qoder SDK 1.0.56 / worker 1.1.79-hotfix.19 | 用户消息的 `uuid` 由调用方预生成，与原生 transcript 一致 | `qoder-trace`、`qoder-cli`、message | 用现有 Qoder 桥接；不用附加参数 |
| Codex App Server 0.169.0-alpha.11.1 | `turn/start` 返回 `turn.id`，不是等 `turn/completed` | `codex-transcript`、`codex`、turn | 现有原生回合键即可 |
| OpenClaw 2026.6.5 `agent` RPC | `idempotencyKey` 对应 `runId`，和原生 session 一起关联 | `openclaw-plugin-log`、`openclaw`、turn | 现有原生回合键即可 |
| Hermes Python SDK 0.16.0 | `run_conversation(task_id=…)`；`pre_llm_call` 提供真实 session/turn | `hermes-agent-log`、`hermes`、turn | 调用方安装示例插件；不改 Input |
| DeepSeek Harness SDK 0.2.1rc2 | 只取 SDK 本次调用回执所辖的 `session.event / turn/start` | `dsh-log`、`dsh`、turn | 调用方实现绑定回调；不改 Input |
| GitHub Copilot SDK 2.0.3 / CLI 1.0.116 | `sendAndWait` 传 `clientTurnId`；`user.message` 回显它并提供 `interactionId` | `copilot-log`、`copilot`、turn | 调用方实现事件绑定；不改 Input |
| Pi Coding Agent SDK 0.73.1 | SDK 常驻宿主订阅 Pilot 扩展的 `onInvocationStart` | `pi-coding-agent-log`、`pi-coding-agent`、turn | **新增**扩展回调，只交出日志会使用的 ID |
| OpenCode 1.14.29 serve / V1 插件 | 调用方提供原生 `messageID`，响应的 `info.parentID` 回显该 ID | `opencode-log`、`opencode`、message | **新增** V1 插件→Input 的 user-message ID 保留 |
| MiMo Code 0.1.17 serve | 调用方提供原生 `messageID`，响应回显同一个 `info.parentID` | `mimo-code-log`、`mimo-code`、message | **新增** native user-message ID 保留，防止 idle 后的旧消息重放重复贴值 |

Qoder、Codex 和 OpenClaw 的完整参数见[原有接入步骤](./invocation-attributes.md#长驻宿主接入)。以下专门列出新验证的调用法。

## Claude Code / Qwen Code CLI：每次新建一个进程

启动器给本次子进程单独设置两项环境变量（不要改常驻 Worker 的 `process.env`）：

```text
LOONGSUITE_PILOT_INVOCATION_ID=<本次子进程的唯一 ID，例如随机 UUID>
LOONGSUITE_PILOT_SPAN_ATTRIBUTES=memory.user_id=tenant:A,audit.request_id=request-123
```

然后按正常方式调用 `claude -p …` 或 `qwen -p …`，可用各自的 `--resume` 继续已有会话。下一轮换用户时传新 ID 和新值；空轮也传新 ID，属性值留空。不要给同一常驻 CLI 进程重复发送 input 来逐轮切换 env。

- Claude Code **2.1.330**、Qwen Code **0.28.4** 的原生 `UserPromptSubmit.prompt_id` 与 transcript 的 `user.promptId` 能对上。Qwen 的登记只接受真正含 `submitted_prompt` 的提交，不在工具续跑时登记。
- 安装本版本提供的 `UserPromptSubmit`、`Stop` Hook（Claude 保留 `StopFailure`）。快照保存在 Pilot dataDir；应用/Pilot 重启后继续使用同一个 dataDir。普通桌面固定标签和不显式设置 `LOONGSUITE_PILOT_INVOCATION_ID` 的既有用法不变。
- 如果宿主没有稳定 ID、漏掉开始 Hook、ID 冲突或快照已过期，普通遥测仍继续，未绑定的轮次不附个人归属。不要把 `--resume` 的 session ID、prompt 文本或 Stop 进程 env 当作旧回合的属性。
- 同一个采集源的业务前缀只选一种入口；使用此 Hook 快照时不要再给该输入配置相同命名空间的 `invocationAttributes.sources`，也不要全局注入这个每次变化的字段。配置 `otlpTrace.spanAttributePassthroughPrefixes` 如 `["memory.", "audit."]`。

例如多个用户共用聊天房间和 Agent 会话：网关从已认证的当前消息取得用户，**不同发送者拆成不同执行轮**；A 的原生 prompt 查 A 的快照，B 的查 B 的。会话 ID 不按用户重写。属性只描述本轮发起人，不会将群聊历史隔离成个人记忆。

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

### MiMo Code：同一种 message 选择器，原生 ID 格式不同

启动原生 0.1.17 `mimo serve` 并启用 Pilot 插件。调用方生成该版本原生的 `msg_g…` 用户消息 ID 后，按 `agent: "mimo-code"`、`selector: {kind: "message", messageId: messageID}` 先登记。发送普通 `POST /session/:id/message`，请求体使用 `{messageID, model, parts}`，并验证 assistant 的 `info.parentID` 与发送的 ID 相等；不用新增业务属性入参。

插件将本次原生用户 ID 交给 `mimo-code-log`，Collector 用同一 message join。实测宿主会在 idle 之后重放旧 user update；活跃进程在最近保留的 session/用户消息 ID 窗口内按**原生 ID**去重，不靠文本。同会话新 ID 仍产生新回合。不是跨进程重启的全量去重保证。

### Hermes：Python SDK + 原生 hook

参考 [Hermes 示例与初始化](./invocation-attributes.md#hermes在调用代码里怎么设置)。给每次 `run_conversation` 使用自己的任务 ID，把 scope 设在执行该调用的 worker 内。示例插件在 `pre_llm_call` 通过 session、task 双重核对并登记真实 turn；Hook 返回 `None`，不会把值注入模型。

补充实测：同一 Hermes 0.16.0 Python 宿主内，两个 session 的同文 A/B 并发，再在 A session 发空属性与换值轮。原生模型是 Model Studio `qwen-plus`，请求正文中没有任何测试属性；本地事件、OTLP 和 CMS 的属性一致。

### DeepSeek Harness：只响应自己的 run 通知

调用前用独立 invocation ID `put`。随后执行 `harness.run(prompt, session_id=sid, on_notification=on_notification)`。回调必须同时满足：

- 该通知来自**这次 SDK `run`** 的回执作用域，方法名 `session.event`，payload 的 `sessionId == sid`。
- `payload.event.type == "turn/start"` 且 `payload.event.data.turn` 是非负整数。
- 对第一次匹配的原生 turn 执行 `bind({kind: "turn", sessionId: sid, turnId: f"{sid}:{turn}"})`（同一轮重复通知不重新换属性）。

不同 SDK session 可并发；同 session 一次仅一个请求。如果 SDK 只给全局 broadcast 而没有本次请求的作用域，不能照抄“同 session 下第一个事件”的做法。

### Copilot：区分调用方的 clientTurnId 与真正的 interactionId

在长期 session 上**先**注册 `session.on("user.message", callback)`。调用前，以新的 `clientTurnId` 对本次属性进行 `put`，然后正常调 `session.sendAndWait({ prompt, clientTurnId }, timeoutMs)`。回调只处理匹配该次 `event.data.clientTurnId` 的事件，从 `event.data.interactionId` 获得原生身份，以 `session.sessionId` 和 `copilot:${session.sessionId}:${interactionId}` 做 `bind`。

不要直接把自造的 `clientTurnId` 当作 Pilot 的 turn ID，也不把会话 summary 归到某一次请求。已验证上述 SDK/CLI 一对版本的同会话连续调用；未把它外推到其它 SDK RPC 版本。

## 独立进程的 Claude Code 与 Qwen Code CLI

Claude Code 2.0.76 用 `claude -p … --settings <本次设置> --setting-sources project --session-id <UUID>`，Qwen Code CLI 0.28.4 用独立 `QWEN_HOME` 与 `qwen -p … --auth-type openai --output-format stream-json`。为各自子进程设置 `LOONGSUITE_PILOT_SPAN_ATTRIBUTES="memory.user_id=tenant:A"`，预置已支持的 Pilot Stop Hook。空值对照**从新进程的 env 删除该变量**。两条都实际用 Model Studio 做了同文 A/B 与空值对照，不用新增产品桥接。这是独立启动证据，不是 SDK 热进程逐轮换 env 的证据。

## Antigravity CLI：原生流和已持久化的回合

固定 AGY 1.5.14，以 `--input-format stream-json --output-format stream-json` 启动原生常驻 CLI。同一 session 只提交一个在途用户请求，记录该次输出中的 `step_update(user_input).step_index`。等待同一原生 session 里对应的 SQLite `steps.idx` 有唯一、已确定的回合 UUID 后，用 Pilot 的规范键 `<sessionId>:<turnUUID>` 绑定。不是按文本查找，不读“文件最后一条”。这是可控 launcher 的版本特定示例，原生私有 SQLite 的布局不应视作公开 API。

已跑同一 CLI、同一 session 4 次同文不同值与空属性；源端和本地 OTLP 完全匹配。该版本验证使用本地模拟的 Gemini 响应，**没有验证真实云模型或 Antigravity IDE**。

## Grok Build：身份已证实，实时采集仍待验

Grok CLI 1.0.92 的真实无头调用返回本次 `requestId`，和同一 session 的 `updates.jsonl` 中唯一已完成的 `promptId` 相等。本轮 4 次均匹配。使用这些真实记录离线重放原 Hook processor 后，按 `sessionId + requestId` 关联，属性与 16 个本地 OTLP Span 对齐。**这不是实时 Hook 的闭环**：不要在未验证事件交付时序前默认“等模型回复完再 bind”必然赶得上；若能收到本次的原生受理事件，应在该边界绑定。

## 29 个入口的本轮验证边界

“实测属性”需同时具备正常的原生调用、可复核的本次身份及事件/Span 属性。历史通过、真实调用本身、模拟模型和事后回放按不同证据记录。

| 入口 | 本轮结论 | 传入或关联点 |
| --- | --- | --- |
| Antigravity IDE | 本机没有可用宿主；未实测 | 已知采集侧可读原生记录，未证实外部调用入口 |
| Antigravity CLI | 原生常驻 CLI + 模拟模型，4 次属性匹配 | native user step index → 唯一 SQLite turn UUID → 公共登记 |
| Claude Code | 真实模型，独立进程 A/B/空属性匹配 | 已有进程 env + Stop Hook；未测其长驻 SDK |
| Codex | 复核前一批真实 App Server 与 CMS 证据 | `turn/start` 的 thread/turn，晚绑定；不把 steer 当新回合 |
| Copilot CLI / SDK | 真实模型，同 SDK session A/B/空属性匹配 | SDK `user.message` 的 `clientTurnId` 与 `interactionId` |
| Cursor IDE | 当前账号配额门禁；未见成功回合 | 原生 Hook 可观测 generation，未证实逐次属性入口 |
| Cursor CLI | 原生进程回调已见，真实模型配额门禁；无属性 Span | generation ID 是候选，不拿 headless 启动 ID 代替 |
| 豆包 App | 工作模式 2 轮真实完成；属性仅确切 ID 离线回放 | 私有日志 `conversation_id` 和 `chat_session_id`，未证实外部 caller 同时持有 |
| 豆包 Work | 工作模式 2 轮真实完成；属性仅确切 ID 离线回放 | 同类原生边界，仍是独立 Input；独立豆包 CLI 不是这条入口 |
| DeepSeek Harness | 同一 runtime 4 次真实模型，属性匹配 | SDK per-run notification 提供原生 turn |
| Grok Build | 4 次真实模型、日志身份及离线属性匹配；实时 Hook 未验 | JSON `requestId` = 原生完成 `promptId`，原 processor 重放已有键即可 |
| Hermes Agent | 真实 Python SDK + 云模型，候选属性匹配 | 自定义启动器 + 原生 `pre_llm_call`，已提供示例 |
| Kiro CLI | 已核对版本与认证检查，缺可用登录态 | Stop/SQLite 可观测不代表外部可传的回合 ID |
| MiMo Code | 原生热 server 真实模型，4 次属性匹配；新增回放去重 | `POST /session/:id/message` 的原生 ID、assistant `parentID` 和 Plugin 事件 |
| OpenClaw | 复核前一批原生 Gateway 与 CMS 证据 | `sessionId`、`idempotencyKey`，无需改 RPC |
| OpenCode | 原生 server 真实模型，新增 V1 桥接属性匹配 | caller 的 `messageID` 到 V1 Plugin 的 native user ID |
| Pi Coding Agent | 原生 SDK 真实模型，新增回调属性匹配 | 扩展把自己在日志使用的确切回合 ID 交给可信调用方 |
| Qoder IDE | 已发起真实输入，模型未完成并取消，不计通过 | 原生用户行已出现；IDE 普通 UI 未证实对外逐次入参 |
| Qoder CN | CN IDE、CN App 各 2 轮真实完成，属性仅离线回放 | 原生 user UUID 与 Pilot 派生 turn 不同；不套用 Global SDK |
| Qoder JetBrains | 本机没有可用宿主；仅代码/历史夹具 | 定义复用 Qoder 的采集，不证明 JetBrains 托管入口 |
| Qoder Work | 2 轮真实完成，属性仅离线回放 | 原生 `promptId` 与采集回合匹配，尚无外部 UI 传值入口 |
| Qoder Work CN | 未找到本机可用该产品 runtime | 不把 Work Global 或 CN App 等同 Work CN |
| Qwen Code CLI | 真实模型，独立进程 A/B/空属性匹配 | 已有进程 env + Stop Hook；不是 QwenPaw |
| 千问办公 | 2 轮真实完成，属性仅离线回放 | 原生 user UUID 与该版本采集回合一致；未证实外部 caller |
| Trae CN | 本机没有可用宿主；未实测 | Hub 原生日志中的回合不能当远端业务入口 |
| WorkBuddy | 登录门禁；未核对原生接口与本地消息的一致性 | [本机助理 API](https://open.workbuddy.cn/docs/openapi#发送消息给本地助理)返回 `data.message_id`，要先验证等于 transcript user `record.id` 才能开发接入 |
| Qoder CLI / SDK | 复核前一批 SDK 真机与 CMS 对账 | 新用户消息 UUID 部署时统一使用已有 message selector |
| Qoder App | Global 客户端提示用户数据版本较新，未发出测试 | 与 CN App 分开；普通 App 没有验证可控入口 |
| Wukong | 已检查 CLI，桌面服务未运行且无可用登录态 | 尚未拿到真实业务调用和原生请求身份 |

参见[源码及初始夹具矩阵](./invocation-attributes-poc-matrix.md)。不因 Collector 能回放便宣称外部接入可用。
