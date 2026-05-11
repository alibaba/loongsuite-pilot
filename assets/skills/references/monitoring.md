# 观测面板与运维手册

本文档随 `loongsuite-pilot` 安装包一起分发，安装完成后自动写入
`~/.loongsuite-pilot/skills/references/monitoring.md`，随 pilot 升级自动更新。

---

## 速查表

| 项目 | 路径 / 地址 |
|------|------------|
| CLI 入口 | `~/.local/bin/loongsuite-pilot` |
| 配置文件 | `~/.loongsuite-pilot/config.json` |
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
