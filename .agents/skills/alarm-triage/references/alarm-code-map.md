# 告警类型 → 代码入口

巡检时按 `alarm_type` 与样本 `alarm_message` 定位发射点，再读上下游逻辑。
下表只是入口；合格结论还须按 [deep-analysis.md](deep-analysis.md) 做 SLS 验证与子 Agent 深挖。

| alarm_type | 主要发射点 | 建议顺藤摸瓜 |
|---|---|---|
| `SERVICE_NOT_RUNNING_ALARM` | `src/core/updater-watchdog.ts`（`recordServiceAlarm`）；`src/updater/updater-metrics.ts` | watchdog 探活 / 心跳 / restart 链路；服务进程是否被判定未运行 |
| `UPDATER_FAILURE_ALARM` | `src/core/updater-watchdog.ts`（`recordFailureAlarm`）；`src/updater/updater.ts`（`writeAlarm` / update check） | 心跳 pid 不一致、update check 失败、restart 失败；对照样本 msg 选分支 |
| `UPDATER_NOT_RUNNING_ALARM` | `src/metrics/metrics-writer.ts`（infra alarm） | 守护进程存活检测、heartbeat 文件、init_type / nohup |
| `DEGRADED_STARTUP_ALARM` | `src/metrics/metrics-writer.ts` | 降级启动条件、启动路径与配置缺失 |
| `FLUSH_SEND_ALARM` | `src/flushers/sls-flusher.ts` | SLS 发送失败 / 重试 / endpoint；是否与 `FLUSH_QUOTA_ALARM` 混淆 |
| `PROCESS_RESOURCE_ALARM` | `src/metrics/metrics-writer.ts` | CPU/内存采样阈值、进程采样逻辑 |
| `INPUT_STOP_ALARM` | `src/core/orchestrator.ts` | Input 生命周期、停止/卸载、采集中断 |
| `BROKEN_VERSION_POINTER_ALARM` | `src/metrics/metrics-writer.ts` | `~/.loongsuite-pilot/current` 与 versions 目录一致性 |
| `INVALID_NODE_BIN_ALARM` | `src/metrics/metrics-writer.ts` | node 二进制校验、打包/安装路径 |

类型定义：`src/metrics/alarm-manager.ts`（`AlarmType`）。

检索提示：

```bash
rg -n "UPDATER_FAILURE_ALARM|SERVICE_NOT_RUNNING_ALARM" src/
```

对样本消息再搜字面量或关键片段（例如 `heartbeat pid`、`does not match`）。
