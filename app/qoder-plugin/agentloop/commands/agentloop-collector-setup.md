---
description: 安装采集器（loongsuite-pilot），或重新安装。
---

# 安装 loongsuite-pilot

用户要安装 loongsuite-pilot，或重新获取安装参数时使用。

按 [agentloop-collector-setup](../skills/agentloop-collector-setup/SKILL.md) 技能执行。先请用户选择用户标识 `hostname`、`username` 或 `email`，并说明这个值用于之后的追踪和审计，需要用户根据情况选择。选了哪一项，就传对应的 `--user-id-source`。不选就不要传这个参数。再在插件根目录执行。成功后按技能先展示可点击的 zip 链接。链接展示不出来时，再补纯文本路径。并说明这个 zip 可以本地解压后安装试用，也可以到管理市场下发。

## 环境

先检测当前环境，只执行对应的一条命令。

### Linux 和 macOS

找不到 `python3` 时用 `python`。

```bash
python3 scripts/run.py install [--user-id-source <hostname|username|email>]
```

### Windows

参数名与 Linux 和 macOS 相同。

```powershell
powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File scripts/run.ps1 install [--user-id-source <hostname|username|email>]
```
