## ADDED Requirements

### Requirement: DeployStrategy interface
系统 SHALL 定义统一的 `DeployStrategy` 接口，包含 `detect()`、`needsDeploy()`、`deploy()`、`undeploy()` 四个方法。所有部署模式 MUST 实现此接口。

#### Scenario: Hook 类部署使用 HookStrategy
- **WHEN** agent 定义的 `deployMode` 为 `"hook"`
- **THEN** DeploymentManager SHALL 使用 HookStrategy 执行部署，HookStrategy 内部 MUST 委派给现有 HookManager

#### Scenario: 插件/探针类部署使用 PluginProbeStrategy
- **WHEN** agent 定义的 `deployMode` 为 `"plugin-probe"`
- **THEN** DeploymentManager SHALL 使用 PluginProbeStrategy 执行部署

### Requirement: DeploymentManager 统一编排
DeploymentManager SHALL 加载所有 agent 定义文件，按策略执行全量部署，并追踪部署状态。

#### Scenario: 全量部署流程
- **WHEN** DeploymentManager.deployAll() 被调用
- **THEN** 系统 SHALL 遍历所有 agent 定义，对每个定义依次执行 detect → needsDeploy → deploy（若需要部署），并将部署结果（含 sourceHash）记录到 `deployed-agents.json`

#### Scenario: Agent 未安装时跳过部署
- **WHEN** strategy.detect() 返回 false（agent 未安装在目标机器上）
- **THEN** DeploymentManager SHALL 跳过该 agent 的部署，不报错

#### Scenario: 源文件未变化时跳过
- **WHEN** strategy.needsDeploy() 比对源文件哈希与 `deployed-agents.json` 中记录的 sourceHash 相同
- **THEN** DeploymentManager SHALL 跳过该 agent 的 deploy()，避免重复安装

### Requirement: PluginProbeStrategy 探测能力
PluginProbeStrategy.detect() SHALL 根据 agent 定义中的 `detection` 配置判断 agent 是否已安装。

#### Scenario: 通过路径探测
- **WHEN** agent 定义的 `detection.paths` 中任一路径存在
- **THEN** detect() SHALL 返回 true

#### Scenario: 通过命令探测
- **WHEN** agent 定义的 `detection.commands` 中任一命令可执行（`which` 返回成功）
- **THEN** detect() SHALL 返回 true

#### Scenario: 所有探测条件不满足
- **WHEN** paths 和 commands 均不存在
- **THEN** detect() SHALL 返回 false

### Requirement: PluginProbeStrategy OSS 下载
当 agent 定义的 `pluginProbe.source.type` 为 `"oss"` 时，PluginProbeStrategy.deploy() SHALL 从配置的 URL 下载插件包到本地目标目录。

#### Scenario: OSS 下载成功
- **WHEN** source.type 为 "oss" 且 URL 可达
- **THEN** 系统 SHALL 下载文件到 `~/.loongsuite-pilot/probes/<agentId>/` 目录

#### Scenario: OSS 下载失败
- **WHEN** 网络不可达或 URL 错误
- **THEN** deploy() SHALL 返回失败状态（`DeployResult.success = false`），不得抛出异常，不得中断其他 agent 的部署

### Requirement: PluginProbeStrategy tar 包解压
当 agent 定义的 `pluginProbe.source.type` 为 `"tar"` 时，PluginProbeStrategy.deploy() SHALL 从本地 tar 包解压到目标目录。

#### Scenario: tar 包解压
- **WHEN** source.type 为 "tar" 且 `source.tarball` 指定的 tar 包存在
- **THEN** 系统 SHALL 解压到 `source.destDir` 指定的目录

#### Scenario: 本地 tarball 不存在且有远程 fallback
- **WHEN** source.type 为 "tar" 且本地 tarball 不存在，但 `source.remoteUrl` 已配置
- **THEN** 系统 SHALL 从 remoteUrl 下载并安装

### Requirement: Convention-based 插件安装脚本执行
PluginProbeStrategy.deploy() 在包获取完成后，SHALL 按约定查找并执行插件自带的安装脚本。宿主不理解插件的安装细节，只负责调用约定入口并通过环境变量传递宿主信息。

#### Scenario: 执行插件安装脚本
- **WHEN** 解压后 destDir 下存在 `scripts/install.sh`
- **THEN** 系统 SHALL 执行该脚本，并通过环境变量传递 `PILOT_DATA_DIR`、`PILOT_LOG_DIR`、`PILOT_NODE_BIN`、`PILOT_NPM_BIN`

#### Scenario: 过渡期 wrapper 优先
- **WHEN** `$PILOT_DIR/scripts/plugin-install-{id}.sh` 存在
- **THEN** 系统 SHALL 优先执行该 wrapper 脚本，而非插件自带的 `scripts/install.sh`

#### Scenario: 安装脚本不存在
- **WHEN** 解压后 destDir 下不存在 `scripts/install.sh`，且无 pilot 侧 wrapper
- **THEN** 系统 SHALL 跳过安装步骤，仅完成解压，返回成功

#### Scenario: 安装脚本失败
- **WHEN** 安装脚本返回非零退出码
- **THEN** deploy() SHALL 返回失败状态，不得抛出异常

### Requirement: 插件更新时先卸载
PluginProbeStrategy.deploy() 在检测到需要更新（tarball hash 变化）时，SHALL 在重新安装前尝试执行旧版本的卸载脚本。

#### Scenario: 更新时旧版本有 uninstall 脚本
- **WHEN** needsDeploy() 返回 true 且旧 destDir 下存在 `scripts/uninstall.sh`
- **THEN** 系统 SHALL 先执行旧版的 `scripts/uninstall.sh`（传递相同环境变量），再清空 destDir，再解压新包并执行 `scripts/install.sh`

#### Scenario: 更新时旧版本无 uninstall 脚本
- **WHEN** needsDeploy() 返回 true 且旧 destDir 下不存在 `scripts/uninstall.sh`
- **THEN** 系统 SHALL 直接清空 destDir，解压新包并执行 `scripts/install.sh`（依赖 install.sh 幂等性）

#### Scenario: 卸载脚本失败不阻塞更新
- **WHEN** `scripts/uninstall.sh` 执行失败（非零退出码）
- **THEN** 系统 SHALL 记录 warning 日志并继续执行后续的清空 + 解压 + 安装流程

### Requirement: mountType 仅用于通知
`pluginProbe.mountType` 字段 SHALL 仅用于决定部署通知的内容（提示用户执行 `hash -r` / `source ~/.bashrc` / 打开新终端），DeploymentManager 不负责执行具体的挂载操作。

#### Scenario: mountType 决定通知内容
- **WHEN** 插件部署成功且 mountType 为 "wrapper"
- **THEN** 系统 SHALL 写入通知提示用户执行 `hash -r` 或打开新终端

### Requirement: 插件更新检测（哈希比对）
PluginProbeStrategy.needsDeploy() SHALL 通过源文件的 SHA-256 哈希值判断插件是否需要更新。

#### Scenario: 首次部署（无记录）
- **WHEN** `deployed-agents.json` 中无该 agent 的记录
- **THEN** needsDeploy() SHALL 返回 true

#### Scenario: 源文件哈希变化（pilot 更新带来新版插件）
- **WHEN** 当前 tarball 的 SHA-256 与 `deployed-agents.json` 中记录的 sourceHash 不同
- **THEN** needsDeploy() SHALL 返回 true，deploy() 执行后更新 sourceHash 记录

#### Scenario: 源文件哈希未变化
- **WHEN** 当前 tarball 的 SHA-256 与记录的 sourceHash 相同
- **THEN** needsDeploy() SHALL 返回 false，跳过安装

#### Scenario: 更新部署后通知用户
- **WHEN** 因哈希变化触发的重新部署完成
- **THEN** 系统 SHALL 写入通知文件，提醒用户插件已更新

### Requirement: 运行时动态 agent 发现
AgentDiscoveryService SHALL 监测所有 agent 定义的 detection.paths，发现新 agent 时触发 DeploymentManager 进行部署。

#### Scenario: daemon 运行中检测到新 agent
- **WHEN** daemon 运行期间用户安装了新 agent（detection.paths 从不存在变为存在）
- **THEN** AgentDiscoveryService SHALL 发射 `agent:discovered` 事件，DeploymentManager 收到后执行 deploySingle() 完成部署并注册 Input

#### Scenario: 动态部署后通知用户
- **WHEN** 运行时动态部署成功
- **THEN** 系统 SHALL 写入通知文件（与启动时部署行为一致）

### Requirement: 部署幂等性
所有部署操作 MUST 为幂等的——重复执行不应产生重复条目或副作用。

#### Scenario: 重复部署 hook
- **WHEN** 对已安装 hook 的 agent 再次执行 deploy()
- **THEN** 系统 SHALL 检测到已安装并跳过，返回成功

#### Scenario: 重复部署插件（哈希未变）
- **WHEN** 对已部署插件的 agent 再次调用 needsDeploy()，且 sourceHash 未变
- **THEN** 系统 SHALL 返回 false，不执行 deploy()

### Requirement: 部署失败不中断主流程
单个 agent 的部署失败 MUST NOT 中断 daemon 启动或其他 agent 的部署。

#### Scenario: 某 agent 部署失败
- **WHEN** 一个 agent 的 deploy() 返回失败
- **THEN** DeploymentManager SHALL 记录错误日志并继续处理下一个 agent
