## ADDED Requirements

### Requirement: Agent 定义文件格式
系统 SHALL 支持通过 JSON 文件声明 agent 的完整配置，每个文件描述一个 agent 的标识、检测规则、部署模式和采集输入配置。

#### Scenario: 最小有效定义
- **WHEN** 一个 JSON 文件包含 `id`、`displayName`、`deployMode`、`detection` 字段
- **THEN** 系统 SHALL 将其识别为有效的 agent 定义

#### Scenario: 无效定义文件
- **WHEN** JSON 文件缺少必填字段或格式无效
- **THEN** 系统 SHALL 记录 warning 日志并跳过该定义，不得中断加载流程

### Requirement: 内置定义文件加载
系统 SHALL 从 `$PACKAGE_DIR/agents.d/*.json` 加载内置 agent 定义，这些定义随 pilot 一起发布。

#### Scenario: 加载内置定义
- **WHEN** daemon 启动时
- **THEN** 系统 SHALL 扫描 `agents.d/` 目录，加载所有合法的 JSON 定义文件

#### Scenario: agents.d 目录不存在
- **WHEN** `agents.d/` 目录缺失
- **THEN** 系统 SHALL 记录 warning 并以空定义列表继续启动

### Requirement: 用户自定义定义文件
系统 SHALL 支持用户在 `~/.loongsuite-pilot/agents.d.local/*.json` 放置自定义 agent 定义。

#### Scenario: 用户自定义定义加载
- **WHEN** `agents.d.local/` 目录存在且包含 JSON 文件
- **THEN** 系统 SHALL 加载这些定义，合并到内置定义列表中

#### Scenario: 用户定义覆盖内置定义
- **WHEN** 用户自定义定义文件的 `id` 与内置定义重复
- **THEN** 用户自定义定义 SHALL 覆盖内置定义（完整替换，不做深合并）

### Requirement: 变量模板替换
Agent 定义文件中的路径字段 SHALL 支持变量模板替换。

#### Scenario: $PILOT_DIR 替换
- **WHEN** 定义文件中包含 `$PILOT_DIR`
- **THEN** 系统 SHALL 将其替换为 pilot 安装目录的实际路径

#### Scenario: $PILOT_DATA 替换
- **WHEN** 定义文件中包含 `$PILOT_DATA`
- **THEN** 系统 SHALL 将其替换为运行时数据目录的实际路径（默认 `~/.loongsuite-pilot`）

#### Scenario: ~ 替换
- **WHEN** 定义文件中路径以 `~` 开头
- **THEN** 系统 SHALL 将 `~` 替换为用户 home 目录

### Requirement: Input 配置声明
Agent 定义文件 SHALL 包含 `input` 字段，声明该 agent 的数据采集 Input 类型和参数。

#### Scenario: Hook JSONL 类型 Input
- **WHEN** `input.type` 为 `"hook-jsonl"`
- **THEN** 系统 SHALL 创建对应的 BaseHookInput 子类实例，使用 `input.logDir` 作为日志目录

#### Scenario: 未知 Input 类型
- **WHEN** `input.type` 不匹配任何已注册的 Input 工厂
- **THEN** 系统 SHALL 记录 warning 并跳过该 agent 的 Input 注册

### Requirement: 部署状态持久化
系统 SHALL 将部署结果持久化到 `~/.loongsuite-pilot/deployed-agents.json`，记录每个 agent 的部署状态、时间和版本。

#### Scenario: 部署成功后记录状态
- **WHEN** 一个 agent 部署成功
- **THEN** 系统 SHALL 在 `deployed-agents.json` 中记录 `{ agentId, deployedAt, version, deployMode }`

#### Scenario: 启动时读取部署状态
- **WHEN** daemon 启动时
- **THEN** 系统 SHALL 读取 `deployed-agents.json`，用于 isDeployed() 的快速判断（可跳过重复检测）
