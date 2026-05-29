## 1. 类型定义与接口

- [x] 1.1 在 `src/types/` 中定义 `AgentDefinition` 接口（id, displayName, deployMode, detection, hook, pluginProbe, input 字段）
- [x] 1.2 定义 `DeployStrategy` 接口（detect, needsDeploy, deploy, undeploy 方法签名）
- [x] 1.3 定义 `DeployResult` 类型（success, agentId, deployMode, error? 字段）
- [x] 1.4 定义 `PluginProbeConfig` 接口（source, install, mountType 字段）
- [x] 1.5 定义 `DeployedAgentRecord` 接口（agentId, deployMode, deployedAt, sourceHash 字段）

## 2. Agent 定义文件加载

- [x] 2.1 创建 `src/deployment/agent-def-loader.ts`，实现从 `agents.d/` 和 `agents.d.local/` 加载 JSON 定义文件
- [x] 2.2 实现变量模板替换逻辑（`$PILOT_DIR`、`$PILOT_DATA`、`~` 展开）
- [x] 2.3 实现用户自定义定义覆盖内置定义的合并逻辑（按 id 去重，local 优先）
- [x] 2.4 添加定义文件校验（必填字段检查，无效文件记录 warning 并跳过）
- [x] 2.5 为现有 agent（Cursor、Qoder CLI、QoderWork、Claude Code、Codex）创建内置定义文件到 `agents.d/` 目录

## 3. HookStrategy 实现

- [x] 3.1 创建 `src/deployment/hook-strategy.ts`，实现 `DeployStrategy` 接口
- [x] 3.2 实现 detect()：根据 AgentDefinition.detection 配置检查路径/命令存在性
- [x] 3.3 实现 isDeployed()：委派给 HookManager.isHookInstalled()，从 AgentDefinition.hook 构造 HookDefinition
- [x] 3.4 实现 deploy()：委派给 HookManager.installHook()，处理 Cursor hooks.json 的 version 字段初始化等特殊逻辑
- [x] 3.5 实现 undeploy()：委派给 HookManager.uninstallHook()

## 4. PluginProbeStrategy 实现

- [x] 4.1 创建 `src/deployment/plugin-probe-strategy.ts`，实现 `DeployStrategy` 接口
- [x] 4.2 实现 detect()：根据 detection.paths 和 detection.commands 检查 agent 是否安装
- [x] 4.3 实现 tar 包解压逻辑：从 `source.tarball` 解压到 `source.destDir`
- [x] 4.4 实现 OSS 下载逻辑：从 `source.remoteUrl` 下载到 destDir（本地 tarball 不存在时的 fallback）
- [x] ~~4.5 实现插件安装命令执行：在 `install.cwd` 下执行 `install.command` + `install.args`~~（已被 4.8-4.12 替代）
- [x] 4.6 实现 needsDeploy()：计算源文件（tarball）的 SHA-256 哈希，与 `deployed-agents.json` 中记录的 `sourceHash` 比对，哈希不同或记录不存在则需要部署
- [x] 4.7 deploy 完成后将 sourceHash 写入 `deployed-agents.json`，并根据 `mountType` 调用通知工具写入通知文件（首次安装和更新都通知）

- [ ] 4.8 重构 PluginProbeStrategy.deploy() 为 convention-based：按约定查找 `scripts/install.sh`（优先 `$PILOT_DIR/scripts/plugin-install-{id}.sh` wrapper）
- [ ] 4.9 实现环境变量 contract：执行脚本时设置 `PILOT_DATA_DIR`、`PILOT_LOG_DIR`、`PILOT_NODE_BIN`、`PILOT_NPM_BIN`
- [ ] 4.10 实现更新时先 uninstall：deploy 前检查旧 destDir 是否有 `scripts/uninstall.sh`，有则先执行
- [ ] 4.11 移除 `PluginInstallConfig` 在 `PluginProbeConfig` 中的引用（`install` 字段），PluginProbeStrategy 构造函数接收 `dataDir` 和 `pilotDir`
- [ ] 4.12 创建过渡 wrapper 脚本 `scripts/plugin-install-claude.sh` 和 `scripts/plugin-install-codex.sh`

## 5. DeploymentManager 编排层

- [x] 5.1 创建 `src/deployment/deployment-manager.ts`，组合 AgentDefLoader + 策略选择 + 状态追踪
- [x] 5.2 实现 deployAll()：遍历定义，选择策略，执行 detect → needsDeploy → deploy 流程
- [x] 5.3 实现部署状态持久化到 `deployed-agents.json`（读写 + sourceHash 记录）
- [x] 5.4 实现部署失败容错：单个 agent 失败不中断整体流程，记录错误日志
- [x] 5.5 实现 deploySingle(agentDef)：供运行时动态发现场景调用，部署单个 agent 并注册 Input

## 6. 部署通知机制

- [x] 6.1 创建通知工具函数：根据挂载方式生成通知内容并追加写入 `~/.loongsuite-pilot/notifications`
- [x] 6.2 生成 RC 注入脚本内容（`if -f notifications; then cat; rm; fi`），带 `# loongsuite-pilot BEGIN/END` 标记
- [x] 6.3 在 `loongsuite-pilot status` 命令中展示待处理通知

## 7. Orchestrator 集成与动态发现

- [x] 7.1 修改 Orchestrator.start()：用 DeploymentManager.deployAll() 替换 installHooks()
- [x] 7.2 保留现有 registerAllInputs() 作为过渡期 fallback，确保向后兼容
- [x] 7.3 扩展 AgentDiscoveryService：将所有 agent 定义的 detection.paths 注册为 watchPaths，发现新 agent 时发射 `agent:discovered` 事件
- [x] 7.4 DeploymentManager 监听 `agent:discovered` 事件，调用 deploySingle() 完成部署 → 通知 → Input 注册
- [ ] 7.5 将 PluginHookWatchdog 的 targets 配置也迁移为从 agent 定义文件读取（可选，低优先级）

## 7.6 Installer 插件逻辑迁移

- [ ] 7.6.1 更新 `agents.d/claude-code.json` 和 `agents.d/codex.json`：移除 `install` 字段
- [ ] 7.6.2 从 `deploy/installer.sh` 中删除 `install_otel_plugin()` 函数及相关调用和常量
- [ ] 7.6.3 从 `deploy/installer.sh` 的 `print_summary()` 中移除插件相关提示

## 8. 测试

- [x] 8.1 为 AgentDefLoader 编写单元测试（加载、合并、校验、变量替换）
- [x] 8.2 为 HookStrategy 编写单元测试（detect/isDeployed/deploy 与 HookManager 的委派关系）
- [ ] 8.3 为 PluginProbeStrategy 编写单元测试（detect、tar 解压、convention-based 脚本执行、环境变量传递、更新时先 uninstall、哈希比对更新检测）
- [x] 8.4 为 DeploymentManager 编写集成测试（全量部署、哈希变化触发更新、失败容错）
- [x] 8.5 为动态发现流程编写测试（agent:discovered → deploySingle → Input 注册）
- [x] 8.6 为通知机制编写单元测试（通知文件写入、RC 注入幂等性、更新场景也触发通知）
