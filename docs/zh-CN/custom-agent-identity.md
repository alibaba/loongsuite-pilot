# 自定义 `gen_ai.agent.name` 和 `agentteams.instance.id`

启动 AI Coding Agent 时设置环境变量，可以自定义 Pilot 采集数据中的 Agent 名称和运行实例。例如，在同一种 Agent 下区分 `planner`、`reviewer`、`coder` 等不同角色。

## 支持范围

| Agent | `gen_ai.agent.type` | 启动命令 |
|-------|---------------------|----------|
| Claude Code | `claude-code` | `claude` |
| Qoder | `qoder` | `qoder` |
| Codex | `codex` | `codex` |
| OpenCode | `opencode` | `opencode` |
| Pi Coding Agent | `pi-coding-agent` | `pi` |
| MiMo Code | `mimo-code` | `mimo` |
| Qwen Code CLI | `qwen-code-cli` | `qwen` |
| Cursor CLI | `cursor-cli` | `cursor-agent` |
| OpenClaw | `openclaw` | `openclaw` |

Cursor Desktop 不支持这组变量。

OpenClaw 当前仅支持 `AGENTTEAMS_WORKER_NAME`，暂不支持
`AGENTTEAMS_INSTANCE_ID`。如果 OpenClaw 运行在容器中，环境变量必须注入
OpenClaw Gateway 所在的容器和进程；修改变量后需要重启或重建容器。

## 设置环境变量

| 环境变量 | 作用 |
|----------|------|
| `AGENTTEAMS_WORKER_NAME` | 设置 `gen_ai.agent.name`，并写入 Resource 属性 `agentteams.worker.name`。 |
| `AGENTTEAMS_INSTANCE_ID` | 写入 Resource 属性 `agentteams.instance.id`，用于区分同一 Worker 的不同运行实例。 |

建议两个变量一起设置：

```bash
export AGENTTEAMS_WORKER_NAME=planner
export AGENTTEAMS_INSTANCE_ID=task-42-worker-1
```

如果由编排系统启动 Agent，请把两个变量分别传入每个 Agent 进程的环境。

## 启动 Agent

设置变量后，正常启动对应 Agent。例如：

```bash
opencode
```

也可以只对一次启动生效：

```bash
AGENTTEAMS_WORKER_NAME=planner \
AGENTTEAMS_INSTANCE_ID=task-42-worker-1 \
opencode
```

其他 Agent 只需将最后一行替换为支持范围表格中的启动命令。

## 输出字段

设置变量后，Pilot 采集的记录包含：

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

- `gen_ai.agent.type` 表示 Agent 产品类型。
- `gen_ai.agent.name` 表示自定义的逻辑 Agent 名称。
- `AGENTTEAMS_INSTANCE_ID` 不会覆盖 Agent 原有的 `gen_ai.agent.id`。

## 验证

完成一个 Agent Turn 后，可以在 Pilot 数据目录中检索相关字段：

```bash
rg 'gen_ai.agent.name|agentteams.worker.name|agentteams.instance.id' \
  ~/.loongsuite-pilot/logs
```

预期结果：

- Turn 内的 GenAI 记录具有正确的 `gen_ai.agent.name`。
- `resourceAttributes` 包含 Worker 名称和 Instance ID。
- OTLP Trace 的 Span 包含 `gen_ai.agent.name`，Resource 包含两个 `agentteams.*` 属性。

## 注意事项

- 环境变量必须设置在 Agent 进程中；修改变量后，请重启已经运行的 Agent。
- 未设置变量时，Pilot 保持 Agent 原有名称和字段行为。
- 空值和超过 512 个字符的值会被忽略。
- Pilot 只采集上述两个变量，其他 `AGENTTEAMS_*` 变量不会写入事件或 Trace。
- `LOONGSUITE_PILOT_SPAN_ATTRIBUTES` 不能用于设置 `gen_ai.agent.name`，请使用 `AGENTTEAMS_WORKER_NAME`。
