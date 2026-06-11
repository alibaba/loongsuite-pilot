## Capability: qoder-work-cn-data-collection

通过 Hook JSONL、SDK log tail、SQLite polling 三种方式采集 QoderWork CN 桌面应用的 agent 活动数据。

## Requirements

### REQ-1: ClientType 枚举

- 新增 `ClientType.QoderWorkCN = 'qoder-work-cn'`
- 在 IDE tools 分组中（与 QoderWork 相邻）

### REQ-2: Agent 描述文件

- `agents.d/qoder-work-cn.json` 包含：
  - `id`: `"qoder-work-cn"`
  - `displayName`: `"QoderWork CN"`
  - `deployMode`: `"hook"`
  - `detection.paths`: `["~/.qoderworkcn"]`
  - `hook.settingsPath`: `"~/.qoderworkcn/settings.json"`
  - `hook.events`: `["Stop"]`
  - `hook.format`: `"nested"`
  - `hook.matcher`: `"*"`
  - `input.type`: `"hook-jsonl"`
  - `input.logDir`: `"$PILOT_DATA/logs/qoder-work-cn/history"`

### REQ-3: 参数化 QoderWorkInput

- constructor 接受 `agentType` 参数（默认 `ClientType.QoderWork`）
- constructor 接受 `detectionPath` 参数（默认 `~/.qoderwork`）
- `id` 属性根据 agentType 动态生成
- `transformRecord` 使用实例 agentType 而非硬编码
- `checkAvailability()` 使用实例的 detectionPath
- 现有 QoderWork 调用方无需任何改动（默认值兼容）

### REQ-4: 参数化 QoderWorkLogInput

- constructor 接受 `agentType` 参数（默认 `ClientType.QoderWork`）
- `id` 属性根据 agentType 动态生成
- 所有内部 `ClientType.QoderWork` 引用替换为 `this.agentType`
- `resolveQoderWorkRoot()` 支持 variant 参数或新增 CN 专用函数
- 现有 QoderWork 调用方无需任何改动

### REQ-5: 参数化 QoderWorkSqliteInput

- constructor 接受 `agentType` 参数（默认 `ClientType.QoderWork`）
- `id` 属性根据 agentType 动态生成
- `transformRow` 使用传入的 agentType
- 现有 QoderWork 调用方无需任何改动

### REQ-6: Hook 脚本

- 新增 `assets/hooks/qoderworkcn-loongsuite-pilot-hook.sh`
- 默认 `AGENT_ID="qoder-work-cn"`
- 复用同一个 `hook-processor.mjs`
- 数据写入 `~/.loongsuite-pilot/logs/qoder-work-cn/history/qoder-work-cn-YYYY-MM-DD.jsonl`

### REQ-7: Orchestrator 注册

- 当检测到 `~/.qoderworkcn` 存在时，实例化三个 CN input
- 三个 input 的 id 分别为 `qoder-work-cn-hook`、`qoder-work-cn-log`、`qoder-work-cn-sqlite`
- Hook 注入使用 `~/.qoderworkcn/settings.json` 路径

### REQ-8: Agent System Map

- 在 agent-system-map 中为 `qoder-work-cn` 添加 model/provider 映射
- 映射规则与 `qoder-work` 相同

## Acceptance Criteria

- `pilot ensure` 在检测到 `~/.qoderworkcn` 后自动注册三个 CN input
- Hook 脚本被安装到 `~/.loongsuite-pilot/hooks/qoderworkcn-loongsuite-pilot-hook.sh`
- Hook 配置被注入到 `~/.qoderworkcn/settings.json`
- SDK 日志被正确 tail 并产生 `llm.response` / `tool.call` entries
- SQLite 被正确 poll 并产生 `llm.request` / `tool.result` entries
- 所有 entry 的 `agent.type` 为 `qoder-work-cn`
- 现有 QoderWork（国际版）功能不受影响
- 单元测试覆盖三个 input 的 CN 变体
