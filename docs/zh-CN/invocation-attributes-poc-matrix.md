# 按次属性 POC：需要适配的是调用身份

下面列的是开源候选覆盖的 26 个 Agent 定义和 3 个额外运行入口/变体。**公共关联不按框架分支**：只要 Input 在原有规范事件上保留了可复核的原生会话与回合身份，调用方就可以用同一接口登记。Qoder SDK 另用原生消息 UUID；其他来源不必仿造 UUID。是否能直接对接，取决于**真正发起调用的一方**能否同时持有本次业务属性和相同的原生键，不能以测试中可读到采集结果来证明客户接口已经就绪。

- **实测**：原生 Agent 热进程 + 原生 Input/Collector + 本地 OTLP/CMS 回读。
- **原生宿主 / 模拟模型**：真实 SDK 和 Hook 生命周期，模型请求走本地模拟 HTTP，核对公共关联和 Span，不计入真实模型或 CMS 结果。
- **夹具**：实际源解析或 Hook/Plugin→Input 验证原生形状；29 个入口另有公共事件→Span 的 A/B、同文、空属性及命名空间隔离测试。没有为每个入口启动原生客户端或调用模型。
- “启动 env”栏是 [主干文档列出的普通自定义属性来源](./trace-output.md#自定义-span-属性)，不是穷举实现，也不是长驻逐次支持。Hermes 的标准用户身份例外不等于任意键透传。

| 入口（事件 Agent 若不同） | Pilot Input | 可关联的身份与调用方边界 | 启动 env | 证据 |
|---|---|---|---|---|
| Antigravity IDE | `antigravity` | 原生日志/SQLite 的会话与用户回合；后台/补采回合不等同外部请求。未确认桌面外部调用参数 | 未列 | 夹具 |
| Antigravity CLI | `antigravity-cli` | 复用独立 CLI Input 的会话回合。需要发起方能复核原生回合，不能把 CLI 进程 PID 当回合 | 未列 | 夹具 |
| Claude Code | `claude-code-log` | 每轮新建进程：子进程 env → `UserPromptSubmit.prompt_id` → transcript 原生回合快照，可 `--resume`。热 SDK 发布者仍需提供可核对原生边界 | 有 | 真实 2.1.330；补采与续接 |
| Codex | `codex-transcript` | App Server 返回 thread 和 turn；登记后按候选规范键绑定。向 active turn steer 不是新的原生 turn | 有 | 实测 App Server |
| Copilot CLI（`copilot`） | `copilot-log` | SDK 自有调用方传 `clientTurnId`，从对应 `user.message` 事件拿 `interactionId` 绑定。普通桌面 UI 无此调用方回调 | 未列 | 原生 SDK 回调 |
| Cursor IDE | `cursor-hook` | Hook 的 conversation/generation；只有 session 的回退记录不关联。桌面纯被动场景不能由外部请求附加 | 未列 | 夹具 |
| Cursor CLI | `cursor-hook` | 同一 Hook/Input 的 CLI 变体，可用真实 generation；验证了原生形状，不等于 CLI API 会将其交给调用方 | 未列 | 夹具 |
| 豆包 | `doubao` | 被动日志中的 conversation/chat session。只验证可确认的客户端请求；未找到外部调用方传任意属性的原生接口 | 未列 | 夹具 |
| 豆包 Work | `doubao-work` | 同类被动观测，独立 Input、原生观测身份。不从本地工具或模型轨迹倒推调用方身份 | 未列 | 夹具 |
| DeepSeek Harness（`dsh`） | `dsh-log` | SDK 调用所辖的 `session.event / turn/start` 给出原生回合。不要从同 session 的其他调用取事件 | 未列 | 原生 SDK 回调 |
| Grok Build | `grok-build-log` | 有原生 prompt ID 才可复核回合；不能把只有 session 的回退记录拿来登记 | 未列 | 夹具 |
| Hermes Agent（`hermes`） | `hermes-agent-log` | `pre_llm_call` 提供 native session/turn；自有 Python caller 用请求局部状态交给 Hook。不能把 Hook 返回的 model context 当属性 | 仅标准用户身份例外 | 原生宿主 / 模拟模型 |
| Kiro CLI | `kiro-cli-log` | 原生会话/SQLite transcript 与 Stop Hook 推导回合。外部调用方若没有对应键，需桥接；不假定另外的会话回放路径也可按次绑定 | 未列 | 夹具 |
| MiMo Code | `mimo-code-log` | serve 发 `messageID`，原生响应 `info.parentID` 与插件的用户消息键对应，先登记后发送 | 未列 | 原生 serve；夹具补重放 |
| OpenClaw | `openclaw-plugin-log` | 已验证的 `agent` RPC：sessionId + idempotencyKey 对应 native runId，可发起前登记 | 有 | 实测 Gateway |
| OpenCode | `opencode-log` | serve + V1 插件：调用方用原生格式生成 `messageID`，响应回显 `info.parentID`，先登记后发送 | 有 | 原生 serve；V1 插件夹具 |
| Pi Coding Agent | `pi-coding-agent-log` | Pilot Extension 在 `before_agent_start` 将采集使用的回合 ID 交给自有 SDK 调用侧，调用侧在此登记 | 未列 | 原生 SDK 回调 |
| Qoder IDE | `qoder-trace` | 原生 transcript/Hook 可观察回合；仅在调用侧确实持有相同原生 user UUID 时能复用消息选择器。不能给普通 GUI 用户假设 SDK 入口 | Qoder 普通透传 | 夹具 |
| Qoder CN | `qoder-cn-trace` | 同一类 transcript UUID 或已证实的会话回合。用实际事件变体登记，不能套用 Global SDK 的 agent 参数 | 有 | 夹具；内部候选另行证实 |
| Qoder JetBrains（`qoder-idea`） | `qoder-trace` | 仅发现定义，复用 Qoder 采集；同文本不等同同调用 | Qoder 普通透传不是该入口实测 | 夹具 |
| Qoder Work | `qoder-work-trace` | Hook/原生会话回合可供采集，不代表办公端暴露任意逐次写入入口 | 未列 | 夹具 |
| Qoder Work CN | `qoder-work-cn-trace` | 同上，独立 CN 变体 | 未列 | 夹具 |
| Qwen Code CLI | `qwen-code-cli-log` | 每轮新建进程：子进程 env → `UserPromptSubmit.prompt_id` → transcript 原生回合快照，可 `--resume`。不使用其他框架的请求扩展字段 | 有 | 真实 0.28.4；补采与续接 |
| 千问办公（`qwen-work-cn`） | `qwen-work-cn-trace` | 原生 Hook/SQLite 工作回合；无外部可控键时只做采集。协作观察不等同客户端请求 | 未列 | 夹具 |
| Trae CN | `trae-cn-log` | Hub 解析得到的会话回合；还没有客户调用方持有同一原生键的证据 | 未列 | 夹具 |
| WorkBuddy | `workbuddy` | transcript 的真实 user record ID 优先；内部生成的回退键不是外部接口 | 未列 | 夹具 |
| Qoder CLI/SDK（`qoder-cli`） | `qoder-trace` | `SDKUserMessage.uuid` → transcript user.uuid → 公共消息选择器 | 有 | 实测 SDK |
| Qoder App（`qoder-app`） | `qoder-trace` | App transcript 区分产品，原生键可供采集。普通桌面 UI 未验证逐次业务参数入口 | Qoder 普通透传不是该入口实测 | 夹具 |
| Wukong | `wukong` | CLI API/消息解析得请求回合；未验证外部调用方在派发时可取得同一键 | 未列 | 夹具 |

AgentCore 的 **QwenPaw** 是另一条内部入口，不在上述开源矩阵。已有内部版本在原生请求的 `request_context.pilot.span_attributes` 保存本次属性，复用相同校验和事件投影，不需要另走 SQLite 登记。**可复用的公共部分是“按次快照 → 事件 → Span”，而不是强制每种宿主包装成同一种原生 API。**

## Claude Code / Qwen Code CLI：原生回合与恢复

启动器给本次子进程单独设置两项环境变量（不要改常驻 Worker 的 `process.env`）：

```text
LOONGSUITE_PILOT_INVOCATION_ID=<本次子进程的唯一 ID，例如随机 UUID>
LOONGSUITE_PILOT_SPAN_ATTRIBUTES=memory.user_id=tenant:A,audit.request_id=request-123
```

然后按正常方式调用 `claude -p …` 或 `qwen …`，可用各自的 `--resume` 继续已有会话。下一轮换用户时传新 ID 和新值；空轮也传新 ID，属性值留空。不要给同一常驻 CLI 进程重复发送 input 来逐轮切换 env。

- Claude Code **2.1.330**、Qwen Code **0.28.4** 的原生 `UserPromptSubmit.prompt_id` 与 transcript 的 `user.promptId` 能对上。Qwen 的登记只接受真正含 `submitted_prompt` 的提交，不在工具续跑时登记。
- 安装本版本提供的 `UserPromptSubmit`、`Stop` Hook（Claude 保留 `StopFailure`）。快照保存在 Pilot dataDir；应用/Pilot 重启后继续使用同一个 dataDir。普通桌面固定标签和不显式设置 `LOONGSUITE_PILOT_INVOCATION_ID` 的既有用法不变。
- 如果宿主没有稳定 ID、漏掉开始 Hook、ID 冲突或快照已过期，普通遥测仍继续，未绑定的轮次不附个人归属。不要把 `--resume` 的 session ID、prompt 文本或 Stop 进程 env 当作旧回合的属性。
- 同一个采集源的业务前缀只选一种入口；使用此 Hook 快照时不要再给该输入配置相同命名空间的 `invocationAttributes.sources`，也不要全局注入这个每次变化的字段。已校验的本轮属性不需要配置 Span 前缀。

例如多个用户共用聊天房间和 Agent 会话：网关从已认证的当前消息取得用户，**不同发送者拆成不同执行轮**；A 的原生 prompt 查 A 的快照，B 的查 B 的。会话 ID 不按用户重写。属性只描述本轮发起人，不会将群聊历史隔离成个人记忆。

### 独立进程 env 的早期实测

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

初始源码与夹具覆盖见本页第一张表。不因 Collector 能回放便宣称外部接入可用。

## 登记配置与适配器契约

- `sources` 的键是 Pilot Input ID，不是客户 ID，也不一定与事件的 `gen_ai.agent.type` 相同。一个 source 只选一种选择器，默认用 `turn`。
- `scope` 是部署/隔离域，由可信调用侧和 Pilot 约定；默认 `default`。它与事件的 Agent 变体、选择器共同组成登记键。不能用业务用户 ID、Prompt 或 Trace ID 代替原生选择器。
- 设置 `attributePrefixes` 后，这些命名空间只认精确登记；找不到匹配或显式登记 `{}` 时，不继承旧的事件级属性。省略该选项则只填未占用字段。不要把同一个前缀同时配置成全局 Span 属性，否则全局补齐规则仍可能给 Span 填值。
- `waitMs` 默认 0，上限 5000。晚返回 ID 时可给首次遥测处理留短暂的绑定窗口；不会让模型/Agent 等待，但同一采集批次可能稍晚导出。无有效绑定时原遥测继续，超时封存的回合不补贴、不重传。
- 存储是本机 SQLite，需要支持 `node:sqlite` 的 Pilot Node 运行时。默认路径为 `<dataDir>/state/invocation-attributes`，可用 `LOONGSUITE_PILOT_ATTRIBUTION_ROOT` 或显式 `root`；Unix 下目录/文件只能由部署身份访问。未提供跨主机注册服务。

JS 调用方也可以从构建产物 `dist/invocation-attributes-api.js` 导入 `InvocationAttributeStore`，使用相同的 `register/put/bind`。相同内容重试幂等，不同内容或将不同调用绑定到同一原生身份会报冲突。登记须在原生回合首批输出前有效；默认 TTL 48 小时，最长 7 天，过期登记和已决结果按有限恢复窗口保留。已知会话占位值及回退用的 `turnId == sessionId` 不视作独立回合。

如果原生运行时明确在每次调用携带属性，而不是让 Collector 旁路关联，可复用 `assets/hooks/shared/invocation-attributes.mjs`：

1. 在真实原生调用开始时取得专属元数据，或者用可复核的原生消息 UUID 读取事先登记的快照。不能按 prompt、会话最近一轮、到达顺序或全局 env 匹配。
2. 在生命周期内为同一次调用保存独立快照。Node producer 可用 `parseInvocationAttributes()` 校验。在受控 producer → Input 的内部记录里使用 `INVOCATION_ATTRIBUTES_FIELD`（`pilot.invocation.attributes`）。
3. Canonical Input 显式设置 `preserveInvocationAttributes: true`，或取出载体、走现有原生归一化后调用 `projectInvocationAttributes(entry, snapshot)`。不要把整个载体、源请求或未经选择的 metadata 输出。投影不会覆盖已存在的原生字段。
4. 采用字符串、有限 number（整数不超过安全整数范围）、boolean；最多 32 项、16 KiB JSON，键最长 128 ASCII 字符，字符串最长 512 UTF-16 单元。非法/超限组不部分投影，`{}` 是明确没有本轮属性。保留、结构及常见敏感字段名不能用作自定义键。值使用业务选定的非敏感 ID，键名校验不代替应用权限或值脱敏。

这是生产者与 Collector 的公共契约，不是给所有原生 Agent 增加了新 RPC 参数。SDK、Hook 或 App 仍须有真实可观察的本次执行边界。可独立于上游 Trace 串联使用；本能力不创建、提取或改写父上下文。
