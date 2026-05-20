# 核心编排层 (src/core/)

> 系统的中枢，负责启动流程、生命周期管理、Agent 发现与准入控制。

## 模块组成

| 文件 | 职责 |
|------|------|
| `orchestrator.ts` | 顶层编排器，串联所有子系统的启动/关闭 |
| `agent-discovery-service.ts` | Agent 自动发现（fs.watch + 轮询 + 状态机） |
| `agent-control-manager.ts` | 三层准入策略（on / off / auto） |
| `input-manager.ts` | 输入源注册、生命周期、Git 富化、事件分发 |
| `config-loader.ts` | 三级配置优先级加载（环境变量 > 配置文件 > 默认值） |
| `hook-watchdog.ts` | Hook 脚本健康监控 |
| `log-retention-service.ts` | 日志文件保留与清理策略 |

## Orchestrator 启动流程

<!-- TODO: 描述 Orchestrator.start() 的完整启动顺序 -->
<!-- TODO: 列出各子系统的初始化依赖关系 -->
<!-- TODO: 描述优雅关闭（graceful shutdown）流程 -->

## Agent Discovery Service

<!-- TODO: 描述发现机制：fs.watch 监听 + 定时轮询的双保险策略 -->
<!-- TODO: 描述 Agent 状态机（未安装 → 已安装 → 已部署 → 运行中） -->
<!-- TODO: 描述 checkAvailability() 的检测逻辑 -->

## Agent Control Manager

<!-- TODO: 描述三层准入策略的决策流程 -->
<!-- TODO: 描述 agent-control.json 的格式和热加载机制 -->
<!-- TODO: 描述 "auto" 模式下的自动判断逻辑 -->

## Input Manager

<!-- TODO: 描述 Input 注册和生命周期管理 -->
<!-- TODO: 描述 Git 富化（解析当前仓库信息附加到事件） -->
<!-- TODO: 描述事件分发到 MultiFlusher 的流程 -->

## Config Loader

<!-- TODO: 描述配置合并策略和各层优先级 -->
<!-- TODO: 描述配置热更新机制（如果有） -->
<!-- TODO: 列出所有配置项的 key/类型/默认值/说明 -->
