# 观测面板与运维手册

本文档随 `loongsuite-pilot` 安装包一起分发，安装完成后自动写入
`~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/monitoring.md`，随 pilot 升级自动更新。

---

## 速查表

| 项目 | 路径 / 地址 |
|------|------------|
| CLI 入口 | `~/.local/bin/loongsuite-pilot` |
| 服务日志 | `~/.loongsuite-pilot/logs/loongsuite-pilot-service.log` |
| 自动更新日志 | `~/.loongsuite-pilot/logs/loongsuite-pilot-updater.log` |
| 监控面板地址 | `http://127.0.0.1:8765/` |
| Node 路径锁定 | `~/.loongsuite-pilot/node-bin` |

### CLI 命令一览

```
loongsuite-pilot start           # 启动采集服务
loongsuite-pilot stop            # 停止采集服务
loongsuite-pilot restart         # 重启采集服务
loongsuite-pilot status          # 查看服务 + 更新器 + 监控状态
loongsuite-pilot info            # 查看版本、配置路径、Node 信息
loongsuite-pilot monitor start   # 启动进程监控 + 面板
loongsuite-pilot monitor stop    # 停止进程监控 + 面板
loongsuite-pilot rollback        # 回滚到上一个版本
```

---

## 观测面板

### 启动监控面板

```bash
~/.local/bin/loongsuite-pilot monitor start
```

成功输出示例：

```
✅ loongsuite-pilot process monitor started (PID 12345)
✅ loongsuite-pilot dashboard started (PID 12346)
   open http://127.0.0.1:8765/
```

### 验证采集正常

1. 浏览器打开 `http://127.0.0.1:8765/`
2. 使用任意 AI 编程工具（Cursor / Qoder / Claude Code / Codex）执行一次编码任务
3. 等待面板刷新——卡片显示 **Active** 即表示采集正常

### 停止监控面板

```bash
~/.local/bin/loongsuite-pilot monitor stop
```

---

## 运维手册

### 全面健康检查（一次执行）

执行以下命令快速确认服务状态与数据链路：

```bash
~/.local/bin/loongsuite-pilot status
~/.local/bin/loongsuite-pilot info
ls -la ~/.loongsuite-pilot/logs/output/
ls ~/.loongsuite-pilot/sls-failed-logs/ 2>/dev/null || echo "无上报失败记录"
```

### 实时查看数据流

```bash
# 查看原始输入（Cursor 为例）
tail -f ~/.loongsuite-pilot/logs/cursor-hook/history/cursor-$(date +%Y-%m-%d).jsonl

# 查看处理后输出
tail -f ~/.loongsuite-pilot/logs/output/cursor/*.jsonl
```

### 强制重启（更新异常或服务假死时使用）

直接 stop 再 start，而不是 restart——restart 在异常状态下有时会复用残留进程：

```bash
~/.local/bin/loongsuite-pilot stop
sleep 2
~/.local/bin/loongsuite-pilot start
~/.local/bin/loongsuite-pilot status
```

### 版本回滚

当新版本出现兼容性问题时，回滚到上一个正常版本：

```bash
~/.local/bin/loongsuite-pilot rollback
~/.local/bin/loongsuite-pilot status
```

回滚后如需确认版本号：

```bash
~/.local/bin/loongsuite-pilot info
```

---

## Dashboard `Last activity` 显示落后于真实时间

**现象**：原始 JSONL 文件末尾已是较新的时间，但监控面板的 `Last activity` 仍停留在更早的时间点。这是 dashboard 显示侧问题，不是采集链路问题。

### 根因：按需懒索引

监控面板的 `Last activity` 与当天事件统计来自本地 `~/.loongsuite-pilot/logs/output/*-YYYY-MM-DD.jsonl`，但 dashboard 不会主动跟随写入：

- 只有 `/api/overview` 接口被请求时才会推进读取
- 单次请求最多读取 **5 MiB / 2 万行**（先到为准）
- 进程内有 5 秒内存缓存

较大的当天 JSONL 需要多次连续请求才能完整索引到尾。只打开一次就离开 dashboard 会停留在第一次推进到的位置。

### 一键确认

```bash
grep '\[overview\] partial index' ~/.loongsuite-pilot/logs/loongsuite-pilot-dashboard.log | tail -20
```

命中 `partial index` 告警即说明触发了懒索引上限；命中 `index caught up` 表示该文件已追上，`Last activity` 为实时值。

### 解决方法

```bash
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -s 'http://127.0.0.1:8765/api/overview?force=true' >/dev/null
  sleep 1
done
```

或在浏览器里反复刷新 dashboard 页面（每次间隔 ≥5 秒），直到 `Last activity` 推进到最新时间。

### 排除项

出现该现象时，以下方向不是原因：

- ❌ SLS 上报：dashboard `Last activity` 完全不读 SLS
- ❌ `sls-failed-logs/`：上报失败的本地兜底，与 last activity 无关
- ❌ pilot service 状态：service 只负责写 output，不参与 dashboard 索引
- ❌ `input-state.json` 的 lastOffset：是 pilot 消费原始 JSONL 的进度，不是 dashboard 索引 output 的进度

若 `loongsuite-pilot-dashboard.log` 中无 `partial index` 告警但 `Last activity` 仍卡住，则属另一类问题（如文件日期不为当天、agent 分类异常等），需按各 agent 诊断文档继续排查。
