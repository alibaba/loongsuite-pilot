## Why

外部（非 inner）安装脚本当前不支持以下能力：
1. **安装时 agent 探测** — 用户不知道机器上有哪些 agent 可以采集，需要手动查找
2. **交互式 agent 选择** — 安装后所有 agent 自动启动，无法按需选择
3. **CMS / Trace 参数** — 缺少 CMS 后端和采集类型控制的配置入口
4. **非管道式安装** — 外部用户需要交互式安装体验

内部（inner）脚本保持现有行为不变——运行时自动探测、无需用户交互。

## What Changes

### 安装脚本（非 inner）
- 新增 CLI 参数：`--collect-log`、`--collect-trace`、`--cms-license-key`、`--cms-endpoint`、`--cms-workspace`、`--service-name-prefix`
- 安装时调用 Node.js 探测脚本（`dist/cli-probe.js`）获取机器上可用的 agent 列表
- 展示交互式菜单供用户选择要启用的 agent
- 将所有参数（含 agent 选择结果）持久化到 `config.json`

### TypeScript 代码
- 新增 `src/cli-probe.ts` 入口——供安装脚本调用，读取 `agents.d/*.json` 并执行探测逻辑，输出 JSON 结果
- `ConfigFile` interface 新增字段：`collectLog`、`collectTrace`、`cms`、`serviceNamePrefix`、`agents[id].enabled`
- `AnalyticsConfig` 类型同步更新
- 非 inner 构建的运行时根据 `config.agents[id].enabled` 决定是否部署/启动 agent（不再 auto-detect）

### 兼容性
- `config.json` 中不存在 `agents` 字段时，运行时保持现有 auto-detect 行为（向后兼容）
- Inner 构建（`__INTERNAL_BUILD__ = true`）忽略 `config.agents`，继续 auto-detect

## Capabilities

### New Capabilities
- `install-time-probe`: 安装时通过 Node.js 代码执行一次性 agent 探测
- `interactive-agent-selection`: 交互式菜单让用户选择启用哪些 agent
- `cms-config`: CMS 后端参数配置（预留，本次不实现 flusher）
- `collect-control`: `collectLog` / `collectTrace` 全局采集开关

### Modified Capabilities
- `config-loader`: 新增字段解析与 AnalyticsConfig 构建
- `agent-discovery`: 非 inner 构建时尊重 config.agents.enabled，跳过 auto-detect

## Impact

### Affected Baseline Modules
- **core** (`docs/modules/core.md`): ConfigLoader 新增字段、AgentDiscoveryService 行为分叉（inner vs non-inner）
- **types** (`docs/modules/types.md`): AnalyticsConfig 新增 CMS、collectLog/Trace、agents.enabled 字段

### 代码影响
- 新增 `src/cli-probe.ts`
- 修改 `src/core/config-loader.ts`（新字段解析）
- 修改 `src/types/index.ts`（类型扩展）
- 修改 `src/core/agent-discovery-service.ts` 或 `src/deployment/deployment-manager.ts`（enabled 门控）
- 修改 `deploy/installer.sh`（非 inner 版本）
- 修改 `build.mjs`（新增 cli-probe 入口构建）

### Baseline Documentation Updates
- `docs/modules/core.md`: 更新 ConfigLoader 字段说明，新增 "Install-time probe" 段落描述 AgentDiscovery 的分叉行为
- `docs/modules/types.md`: 新增 CMS、collectLog/Trace、agents.enabled 类型说明

### No Baseline Modification Required
本变更不修改架构原则或数据流——仅扩展配置字段和安装时行为。CMS flusher 实现留给后续 change。
