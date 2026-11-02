# LoongSuite Pilot Dashboard

这是一个面向 AI Agent 事件洞察的 SLS 报表工作区，数据来自 LoongSuite Pilot。用自然语言描述目标，由 Agent 配置数据源、编写 spec，并生成 dashboard JSON 和 HTML 预览。

核心入口是业务 skill：`loongsuite-pilot-insight`。它理解 LoongSuite Pilot 的数据语义，并会配合 `sls-dashboard-builder` 生成可导入 SLS 的 dashboard。

## 第一次使用

第一次接入新客户或新环境时，先让 Agent 更新必需的数据源绑定。事件洞察使用逻辑数据源 `agent_events`，由 `agent-event` 和 `agent-event-webtracking` 两路应用事实合并。可先创建 `agent-events` 场景 spec，再生成事件洞察报表：

```text
使用 loongsuite-pilot-insight，把这个项目切到新的 SLS 环境，先只配置 AI Agent 事件数据源：
aliyun profile 使用 <profile>，
project 改为 <project>，
region 改为 <region>，
应用事实使用 agent-event 和 agent-event-webtracking 两张 Logstore，合并为逻辑源 agent_events；
若环境使用自定义表名，请按相同字段契约分别绑定。
部门维表暂不配置；请确认 agent-events 只依赖 agent_events，并检查 schema.md 里的事件字段语义是否适配。
```

如果还要生成 `business-team` 团队报表，再补充部门维表或客户自定义外表。团队报表需要构建 `dept_roster` / `dept_user`，用于总人数、覆盖率、未产生日志员工列表和团队 TopN：

```text
请创建 business-team 场景 spec，生成团队报表。
部门维表 logstore 使用 <department-logstore>。
部门表里员工工号字段叫 <work-no-field>，姓名字段叫 <name-field>，部门路径字段叫 <dept-field>。
请更新 loongsuite-pilot-insight 的 schema，构建 dept_roster / dept_user 口径，并说明会影响哪些团队报表指标。
```

环境确认后，按报表层次生成本地预览：

```text
使用 loongsuite-pilot-insight，根据 agent-events spec 生成 dashboard JSON 和 HTML 预览，并检查所有查询是否成功。
```

```text
使用 loongsuite-pilot-insight，根据 business-team spec 生成 dashboard JSON 和 HTML 预览，并检查部门维表 JOIN、覆盖率和团队筛选器是否正常。
```

## 报表数据源

逻辑数据源是报表 spec 在 `data.sources` 中使用的引用名，对应一类业务数据及其实际数据表。数据说明包含采集或识别来源、记录内容和分析用途。

| 逻辑数据源（spec 引用名） | 实际数据范围 | 数据内容与用途 |
|---|---|---|
| `agent_events` | `agent-event` + `agent-event-webtracking` | Pilot 采集的 Agent 应用行为事实，包括用户输入、模型请求与响应、工具调用与结果等。两张表字段契约相同、写入链路不同，查询时合并读取，用于行为与用量分析。 |
| `intent_events` | `audit-event` 中的意图识别结果 | 用户意图的识别结果，包含普通意图和风险意图。用于统计意图分类与分布，并通过会话关联分析对应的已观测用量。 |
| `incident_events` | `incident-event` 风险事件 | 基于行为证据和检测结果形成的风险事件，记录风险类型、严重性、涉及的用户或会话及证据引用。用于风险趋势、影响范围分析和证据回溯。 |
| `dept_roster` | 客户提供的员工与团队名单 | 客户提供的员工花名册及组织归属，通常包含员工标识、姓名、部门或业务团队。与行为事实关联，提供在册人数和团队维度，用于覆盖率及未产生日志员工分析。 |

eBPF 采集的运行时模型、工具及进程、文件、网络观测存储于独立的 `ebpf-event`。应用用量分析使用 `agent_events`，运行时调查按来源读取相应事实表。

## 示例报表

| 场景 | 依赖 | 需求入口 | 输出 |
|---|---|---|---|
| `agent-events`：Agent 事件洞察 | `agent_events` | [agent-events-spec.md](cases/loongsuite-pilot-insight/input/agent-events-spec.md) | [Dashboard JSON](cases/loongsuite-pilot-insight/output/agent-events-dashboard.json)、[HTML 预览](cases/loongsuite-pilot-insight/output/agent-events-report.html) |
| `business-team`：业务团队报表 | `agent_events` + `dept_roster` | [business-team-spec.md](cases/loongsuite-pilot-insight/input/business-team-spec.md) | [Dashboard JSON](cases/loongsuite-pilot-insight/output/business-team-dashboard.json)、[HTML 预览](cases/loongsuite-pilot-insight/output/business-team-report.html) |

其他场景的名称和 `dashboard.name` 在 spec 中确定，输入与输出路径按 `<scenario>` 生成。

## 常用请求

调整团队报表内容：

```text
使用 loongsuite-pilot-insight，调整 business-team 团队报表：
把 Token 使用时段分布放到趋势区，
新增团队维度的 Top 10 Tool 调用次数，
生成 dashboard JSON 和 HTML 预览后检查查询结果。
```

新增一张同类报表：

```text
使用 loongsuite-pilot-insight，新建一个 <scenario> 报表 spec。
这张报表只关注 <业务目标>。
如果只做事件层分析，数据源只使用 agent_events；
如果要做团队覆盖率、部门筛选或在册员工分析，再加入 dept_roster。
请先生成 spec，再生成 dashboard JSON 和 HTML 预览。
```

只改数据口径：

```text
使用 loongsuite-pilot-insight，把活跃用户口径改为：
在当前时间范围内至少产生 1 条 AI Agent 事件的在册员工。
请更新 schema/spec 中相关说明，并重新生成受影响报表的 JSON 和 HTML 预览。
```

重新预览：

```text
使用 loongsuite-pilot-insight，重新生成 <scenario> 的 HTML 预览，并检查失败查询、空结果和布局异常。
```

发布到 SLS：

```text
请把已确认预览的 <scenario> 报表发布到 SLS。
发布前先确认本地 dashboard JSON 合法，并在发布后拉取线上配置校验 dashboardName、displayName、图表数量和 attribute。
```

## 预览验收

HTML 预览是发布前的本地验收页。让 Agent 生成后，重点看这些点：

- 标题、表头、图例是否符合交付语言。
- SQL 是否查对 project、logstore 和字段。
- 查询结果是否有数据，是否符合当前时间范围。
- 团队报表的部门筛选器是否能联动图表。
- 页面布局是否便于阅读。

如果预览失败，可以直接让 Agent 排查：

```text
business-team 预览里有查询失败，请分析是权限、网络、字段索引、SQL 还是数据为空导致的，并给出修复后的 JSON 和 HTML 预览。
```

## 文件分工

多数情况下你只需要描述目标，不需要手工改文件。Agent 会按下面的边界处理：

- `.agents/skills/loongsuite-pilot-insight/schema.md`：Project / Region 绑定、应用事实、意图与风险 Logstore、字段语义、指标口径和公共 CTE；部门维表 logstore / 外表只在团队报表需要时配置。
- `cases/loongsuite-pilot-insight/input/*-spec.md`：某一张报表的目标、模块、指标、筛选器和布局。
- `cases/loongsuite-pilot-insight/output/*-dashboard.json`：生成后的 SLS dashboard JSON。
- `cases/loongsuite-pilot-insight/output/*-report.html`：本地 HTML 预览。
- `AGENTS.md`：给 Agent 看的项目维护规则。

一般不要手工改 `output/` 里的 JSON 或 HTML；更推荐改 schema 或 spec 后重新生成。
