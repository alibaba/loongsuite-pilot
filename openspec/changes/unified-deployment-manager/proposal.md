## Why

当前系统只支持 Hook 类部署模式（通过 HookManager 向 agent 配置文件注入 hook 命令）。但许多 agent（如 Aider、Python OTel 探针、OpenClaw 等）不提供原生 hook 机制，需要以**插件/探针**的形式（OSS 下载、tar 包解压、wrapper/rc-inject/env-inject 挂载）部署采集能力。目前这类 agent 的接入需要硬编码安装逻辑到安装脚本中，新增 agent 需改代码、改安装脚本，无法通过声明式配置驱动。

## What Changes

- 引入统一的 `DeploymentManager`，作为所有 agent 采集能力部署的编排层，取代 Orchestrator 中硬编码的 `installHooks()` 逻辑
- 定义两种部署策略接口：
  - `HookStrategy`：复用现有 HookManager 能力，负责 hook 类配置注入
  - `PluginProbeStrategy`：新增，负责插件/探针类部署（OSS 下载 / tar 包解压 + wrapper / rc-inject / env-inject 挂载）
- 引入声明式 **Agent 定义文件**（`agents.d/*.json` 内置 + `agents.d.local/*.json` 用户自定义），每个 agent 通过 JSON 声明其 `deployMode`、检测规则、部署配置和采集输入配置
- 将 Orchestrator 中硬编码的 agent 检测、hook 安装、Input 注册逻辑改为由 Agent 定义文件数据驱动
- 新增 Shell 通知机制：插件/探针类部署完成后写入通知文件（`~/.loongsuite-pilot/notifications`），用户打开新终端时自动展示并清除

## Capabilities

### New Capabilities
- `plugin-probe-deploy`: 插件/探针类部署策略，支持 OSS 下载 / tar 包解压，以及 wrapper / rc-inject / env-inject 三种挂载方式
- `agent-definition`: 声明式 Agent 定义文件格式与加载机制，支持内置 + 用户自定义，驱动检测、部署、采集全流程
- `deployment-notification`: 部署完成后的 Shell 通知机制，通过通知文件 + RC 注入的检查逻辑，在新终端中提示用户

### Modified Capabilities
_(无需修改现有 spec 级别的行为要求)_

## Impact

### Affected Baseline Modules
- **core** (`core.md`): Orchestrator 启动序列变更——`installHooks()` + 硬编码 `registerAllInputs()` 替换为 `DeploymentManager.deployAll()` + 数据驱动的 Input 注册
- **hooks** (`hooks.md`): HookManager 本身不变，但被 `HookStrategy` 包装调用，不再由 Orchestrator 直接使用
- **types** (`types.md`): 新增 Agent 定义文件的类型定义（`AgentDefinition`、`DeployMode`、`PluginProbeConfig` 等）
- **inputs** (`inputs.md`): Input 注册方式从硬编码转为由 Agent 定义中的 `input` 字段驱动

### 代码影响
- 新增 `src/deployment/` 目录：`deployment-manager.ts`、`hook-strategy.ts`、`plugin-probe-strategy.ts`
- 新增 `agents.d/` 目录：内置 agent 定义 JSON 文件
- 修改 `src/core/orchestrator.ts`：简化启动流程，委派给 DeploymentManager
- 新增通知相关工具函数

### 运行时目录变更
- 新增 `~/.loongsuite-pilot/probes/`：已部署的插件/探针存放目录
- 新增 `~/.loongsuite-pilot/notifications`：部署通知文件
- 新增 `~/.loongsuite-pilot/agents.d.local/`：用户自定义 agent 定义目录