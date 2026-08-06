# 为 AgentTeams Worker 标记 GenAI 可观测数据

当同一种 AI Coding Agent 被 AgentTeams 以不同角色或 Worker 启动时，可以通过两个进程环境变量，把逻辑 Worker 身份写入 Pilot 采集的事件和 OTLP Trace。这样可以按 `planner`、`reviewer`、`coder` 等角色筛选调用链，而不需要改变 Agent 产品类型。

## 支持范围

| Agent | 启动命令 | 上下文采集时机 |
|-------|----------|----------------|
| OpenCode | `opencode` | Plugin 初始化时读取；修改变量后需要重启 Agent。 |
| Pi Coding Agent | `pi` | Extension 初始化时读取；修改变量后需要重启 Agent。 |
| MiMo Code | `mimo` | Plugin 初始化时读取；修改变量后需要重启 Agent。 |
| Qwen Code CLI | `qwen` | Stop Hook 执行时读取，并绑定到本次 Turn。 |
| Cursor CLI | `cursor-agent` | 每个 Hook 执行时读取，并通过事件 journal 绑定到本次 Turn。 |

Claude Code、Qoder 和 Codex 也支持相同协议。Cursor Desktop 不读取这组变量，避免 CLI 和桌面端共用 Hook journal 时互相影响。

## 字段映射

| 环境变量 | 可观测字段 | 说明 |
|----------|------------|------|
| `AGENTTEAMS_WORKER_NAME` | `gen_ai.agent.name`、`resourceAttributes["agentteams.worker.name"]` | 逻辑 Worker 名称，例如 `planner`。主 Agent 上优先于 Agent 原生名称。 |
| `AGENTTEAMS_INSTANCE_ID` | `resourceAttributes["agentteams.instance.id"]` | 本次 Worker 运行实例，例如任务或容器实例 ID。不会覆盖 `gen_ai.agent.id`。 |

`gen_ai.agent.type` 始终表示 Agent 产品，例如 `opencode` 或 `qwen-code-cli`。`gen_ai.agent.name` 表示 AgentTeams 中的逻辑角色。二者应配合使用：

```json
{
  "gen_ai.agent.type": "opencode",
  "gen_ai.agent.name": "planner",
  "resourceAttributes": {
    "agentteams.worker.name": "planner",
    "agentteams.instance.id": "task-42-worker-1"
  }
}
```

## 启动 Agent

在启动 Agent 的进程上设置变量。不要只把变量设置到 Pilot daemon；daemon 可能同时接收多个 Worker 的数据，无法替 Agent 判断当前调用身份。

### 单次启动

```bash
AGENTTEAMS_WORKER_NAME=planner \
AGENTTEAMS_INSTANCE_ID=task-42-worker-1 \
opencode
```

将最后一行替换为对应命令即可：

```bash
AGENTTEAMS_WORKER_NAME=reviewer AGENTTEAMS_INSTANCE_ID=task-42-worker-2 pi
AGENTTEAMS_WORKER_NAME=coder AGENTTEAMS_INSTANCE_ID=task-42-worker-3 mimo
AGENTTEAMS_WORKER_NAME=tester AGENTTEAMS_INSTANCE_ID=task-42-worker-4 qwen
AGENTTEAMS_WORKER_NAME=reviewer AGENTTEAMS_INSTANCE_ID=task-42-worker-5 cursor-agent
```

### 当前终端持续生效

```bash
export AGENTTEAMS_WORKER_NAME=planner
export AGENTTEAMS_INSTANCE_ID=task-42-worker-1
opencode
```

OpenCode、Pi Coding Agent 和 MiMo Code 会在 Plugin/Extension 初始化时固定当前上下文。更新 `export` 后，必须退出并重新启动 Agent，不能复用已经运行的进程。

### 编排系统传入

AgentTeams 或其他编排器应为每个 Agent 子进程分别构造环境变量。例如伪代码：

```js
spawn('qwen', [], {
  env: {
    ...process.env,
    AGENTTEAMS_WORKER_NAME: worker.name,
    AGENTTEAMS_INSTANCE_ID: worker.instanceId,
  },
});
```

不要在多个并发 Worker 之间修改同一个长驻 Agent 进程的环境。环境变量是进程级上下文，一个 Agent 进程应只对应一个 Worker。

## 验证采集结果

完成至少一个 Agent Turn 后，可以在 Pilot 数据目录中检索字段：

```bash
rg 'gen_ai.agent.name|agentteams.worker.name|agentteams.instance.id' \
  ~/.loongsuite-pilot/logs
```

预期结果：

- 每条属于该 Turn 的 GenAI Record 都带有正确的 `gen_ai.agent.name`。
- `resourceAttributes` 中包含 Worker 名称和 Instance ID。
- OTLP Trace 的 Span 上包含 `gen_ai.agent.name`，Resource 上包含两个 `agentteams.*` 属性。
- `gen_ai.agent.id` 仍然是 Agent 自己提供的 ID。

## 兼容性与安全

- 未设置两个变量时，Pilot 保持 Agent 原有名称和字段回退行为。
- 空字符串和超过 512 字符的值会被忽略。
- Pilot 只允许采集这两个固定变量。`AGENTTEAMS_TOKEN`、`AGENTTEAMS_SECRET` 等其他变量不会进入事件、日志或 OTLP Resource。
- Qwen Code CLI 同一 session 被不同 Worker 恢复时，以当前 Stop Hook 的环境为准，不会沿用上一次 Worker。
- Cursor CLI 会把上下文保存在当前 conversation 的事件 journal 中，支持 Stop 早于 `afterAgentResponse` 的延迟组装流程。

## 常见问题

### 设置变量后仍然显示 Agent 默认名称

确认变量设置在 Agent 启动命令所在的进程环境中，并重启 OpenCode、Pi Coding Agent 或 MiMo Code。已经运行的 Plugin/Extension 不会重新读取父进程环境。

### Cursor CLI 没有产生完整 Turn

部分 Cursor CLI headless 版本不会触发完整的 Cursor Hook 事件。Worker 上下文只能附加到实际完成组装的 Turn，不能补齐 Agent 本身没有触发的 Hook。

### 是否可以通过 `LOONGSUITE_PILOT_SPAN_ATTRIBUTES` 设置 `gen_ai.agent.name`

不可以。`gen_ai.*` 是 Pilot 管理的保留字段，会从通用 Span Attribute 输入中移除。应使用 `AGENTTEAMS_WORKER_NAME`。
