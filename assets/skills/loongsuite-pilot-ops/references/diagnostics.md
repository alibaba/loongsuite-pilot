# 诊断排查指南

本文档随 `loongsuite-pilot` 安装包一起分发，安装完成后自动写入
`~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/diagnostics.md`，随 pilot 升级自动更新。

本仓库中的源文件位于 `assets/skills/loongsuite-pilot-ops/references/`；安装后对应路径为
`~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/`。

# 重点！！必须遵守！
**不要读取、打印或让用户粘贴完整的 `~/.loongsuite-pilot/config.json`。**
该文件可能包含 SLS AK/SK、HTTP token、用户标识等敏感信息。诊断时只允许读取必要字段，且必须用 `grep` / 小脚本做字段级筛选；涉及 `ak`、`secret`、`token`、`password`、`authorization` 等字段时只输出是否存在或脱敏后的前后 2 位。

---

## 支持的 AI 编程工具与功能矩阵

| Agent | Token 使用量采集 | Chat / Tool call 详情采集 | 自测状态 | 默认开启 |
|-------|:---:|:---:|---|:---:|
| Cursor | ✅ | ✅ | 正常 | ✅ |
| Cursor CLI | ✅ | ✅ | 通过 Cursor hook payload 中的 `cursor_version` 自动识别 | ✅ |
| Qoder IDE | ✅ | ✅ | 正常 | ✅ |
| Qoder CLI | ✅ | ✅ | Hook / session polling / trace 多链路 | ✅ |
| Qoder CN | ✅ | ✅ | Hook / SQLite / trace 多链路 | ✅ |
| Qoder for JetBrains | ✅ | ✅ | 自动检测，采集数据标记为 `qoder-idea` | ✅ |
| Qoder Work | ✅ | ✅ | Hook / local data polling / trace 多链路 | ✅ |
| Qoder Work CN | ✅ | ✅ | Hook / local data polling / trace 多链路 | ✅ |
| Claude Code | ✅ | ✅ | 安装后需要 `source` 一下 shell rc | ✅ |
| Codex | ✅ | ✅ | 正常 | ✅ |
| OpenCode | ✅ | ✅ | 插件注入模式，需 OpenCode 启动过一次 | ✅ |
| Qwen Code CLI | ✅ | ✅ | 正常 | ✅ |
| Wukong | ✅ | ✅ | 需 `wukong-cli` 可用且本地守护进程存活 | ✅ |

> **如果用户使用的工具后续矩阵中对应单元格为「❌ 暂不支持」，
> 请直接告知用户：当前 `loongsuite-pilot` 暂未支持该工具的数据采集，无需进一步排查。**

---

## 按 Agent 分诊（请阅读对应的诊断文档）

确认用户使用的是哪个 agent，然后**只**阅读对应的诊断文档，不要把所有 agent 的内容混合输出：

| 用户使用的工具 | 应阅读的诊断文档 |
|----------------|------------------|
| Cursor / Cursor CLI | `~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/cursor-diagnostics.md` |
| Qoder IDE / Qoder CLI | `~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/qoder-diagnostics.md` |
| Qoder CN | `~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/qoder-cn-diagnostics.md` |
| Qoder for JetBrains | `~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/qoder-jetbrains-diagnostics.md` |
| Qoder Work | `~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/qoderwork-diagnostics.md` |
| Qoder Work CN | `~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/qoder-work-cn-diagnostics.md` |
| Claude Code | `~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/claude-code-diagnostics.md` |
| Codex | `~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/codex-diagnostics.md` |
| OpenCode | `~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/opencode-diagnostics.md` |
| Qwen Code CLI | `~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/qwen-code-cli-diagnostics.md` |
| Wukong | `~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/wukong-diagnostics.md` |

每份分诊文档独立给出该 agent 的：服务状态检查、原始日志路径、Hook / Plugin / CLI 配置位置、常见问题与修复步骤。

---

## 按平台子系统分诊

如果用户的问题**不是某个 agent 的数据缺失**，而是 pilot 服务自身、自动更新、SLS 上报或 SQLite 采集等平台级异常，
请根据下表阅读对应的诊断文档：

| 排查场景 | 应阅读的诊断文档 |
|---------|---------------|
| pilot 服务异常（启动序列、Input 注册、Flusher、日志异常） | `~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/service-diagnostics.md` |
| 自动更新异常（版本不更新、更新后服务异常、回滚） | `~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/updater-diagnostics.md` |
| SLS 数据上报异常（数据采集正常但 SLS 查不到、上报失败、failed-logs 堆积） | `~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/sls-diagnostics.md` |
| SQLite 数据采集异常（Qoder / Qoder CN / Qoder Work token 或本地消息数据缺失） | `~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/sqlite-diagnostics.md` |

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
