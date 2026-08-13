# 本地 Dashboard 与运维手册

本文档随 `loongsuite-pilot` 安装包一起分发，安装完成后自动写入
`~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/monitoring.md`，随 Pilot 升级自动更新。

## 速查表

| 项目 | 路径 / 地址 |
|------|------------|
| CLI 入口 | `~/.local/bin/loongsuite-pilot` |
| 服务日志 | `~/.loongsuite-pilot/logs/loongsuite-pilot-service.log` |
| 自动更新日志 | `~/.loongsuite-pilot/logs/loongsuite-pilot-updater.log` |
| Dashboard 地址 | `http://127.0.0.1:18765/` |
| Dashboard 数据 | `~/.loongsuite-pilot/logs/metrics-summary.json` |
| Node 路径锁定 | `~/.loongsuite-pilot/node-bin` |

### CLI 命令一览

```text
loongsuite-pilot start           # 启动采集服务和本地 Dashboard
loongsuite-pilot stop            # 停止采集服务和本地 Dashboard
loongsuite-pilot restart         # 重启采集服务和本地 Dashboard
loongsuite-pilot status          # 查看服务、更新器和 Dashboard 地址
loongsuite-pilot info            # 查看版本、配置路径、Node 信息
loongsuite-pilot token-usage     # 查看 Token 使用情况
loongsuite-pilot rollback        # 回滚到上一个版本
```

## 本地 Dashboard

Dashboard 由采集主进程直接托管，不需要额外启动命令，也不会自动弹出浏览器。执行：

```bash
~/.local/bin/loongsuite-pilot start
~/.local/bin/loongsuite-pilot status
```

服务正常时，`status` 会显示 Dashboard 地址。默认访问：

```text
http://127.0.0.1:18765/
```

服务固定监听 `127.0.0.1:18765`，不向局域网或公网暴露。

Dashboard 前端只请求 `GET /metrics-summary.json`，服务端会原样返回
`logs/metrics-summary.json`。该汇总文件由 Pilot 主进程默认生成：启动约 5 秒后首次写入，
之后通常每 60 秒更新一次。页面不会再次扫描或聚合 `logs/output/*.jsonl`。

Agent 卡片来自 `ranges.today.agentShares`，因此新增 Agent 类型会自动出现，无需维护固定清单。

## 全面健康检查

```bash
~/.local/bin/loongsuite-pilot status
~/.local/bin/loongsuite-pilot info
ls -la ~/.loongsuite-pilot/logs/output/
ls -l ~/.loongsuite-pilot/logs/metrics-summary.json
curl -fsS http://127.0.0.1:18765/metrics-summary.json
ls ~/.loongsuite-pilot/sls-failed-logs/ 2>/dev/null || echo "无上报失败记录"
```

若 Dashboard 返回 `503`，表示 `metrics-summary.json` 尚未生成。先等待首次汇总；持续超过
一分钟时，检查采集服务状态和 `loongsuite-pilot-service.log` 中的
`MetricsSummaryWriter` 日志。

## 实时查看数据流

```bash
# 查看原始输入（Cursor 为例）
tail -f ~/.loongsuite-pilot/logs/cursor-hook/history/cursor-$(date +%Y-%m-%d).jsonl

# 查看归一化输出
find ~/.loongsuite-pilot/logs/output -name '*.jsonl' -type f -print
```

## 强制重启

更新异常或服务假死时，可以停止后重新启动：

```bash
~/.local/bin/loongsuite-pilot stop
sleep 2
~/.local/bin/loongsuite-pilot start
~/.local/bin/loongsuite-pilot status
```

## 版本回滚

```bash
~/.local/bin/loongsuite-pilot rollback
~/.local/bin/loongsuite-pilot status
~/.local/bin/loongsuite-pilot info
```
