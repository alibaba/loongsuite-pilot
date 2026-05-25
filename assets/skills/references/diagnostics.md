# 诊断排查指南

本文档随 `loongsuite-pilot` 安装包一起分发，安装完成后自动写入
`~/.loongsuite-pilot/skills/references/diagnostics.md`，随 pilot 升级自动更新。

# 重点！！必须遵守！
**绝对**不要尝试读取用户的 ~/.loongsuite-pilot/config.json文件！

---

## 支持的 AI 编程工具与功能矩阵

| Agent | Token 使用量采集 | Chat / Tool call 详情采集 | 自测状态 | 默认开启 |
|-------|:---:|:---:|---|:---:|
| Cursor | ✅ | ✅ | 正常 | ✅ |
| Qoder IDE / CLI | ✅ | ✅ | 正常 | ✅ |
| Qoder Work | ✅ | ✅ | 正常 | ✅ |
| Claude Code | ✅ | ✅ | 安装后需要 `source` 一下 shell rc | ✅ |
| Codex | ✅ | ✅ | 正常 | ✅ |

> **如果用户使用的工具不在上表中，或对应单元格为「❌ 暂不支持」，
> 请直接告知用户：当前 `loongsuite-pilot` 暂未支持该工具的数据采集，无需进一步排查。**

---

## 按 Agent 分诊（请阅读对应的诊断文档）

确认用户使用的是哪个 agent，然后**只**阅读对应的诊断文档，不要把所有 agent 的内容混合输出：
重点：分诊的过程中，**绝对**不要尝试读取用户的 ~/.loongsuite-pilot/config.json文件！

| 用户使用的工具 | 应阅读的诊断文档 |
|----------------|------------------|
| Cursor | `~/.loongsuite-pilot/skills/references/cursor-diagnostics.md` |
| Qoder IDE / Qoder CLI | `~/.loongsuite-pilot/skills/references/qoder-diagnostics.md` |
| Qoder Work | `~/.loongsuite-pilot/skills/references/qoderwork-diagnostics.md` |
| Claude Code | `~/.loongsuite-pilot/skills/references/claude-code-diagnostics.md` |
| Codex | `~/.loongsuite-pilot/skills/references/codex-diagnostics.md` |

每份分诊文档独立给出该 agent 的：服务状态检查、原始日志路径、Hook 配置位置、常见问题与修复步骤。

---

## 按平台子系统分诊

如果用户的问题**不是某个 agent 的数据缺失**，而是 pilot 服务自身、自动更新、SLS 上报或 SQLite 采集等平台级异常，
请根据下表阅读对应的诊断文档：

| 排查场景 | 应阅读的诊断文档 |
|---------|---------------|
| pilot 服务异常（启动序列、Input 注册、Flusher、日志异常） | `~/.loongsuite-pilot/skills/references/service-diagnostics.md` |
| 自动更新异常（版本不更新、更新后服务异常、回滚） | `~/.loongsuite-pilot/skills/references/updater-diagnostics.md` |
| SLS 数据上报异常（数据采集正常但 SLS 查不到、上报失败、failed-logs 堆积） | `~/.loongsuite-pilot/skills/references/sls-diagnostics.md` |
| SQLite 数据采集异常（Qoder IDE token 数据缺失） | `~/.loongsuite-pilot/skills/references/sqlite-diagnostics.md` |

> **分诊提示**：如果用户同时遇到"某个 agent 没数据" + "pilot 服务异常"，先走平台子系统排查（确保 pilot 服务自身健康），再走 agent 分诊。

---

## 通用前置检查（任意 agent 都先做这一步）

不论用户使用哪个 agent，先确认 `loongsuite-pilot` 自身在运行，再去看对应分诊文档：

```bash
~/.local/bin/loongsuite-pilot status
```

预期输出包含：`✅ loongsuite-pilot is running (PID ...)`，updater 显示 running。

若服务未运行，先启动并查看服务日志：

```bash
~/.local/bin/loongsuite-pilot start
tail -100 ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log
```

服务正常后，再回到「按 Agent 分诊」表，打开对应文档继续排查。
