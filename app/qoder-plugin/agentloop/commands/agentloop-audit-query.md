---
description: 查询审计日志。
---

# 查询审计日志

用户要看 loongsuite-pilot 的审计日志时使用。

按 [agentloop-audit-query](../skills/agentloop-audit-query/SKILL.md) 技能执行。在插件根目录执行。

## 环境

先检测当前环境，只执行对应的一条命令。

### Linux 和 macOS

找不到 `python3` 时用 `python`。

```bash
python3 scripts/run.py audit --query "<检索或 SQL>"
```

### Windows

参数名与 Linux 和 macOS 相同。

```powershell
powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File scripts/run.ps1 audit --query "<检索或 SQL>"
```
