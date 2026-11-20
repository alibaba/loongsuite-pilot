---
description: 准备 AgentLoop 环境、切换账户或查询目标，以及安装采集器。
---

# AgentLoop 环境与采集器准备

按 [agentloop-collector-setup](../skills/agentloop-collector-setup/SKILL.md) 先判断用户意图。只登录、切账户或切换查询目标时，按[账户与查询目标切换](../skills/agentloop-collector-setup/references/auth.md)完成，不询问 `user.id`、日志时间或生成 Pilot 安装包。切换查询目标还需要 Query Skill。

明确要安装或重新获取采集器时，先请用户选择用户标识，再生成 zip；安装命令本身无需 Query。成功后按技能展示可点击的 zip 链接，并说明可以本地解压试用或到管理市场下发。

在当前项目目录使用 Setup 共享入口的绝对路径，`<子命令>` 按意图选择 `auth`、`audit` 或 `install`，参数由 Agent 根据用户目标组织：

```bash
python3 "<agentloop-collector-setup目录>/scripts/run.py" <子命令> [参数]
```

Windows 使用本机原生 PowerShell，参数相同：

```powershell
powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "<agentloop-collector-setup目录>/scripts/run.ps1" <子命令> [参数]
```
