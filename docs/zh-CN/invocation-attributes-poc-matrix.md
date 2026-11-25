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
| Claude Code | `claude-code-log` | Hook 读取原生 transcript，当前回合键由会话和轮次构造。CLI 新启用 env；热 SDK 需把调用和原生消息边界桥接，不让客户猜轮次 | 有 | 夹具 |
| Codex | `codex-transcript` | App Server 返回 thread 和 turn；登记后按候选规范键绑定。向 active turn steer 不是新的原生 turn | 有 | 实测 App Server |
| Copilot CLI（`copilot`） | `copilot-log` | 原生会话事件给采集侧回合身份，尚未核定所用外部调用入口是否在派发时暴露同一键 | 未列 | 夹具 |
| Cursor IDE | `cursor-hook` | Hook 的 conversation/generation；只有 session 的回退记录不关联。桌面纯被动场景不能由外部请求附加 | 未列 | 夹具 |
| Cursor CLI | `cursor-hook` | 同一 Hook/Input 的 CLI 变体，可用真实 generation；验证了原生形状，不等于 CLI API 会将其交给调用方 | 未列 | 夹具 |
| 豆包 | `doubao` | 被动日志中的 conversation/chat session。只验证可确认的客户端请求；未找到外部调用方传任意属性的原生接口 | 未列 | 夹具 |
| 豆包 Work | `doubao-work` | 同类被动观测，独立 Input、原生观测身份。不从本地工具或模型轨迹倒推调用方身份 | 未列 | 夹具 |
| DeepSeek Harness（`dsh`） | `dsh-log` | 原生会话和 turn 序号组合。若调用侧没有同一原生 turn，需 Hook/启动入口桥接 | 未列 | 夹具 |
| Grok Build | `grok-build-log` | 有原生 prompt ID 才可复核回合；不能把只有 session 的回退记录拿来登记 | 未列 | 夹具 |
| Hermes Agent（`hermes`） | `hermes-agent-log` | `pre_llm_call` 提供 native session/turn；自有 Python caller 用请求局部状态交给 Hook。不能把 Hook 返回的 model context 当属性 | 仅标准用户身份例外 | 原生宿主 / 模拟模型 |
| Kiro CLI | `kiro-cli-log` | 原生会话/SQLite transcript 与 Stop Hook 推导回合。外部调用方若没有对应键，需桥接；不假定另外的会话回放路径也可按次绑定 | 未列 | 夹具 |
| MiMo Code | `mimo-code-log` | Plugin 记录 session/turn 序列；业务调用方需在 lifecycle 共享同一轮边界，不凭计数猜 | 未列 | 夹具 |
| OpenClaw | `openclaw-plugin-log` | 已验证的 `agent` RPC：sessionId + idempotencyKey 对应 native runId，可发起前登记 | 有 | 实测 Gateway |
| OpenCode | `opencode-log` | Plugin 回合键含原生 session 及内部 turn/Trace 标识；需要可观察的 message lifecycle 桥接，`opencode.message.id` 本身不是业务属性容器 | 有 | 夹具 |
| Pi Coding Agent | `pi-coding-agent-log` | Extension 在回合生命周期分配 ID；自有 Extension/调用侧要复用同一身份，而非另造 ID | 未列 | 夹具 |
| Qoder IDE | `qoder-trace` | 原生 transcript/Hook 可观察回合；仅在调用侧确实持有相同原生 user UUID 时能复用消息选择器。不能给普通 GUI 用户假设 SDK 入口 | Qoder 普通透传 | 夹具 |
| Qoder CN | `qoder-cn-trace` | 同一类 transcript UUID 或已证实的会话回合。用实际事件变体登记，不能套用 Global SDK 的 agent 参数 | 有 | 夹具；内部候选另行证实 |
| Qoder JetBrains（`qoder-idea`） | `qoder-trace` | 仅发现定义，复用 Qoder 采集；同文本不等同同调用 | Qoder 普通透传不是该入口实测 | 夹具 |
| Qoder Work | `qoder-work-trace` | Hook/原生会话回合可供采集，不代表办公端暴露任意逐次写入入口 | 未列 | 夹具 |
| Qoder Work CN | `qoder-work-cn-trace` | 同上，独立 CN 变体 | 未列 | 夹具 |
| Qwen Code CLI | `qwen-code-cli-log` | transcript user prompt 与当前轮；新进程 env 可用。热调用需 lifecycle 同一原生轮桥接，不能把 QwenPaw 的请求字段套在这里 | 有 | 夹具 |
| 千问办公（`qwen-work-cn`） | `qwen-work-cn-trace` | 原生 Hook/SQLite 工作回合；无外部可控键时只做采集。协作观察不等同客户端请求 | 未列 | 夹具 |
| Trae CN | `trae-cn-log` | Hub 解析得到的会话回合；还没有客户调用方持有同一原生键的证据 | 未列 | 夹具 |
| WorkBuddy | `workbuddy` | transcript 的真实 user record ID 优先；内部生成的回退键不是外部接口 | 未列 | 夹具 |
| Qoder CLI/SDK（`qoder-cli`） | `qoder-trace` | `SDKUserMessage.uuid` → transcript user.uuid → 公共消息选择器 | 有 | 实测 SDK |
| Qoder App（`qoder-app`） | `qoder-trace` | App transcript 区分产品，原生键可供采集。普通桌面 UI 未验证逐次业务参数入口 | Qoder 普通透传不是该入口实测 | 夹具 |
| Wukong | `wukong` | CLI API/消息解析得请求回合；未验证外部调用方在派发时可取得同一键 | 未列 | 夹具 |

AgentCore 的 **QwenPaw** 是另一条内部入口，不在上述开源矩阵。已有内部版本在原生请求的 `request_context.pilot.span_attributes` 保存本次属性，复用相同校验和事件投影，不需要另走 SQLite 登记。**可复用的公共部分是“按次快照 → 事件 → Span”，而不是强制每种宿主包装成同一种原生 API。**
