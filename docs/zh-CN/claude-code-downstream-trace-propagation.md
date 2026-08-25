# Claude Code 下游 CLI 上下文传播

本文介绍 LoongSuite Pilot 如何通过 Claude Code 的 `PreToolUse(Bash)` hook，
把 Trace Context 和资源属性传给 Claude Code 调用的用户 CLI。

该能力支持两种 Trace 来源：

- 有上游：复用启动 Claude Code 时传入的 `TRACEPARENT`。
- 无上游：按需为每个 Claude turn 生成本地 Trace Context。

用户通过 `LOONGSUITE_PILOT_RESOURCE_ATTRIBUTES` 提供的属性会被 Pilot 映射为
下游进程的标准 `OTEL_RESOURCE_ATTRIBUTES`，可供 OpenTelemetry Go 探针等
标准实现直接读取。

## 最终链路

有上游时：

```text
上游应用 Span
└── Claude Code ENTRY Span
    └── Claude Code AGENT / STEP / LLM Span
        └── Bash TOOL Span
            └── 用户 CLI Span
                └── 用户 CLI 的更多下游 Span
```

没有上游且开启本地生成时，链路从 Claude Code ENTRY span 开始：

```text
Claude Code ENTRY Span
└── Claude Code AGENT / STEP / LLM Span
    └── Bash TOOL Span
        └── 用户 CLI Span
```

Pilot 为每个 Bash TOOL span 预留一个 span ID，并将以下内容传给用户 CLI：

- `TRACEPARENT`：trace ID 与本 turn 的 Claude Code Trace 一致，parent span ID
  等于 Bash TOOL span ID。
- `TRACESTATE`：仅在使用有效上游上下文且值合法时传播。
- `OTEL_RESOURCE_ATTRIBUTES`：来自 Claude Code 进程上的
  `LOONGSUITE_PILOT_RESOURCE_ATTRIBUTES`。

## 用户需要配置什么

已有的两个总开关仍然必需。推荐写入
`~/.loongsuite-pilot/config.json`，这样 Pilot 采集进程和 Claude Code hook
读取的是同一份配置：

```json
{
  "upstreamLink": {
    "enabled": true,
    "propagateToTools": true
  }
}
```

本次功能新增两个字段：

| 新字段 | 类型 | 默认值 | 用途 |
|--------|------|--------|------|
| `upstreamLink.generateTraceWhenMissing` | `boolean` | `false` | 没有有效上游 `TRACEPARENT` 时，为每个 turn 生成并传播本地 Trace Context |
| `LOONGSUITE_PILOT_RESOURCE_ATTRIBUTES` | 环境变量字符串 | 未设置 | 资源属性私有载体；Pilot 将其映射成下游 CLI 的 `OTEL_RESOURCE_ATTRIBUTES` |

如果业务始终会传入上游 `TRACEPARENT`，只需要按需新增
`LOONGSUITE_PILOT_RESOURCE_ATTRIBUTES`，不必开启本地生成。

如果业务没有上游，但希望 Claude Code 与下游 CLI 仍处于同一条 Trace，需要
把完整配置写成：

```json
{
  "upstreamLink": {
    "enabled": true,
    "propagateToTools": true,
    "generateTraceWhenMissing": true
  }
}
```

修改配置后重启 Pilot：

```bash
loongsuite-pilot restart
```

完整配置项如下：

| 配置项 | 环境变量 | 默认值 | 说明 |
|--------|----------|--------|------|
| `upstreamLink.enabled` | `LOONGSUITE_PILOT_UPSTREAM_LINK` | `false` | 开启上游关联和下游传播能力的总开关 |
| `upstreamLink.propagateToTools` | `LOONGSUITE_PILOT_UPSTREAM_LINK_PROPAGATE_TO_TOOLS` | `false` | 允许向支持的 CLI 工具注入上下文 |
| `upstreamLink.generateTraceWhenMissing` | `LOONGSUITE_PILOT_UPSTREAM_LINK_GENERATE_TRACE_WHEN_MISSING` | `false` | 没有有效上游时生成每 turn 本地 Trace |
| `upstreamLink.ttlMs` | `LOONGSUITE_PILOT_UPSTREAM_LINK_TTL_MS` | `86400000` | 关联状态文件清理 TTL，单位为毫秒 |

配置优先级为：环境变量 > `config.json` > 内置默认值。

也可以通过环境变量配置，但环境变量只对继承它的进程生效。以下方式要求在同一
终端中重启 Pilot，并从该终端启动一个新的 Claude Code 进程：

```bash
export LOONGSUITE_PILOT_UPSTREAM_LINK=true
export LOONGSUITE_PILOT_UPSTREAM_LINK_PROPAGATE_TO_TOOLS=true
export LOONGSUITE_PILOT_UPSTREAM_LINK_GENERATE_TRACE_WHEN_MISSING=true

loongsuite-pilot restart
claude
```

`loongsuite-pilot restart` 只会让新启动的 Pilot 采集进程读取当前配置/环境，
不会把变量注入已经运行的 Claude Code。反过来，只在启动 `claude` 的命令前设置
环境变量，也不会修改已经运行的 Pilot 采集进程。因此：

- `upstreamLink.enabled` 必须对 Pilot 采集进程生效；
- `enabled`、`propagateToTools` 和 `generateTraceWhenMissing` 必须能被 Claude Code
  的 hook 读取；
- `TRACEPARENT`、`TRACESTATE` 和 `LOONGSUITE_PILOT_RESOURCE_ATTRIBUTES` 必须设置在
  新启动的 Claude Code 进程上。

如果 Pilot 由系统服务或其他进程管理器启动，优先使用 `config.json` 配置三个
`upstreamLink` 开关，仅把每次调用不同的 Trace Context 和资源属性放在
`claude` 启动命令上。

## 使用方式

### 场景一：有上游 Trace

在启动 Claude Code 时传入上游 Trace Context 和可选资源属性：

```bash
TRACEPARENT='00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' \
TRACESTATE='vendor=value' \
LOONGSUITE_PILOT_RESOURCE_ATTRIBUTES='service.namespace=demo,deployment.environment.name=test' \
claude
```

环境变量必须在启动 Claude Code 时设置。Claude Code 启动后再修改父终端环境，
不会影响已有进程。

`TRACEPARENT` 必须符合以下格式：

```text
00-<32 位非零 trace ID>-<16 位非零 parent span ID>-<2 位 flags>
```

有效上游上下文优先于本地生成。它只关联和传播到会话首个 turn；如果同时开启
`generateTraceWhenMissing`，后续 turn 会各自生成新的本地 trace ID，不会继续
错误引用首轮上游 span。

### 场景二：没有上游 Trace

确保 `generateTraceWhenMissing` 已开启，然后直接启动 Claude Code：

```bash
LOONGSUITE_PILOT_RESOURCE_ATTRIBUTES='service.namespace=demo,deployment.environment.name=test' \
claude
```

当本 turn 首次执行 Bash 工具时，Pilot 会生成一个 trace ID。同一 turn 内的
所有 Bash 调用共享该 trace ID，但各自拥有独立的 TOOL span ID；不同 turn
使用不同的 trace ID。

### 场景三：只传资源属性

资源属性传播不依赖 Trace Context。即使没有上游且没有开启本地 Trace 生成，
只要 `upstreamLink.enabled` 和 `propagateToTools` 已开启，以下设置仍会被映射给
下游 CLI：

```bash
LOONGSUITE_PILOT_RESOURCE_ATTRIBUTES='service.namespace=demo,tenant.id=tenant-a' \
claude
```

之所以使用 Pilot 私有载体，而不是直接要求用户在 Claude Code 上设置
`OTEL_RESOURCE_ATTRIBUTES`，是因为 Claude Code 可能清理传给 Bash 的
`OTEL_*` 环境变量。Pilot 在工具执行前显式写入标准字段，传播行为更可控。

## 下游 CLI 会收到什么

Pilot 返回给 Claude Code 的 Bash 命令结构类似：

```bash
export TRACEPARENT='<downstream-traceparent>';
export TRACESTATE='<tracestate>';
export OTEL_RESOURCE_ATTRIBUTES='<resource-attributes>';
<原始 Bash 命令>
```

只有实际存在且通过校验的字段才会注入。原始 Bash 命令和
`description`、`timeout`、`run_in_background` 等工具参数保持不变。

例如，上游传给 Claude Code 的 `TRACEPARENT` 是：

```text
00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
```

Pilot 为 Bash TOOL span 预留 `d41591ac92dd2cec` 后，下游收到：

```text
00-4bf92f3577b34da6a3ce929d0e0e4736-d41591ac92dd2cec-01
```

| 字段 | 上游传给 Claude Code | Pilot 传给下游 CLI |
|------|----------------------|---------------------|
| Version | `00` | `00` |
| Trace ID | 上游 trace ID | 保持不变 |
| Parent span ID | 上游应用 span ID | Pilot 的 Bash TOOL span ID |
| Trace flags | 上游 flags | 保持不变 |
| `TRACESTATE` | 可选 | 有效时保持不变 |

本地生成时使用随机的 16 字节 trace ID，trace flags 为 `01`。

## 下游 CLI 的职责

Pilot 只负责注入环境变量，不会替用户 CLI 自动创建或上报 span。用户 CLI 需要：

1. 从大写环境变量 `TRACEPARENT` 和 `TRACESTATE` 读取 W3C Trace Context。
2. 映射成 propagator 能识别的 `traceparent`、`tracestate` carrier 并提取父上下文。
3. 基于父上下文创建 CLI span，并配置 exporter。
4. 调用更下游的服务时继续注入当前 span 上下文。

Go 探针通常会按 OpenTelemetry 规范自动读取
`OTEL_RESOURCE_ATTRIBUTES`。因此资源属性不需要 CLI 再做 Pilot 专用适配；
但 `TRACEPARENT` 是进程环境载体，不等同于 HTTP header，CLI 或其探针仍需明确
支持从该环境变量提取上下文。

### Node.js 最小提取示例

```js
import { context, propagation, trace } from '@opentelemetry/api';

const carrier = {
  traceparent: process.env.TRACEPARENT,
  tracestate: process.env.TRACESTATE,
};

const parentContext = propagation.extract(context.active(), carrier);
const tracer = trace.getTracer('my-cli');

await tracer.startActiveSpan('my-cli.operation', {}, parentContext, async (span) => {
  try {
    // 执行 CLI 业务逻辑。
  } finally {
    span.end();
  }
});
```

### 最小接收验证

可以先让 Claude Code 通过 Bash 执行：

```bash
node -e 'console.log(JSON.stringify({
  traceparent: process.env.TRACEPARENT,
  tracestate: process.env.TRACESTATE,
  resourceAttributes: process.env.OTEL_RESOURCE_ATTRIBUTES
}))'
```

生产环境不建议长期打印这些值。

## 实现原理

### PreToolUse 阶段

Pilot 只处理主 Agent 的 `Bash` 工具调用。每次调用时：

1. 以 `session_id + prompt_id` 选择本 turn 的 Trace Context。
2. 优先使用尚未消费的有效上游 `TRACEPARENT`；否则按配置生成本地 trace ID。
3. 以 `session_id + tool_use_id` 为 Bash TOOL span 预留独立 span ID。
4. 组装下游 `TRACEPARENT`，并映射可选资源属性。
5. 通过 `hookSpecificOutput.updatedInput` 更新 Bash 命令。

turn 和工具预留记录保存在 `~/.loongsuite-pilot/acp-correlate/`。Hook 先完整写入
临时文件，再通过原子 create-if-absent 发布，保证并行调用不会读取空文件或半条
JSON，同时保持 hook 重试幂等。过期记录由现有 retention 任务清理。

### Stop 阶段

Stop hook 根据 transcript 中相同的 `prompt_id` 读取本 turn trace ID，使 Claude
Code ENTRY、AGENT、STEP、LLM 和 TOOL span 与注入下游的 Trace Context 一致。
它再按 `tool_use_id` 复用并消费预留的 TOOL span ID。

如果预留状态丢失或损坏，Pilot 会回退到普通随机 ID，不影响 Claude Code 工具
执行和其他遥测数据采集。

## 优先级与 turn 语义

Trace 来源优先级如下：

1. 会话首个 turn 的有效环境变量 `TRACEPARENT`。
2. `generateTraceWhenMissing=true` 时生成的本地 turn Trace。
3. 两者都不存在时沿用原有采集逻辑，不向下游注入 `TRACEPARENT`。

环境变量上游上下文保持“会话首轮消费一次”的现有语义，消费状态会持久化，Pilot
采集进程重启也不会把同一上游错误地应用到后续 turn。开启本地生成后，后续 turn
会生成新的本地 Trace，而不是复用首轮上游 trace ID。

仅通过 ACP per-turn 关联文件提供、但未出现在 Claude Code 进程环境中的上游
上下文，当前仍不能在 `PreToolUse` 阶段传播给下游。Pilot 检测到 ACP 管理的会话
后会跳过 `TRACEPARENT` 注入（包括本地生成），避免 Claude Code span 最终关联到
ACP trace、而下游 CLI 落到另一条本地 trace。资源属性仍会独立传播。

本地生成依赖 Claude Code hook 事件中的稳定 `prompt_id`。缺少该字段时 Pilot
会 fail-open：保留原有首轮环境变量上游传播，但不生成本地 Trace。

## 校验与安全

- `TRACEPARENT` 必须是合法的 W3C version `00` 格式，且 trace ID 和 span ID
  不能全零。
- `TRACESTATE` 必须非空、不超过 512 个字符且不含控制字符。
- `LOONGSUITE_PILOT_RESOURCE_ATTRIBUTES` 必须非空、UTF-8 编码不超过 8 KiB。
  Pilot 会去掉末尾的 CR/LF（兼容文件和 PowerShell 读取结果），但拒绝中间包含
  换行或其他控制字符的值。属性字符串其余部分作为不透明值传播；格式和属性语义
  由 OpenTelemetry SDK 或探针校验。
- 所有注入值都经过 shell 单引号转义。
- Trace Context 和资源属性不应承载 AccessKey、API Key、Cookie 或用户隐私。

## Fail-open 行为

以下情况会跳过相应字段的注入，并让原 Bash 命令继续执行：

- 总开关或工具传播开关未开启。
- 上游 `TRACEPARENT` 无效，且本地生成未开启。
- 当前工具不是主 Agent 的 `Bash`。
- 缺少 `session_id`、`tool_use_id`，或本地生成时缺少 `prompt_id`。
- Bash 命令为空或输入格式不支持。
- 上下文、属性或预留状态未通过校验。
- 状态文件无法创建、读取或校验。

Trace Context 和资源属性相互独立。例如，非法资源属性不会阻止合法
`TRACEPARENT` 传播；没有 Trace Context 也不会阻止合法资源属性传播。

## 当前支持范围

支持：

- Claude Code 主 Agent。
- `Bash` 工具，包括 `run_in_background: true` 的后台命令。
- 环境变量提供的首轮 W3C `TRACEPARENT` 和可选 `TRACESTATE`。
- 没有上游时的每 turn 本地 Trace 生成。
- `LOONGSUITE_PILOT_RESOURCE_ATTRIBUTES` 到
  `OTEL_RESOURCE_ATTRIBUTES` 的映射。

暂不支持：

- subagent 的工具调用。
- PowerShell、MCP 和非 Bash 工具。
- 恢复已有会话时注入一份新的环境变量上游上下文。
- ACP-only per-turn 上游上下文向下游传播。

## 如何验证完整链路

建议同时检查进程环境和 Trace 后端：

1. 用户 CLI 收到合法的 `TRACEPARENT`。
2. 下游 trace ID 与对应 Claude turn 的 trace ID 一致。
3. 下游 parent span ID 等于 Pilot Bash TOOL span ID。
4. 有上游时，首轮 Claude Code ENTRY span 指向上游 span。
5. 用户 CLI 的 span 位于 Bash TOOL span 下，并成功上报。
6. 下游收到的 `OTEL_RESOURCE_ATTRIBUTES` 与私有载体值一致，Go 探针创建的
   Resource 中包含预期属性。

只看到环境变量并不代表完整链路已经建立，还需要确认 CLI 正确提取上下文、
创建 span，并与 Pilot 上报到可关联的 Trace 后端。

## 常见问题

### 下游没有收到任何字段

检查 `upstreamLink.enabled`、`upstreamLink.propagateToTools` 是否为 `true`，
修改配置后是否重启了 Pilot、是否重新启动了继承正确环境的 Claude Code，以及
Claude Code 调用的是否为主 Agent `Bash`。ACP 管理的会话当前只传播资源属性，
不会向下游注入 Trace Context。

### 没有上游时未收到 TRACEPARENT

检查 `upstreamLink.generateTraceWhenMissing` 是否为 `true`，以及当前 Claude Code
版本的 `PreToolUse` hook 事件是否包含 `prompt_id`。

### 下游收到了 TRACEPARENT，但后端仍显示两条 Trace

通常是用户 CLI 或探针没有从进程环境变量提取 W3C carrier，或创建 span 时没有
使用提取的 parent context。还应检查 CLI 和 Pilot 是否上报到同一个可关联后端。

### 下游没有收到资源属性

检查 `LOONGSUITE_PILOT_RESOURCE_ATTRIBUTES` 是否设置在 Claude Code 进程上，
值是否为空、超过 8 KiB 或在中间包含换行等控制字符。末尾 CR/LF 会被去掉。
下游读取的字段名是标准
`OTEL_RESOURCE_ATTRIBUTES`，不是 Pilot 私有载体名。

### 后续 turn 的 trace ID 与首轮不同

这是开启本地生成后的预期行为。环境变量上游只用于首个 turn，后续 turn 使用
各自的本地 trace ID，以免错误地继续挂载到首轮上游 span。

### Hook 配置被其他工具覆盖

重新启动 Pilot 并检查状态：

```bash
loongsuite-pilot restart
loongsuite-pilot status
loongsuite-pilot info
```

Pilot 的 hook watchdog 会持续检查受管 hook，但仍应避免手工删除 Pilot 注册的
Claude Code hook。
