# 部署管理层 (src/deployment/)

> 声明式 Agent 部署：通过 agents.d/*.json 描述 Agent 的检测规则和部署方式，DeploymentManager 自动完成检测→部署→状态跟踪。

## 模块组成

| 文件 | 职责 |
|------|------|
| `agent-def-loader.ts` | 加载并解析 `agents.d/*.json` 声明文件 |
| `deployment-manager.ts` | 部署编排（检测→判定→执行→记录） |
| `detect-utils.ts` | Agent 安装检测工具函数 |
| `hook-strategy.ts` | Hook 模式部署策略实现 |
| `plugin-probe-strategy.ts` | Plugin-Probe 模式部署策略实现 |
| `deploy-notification.ts` | 部署状态变更通知 |

## 部署流程

```
DeploymentManager.deployAll()
  │
  ├─ AgentDefLoader.loadAll()       ← 加载 agents.d/*.json
  │
  └─ 对每个 Agent:
       ├─ detect()                  ← 检测 agent 是否已安装
       ├─ needsDeploy()             ← 检查是否需要（重新）部署
       ├─ deploy()                  ← 执行部署
       │   ├─ Hook 模式:           写入 agent 配置文件
       │   └─ Plugin-Probe 模式:   解压插件 + 安装 + 注册 hook
       └─ 记录状态 → deployed-agents.json
```

## agents.d/ 声明文件 Schema

<!-- TODO: 描述声明文件的完整 JSON Schema -->
<!-- TODO: 描述各字段含义（id, displayName, deployMode, detection, hook, pluginProbe, input） -->
<!-- TODO: 描述变量替换规则（$PILOT_DIR, $PILOT_DATA） -->

## Hook 模式 (hook-strategy.ts)

<!-- TODO: 描述 Hook 注入机制（写入 agent 的 settings.json / hooks.json） -->
<!-- TODO: 描述 flat vs nested 两种 Hook 配置格式 -->
<!-- TODO: 描述 Hook 事件列表和每个事件的含义 -->
<!-- TODO: 描述幂等性保证（重复部署不产生副作用） -->

## Plugin-Probe 模式 (plugin-probe-strategy.ts)

<!-- TODO: 描述插件包的解压、npm install、hook 注册流程 -->
<!-- TODO: 描述 otel-config.json 协商机制 -->
<!-- TODO: 描述 wrapper mountType 的工作原理 -->
<!-- TODO: 描述 trust hash 计算（codex 场景） -->

## 检测逻辑 (detect-utils.ts)

<!-- TODO: 描述 paths 检测和 commands 检测的实现 -->
<!-- TODO: 描述检测结果缓存策略 -->

## 状态持久化 (deployed-agents.json)

<!-- TODO: 描述部署状态文件的格式 -->
<!-- TODO: 描述状态变更触发重新部署的条件 -->
