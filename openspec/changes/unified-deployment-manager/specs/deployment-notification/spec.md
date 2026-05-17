## ADDED Requirements

### Requirement: 部署通知文件写入
插件/探针类部署完成后，系统 SHALL 将通知内容写入 `~/.loongsuite-pilot/notifications` 文件。

#### Scenario: Wrapper 部署后通知
- **WHEN** 插件/探针以 wrapper 方式部署成功
- **THEN** 系统 SHALL 写入通知内容，提示用户执行 `hash -r` 或打开新终端

#### Scenario: RC-inject 部署后通知
- **WHEN** 插件/探针以 rc-inject 方式部署成功
- **THEN** 系统 SHALL 写入通知内容，提示用户执行 `source ~/.bashrc` / `source ~/.zshrc` 或打开新终端

#### Scenario: Hook 类部署不产生通知
- **WHEN** agent 以 hook 方式部署成功
- **THEN** 系统 SHALL NOT 写入通知文件（hook 部署对用户透明，无需额外操作）

### Requirement: Shell 启动通知展示
系统 SHALL 通过在 shell RC 文件中注入检查逻辑，在用户打开新终端时自动展示通知。

#### Scenario: 新终端显示通知
- **WHEN** 用户打开新终端且通知文件存在
- **THEN** shell SHALL 显示通知文件内容并自动删除通知文件

#### Scenario: 无通知时无输出
- **WHEN** 用户打开新终端且通知文件不存在
- **THEN** shell SHALL 无任何额外输出（对启动时间无感知影响）

### Requirement: RC 注入安全性
注入到 shell RC 文件的代码 MUST 使用明确的标记注释包裹，便于识别和清理。

#### Scenario: 标记注释格式
- **WHEN** pilot 向 RC 文件注入通知检查逻辑
- **THEN** 注入内容 MUST 包裹在 `# loongsuite-pilot BEGIN` 和 `# loongsuite-pilot END` 标记之间

#### Scenario: 重复注入幂等
- **WHEN** RC 文件中已存在 pilot 标记块
- **THEN** 系统 SHALL 不重复注入，保持幂等性

### Requirement: 通知内容格式
通知内容 SHALL 包含部署的 agent 名称和用户需要执行的操作。

#### Scenario: 通知内容结构
- **WHEN** 系统写入通知
- **THEN** 通知 MUST 包含：(1) pilot 标识前缀 (2) 已部署的 agent 显示名 (3) 用户需执行的具体命令

### Requirement: loongsuite-pilot status 展示
`loongsuite-pilot status` 命令 SHALL 展示待处理的通知内容。

#### Scenario: 有待处理通知
- **WHEN** 用户执行 `loongsuite-pilot status` 且通知文件存在
- **THEN** 系统 SHALL 在状态输出中显示通知内容

#### Scenario: 无通知
- **WHEN** 用户执行 `loongsuite-pilot status` 且通知文件不存在
- **THEN** 状态输出中 SHALL NOT 显示通知相关信息
