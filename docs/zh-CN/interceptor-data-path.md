# Interceptor 架构与数据链路

本文描述 Pilot 本地拦截模块的运行架构、三个可拦截 hook 的数据链路，以及链路各阶段的字段格式。运维命令、规则开关与排障见 [本地拦截](interceptor.md)。

## 1. 架构

Interceptor 是与 collector / updater 同级的第三个常驻服务。采集 hook 与拦截 hook 互相独立：采集仍走 `qoder-loongsuite-pilot-hook.sh`，拦截走第二条 `interceptor-hook.sh`（`insert: "head"`，排在采集 hook 之前）。CLI **不会**自行拉起 daemon；runtime 缺失或连不上立即 fail-open。

### 1.1 进程与部署拓扑

```mermaid
flowchart TB
  subgraph host["Qoder 宿主"]
    QD["Qoder Desktop<br/>surface = qoder"]
    QC["Qoder CLI<br/>surface = qodercli"]
  end

  subgraph settings["~/.qoder/settings.json"]
    IH["hooks.UserPromptSubmit / PreToolUse / PostToolUse<br/>interceptor-hook.sh 插在队头"]
    CH["hooks.Stop<br/>采集 hook（独立）"]
  end

  subgraph hookproc["短命进程（每次 hook 一次）"]
    HS["interceptor-hook.sh / .ps1"]
    CLI["dist/interceptor/cli.cjs<br/>hook --agent qoder-auto"]
  end

  subgraph svc["同级常驻服务"]
    D["interceptor daemon<br/>127.0.0.1:18791"]
    C["collector"]
    U["updater"]
  end

  subgraph disk["~/.loongsuite-pilot"]
    RT["interceptor/runtime.json"]
    AL["interceptor/logs/access.log"]
    CFG["config.json<br/>interceptor 开关"]
  end

  QD --> IH
  QC --> IH
  IH -->|"stdin JSON 透传"| HS
  HS -->|"exec node cli.cjs"| CLI
  CLI -->|"读 runtime.json"| RT
  CLI -->|"GET /health + POST /v1/hooks/evaluate<br/>超时 4s"| D
  D -->|"启动时读一次"| CFG
  D --> AL
  CLI -.->|"fail-open 时写"| AL
  C --- U
```

平台侧守护与 collector 同一层级：macOS `com.loongsuite-pilot.interceptor`、Linux systemd `loongsuite-pilot-interceptor.service`、Windows `LoongsuitePilotInterceptor-<tag>`。

### 1.2 源码组件

```mermaid
flowchart LR
  subgraph cli["src/interceptor/cli"]
    H["hook.ts<br/>读 stdin / 写 stdout"]
    S["qoder-surface.ts<br/>qoder / qodercli"]
    A["adapters/qoder.ts<br/>parse + render"]
    DC["daemon-client.ts<br/>loopback HTTP"]
  end

  subgraph daemon["src/interceptor/daemon"]
    SV["server.ts<br/>/health /v1/hooks/evaluate"]
    E["rules/engine.ts<br/>顺序执行，首个 block 短路"]
    R["rules/registry.ts<br/>cloudAccessKey / apiKey /<br/>privateKey / databaseUrl"]
  end

  H --> S
  H --> A
  H --> DC
  DC -->|"HookRequest JSON"| SV
  SV --> E
  E --> R
  H -->|"block 时 renderQoderBlock"| HOST["宿主 stdout"]
```

| 路径 | 职责 |
|------|------|
| `assets/hooks/interceptor-hook.sh` / `.ps1` | 选 Node ≥ 18、定位 `cli.cjs`，`exec` 转交 stdin/argv；基础设施失败 `exit 0` |
| `src/interceptor/cli.ts` | CLI 入口：`hook` / `status` / `version` |
| `src/interceptor/cli/hook.ts` | 解析 stdin、探活 daemon、把判定写成宿主 JSON |
| `src/interceptor/adapters/qoder.ts` | snake_case stdin → `HookRequest`；`block` → 宿主 stdout |
| `src/interceptor/cli/qoder-surface.ts` | `--agent qoder-auto` 时用祖先进程链区分 Desktop / CLI |
| `src/interceptor/daemon.ts` | 单实例锁、绑 `127.0.0.1:18791`（占用则改绑 `0`）、写 runtime |
| `src/interceptor/rules/engine.ts` | 仅执行 `interceptor[rule.id] === true` 的规则 |

### 1.3 一次判定的公共时序

三个 hook 共用同一条管道，差别只在 stdin 字段、规则扫描的文本，以及 block 时写给宿主的 JSON。

```mermaid
sequenceDiagram
  autonumber
  participant Q as Qoder 宿主
  participant SH as interceptor-hook.sh/.ps1
  participant CLI as interceptor CLI
  participant RT as runtime.json
  participant D as interceptor daemon
  participant E as RuleEngine

  Q->>SH: 执行 hooks.json command<br/>stdin = 宿主 hook JSON
  Note over SH: 无 TTY / Node 可用 / cli.cjs 存在<br/>否则 exit 0（fail-open）
  SH->>CLI: exec node cli.cjs hook --agent qoder-auto
  CLI->>CLI: JSON.parse(stdin) → parseHookRequest
  CLI->>CLI: 解析 surface：qoder / qodercli
  CLI->>RT: 读 daemon_port / pid / version
  alt runtime 缺失或身份不一致
    CLI-->>Q: exit 0 + 空 stdout
  else 正常
    CLI->>D: GET /health（200ms）
    CLI->>D: POST /v1/hooks/evaluate（4s）
    D->>E: evaluate(HookRequest)
    E-->>D: EvaluateHookResponse
    D-->>CLI: action = allow / block
    alt action = block
      CLI-->>Q: exit 0 + 一行宿主 JSON
    else allow / 超时 / 坏响应
      CLI-->>Q: exit 0 + 空 stdout
    end
  end
```

fail-open 条件：stdin 非法、未知事件、未知 `--agent`、runtime 缺失、health 身份不匹配、daemon 超时/非 2xx/坏 JSON、规则抛错。一律 `exit 0` 且 stdout 为空。

超时预算：宿主 hook 超时 `UserPromptSubmit` 15s、`PreToolUse` / `PostToolUse` 10s；CLI 请求 daemon 固定 4s。

OpenClaw ≥ 2026.5.12 不经过 `interceptor-hook.sh`。采集插件在 `before_agent_run` / `before_tool_call` / `tool_result_persist` 上问同一 daemon；`--agent` 为 `openclaw`。runtime 缺失静默放行。block 时返回宿主对象而不是 stdout：`{ outcome:"block" }`、`{ block:true, blockReason }`、`{ message }`。3.8 legacy 不拦截。详见 [本地拦截 · OpenClaw 协议](interceptor.md#openclaw-协议)。

---

## 2. 三个 hook 的数据链路

部署声明在 `agents.d/qoder.json` 的 `hook.interceptor`：事件 `UserPromptSubmit`、`PreToolUse`、`PostToolUse`，matcher `*`，插入队头。

规则扫描文本由 `collectHookText()` 拼接：`prompt`、`toolName`、`toolInput` 叶子、`toolResponse` 叶子，用 `\n` 连接。当前四条敏感信息规则对三个事件都 `supports() === true`。

### 2.1 UserPromptSubmit — 提示词进模型前

```mermaid
flowchart LR
  A["用户提交 prompt"] --> B["宿主 stdin JSON<br/>hook_event_name + prompt"]
  B --> C["CLI → HookRequest<br/>event=UserPromptSubmit"]
  C --> D["daemon 扫 prompt 文本"]
  D -->|allow| E["空 stdout → 对话继续"]
  D -->|block| F["Desktop: decision=block<br/>CLI: decision=deny"]
  F --> G["本轮对话终止"]
```

拦截点在模型调用之前，能真正拦住本轮对话。

### 2.2 PreToolUse — 工具执行前

```mermaid
flowchart LR
  A["模型发出 tool_use"] --> B["宿主 stdin JSON<br/>tool_name + tool_input"]
  B --> C["CLI → HookRequest<br/>event=PreToolUse"]
  C --> D["daemon 扫 toolName + toolInput"]
  D -->|allow| E["空 stdout → 工具执行"]
  D -->|block| F["permissionDecision=deny"]
  F --> G["本次工具调用终止"]
```

Desktop 与 CLI 的 stdout 协议相同。拦住后工具不会执行。

### 2.3 PostToolUse — 工具已执行，替换回给模型的结果

```mermaid
flowchart LR
  A["工具已经跑完"] --> B["宿主 stdin JSON<br/>tool_name + tool_input<br/>+ tool_response"]
  B --> C["CLI → HookRequest<br/>event=PostToolUse"]
  C --> D["daemon 扫 toolName + toolInput + toolResponse"]
  D -->|allow| E["空 stdout → 原结果回模型"]
  D -->|block| F["updatedToolOutput = 包装后的 reason"]
  F --> G["模型看到替换文本<br/>已发生的副作用撤不回"]
```

`PostToolUse` 发生在副作用之后：Shell 已经跑完、文件已经写完。拦截信号是替换回给模型的工具结果，不是拒绝执行。Desktop 对 PostToolUse 的强制力弱于 CLI。

### 2.4 三条链路对照

| | UserPromptSubmit | PreToolUse | PostToolUse |
|--|--|--|--|
| 发生时机 | prompt 进模型前 | 工具执行前 | 工具执行后 |
| 宿主超时 | 15s | 10s | 10s |
| 主要扫描字段 | `prompt` | `toolName` + `toolInput` | 上列 + `toolResponse` |
| 能否拦住动作 | 能（终止本轮） | 能（不执行工具） | 不能拦住已执行；只能改回给模型的文本 |
| block stdout | `decision` + `reason` | `permissionDecision=deny` | `updatedToolOutput` |

---

## 3. 各阶段字段格式

字段在链路上会换一套命名：宿主 stdin 是 **snake_case**，给 daemon 的 `HookRequest` 是 **camelCase**，写回宿主的 stdout 又回到 Qoder hook 协议（Desktop / CLI 略有差异）。

```mermaid
flowchart TB
  S1["① 宿主 stdin<br/>snake_case JSON"]
  S2["② interceptor-hook<br/>字节透传，不改字段"]
  S3["③ HookRequest<br/>camelCase，给 daemon"]
  S4["④ EvaluateHookResponse<br/>daemon 返回判定"]
  S5["⑤ wrapHostReason<br/>把 rule reason 包成中文"]
  S6["⑥ 宿主 stdout<br/>一行 JSON + 换行"]

  S1 --> S2 --> S3 --> S4
  S4 -->|action=block| S5 --> S6
  S4 -->|action=allow 或 fail-open| EMPTY["stdout 为空"]
```

### 3.1 阶段①：宿主 stdin

Qoder 把一次 hook 的上下文以 **单个 JSON 对象** 写到 hook 进程的 stdin。CLI 要求：非空、能 `JSON.parse`、且是普通对象（不是数组）。事件名来自 `hook_event_name`，也接受 `--event` 覆盖；以下别名都会规范化成三个官方名：

| 规范名 | 接受的别名 |
|--------|------------|
| `UserPromptSubmit` | `user_prompt_submit`、`user-prompt-submit`、`userPromptSubmit` |
| `PreToolUse` | `pre_tool_use`、`pre-tool-use`、`preToolUse` |
| `PostToolUse` | `post_tool_use`、`post-tool-use`、`postToolUse` |

其它事件（如 `Stop`）解析失败，fail-open。

**UserPromptSubmit**

```json
{
  "hook_event_name": "UserPromptSubmit",
  "session_id": "s1",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/path/to/project",
  "prompt": "用户输入的提示词"
}
```

**PreToolUse**

```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "s1",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/path/to/project",
  "tool_name": "Bash",
  "tool_input": { "command": "export KEY=sk-..." },
  "tool_use_id": "call_abc"
}
```

**PostToolUse**

```json
{
  "hook_event_name": "PostToolUse",
  "session_id": "s1",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/path/to/project",
  "tool_name": "Read",
  "tool_input": { "file_path": "/tmp/config" },
  "tool_response": {
    "type": "text",
    "file": { "content": "mysql://user:pass@127.0.0.1:3306/db" }
  },
  "tool_use_id": "call_abc"
}
```

stdin 字段与解析规则（实现：`parseHookRequest`）：

| stdin 字段 | 类型 | 使用事件 | 解析规则 |
|------------|------|----------|----------|
| `hook_event_name` | string | 全部 | 规范化成三个官方名，否则丢弃 |
| `session_id` | string | 全部 | 非 string 则忽略 |
| `transcript_path` | string | 全部 | 非 string 则忽略 |
| `cwd` | string | 全部 | 非 string 则忽略 |
| `prompt` | string | 主要 UserPromptSubmit | 非 string 则忽略 |
| `tool_name` | string | Pre / Post | 非 string 则忽略 |
| `tool_input` | unknown | Pre / Post | **原样保留**，不校验结构 |
| `tool_response` | unknown | Post | 原样保留 |
| `tool_output` | unknown | Post | `tool_response` 缺失时的别名 |
| `tool_use_id` | string | Pre / Post | 优先 |
| `call_id` | string | Pre / Post | `tool_use_id` 缺失时的别名 |
| 其它任意字段 | — | — | 整包进入 `raw`，规则不直接读 |

`interceptor-hook.sh` / `.ps1` **不改 JSON**。shell 只负责选 Node、定位 `cli.cjs`，然后 `exec`；Windows 侧禁止把 stdout piped 到 `Out-Null`。

### 3.2 阶段③：给 interceptor daemon 的 `HookRequest`

CLI 解析 surface 后，把上面的对象编成 camelCase，作为 `POST http://127.0.0.1:<port>/v1/hooks/evaluate` 的 JSON body。`--agent qoder-auto` 时 surface 来自 `QODER_CONFIG_DIR` 或最多 12 层祖先进程：可执行名含 `qodercli` / `qoder-cli` → `qodercli`，含 `qoder`（且不是 qoderwork）→ `qoder`。

```ts
interface HookRequest {
  agent: 'qoder' | 'qodercli' | 'openclaw';
  event: 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse';
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  toolUseId?: string;
  prompt?: string;
  raw: Record<string, unknown>;   // 宿主 stdin 原对象
}
```

字段对照：

| stdin（snake_case） | HookRequest（camelCase） |
|---------------------|--------------------------|
| （祖先进程 / `--agent`） | `agent` |
| `hook_event_name` | `event` |
| `session_id` | `sessionId` |
| `transcript_path` | `transcriptPath` |
| `cwd` | `cwd` |
| `prompt` | `prompt` |
| `tool_name` | `toolName` |
| `tool_input` | `toolInput` |
| `tool_response` 或 `tool_output` | `toolResponse` |
| `tool_use_id` 或 `call_id` | `toolUseId` |
| 整个 stdin 对象 | `raw` |

示例（PreToolUse → daemon）：

```json
{
  "agent": "qodercli",
  "event": "PreToolUse",
  "sessionId": "s1",
  "transcriptPath": "/path/to/transcript.jsonl",
  "cwd": "/path/to/project",
  "toolName": "Bash",
  "toolInput": { "command": "export KEY=sk-..." },
  "toolUseId": "call_abc",
  "raw": { "hook_event_name": "PreToolUse", "tool_name": "Bash" }
}
```

daemon 只校验 `event` 属于三个官方名、`agent` 为 `qoder`、`qodercli` 或 `openclaw`；否则 HTTP 400 `{ "error": "invalid-request" }`，CLI 视为 fail-open。

### 3.3 阶段④：daemon 返回的 `EvaluateHookResponse`

```ts
interface EvaluateHookResponse {
  action: 'allow' | 'block';
  reason?: string;
  ruleId?: string;
  evaluatedRules: string[];
}
```

| 字段 | allow | block | 规则抛错 |
|------|-------|-------|----------|
| `action` | `"allow"` | `"block"` | `"allow"`（该次判定 fail-open） |
| `reason` | 无 | 规则原文，例如 `[APIKEY_MASKED]` | 无 |
| `ruleId` | 无 | 命中的规则 id | 无 |
| `evaluatedRules` | 实际跑过的 id | 含命中规则，后续短路不进数组 | 含抛错那条 |

敏感信息规则命中时 `reason` 是替换 token，不是用户原文：

| 规则 id（config.json 开关） | `reason` |
|-----------------------------|----------|
| `cloudAccessKey` | `[ACCESSKEY_MASKED]` |
| `apiKey` | `[APIKEY_MASKED]` |
| `privateKey` | `[PRIVATEKEY_MASKED]` |
| `databaseUrl` | `[DATABASEURL_MASKED]` |

HTTP 探活（CLI 在 evaluate 之前调用，200ms）：

```http
GET /health
```

```json
{
  "service": "loongsuite-pilot-interceptor",
  "status": "ok",
  "pid": 4242,
  "version": "1.0.2",
  "daemon_port": 18791
}
```

`pid` / `version` 必须与 `runtime.json` 一致，否则 CLI fail-open。

### 3.4 阶段⑤：CLI 包装 reason

daemon 的 `reason` **不会**原样给宿主。`wrapHostReason(event, reason)` 先包一层中文，再交给 `renderQoderBlock`。

| 事件 | 有 `reason` | 无 / 空白 `reason` |
|------|-------------|---------------------|
| UserPromptSubmit | `检测到敏感信息：{reason}，本轮对话终止` | `检测到敏感信息，本轮对话终止` |
| PreToolUse | `检测到非预期行为：{reason}，本次工具调用终止，且不允许通过其它手段重新发起直接或间接调用。` | `检测到非预期行为，本次工具调用终止，且不允许通过其它手段重新发起直接或间接调用。` |
| PostToolUse | `检测到非预期行为：{reason}，本次工具调用结果已拦截，且不允许通过其它手段重新发起直接或间接调用。` | `检测到非预期行为，本次工具调用结果已拦截，且不允许通过其它手段重新发起直接或间接调用。` |

例如 daemon `reason = "[APIKEY_MASKED]"`、事件 `PreToolUse` 时，宿主看到的文本是：

```
检测到非预期行为：[APIKEY_MASKED]，本次工具调用终止，且不允许通过其它手段重新发起直接或间接调用。
```

### 3.5 阶段⑥：写回宿主的 stdout

仅 `action === "block"` 时写一行 JSON（末尾 `\n`）。allow / fail-open 不写任何字节。信号是 **exit 0 + stdout JSON**，不是非零退出码。

**UserPromptSubmit / Desktop（`agent=qoder`）**

```json
{"decision":"block","reason":"检测到敏感信息：[APIKEY_MASKED]，本轮对话终止"}
```

**UserPromptSubmit / CLI（`agent=qodercli`）**

```json
{"decision":"deny","reason":"检测到敏感信息：[APIKEY_MASKED]，本轮对话终止"}
```

Desktop 用 `block`，CLI 用 `deny`，这是 Qoder 两套运行面的协议差异。

**PreToolUse（Desktop 与 CLI 相同）**

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "检测到非预期行为：[APIKEY_MASKED]，本次工具调用终止，且不允许通过其它手段重新发起直接或间接调用。"
  }
}
```

**PostToolUse（Desktop 与 CLI 相同）**

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "updatedToolOutput": "检测到非预期行为：[DATABASEURL_MASKED]，本次工具调用结果已拦截，且不允许通过其它手段重新发起直接或间接调用。"
  }
}
```

stdout 字段一览：

| 运行面 | 事件 | 顶层结构 | 拦截字段 |
|--------|------|----------|----------|
| Desktop | UserPromptSubmit | `{ decision, reason }` | `decision = "block"` |
| CLI | UserPromptSubmit | `{ decision, reason }` | `decision = "deny"` |
| 两者 | PreToolUse | `{ hookSpecificOutput }` | `permissionDecision = "deny"` + `permissionDecisionReason` |
| 两者 | PostToolUse | `{ hookSpecificOutput }` | `updatedToolOutput`（替换工具结果，不是 deny） |

### 3.6 旁路：access.log

每次判定写一行 JSONL 到 `~/.loongsuite-pilot/interceptor/logs/access.log`。**allow / block 由 daemon 写**；**fail-open 由 CLI 写**（此时请求可能没到 daemon）。

```ts
interface InterceptorAccessLogEntry {
  ts: string;                 // ISO-8601
  event: string;              // 三个官方名，或 "unknown"
  agent?: string;
  sessionId?: string;
  input: {
    prompt?: string;
    toolName?: string;
    toolInput?: unknown;
    toolResponse?: unknown;
    cwd?: string;
    raw?: unknown;            // 解析成功时的宿主对象 / HookRequest.raw
    rawText?: string;         // 仅 stdin 解析失败
  };
  result: {
    action: 'allow' | 'block' | 'fail-open';
    reason?: string;
    ruleId?: string;
    evaluatedRules?: string[];
    error?: string;           // 仅 fail-open
  };
}
```

单行超过 256 000 字符时截断 `input` 各字段，不丢整行。运维日志仍在 `interceptor/logs/interceptor.log`。

---

## 附录：端到端字段走样例

以 CLI 面上一次 PreToolUse 命中 `apiKey` 为例。

```text
stdin
  { "hook_event_name": "PreToolUse",
    "tool_name": "Bash",
    "tool_input": { "command": "export KEY=sk-1234567890abcdefghijklmnop" } }

        │  parseHookRequest + surface=qodercli
        ▼
HookRequest POST /v1/hooks/evaluate
  { "agent": "qodercli", "event": "PreToolUse",
    "toolName": "Bash",
    "toolInput": { "command": "export KEY=sk-..." },
    "raw": { ...stdin } }

        │  collectHookText = "Bash\nexport KEY=sk-..."
        │  apiKey 命中
        ▼
EvaluateHookResponse
  { "action": "block", "reason": "[APIKEY_MASKED]",
    "ruleId": "apiKey", "evaluatedRules": ["apiKey"] }

        │  wrapHostReason('PreToolUse', '[APIKEY_MASKED]')
        │  renderQoderBlock
        ▼
stdout（一行 JSON + \n）
  { "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": "检测到非预期行为：[APIKEY_MASKED]，本次工具调用终止，且不允许通过其它手段重新发起直接或间接调用。"
    } }
```
