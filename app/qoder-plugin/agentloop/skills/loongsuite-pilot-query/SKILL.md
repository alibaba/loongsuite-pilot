---
name: loongsuite-pilot-query
description: |
  查询 loongsuite-pilot 写入的审计日志。用户要看使用情况、人员、仓库、会话或一段时间内的日志时使用。
  Triggers: "查询审计", "查日志", "审计日志", "loongsuite-pilot 日志", "agent-event".
---

# 查询审计日志

判断用户要查日志之后，不要自己调用阿里云。查询语句由用户给出，或由你写成 SLS 检索 / SQL，再交给脚本。脚本只负责取数。不要打印 license key、API key 或 AccessKey。

用户还没有给出检索或 SQL 时，可以参考 `~/.loongsuite-pilot/audit/query-history.jsonl` 来写查询语句。这份记录每行一条，含时间、查询语句和时间范围，不含日志正文。新记录在文件末尾，只保留最近 50 条。

在插件根目录执行。后面的重新执行沿用这一次的入口，只改参数。

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

要改查询目标时，`--project`、`--logstore`、`--region` 可以只传要改的那一项，并保留 `--query`。没传的从 `~/.loongsuite-pilot/audit/config-record.json` 里已有的 `slsProject`、`slsLogstore`、`regionId` 沿用。查询时这三项都必须有值。合并后仍缺的，脚本报错返回，把缺的项告诉用户补上，不要改用 AgentSpace 推导。指定 AgentSpace 时，名称和地域一起带：`--agent-space`、`--region`，并保留 `--query`。

`region` 是地域 ID，例如 `cn-hangzhou`。SLS endpoint 是 `{region}.log.aliyuncs.com`，例如 `cn-hangzhou.log.aliyuncs.com`。查询命令和 `config-record.json` 只使用 `region`，不要传 `--endpoint`。用户给出 endpoint 时，去掉后缀 `.log.aliyuncs.com` 得到 `region`。安装 loongsuite-pilot 时，脚本会把 `region` 拼成 `--sls-endpoint`。CMS endpoint 是另一项，形如 `https://<域名>/apm/trace/opentelemetry`，不能按这条规则和 `region` 互转。

未传 `--from` 和 `--to` 时，脚本查询最近 1 小时，时间是 Unix 秒。单次最多 100 条。stdout 是 GetLogsV2 的 JSON，用它在对话里回答，不要再改查询目标。

检索和统计都可以，由你或用户写语句，例如：

- 原文：`--query '*'`
- 统计：`--query '* | SELECT count(*)'`

用户要看当前查询目标时，读 `~/.loongsuite-pilot/audit/config-record.json`。其中 `slsProject`、`slsLogstore`、`regionId` 就是当前的 project、logstore、region。不要为了列目标去跑查询命令。

## 报错

登录没完成，或用户说明是国际站、要用 AccessKey 时，先读 [skills/references/auth.md](../references/auth.md)。不要在这里重写鉴权步骤。授权完成后原样重新执行查询，保留原来的查询目标、时间范围、分页和 `--list` 等全部参数。

### 退出码 1

看 stderr：

- `Query target is incomplete. Missing ... project, logstore, and region are required.`：这次传入的和记录里已有的合在一起后，project、logstore、region 仍缺 `Missing` 后面列出的项。请用户补上缺的项，不要改用 AgentSpace 推导。
- `Pass --region. Choosing an AgentSpace requires its region. Do not use a default region.`：请用户填写 regionId，不要自己补默认地域。
- `No AgentSpace found`：账号下没有空间。
- `AgentSpace is missing slsProject or regionId`：选中的空间没有查询要用的字段。
- `Missing --query. Search example: * . Stats example: * | SELECT count(*)`：没有查询语句。
- `--from must not be later than --to`、`--line must be greater than 0`、`--line must not exceed 100`、`--offset must not be less than 0`，或参数名后接 `is not a number`：按提示改正参数。

### 退出码 7

stdout 每行是 `agentSpace regionId`。这些行不一定包含账号下的全部空间。某个地域查询失败，或列举达到分页上限时，对应空间不会出现。把这些行发给用户选。用户的空间不在列表里时，请用户给出名称和 regionId。选定后沿用上面的入口重新执行，原样保留查询语句、时间范围、分页和 `--list` 等已有参数，只增加 `--agent-space` 和 `--region`。

### 其他失败

上面的退出码和 stderr 都对不上时，可以阅读脚本，看它实际调用了哪条命令，把这条命令单独拿出来执行，用来确认失败原因。要改参数时，只改你单独执行的那条命令。尽量不要改文件。单独执行的命令已经跑通之后，才可以把同样的改动写回文件。改文件要慎重，改过的文件会被后面的查询接着使用。
