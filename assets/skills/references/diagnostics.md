# 诊断排查指南

本文档随 `loongsuite-pilot` 安装包一起分发，安装完成后自动写入
`~/.loongsuite-pilot/skills/references/diagnostics.md`，随 pilot 升级自动更新。

---

## 支持的 AI 编程工具与功能矩阵

| Agent | Token 使用量采集 | Chat / Tool call 详情采集 | 自测状态 | 默认开启 |
|-------|:---:|:---:|---|:---:|
| Cursor | ✅ | ✅ | 正常 | ✅ |
| Qoder IDE / CLI | ✅ | ✅ | 正常 | ✅ |
| Qoder Work | ❌（暂不支持） | ❌ | - | - |
| Claude Code | ✅ | ✅ | 安装后需要 `source` 一下 shell rc | ✅ |
| Codex | ✅ | ✅ | 正常 | ✅ |

> **如果用户使用的工具不在上表中，或对应单元格为「❌ 暂不支持」（如 Qoder Work），
> 请直接告知用户：当前 `loongsuite-pilot` 暂未支持该工具的数据采集，无需进一步排查。**

---

## 按 Agent 分诊（请阅读对应的诊断文档）

确认用户使用的是哪个 agent，然后**只**阅读对应的诊断文档，不要把所有 agent 的内容混合输出：

| 用户使用的工具 | 应阅读的诊断文档 |
|----------------|------------------|
| Cursor | `~/.loongsuite-pilot/skills/references/cursor-diagnostics.md` |
| Qoder IDE / Qoder CLI | `~/.loongsuite-pilot/skills/references/qoder-diagnostics.md` |
| Claude Code | `~/.loongsuite-pilot/skills/references/claude-code-diagnostics.md` |
| Codex | `~/.loongsuite-pilot/skills/references/codex-diagnostics.md` |
| Qoder Work | 暂不支持 — 直接答复用户后结束 |

每份分诊文档独立给出该 agent 的：服务状态检查、原始日志路径、Hook 配置位置、常见问题与修复步骤。

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
