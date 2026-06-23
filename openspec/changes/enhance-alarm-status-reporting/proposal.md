# Proposal: Enhance Alarm & Status Reporting

## Summary

增强告警事件和状态指标上报系统，解决三个问题：
1. 告警/状态事件缺少 `user_id` 字段，无法定位到具体用户
2. 用户工号（userId）格式异常（如 `{123456}`）无法通过告警发现
3. 缺少用户数据隐私设置（`captureMessageContent`）的可观测性

## Motivation

当前告警和状态上报系统中，仅 L1 `pilot_status` 包含 `user_id`，而 L2 指标（input/flusher/alarm detail）、AlarmEntry、UpdaterEvent 均不携带用户标识。运维侧无法从告警直接定位受影响用户。

此外，部分用户在 config.json 中配置的工号带有花括号（如 `{123456}`），属于格式错误但无感知手段。需要通过低级别告警主动发现并提示修复。

最后，`captureMessageContent` 作为核心隐私开关，其配置状态从未上报，运维侧无法了解用户群体的隐私设置分布。

## Scope

### In Scope
- 所有告警事件（`AlarmEntry`）追加 `user_id` 字段
- 所有 L2 状态指标（`InputMetrics`, `FlusherMetrics`, `AlarmMetrics`）追加 `user_id` 字段
- Updater 进程的 `UpdaterEvent` 和 `AlarmEntry` 追加 `user_id` 字段
- 新增 `AlarmLevel '1'`（info/notice 级别）
- 新增 `USER_ID_FORMAT_ALARM` 告警类型，每次 L1 周期检测并上报
- L1 `pilot_status` 新增 `privacy_settings` 字段，JSON 字符串格式，包含每个 agent 的 `captureMessageContent` 状态

### Out of Scope
- 修改 `user.id` 在 AgentActivityEntry 主数据流中的行为
- 修改 config-loader 的 userId 优先级链
- 变更 SLS logstore 或 topic 结构
- 变更社区版（community build）的 `sendRunningStatus` 白名单

## Affected Baseline Modules

| Module Doc | Impact |
|-----------|--------|
| `docs/modules/monitor.md` | 状态指标扩展（L1/L2 新字段） |
| `docs/modules/core.md` | config-loader 无改动；Orchestrator 传参变更 |
| `docs/modules/updater.md` | UpdaterMetrics 接口扩展 |

本变更不修改基准文档中的约束，仅在已有告警/状态框架内扩展字段和类型。

## Design Decisions

1. **Updater 获取 userId**：在 updater entry (`src/updater/index.ts`) 中从已读取的 config file 直接解析 userId（与 collector 同样的 env > file > hostname 优先级），不扩展 `AutoUpdateConfig` 类型
2. **隐私设置格式**：采用 JSON 字符串（类似已有的 `agent_versions` 字段），键为 agent_type，值为 `{ captureMessageContent: boolean }`
3. **告警级别扩展**：新增 `'1'` 级别（info），用于配置建议类告警，不影响已有 `'2'`/`'3'` 级别的语义
4. **格式校验触发**：每次 L1 写入时检查 userId 格式（因用户可能热修改 config），而非仅启动时
