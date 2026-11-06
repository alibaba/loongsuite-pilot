# AgentLoop

本插件提供 Agent 数据接入、审计查询与仪表盘制作。在对话里选定 AgentSpace，生成采集器（loongsuite-pilot）的安装包，并查询已经上报的使用记录。记录也可以到 AgentLoop 控制台查看。

## 功能

- 按选定的 AgentSpace 生成 loongsuite-pilot 安装包。对话会返回 zip 路径。可以本地解压后安装试用，也可以到管理市场下发。
- 查询行为、Token、风险、意图、拦截与实体数据；按需求返回实际结果、验证 SQL 或 CLI/SDK 接入材料。
- 生成 SLS 仪表盘与本地 HTML 预览，确认后发布；查询与报表复用同一数据模型。

## 相关产品

采集到的审计数据可在 [AgentLoop 控制台](https://agentloop.console.aliyun.com/agentloop/home) 查看。loongsuite-pilot 是面向 AI Agent 的本地采集器，项目与说明见 [alibaba/loongsuite-pilot](https://github.com/alibaba/loongsuite-pilot)。

## 使用方式

安装时在对话中输入「安装采集器」，或使用 `/agentloop-collector-setup`。安装会生成一个 zip，对话返回文件路径。可以本地解压后安装试用，也可以到管理市场下发。

查询时描述业务目标，或使用 `/agentloop-audit-query`。例如“查哪些用户消耗最高”，助手会先确认时间范围；“最近 7 天各 Agent 的 Token”会先窄窗验证新 SQL，再查询完整七天。追问“看其中某个 Agent 的会话”沿用已确认范围和原始 Agent 值。

默认返回结果；说“给我可以贴到 SLS 查询框的 SQL”会返回完整查询、目标表、时间/参数及验证说明；说“我要用 SDK 包一个查询服务”会返回查询模板、参数和结果契约，以及指定方式的调用示例。目录覆盖行为分析、Token 分析、风险概览、风险浏览、用户风险、意图审计、拦截记录和实体调查，入口见 [核心面板查询目录](skills/agentloop-audit-query/references/catalog.md)。

要仪表盘时使用 `/agentloop-audit-dashboard` 或说“把这些生成一份报表”。助手复用查询知识，生成 dashboard JSON 和可点击的本地 HTML 链接；确认预览后才发布到 SLS。图表、筛选器与点击交互由通用 `sls-dashboard-builder` 提供。

应用事实合并 agent-event / agent-event-webtracking；意图限定 audit-event 的意图事件；高保真风险使用 incident-event；运行时与实体查询按数据契约选择来源。客户没有花名册时不编造在册人数或覆盖率。SQL、接入材料和报表默认保存在当前项目的 `output/audit/reports/`，也可指定其他目录。

## 部门与业务团队接入

团队报表需要客户组织名单及身份映射。可以直接描述目标，例如：

```text
请为 <project> / <region> 在 <时间范围> 内生成部门覆盖与用量报表。
组织表使用 <logstore>，员工标识字段 <work-no-field>，姓名 <name-field>，部门路径 <dept-field>；事件用户与员工标识的映射为 <映射规则>。
先检查花名册快照有效期、员工唯一归属和关联覆盖，再保留零用量员工计算在册人数、使用人数与覆盖率，生成本地预览并检查部门筛选联动。
```

具体表名和字段映射写入本次项目的场景资料。组织结构和个人账单均可作为外表关联：前者提供人群与归属，后者提供实际费用。只有事件数据时先做事件洞察；部门字段缺失或身份不匹配时说明限制。示例规格在 [事件洞察](skills/agentloop-audit-dashboard/examples/agent-events-spec.md) 与 [业务团队](skills/agentloop-audit-dashboard/examples/business-team-spec.md)，根据本轮目标适配查询和筛选。

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

安装与查询可共用以下策略。下例仅覆盖默认 `agent-event`；查询两表合并、意图、风险、实体或运行时时，应为实际访问的各 Logstore 授予 log:GetLogStoreLogs，索引核对另需 log:GetIndex。部门外表同样按实际表授权。仪表盘创建/更新权限按需单独授予，不属于只读查询权限。

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
