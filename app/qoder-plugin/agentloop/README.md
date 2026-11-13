# AgentLoop

本插件提供 Agent 数据接入、审计查询与仪表盘制作。在对话里选定 AgentSpace，生成采集器（loongsuite-pilot）的安装包，并查询已经上报的使用记录。记录也可以到 AgentLoop 控制台查看。

## 功能

- 按选定的 AgentSpace 生成 loongsuite-pilot 安装包。对话会返回 zip 路径。可以本地解压后安装试用，也可以到管理市场下发。
- 查询行为、Token、风险、意图、拦截与实体数据；按需求返回实际结果、验证 SQL 或 CLI/SDK 接入材料。
- 生成 SLS 仪表盘与本地 HTML 预览，确认后发布；查询与报表复用同一数据模型。

## 相关产品

采集到的审计数据可在 [AgentLoop 控制台](https://agentloop.console.aliyun.com/agentloop/home) 查看。loongsuite-pilot 是面向 AI Agent 的本地采集器，项目与说明见 [alibaba/loongsuite-pilot](https://github.com/alibaba/loongsuite-pilot)。

## 安装

### Qoder 插件

在 Qoder 扩展的“插件”页搜索 `agentloop`，安装 AgentLoop 插件。

### npx

在业务项目目录执行下列命令，将报表所需的四项 Skill 一起安装到 Codex：

```bash
npx skills add https://github.com/alibaba/loongsuite-pilot/tree/main/app/qoder-plugin/agentloop/skills --skill agentloop-collector-setup agentloop-audit-query agentloop-audit-dashboard sls-dashboard-builder -a codex
```

仅准备登录环境或生成采集器安装包时，安装 `agentloop-collector-setup` 即可；切换查询目标与查询还需要 `agentloop-audit-query`。使用其他 Agent 时将 `-a codex` 改成相应标识，例如 `qoder`、`claude-code`、`qwen-code` 或 `openclaw`。默认安装到当前项目，加 `-g` 为用户级安装。

npx 需要 Node.js 22.20 或以上版本。macOS / Linux 的执行脚本和各平台的 HTML 预览、仪表盘发布需要 Python 3.9 或以上版本；Windows 的查询、授权和采集器安装也提供原生 PowerShell 入口。

### 手动复制

从本仓库的 `app/qoder-plugin/agentloop/skills/` 取得所需的完整 Skill 目录，放到所用 Agent 的 Skill 目录并保持相邻。Codex 的项目级目录是 `.agents/skills/`，Qoder 是 `.qoder/skills/`。制作报表需要 Collector Setup、Query、Dashboard 和 Builder 四项；登录环境与生成采集器安装包只需 Collector Setup，切换查询目标与查询需要再安装 Query。重新加载 Agent 后即可使用。

各 Skill 的 `scripts/`、`references/` 与 `SKILL.md` 平级：Collector Setup 持有共享 CLI、授权、环境准备、采集器安装与命令入口，Query 持有查询脚本，Builder 持有渲染与发布脚本。执行指南统一使用 Collector Setup 的 `scripts/run.py` 或 `scripts/run.ps1`。云端操作通过 `aliyun` CLI 完成，HTML 渲染、参数处理和目标记录在本地完成。

## 使用方式

准备环境时直接说“登录 AgentLoop”“切换账户”或“切换查询目标”。目标可以是 AgentSpace，也可以是直接 SLS Project；助手会按需要列出账户或空间，补齐参数并完成绑定；只切换环境时，不询问机器用户标识或日志时间，也不安装 Pilot。

需要安装采集器时，输入“安装采集器”或使用 `/agentloop-collector-setup`。助手会先确认用于审计的用户标识，再生成 zip。可以本地解压后安装试用，也可以到管理市场下发。

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

Collector Setup 提供独立的阿里云 CLI、AgentLoop CLI 插件和多 Profile 登录环境。默认 Profile 为 `loongsuite-pilot`；其他命名 Profile 分别保存自己的凭证。脚本会在需要时准备 CLI 3.3.0 及以上版本，不与终端默认 CLI 的登录配置混用。

- Qoder 插件使用插件根目录的 `aliyun/`。
- 独立安装默认使用 `agentloop-collector-setup/aliyun/`；该目录尚未配置且相邻 Query 的 `aliyun/config.json` 已存在时，脚本沿用 Query 的授权目录，不要求手动迁移。Agent 不读取、复制或输出凭证文件。

npx 更新会重建所安装的 Skill 目录，独立安装时目录内的 CLI 与登录配置可能被清理；更新后若提示未授权，重新执行 `auth` 登录。旧 Query 授权目录只有在更新后仍存在时才能自动沿用。

查询、报表和采集器安装共用当前选中的 Profile。用户要切换账户时，助手通过 `auth --list` 获取安全元数据；`configured` 只代表本地已配置，不代表云端授权已经验证。用户选定后完成授权，再确认查询目标。完整流程见 [账户与查询目标切换](skills/agentloop-collector-setup/references/auth.md)。

通过 OAuth 登录时，授权范围为该阿里云账号可调用的全部 API。如需收敛权限，请创建专用 RAM 用户，仅授予下方策略，并使用该用户登录。使用 OAuth 前，请将官方 CLI 应用 `official-cli` 分配给该用户。

采用 AccessKey 时，由本人在本机终端执行脚本提示的完整 `configure --mode AK` 命令，包括其 `--config-path`。不要在对话中提供 AccessKey，也不要让 Agent 读取凭证文件。

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

`config-record.json` 保存当前选中的 Profile 和目标元数据：

```json
{
  "agentSpace": "<AgentSpace 名称>",
  "regionId": "<地域，例如 cn-hangzhou>",
  "slsProject": "<SLS Project>",
  "slsLogstore": "agent-event",
  "profile": "<当前选中的阿里云 CLI Profile 名称>"
}
```

`profile` 记录当前选中的 Profile，其他字段记录其当前目标。成功切换到不同 Profile 后，脚本清除旧目标，再按用户确认的 AgentSpace 或直接 SLS 目标重新绑定；授权失败时保留原状态。

首次需要目标或用户说“切换查询目标”时，助手保持当前 Profile：AgentLoop 场景用空间名称与地域解析目标，直接 SLS 场景确认 Project、Region 与 Logstore。缺项只补问必要信息，不要求用户手写命令。绑定不查询日志；没有查询或报表任务时，无需提供日志时间。目标确认后，再继续已提出的查询或发布任务。

`query-history.jsonl` 保存最近的查询，每行一条，含时间和查询语句，不含日志正文。用户还没有给出检索或 SQL 时，助手可以参考这份文件来写查询语句。新记录追加在文件末尾，只保留最近 50 条，超出后自动删除最早的一条。需要去掉某条记录时，删除对应行即可。
