# AgentLoop

本插件面向 Agent 的排查与管理。在对话里选定 AgentSpace，生成采集器（loongsuite-pilot）的安装包，并查询已经上报的使用记录。记录也可以到 AgentLoop 控制台查看。

## 功能

- 按选定的 AgentSpace 生成 loongsuite-pilot 安装包。对话会返回 zip 路径。可以本地解压后安装试用，也可以到管理市场下发。
- 在对话中查询使用记录，例如近期使用情况、指定仓库，或一段时间内的统计结果。

## 相关产品

采集到的审计数据可在 [AgentLoop 控制台](https://agentloop.console.aliyun.com/agentloop/home) 查看。loongsuite-pilot 是面向 AI 编程助手的本地采集器，项目与说明见 [alibaba/loongsuite-pilot](https://github.com/alibaba/loongsuite-pilot)。

## 使用方式

安装时在对话中输入「安装采集器」，或使用 `/agentloop-collector-setup`。安装会生成一个 zip，对话返回文件路径。可以本地解压后安装试用，也可以到管理市场下发。

查询时在对话中说明要查看的内容，或使用 `/agentloop-audit-query`。例如输入：「查询近期各 Agent 的使用情况」、「统计各 Agent 耗费的 Token」、「查看这些 Agent 大部分时间在处理什么工作」。助手会按查询技能里的筛选说明，用 `agent_type=__all__` 统计已观测 Token；再说「看其中某个 Agent 的会话」时，沿用同一时间窗口，把该 Agent 的原值带进下一次查询。

问完几项后再要一份页面时，使用 `/agentloop-audit-dashboard`，或输入「把这些生成一份报表」。助手把这些结果渲染进同一份本地 HTML，并给出文件链接。用浏览器打开。这不是发布到 AgentLoop 或 SLS。

也可以描述一整张大盘，例如「做一份最近 7 天的 Agent 事件洞察报表」。助手按报表技能的指标口径写出大盘定义，先生成本地预览；你确认之后才会发布到线上。

查询会按能力选择 logstore：应用事实用 `agent-event`，意图用 `audit-event`，风险用 `incident-event`，运行时用 `ebpf-event`。当前空间没有部门花名册时，不会编造覆盖率。

## 身份凭证

插件使用阿里云 CLI 中名为 `loongsuite-pilot` 的 Profile，与本机其他 Profile 相互独立。

本机需安装阿里云 CLI 3.3.0 及以上版本。插件运行时若没有 aliyun，会自动尝试下载，并同时下载 AgentLoop CLI 插件。macOS 与 Linux 也可在终端执行：

```bash
/bin/bash -c "$(curl -fsSL https://aliyuncli.alicdn.com/install.sh)"
```

Windows 请下载 [amd64](https://aliyuncli.alicdn.com/aliyun-cli-windows-latest-amd64.zip)，将其中的 `aliyun.exe` 加入 PATH。Windows ARM64 也使用该版本。安装后执行以下命令，确认版本不低于 3.3.0：

```bash
aliyun version
```

首次安装或查询时需要完成登录。通过 OAuth 登录时，授权范围为该阿里云账号可调用的全部 API。如需收敛权限，请创建专用 RAM 用户，仅授予下方策略，并使用该用户登录。使用 OAuth 前，请将官方 CLI 应用 `official-cli` 分配给该用户。

同一 Profile 也可配置 AccessKey。在终端执行：

```bash
aliyun configure --mode AK --profile loongsuite-pilot
```

勿在对话中提供 AccessKey。

### 最小权限

安装与查询可共用以下策略。默认 Logstore 为 `agent-event`。若修改了 `slsLogstore`，请将策略中的 Logstore 名称改为一致。

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "agentloop:DescribeRegions",
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "agentloop:ListAgentSpaces",
      "Resource": "acs:agentloop:*:*:agentspace/*"
    },
    {
      "Effect": "Allow",
      "Action": "agentloop:GetAgentSpace",
      "Resource": "acs:agentloop:*:*:agentspace/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "cms:GetServiceObservability",
        "cms:CreateServiceObservability"
      ],
      "Resource": "acs:cms:*:*:workspace/*/service-observability/apm"
    },
    {
      "Effect": "Allow",
      "Action": [
        "log:GetApiKey",
        "log:CreateApiKey"
      ],
      "Resource": "acs:log:*:*:project/*/apikey/loongsuite-pilot-log"
    },
    {
      "Effect": "Allow",
      "Action": "log:GetLogStoreLogs",
      "Resource": "acs:log:*:*:project/*/logstore/agent-event"
    }
  ]
}
```

## 本地数据

本地配置、查询历史和安装包都放在 `~/.loongsuite-pilot/audit/`。

`config-record.json` 保存已授权的 Profile 和当前查询目标：

```json
{
  "agentSpace": "<AgentSpace 名称>",
  "regionId": "<地域，例如 cn-hangzhou>",
  "slsProject": "<SLS Project>",
  "slsLogstore": "agent-event",
  "profile": "<已授权的阿里云 CLI Profile 名称>"
}
```

`profile` 是已授权的 Profile 名称。直接编辑查询目标时保留这一字段。

首次查询时，若该文件尚无查询目标，对话中会请你选择。回复 AgentSpace 名称和地域即可。插件会记下 `regionId`，并写入对应的 `slsProject` 与 `slsLogstore`。

更换目标时，在对话中说明要查询的 AgentSpace 和地域。插件会用这两项重新获取 `slsProject` 与 `slsLogstore`，并更新 `regionId`。也可以只改 `slsProject`、`slsLogstore`、`regionId` 中的一项，另外两项沿用这个文件里已有的值。要看当前查询目标，读这个文件。该文件也可在本地直接编辑。

`query-history.jsonl` 保存最近的查询，每行一条，含时间和查询语句，不含日志正文。用户还没有给出检索或 SQL 时，助手可以参考这份文件来写查询语句。新记录追加在文件末尾，只保留最近 50 条，超出后自动删除最早的一条。需要去掉某条记录时，删除对应行即可。
