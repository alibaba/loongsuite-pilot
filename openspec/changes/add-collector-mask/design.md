## Context

Pilot 的 collector 会把各类输入归一化为 `AgentActivityEntry`，随后由 `InputManager.handleEntries()` 统一分发给 flusher。当前代码已经在该链路中执行 `applyAgentContentPolicy()`；`OtlpTraceFlusher` 也会直接使用收到的 `AgentActivityEntry[]` 调用 `convertEventLogToTrace(records)` 转 span。

因此 mask 的最佳接入点是 collector 分发前：同一条 entry 先完成脱敏，再进入 JSONL / SLS / HTTP / OTLP trace，避免不同出口各自处理导致不一致。

## Goals / Non-Goals

**Goals:**
- 新增顶层 `mask.mode/types` 配置
- 在 collector 分发给 flusher 前统一执行字段内打码
- 本次变更支持 `cloudAccessKey`、`apiKey`、`privateKey`、`databaseUrl`
- 支持大字段中间位置的 secret 扫描，不只扫头尾
- 保持 hook 本地 history 不变
- 保持现有 `captureMessageContent` 和 SLS endpoint `redact` 行为不变

**Non-Goals:**
- 不做 hook 侧脱敏
- 不改写本地 history 文件

## Decisions

### D1: mask 放在 collector 分发前

**选择**: 在 `applyAgentContentPolicy()` 之后、`dispatchEntries()` 之前执行 mask。

**原因**:
- `captureMessageContent=false` 时内容字段已经被删除，无需再扫描
- log 和 trace 都基于同一份已脱敏 entry
- `OtlpTraceFlusher` 在 trace 转换前收到的 records 已经脱敏
- 不需要在每个 flusher 中重复实现 mask

与现有 SLS endpoint `redact` 的关系：
- `mask` 是 collector 分发前的字段内打码，替换命中的 secret 值
- `endpoint.redact` 是某个 SLS endpoint 序列化后的整字段删除
- 两者互不替代，`mask` 开启后仍保持 `endpoint.redact` 的原有行为

### D2: 配置使用顶层 mask

**选择**: `mask` 放在配置最外层，不放在各个 agent 内部。

```jsonc
{
  "mask": {
    "mode": "all"
  },
  "agents": {
    "cursor": {
      "captureMessageContent": true
    }
  }
}
```

参数说明：

| 参数 | 取值 | 含义 |
| --- | --- | --- |
| `mask.mode` | `none` | 关闭脱敏；缺失 `mask` 或缺失 `mask.mode` 时默认按 `none` 处理 |
| `mask.mode` | `all` | 开启本次变更支持的全部脱敏类型；此时不需要配置 `types` |
| `mask.mode` | `custom` | 只开启 `types` 中列出的脱敏类型 |
| `mask.types` | `cloudAccessKey` / `apiKey` / `privateKey` / `databaseUrl` | 仅在 `mode=custom` 时生效；`custom` 模式下为空或缺失时，不开启任何脱敏类型 |

**原因**:
- 脱敏是上报链路的统一保护策略，不依赖具体 agent
- 与当前对齐后的配置格式一致
- 新增 agent 时不需要单独配置才有保护

### D3: 规则集中放在 src/mask/sensitive-rules.json

**选择**: 新建 `src/mask/sensitive-rules.json` 作为规则配置文件，代码侧只负责加载、校验、编译和执行。

规则示例：

```json
{
  "id": "cloudAccessKey.alicloud.accessKeyId",
  "type": "cloudAccessKey",
  "kind": "regex",
  "replacement": "[ACCESSKEY_MASKED]",
  "prefilter": ["LTAI"],
  "pattern": "\\bLTAI[A-Za-z0-9]{12,}\\b",
  "flags": "g"
}
```

规则文件整体结构：

```json
{
  "version": 1,
  "rules": [
    {
      "id": "cloudAccessKey.alicloud.accessKeyId",
      "type": "cloudAccessKey",
      "kind": "regex",
      "replacement": "[ACCESSKEY_MASKED]",
      "prefilter": ["LTAI"],
      "pattern": "\\bLTAI[A-Za-z0-9]{12,}\\b",
      "flags": "g"
    },
    {
      "id": "cloudAccessKey.aws.accessKeyId",
      "type": "cloudAccessKey",
      "kind": "regex",
      "replacement": "[ACCESSKEY_MASKED]",
      "prefilter": ["AKIA", "ASIA", "ABIA", "ACCA"],
      "pattern": "\\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\\b",
      "flags": "g"
    },
    {
      "id": "cloudAccessKey.tencent.secretId",
      "type": "cloudAccessKey",
      "kind": "regex",
      "replacement": "[ACCESSKEY_MASKED]",
      "prefilter": ["AKID"],
      "pattern": "\\bAKID[A-Za-z0-9]{13,}\\b",
      "flags": "g"
    },
    {
      "id": "apiKey.openaiCompatible",
      "type": "apiKey",
      "kind": "regex",
      "replacement": "[APIKEY_MASKED]",
      "prefilter": ["sk-"],
      "pattern": "\\bsk-[A-Za-z0-9_-]{20,}\\b",
      "flags": "g"
    },
    {
      "id": "apiKey.github",
      "type": "apiKey",
      "kind": "regex",
      "replacement": "[APIKEY_MASKED]",
      "prefilter": ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"],
      "pattern": "\\b(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\\b",
      "flags": "g"
    },
    {
      "id": "privateKey.pem",
      "type": "privateKey",
      "kind": "block",
      "replacement": "[PRIVATEKEY_MASKED]",
      "prefilter": ["PRIVATE KEY"],
      "beginPattern": "-----BEGIN [A-Z ]*PRIVATE KEY-----",
      "endPattern": "-----END [A-Z ]*PRIVATE KEY-----"
    },
    {
      "id": "databaseUrl.withPassword",
      "type": "databaseUrl",
      "kind": "urlWithPassword",
      "replacement": "[DATABASEURL_MASKED]",
      "prefilter": ["://", "@"],
      "schemes": ["mysql", "postgres", "postgresql", "mongodb", "redis"]
    },
    {
      "id": "databaseUrl.jdbcWithPassword",
      "type": "databaseUrl",
      "kind": "regex",
      "replacement": "[DATABASEURL_MASKED]",
      "prefilter": ["jdbc:", "password", "pwd="],
      "pattern": "\\bjdbc:(?:mysql|postgresql)://[^\\s\"'`]+(?:[?&;](?:password|pwd)=[^\\s&;\"'`]+)[^\\s\"'`]*",
      "flags": "gi"
    }
  ]
}
```

规则字段说明：

| 字段 | 含义 |
| --- | --- |
| `version` | 规则文件版本 |
| `rules` | 规则数组 |
| `id` | 规则唯一标识，用于测试和排查 |
| `type` | 脱敏类别，对应 `mask.types` |
| `kind` | 执行方式，支持 `regex`、`block`、`urlWithPassword` |
| `replacement` | 命中后的替换文本 |
| `prefilter` | 关键词预筛，未命中则不执行正式规则 |
| `pattern` / `flags` | `regex` 规则使用 |
| `beginPattern` / `endPattern` | `block` 规则使用，用于识别私钥块 |
| `schemes` | `urlWithPassword` 规则使用，用于限制数据库 URL 类型 |

**原因**:
- 规则和执行逻辑分离，后续新增规则更清晰
- 规则可以被单测单独校验
- 避免正则散落在多个 TypeScript 文件中

规则扩展方式：

| 场景 | 做法 |
| --- | --- |
| 同一类型新增稳定前缀 | 在 `rules` 中追加同 `type` 的新 rule，并配置自己的 `prefilter` / `pattern` |
| 同一类型新增数据库 scheme | 优先追加到 `databaseUrl.withPassword.schemes`；如果不是标准 URL 结构，例如 JDBC，则新增独立 `regex` rule |
| 新增敏感类型 | 新增 `MaskType`、替换文本、规则、配置解析合法值和测试用例 |
| 收紧误报规则 | 只修改或删除对应 `id` 的 rule，不影响同类型其他规则 |

### D4: 字段白名单 + 关键词预筛 + 规则执行

**选择**: 不对每个字段做 JSON parse / URL parse，全量结构化解析不作为本次变更方案。

这里的“字段白名单”指的是 **flusher 之前的 `AgentActivityEntry` 字段 key**。mask 在 `InputManager` 分发前执行，此时还没有进入 JSONL / SLS / HTTP 序列化，也还没有被 `OtlpTraceFlusher` 转成 span。  
因此白名单扫描的是统一 entry 字段；这些字段后续会分别影响 log 字段和 trace attribute。

字段白名单按当前代码里的 `AgentActivityEntry` 构建逻辑整理：

| 字段族 | flusher 前 `AgentActivityEntry` 字段 | 代码依据 / 下游影响 |
| --- | --- | --- |
| LLM 输入 | `gen_ai.input.messages`、`gen_ai.input.messages_delta` | `entry-builder.ts`、`cursor-hook-input.ts`、`qoder-cli-input.ts`、`qoder-work-trace-input.ts`、`codex-log-input.ts`、`claude-code-log-input.ts` 都会产出或归一化这些字段；后续进入 log 同名字段和 trace input message attribute |
| LLM 输出 | `gen_ai.output.messages` | 同上；后续进入 log 同名字段和 trace output message attribute |
| 工具调用参数 | `gen_ai.tool.call.arguments` | 工具调用事件的参数；后续进入 log 同名字段和 trace tool call attribute |
| 工具执行结果 | `gen_ai.tool.call.result` | 工具结果事件的返回内容；后续进入 log 同名字段和 trace tool result attribute |
| System prompt | `gen_ai.system_instructions` | Codex / Claude log 输入会带该字段；后续进入 log 同名字段和 trace system instruction attribute |
| 工具定义 | `gen_ai.tool.definitions` | Codex / Claude log 输入会带该字段；后续进入 log 同名字段和 trace tool definitions attribute |
| 错误文本 | `error.message` | Cursor / Codex / Claude hook 或 log 输入会归一化到该字段；后续进入 log 同名字段和 trace error attribute |
| 兼容内容字段 | `content`、`inlineDiffMessage`、`agent.content`、`agent.inline_diff_message` | legacy code-generation 输入和 `applyAgentContentPolicy()` 已覆盖这些字段；如果某些历史或扩展 entry 在分发前仍保留这些字段，也进入 mask |
| 兼容工具字段 | `input.messages`、`input.messages_delta`、`output.messages`、`tool.arguments`、`tool.result`、`tool.result.payload`、`system_instructions`、`tool.definitions` | 当前标准构建会优先归一化为 `gen_ai.*`，但为了兼容直接传入的 legacy / 外部 OTel 风格 entry，mask 也覆盖这些字段 |
| 兼容 agent 文本字段 | `agent._cinput`、`agent._ctext`、`agent._ccontent`、`agent._cthinking` | 兼容历史 Qoder Work / agent 扩展文本字段；如果当前 entry 中存在这些字段，也进入 mask |
| 兼容错误字段 | `error`、`error_message` | 当前代码主要归一化为 `error.message`，这里保留兼容覆盖 |

普通元数据字段不进入扫描，例如 model、token count、duration、cost、event id、session id、host、client ip、workspace path、git 字段。`attributes` 整体也不作为扫描入口；当前 `buildAgentActivityEntry()` 会把 `attributes` 展开成 `agent.*` 并移除 `attributes` 本身，如果未来新 input 保留 `attributes`，需要先把其中的内容类字段映射成明确 key 再加入白名单。

关键词预筛来源：

- 预筛关键词不是另外维护的一份固定列表，而是来自 `src/mask/sensitive-rules.json` 中每条规则的 `prefilter`
- 运行时先根据 `mask.mode/types` 选出启用规则，再把启用规则的 `prefilter` 合并成预筛集合
- 某个字符串如果没有命中任何启用规则的 `prefilter`，直接跳过正式规则执行
- 某条规则自己的 `prefilter` 没命中时，也不会执行该规则

预筛关键词示例：

| 类型 | 关键词来源 |
| --- | --- |
| `cloudAccessKey` | `LTAI`、`AKIA`、`ASIA`、`ABIA`、`ACCA`、`AKID` |
| `apiKey` | `sk-`、`ghp_`、`gho_`、`ghu_`、`ghs_`、`ghr_`、`github_pat_` |
| `privateKey` | `PRIVATE KEY`、`OPENSSH PRIVATE KEY` |
| `databaseUrl` | `://`、`@`、`jdbc:`、`password` |

规则执行方式：

```text
activeTypes = resolveTypes(mask.mode, mask.types)
activeRules = rules.filter(rule.type in activeTypes)

for each whitelisted entry field:
  walk JSON-safe value
  for each string:
    if string is already *_MASKED -> skip
    if no active prefilter keyword appears -> skip
    for each active rule:
      if rule.prefilter does not match this string -> continue
      apply rule by rule.kind
```

| `rule.kind` | 执行方式 |
| --- | --- |
| `regex` | 规则加载时编译 `pattern + flags`；普通字符串可直接替换，大字段窗口内返回命中区间再统一回写 |
| `block` | 用 `beginPattern` / `endPattern` 找多行块，替换完整块；用于 PEM / OpenSSH 私钥；大字段窗口内也返回命中区间 |
| `urlWithPassword` | 先从字符串中提取 URL 候选，再判断 scheme 是否在 `schemes` 中，并且 URL 含 password 或 `user:pass@host` 结构；命中后替换完整连接串，大字段窗口内返回候选区间 |

大字段处理：
- 不只扫描头尾，也不对整段内容做完整结构化解析
- 字符串长度判断按 UTF-8 字节数计算，Node.js 中使用 `Buffer.byteLength(value, 'utf8')`
- 字符串长度 `<= 64 KiB` 时，直接对整段字符串执行启用规则
- 字符串长度 `> 64 KiB` 时，按大字段处理：先用启用规则的 `prefilter` 在全文中找关键词位置，再只扫描关键词附近窗口
- 窗口初始值为关键词前后各 `8 KiB`，即单个命中点最多扫描约 `16 KiB`；多个窗口重叠时先合并再执行规则
- 如果全文没有命中任何启用规则的 `prefilter`，直接跳过，不执行正式规则
- `privateKey` 的 `block` 规则可在窗口内继续查找 `beginPattern` 到 `endPattern`；实现时限制单个私钥块最大查找范围，例如 `64 KiB`，避免异常文本导致长距离扫描
- 大字段窗口内仍然按规则自己的 `prefilter` 再过滤一次，只执行相关规则

大字段替换回写：
- 不直接对窗口 `slice` 替换后拼回原字符串，避免多个窗口重叠时替换错位
- 每条规则在窗口内命中后返回原字符串上的 `[start, end, replacement]`
- `regex` 规则用 `window.start + match.index` 映射回原文 offset；`block` / `urlWithPassword` 规则同样返回原文 offset
- 对命中区间按 `start/end` 排序、去重，并处理重叠区间
- 最后从后往前替换原字符串，避免前面的替换改变后续 offset

大字段阈值和窗口大小：

| 常量 | 初始值 | 含义 | 取值考虑 |
| --- | --- | --- | --- |
| `LARGE_STRING_THRESHOLD` | `64 KiB` | 超过该长度的字符串按大字段处理 | 最近 6 份采集数据中，`<= 64 KiB` 已覆盖绝大多数记录；超过该阈值后改走窗口扫描，能减少大字段整段反复跑正则 |
| `KEYWORD_CONTEXT_WINDOW` | `8 KiB` | 关键词前后各取多少内容进入正式规则扫描 | AK / API Key / DB URL 通常远小于 1 KiB；私钥块一般也在几 KB 级，前后 8 KiB 能覆盖大多数上下文，同时把每个命中点的正则扫描量控制在约 16 KiB |
| `PRIVATE_KEY_BLOCK_LIMIT` | `64 KiB` | 单个私钥块最大查找范围 | 正常 PEM / OpenSSH 私钥远小于该值；加上上限可以避免格式异常时从大字段头扫到尾 |

这几个值先作为实现常量，不暴露到用户配置。实现完成后需要用最近采集数据做性能测试，再决定是否调整。建议测试 `64 / 128 / 256 KiB` 三档大字段阈值，以及 `4 / 8 / 16 KiB` 三档窗口大小，重点看大字段中间有 secret 时的命中率和单条 entry 处理耗时。

统计数据如下：

| 字段大小区间 | 占总行数 |
| --- | ---: |
| `<= 64 KiB` | `99.762%` |
| `64 - 128 KiB` | `0.131%` |
| `128 - 256 KiB` | `0.051%` |
| `256 - 512 KiB` | `0.042%` |
| `512 KiB - 1 MiB` | `0.010%` |
| `1 - 2 MiB` | `0.003%` |
| `> 2 MiB` | `0.001%` |

从这个比例看，`<= 64 KiB` 已覆盖 `99.762%` 的记录，因此可以先以 `64 KiB` 作为阈值，后续测试中再调整。

**原因**:
- AI Coding 大字段经常混合自然语言、命令输出、代码、JSON 片段和 shell 文本
- 每段字符串都解析成 JSON/URL 性能和稳定性都不合适
- 关键词预筛能显著减少正则执行次数
- 直接扫描整段字符串可以覆盖 secret 出现在大字段中间的情况

### D5: 本次变更规则保持窄口径

**选择**: 只实现边界清楚、误报较低的四类：

| 类型 | 范围 | 替换文本 |
| --- | --- | --- |
| `cloudAccessKey` | `LTAI`、`AKIA`、`ASIA`、`ABIA`、`ACCA`、`AKID` 等稳定前缀 | `[ACCESSKEY_MASKED]` |
| `apiKey` | `sk-`、GitHub token 前缀 | `[APIKEY_MASKED]` |
| `privateKey` | PEM / OpenSSH 私钥块 | `[PRIVATEKEY_MASKED]` |
| `databaseUrl` | 包含密码的 Postgres / MySQL / MongoDB / Redis / JDBC 连接串 | `[DATABASEURL_MASKED]` |

**原因**:
- 这些类型在采样数据中风险高
- 前缀或结构相对明确，适合本次变更上线
- 云 SK、PII、JWT 等误报风险更高，先不纳入

## Implementation Approach

### Phase 1: 配置与类型

- 在 `src/types/index.ts` 新增 `MaskMode`、`MaskType`、`MaskConfig`
- 在 `AnalyticsConfig` 中新增 `mask`
- 在 `src/core/config-loader.ts` 中解析顶层 `mask`
- 缺失 `mask` 或缺失 `mask.mode` 时按 `none` 处理，不执行脱敏

### Phase 2: Mask 模块实现

文件结构：

```text
src/mask/
  ├── sensitive-rules.json
  ├── rule-loader.ts
  ├── field-whitelist.ts
  ├── string-masker.ts
  ├── entry-masker.ts
  └── types.ts
```

核心职责：
- 加载并校验规则文件
- 根据 `mask.mode/types` 过滤启用规则
- 编译正则
- 遍历字段白名单中的字符串，支持对象/数组递归、按行扫描和超长单行分块扫描
- 替换命中的 secret
- 保持已打码文本幂等

### Phase 3: Collector 链路接入

接入位置：

```text
Input entries
  -> user.id enrichment
  -> applyAgentContentPolicy()
  -> maskAgentActivityEntry()
  -> dispatchEntries()
```

`InputManager` 只负责调用 `maskAgentActivityEntry()`，不承载规则和扫描细节。

### Phase 4: 测试与验证

- config-loader: `mask` 配置解析
- mask module: 四类规则、字段白名单、递归遍历、幂等
- collector path: flusher 前 entry 已脱敏
- trace path: `convertEventLogToTrace(records)` 收到已脱敏 records
- large field: secret 位于大字段中间仍能命中

## Risks

- **低风险**: 配置理解偏差。缺失 `mask.mode` 时默认 `none`，如果用户期望开启脱敏，需要显式配置 `all` 或 `custom`。通过配置文档和示例说明。
- **低风险**: 字段白名单遗漏。新增内容字段如果没有加入白名单，可能不会进入 mask 扫描。通过字段清单测试和典型 agent 样例覆盖。
- **低风险**: 规则文件维护。规则写错可能导致漏扫或误扫。通过 rule loader 校验、规则单测和样例回归测试控制。
