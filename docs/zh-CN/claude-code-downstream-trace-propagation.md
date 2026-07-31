# Claude Code 下游 CLI Trace 上下文传播

本文介绍 LoongSuite Pilot 如何把上游 Trace 上下文继续传递给 Claude Code
通过 `Bash` 调用的下游 CLI，使上游应用、Claude Code、Bash TOOL span 和用户
CLI 的 Trace 串联成一条完整链路。

## 适用场景

假设业务系统通过环境变量启动 Claude Code：

```bash
TRACEPARENT='00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' \
TRACESTATE='vendor=value' \
claude
```

Claude Code 在执行任务时可能通过 `Bash` 调用用户自己的 CLI。开启本功能后，
Pilot 会把同一个 Trace 上下文传给该 CLI，并保证下游收到的 parent span ID
就是 Pilot 最终生成的 Bash TOOL span ID。

最终链路关系如下：

```text
上游应用 Span
└── Claude Code ENTRY Span
    └── Claude Code AGENT / STEP / LLM Span
        └── Bash TOOL Span
            └── 用户 CLI Span
                └── 用户 CLI 的更多下游 Span
```

其中：

- 上游 `traceparent` 的 trace ID 会贯穿整条链路。
- Claude Code ENTRY span 的 parent span ID 指向上游应用 span。
- Pilot 为 Bash TOOL span 预留一个 span ID。
- 传给用户 CLI 的 `TRACEPARENT` 使用这个 TOOL span ID 作为 parent span ID。
- 用户 CLI 应提取该上下文并创建自己的子 span。

## 功能概述

本功能以 Claude Code 的 `PreToolUse(Bash)` hook 为注入点。

当 Claude Code 准备执行主 Agent 的 Bash 工具时，Pilot 会：

1. 校验 Claude Code 进程继承的 `TRACEPARENT`。
2. 为本次 Bash TOOL span 预留一个新的 span ID。
3. 使用原 trace ID、预留 span ID 和原 trace flags 构造新的
   `TRACEPARENT`。
4. 保留有效的 `TRACESTATE`。
5. 在原 Bash 命令前增加 `export TRACEPARENT=...` 和可选的
   `export TRACESTATE=...`。
6. 在处理 Claude Code Stop hook 时，用同一个预留 span ID 生成
   TOOL span。

例如，上游传给 Claude Code 的上下文是：

```text
00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
```

Pilot 为 Bash TOOL span 预留 `d41591ac92dd2cec` 后，下游 CLI 收到：

```text
00-4bf92f3577b34da6a3ce929d0e0e4736-d41591ac92dd2cec-01
```

各字段的对应关系：

| 字段 | 上游传给 Claude Code | Pilot 传给下游 CLI |
|------|----------------------|---------------------|
| Version | `00` | 保持 `00` |
| Trace ID | `4bf92f...4736` | 保持不变 |
| Parent span ID | 上游应用 span ID | Pilot 的 Bash TOOL span ID |
| Trace flags | `01` | 保持不变 |
| `TRACESTATE` | 可选 | 有效时保持不变 |

## 前置条件

使用本功能前，需要满足以下条件：

1. 已安装并启动 LoongSuite Pilot。
2. Pilot 已启用 Claude Code 采集。
3. Claude Code 的 `PreToolUse(Bash)` 和 `Stop` hook 已由 Pilot 部署。
4. 上游在启动 Claude Code 时提供有效的 `TRACEPARENT`。
5. Pilot 已开启上游 Trace 串联和下游工具传播。
6. 用户 CLI 能读取 W3C Trace Context，并配置自己的 Trace exporter。

可以通过以下命令检查 Pilot：

```bash
loongsuite-pilot status
loongsuite-pilot info
```

## 开启功能

### 推荐：通过配置文件开启

编辑 `~/.loongsuite-pilot/config.json`：

```json
{
  "upstreamLink": {
    "enabled": true,
    "propagateToTools": true
  }
}
```

修改后重启 Pilot：

```bash
loongsuite-pilot restart
```

配置项说明：

| 配置项 | 环境变量 | 默认值 | 说明 |
|--------|----------|--------|------|
| `upstreamLink.enabled` | `LOONGSUITE_PILOT_UPSTREAM_LINK` | `false` | 将 Claude Code span 挂载到上游 Trace |
| `upstreamLink.propagateToTools` | `LOONGSUITE_PILOT_UPSTREAM_LINK_PROPAGATE_TO_TOOLS` | `false` | 将上下文继续传给支持的 CLI 工具 |
| `upstreamLink.ttlMs` | `LOONGSUITE_PILOT_UPSTREAM_LINK_TTL_MS` | `86400000` | 关联状态文件的清理 TTL |

配置优先级为：环境变量 > `config.json` > 内置默认值。

### 通过环境变量开启

如果使用环境变量配置 Pilot，需要确保 Pilot collector 和 Claude Code
进程都能读取对应开关。对于长期使用，推荐写入 `config.json`。

```bash
export LOONGSUITE_PILOT_UPSTREAM_LINK=true
export LOONGSUITE_PILOT_UPSTREAM_LINK_PROPAGATE_TO_TOOLS=true

loongsuite-pilot restart
```

## 启动 Claude Code

必须在启动 Claude Code 时设置上下文；在 Claude Code 已经启动后再修改当前
终端的环境变量不会影响已有进程。

```bash
TRACEPARENT='00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' \
TRACESTATE='vendor=value' \
claude
```

`TRACEPARENT` 必须符合以下格式：

```text
00-<32 位非零 trace ID>-<16 位非零 parent span ID>-<2 位 flags>
```

`TRACESTATE` 是可选项。Pilot 只传播非空、长度不超过 512 且不包含控制字符
的值。

## 下游 CLI 如何接收

Pilot 负责把上下文注入下游进程，但不会替用户 CLI 自动创建或上报 span。
用户 CLI 至少需要完成以下步骤：

1. 读取 `TRACEPARENT` 和可选的 `TRACESTATE`。
2. 使用 W3C Trace Context propagator 提取父上下文。
3. 基于该父上下文创建 CLI 自己的 span。
4. 配置 exporter，将 span 上报到能够与 Pilot Trace 汇聚的后端。
5. CLI 如需调用更下游的服务，应继续注入当前 span 的上下文。

### Node.js 示例

下面的示例只展示上下文提取和创建子 span。SDK、资源属性和 exporter 应按
用户 CLI 的实际环境配置。

```js
import { context, propagation, trace } from '@opentelemetry/api';

const carrier = {
  traceparent: process.env.TRACEPARENT,
  tracestate: process.env.TRACESTATE,
};

const parentContext = propagation.extract(context.active(), carrier);
const tracer = trace.getTracer('my-cli');

await tracer.startActiveSpan(
  'my-cli.operation',
  {},
  parentContext,
  async (span) => {
    try {
      // 执行 CLI 的实际业务逻辑。
    } catch (error) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  },
);
```

注意：环境变量名称是大写的，而 OpenTelemetry carrier 通常使用小写
`traceparent` 和 `tracestate`，因此示例中显式进行了字段映射。

### 最小接收验证

可以先让下游 CLI 打印它实际收到的上下文：

```bash
node -e 'console.log(JSON.stringify({
  traceparent: process.env.TRACEPARENT,
  tracestate: process.env.TRACESTATE
}))'
```

让 Claude Code 通过 Bash 执行该命令。如果功能正常，输出中的 trace ID
应与启动 Claude Code 时提供的 trace ID 相同，但 parent span ID 应变为一个
新的值。

打印环境变量只适合测试。生产 CLI 应提取上下文并创建 span，不建议把
Trace Context 当作业务日志长期输出。

## 安全注意事项

- `TRACEPARENT` 和 `TRACESTATE` 是链路关联数据，不是身份认证凭证。
- 不要在 `TRACESTATE` 中放入 AccessKey、API Key、Cookie、用户输入或其他
  敏感数据。
- 用户 CLI 应校验收到的上下文，并在上下文无效时安全地创建新 Trace 或按
  自身策略 fail-open。
- Pilot 会校验 `TRACEPARENT`、过滤含控制字符的 `TRACESTATE`，并对注入值
  做 shell 单引号转义，但下游 CLI 仍应把环境变量视为外部输入。

## 实现原理

### 1. Hook 注册

Pilot 为 Claude Code 注册以下相关 hook：

- `PreToolUse`，matcher 为 `Bash`。
- `Stop`。

`PreToolUse` 负责在命令执行前预留上下文并返回
`hookSpecificOutput.updatedInput`。Pilot 只替换 `tool_input.command`，保留
`description`、`timeout`、`run_in_background` 等原字段，也不会改变用户
已有的工具权限策略。

### 2. 每个工具调用独立预留

Pilot 使用 `session_id + tool_use_id` 标识一次 Bash 工具调用，并在
`~/.loongsuite-pilot/acp-correlate/` 中保存独立的临时预留记录。

记录采用“每个工具调用一个文件”的方式，并通过独占创建保证：

- 并行 Bash 调用不会争用同一个会话状态文件。
- 重复执行同一个 PreToolUse hook 时会复用相同的预留 span ID。
- 部分写入、文件缺失或状态损坏时能够 fail-open。

过期的预留文件由现有 upstream-link retention 任务清理。

### 3. 安全修改 Bash 命令

Pilot 返回给 Claude Code 的命令结构类似：

```bash
export TRACEPARENT='<downstream-traceparent>';
export TRACESTATE='<tracestate>';
<原始 Bash 命令>
```

注入值使用 shell 单引号转义，能够安全处理 `TRACESTATE` 中的普通标点和
单引号。原始 Bash 命令内容保持不变。

### 4. Stop 阶段复用 TOOL span ID

Stop hook 解析 Claude Code transcript 时，会按 `tool_use_id` 读取并删除预留
记录，然后为对应的 `tool.call` 和 `tool.result` 写入相同的 `span_id`。

OTLP Trace flusher 在创建真实 TOOL span 前，会再次按 tool call ID 找到该
预留 ID，并通过一次性的 span ID generator 让 OpenTelemetry SDK 使用这个
ID。无效、重复冲突或缺失的预留都会回退到 SDK 正常生成的随机 span ID。

### 5. 首轮约束

通过环境变量提供的上游上下文只用于会话首个 turn。首个 Stop hook 完成后，
Pilot 会写入已消费标记，后续 turn 的 Bash 调用不再传播该上下文。这与
现有 TraceLinker 的“环境变量上下文只关联首轮”语义保持一致。

## Fail-open 行为

该能力不会阻断 Claude Code 的正常工具执行。出现以下情况时，Pilot 会跳过
注入并让原 Bash 命令继续执行：

- 功能开关未开启。
- `TRACEPARENT` 缺失、格式错误或包含全零 ID。
- 当前工具不是主 Agent 的 `Bash`。
- 缺少 `session_id` 或 `tool_use_id`。
- 命令为空或工具输入格式不受支持。
- 预留状态文件无法创建、读取或校验。
- 当前会话的环境变量上下文已经消费。

如果预留 ID 无法在 Stop 或 OTLP 转换阶段复用，Pilot 会回退到普通 TOOL
span ID，不影响其他 Trace 数据采集。

## 当前支持范围

首版支持：

- Claude Code。
- 主 Agent。
- 通过环境变量传入的会话首轮上游上下文。
- Claude Code `Bash` 工具调用。
- W3C `TRACEPARENT`。
- 可选的 `TRACESTATE`。

暂不支持：

- Claude Code subagent 的工具调用。
- PowerShell 工具命令。
- MCP 工具。
- 非 Bash 工具。
- 后续 turn 继续使用首轮环境变量上下文。
- 恢复已有会话时注入一份新的环境变量上下文。
- 仅通过 ACP per-turn 关联文件提供、但未出现在 Claude Code 进程环境中的
  下游上下文。

## 如何验证链路

建议同时验证进程侧和 Trace 后端：

1. 下游 CLI 收到了格式正确的 `TRACEPARENT`。
2. 下游 `TRACEPARENT` 的 trace ID 与上游一致。
3. 下游 `TRACEPARENT` 的 parent span ID 等于 Pilot Bash TOOL span ID。
4. Claude Code ENTRY span 的 parent span ID 等于上游 span ID。
5. `TRACESTATE` 在需要时保持一致。
6. 用户 CLI 创建的 span 位于 Bash TOOL span 之下。

只看到环境变量并不代表完整链路已经建立；还需要确认用户 CLI 正确提取
上下文、创建 span，并成功上报。

## 常见问题

### Claude Code 已串到上游，但下游 CLI 没有收到上下文

检查：

- `upstreamLink.propagateToTools` 是否为 `true`。
- 修改配置后是否重启了 Pilot。
- `TRACEPARENT` 是否在启动 Claude Code 时设置。
- Claude Code 调用的是否是主 Agent 的 `Bash`。
- 当前是否已经超过会话首个 turn。

### 下游 CLI 收到了 TRACEPARENT，但后端仍显示为两条 Trace

通常是用户 CLI 没有把环境变量作为 W3C carrier 提取，或者创建 span 时没有
显式使用提取到的 parent context。还应检查 CLI 和 Pilot 是否上报到同一个
可关联的 Trace 后端。

### TRACESTATE 没有传递

检查该值是否为空、超过 512 字符或包含换行等控制字符。无效
`TRACESTATE` 会被忽略，但有效的 `TRACEPARENT` 仍可继续传播。

### 后续 turn 不再注入

这是首版的预期行为。环境变量提供的是会话级启动上下文，为避免错误地把
后续 turn 重挂到首轮上游 span，Pilot 只在首个 turn 中使用和传播它。

### Hook 配置被其他工具覆盖

重新启动 Pilot 并检查状态：

```bash
loongsuite-pilot restart
loongsuite-pilot status
loongsuite-pilot info
```

Pilot 的 hook watchdog 会持续检查受管 hook，但仍应避免手工删除 Pilot
注册的 Claude Code hook。
