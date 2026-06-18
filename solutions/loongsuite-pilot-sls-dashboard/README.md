# LoongSuite Pilot Dashboard

这是一个面向 LoongSuite Pilot / AI Coding Agent 的 SLS 报表交付工作区。使用时优先把目标用自然语言告诉 Agent，让 Agent 去更新 `schema.md`、spec、dashboard JSON 和 HTML 预览；不要把它当成需要手工拼 JSON 的工程。

核心入口是业务 skill：`loongsuite-pilot-insight`。它理解 LoongSuite Pilot 的数据语义，并会配合 `sls-dashboard-builder` 生成可导入 SLS 的 dashboard。

## 第一次使用

第一次接入新客户或新环境时，先让 Agent 更新必需的数据源绑定。最小可用配置只需要 AI Coding 事件表，可先生成 `ai-coding-events` 事件洞察报表：

```text
使用 loongsuite-pilot-insight，把这个项目切到新的 SLS 环境，先只配置 AI Coding 事件数据源：
aliyun profile 使用 <profile>，
project 改为 <project>，
region 改为 <region>，
AI Coding 事件 logstore 改为 <event-logstore>。
部门维表暂不配置；请确认 ai-coding-events 只依赖 ai_coding_events，并检查 schema.md 里的事件字段语义是否适配。
```

如果还要生成 `ai-coding-team` 团队报表，再补充部门维表或客户自定义外表。团队报表需要构建 `dept_roster` / `dept_user`，用于总人数、覆盖率、未产生日志员工列表和团队 TopN：

```text
我还需要 ai-coding-team 团队报表。
部门维表 logstore 使用 <department-logstore>。
部门表里员工工号字段叫 <work-no-field>，姓名字段叫 <name-field>，部门路径字段叫 <dept-field>。
请更新 loongsuite-pilot-insight 的 schema，构建 dept_roster / dept_user 口径，并说明会影响哪些团队报表指标。
```

环境确认后，按报表层次生成本地预览：

```text
使用 loongsuite-pilot-insight，根据 ai-coding-events spec 生成 dashboard JSON 和 HTML 预览，并检查所有查询是否成功。
```

```text
使用 loongsuite-pilot-insight，根据 ai-coding-team spec 生成 dashboard JSON 和 HTML 预览，并检查部门维表 JOIN、覆盖率和团队筛选器是否正常。
```

## 当前报表

| 层次 | 场景 | 依赖 | 用途 | 需求入口 | 输出 |
|---|---|---|---|---|---|
| 事件层 | `ai-coding-events` | 只依赖 AI Coding 事件表 | 分析事件、Token、模型、Skill、Tool 和使用集中度；不需要部门维表 | `cases/loongsuite-pilot-insight/input/ai-coding-events-spec.md` | `cases/loongsuite-pilot-insight/output/ai-coding-events-dashboard.json`、`ai-coding-events-report.html` |
| 团队层 | `ai-coding-team` | 依赖 AI Coding 事件表 + 部门维表或客户自定义外表 | 展示总人数、覆盖率、团队明细、未产生日志员工列表、团队 TopN、Token、Skill、Tool 等 | `cases/loongsuite-pilot-insight/input/ai-coding-team-spec.md` | `cases/loongsuite-pilot-insight/output/ai-coding-team-dashboard.json`、`ai-coding-team-report.html` |

对应线上 dashboardName：

- `loongsuite-pilot-ai-coding-team`
- `loongsuite-pilot-ai-coding-events`

## 常用请求

调整团队报表内容：

```text
使用 loongsuite-pilot-insight，调整 ai-coding-team 团队报表：
把 Token 使用时段分布放到趋势区，
新增团队维度的 Top 10 Tool 调用次数，
生成 dashboard JSON 和 HTML 预览后检查查询结果。
```

新增一张同类报表：

```text
使用 loongsuite-pilot-insight，新建一个 <scenario> 报表 spec。
这张报表只关注 <业务目标>。
如果只做事件层分析，数据源只使用 ai_coding_events；
如果要做团队覆盖率、部门筛选或在册员工分析，再加入 dept_roster。
请先生成 spec，再生成 dashboard JSON 和 HTML 预览。
```

只改数据口径：

```text
使用 loongsuite-pilot-insight，把活跃用户口径改为：
在当前时间范围内至少产生 1 条 AI Coding 事件的在册员工。
请更新 schema/spec 中相关说明，并重新生成受影响报表的 JSON 和 HTML 预览。
```

重新预览：

```text
使用 loongsuite-pilot-insight，重新生成 ai-coding-team 和 ai-coding-events 的 HTML 预览，并检查失败查询、空结果和布局异常。
```

发布到 SLS：

```text
请把 ai-coding-team 和 ai-coding-events 两个报表都发布到 SLS。
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
ai-coding-team 预览里有查询失败，请分析是权限、网络、字段索引、SQL 还是数据为空导致的，并给出修复后的 JSON 和 HTML 预览。
```

## 文件分工

多数情况下你只需要描述目标，不需要手工改文件。Agent 会按下面的边界处理：

- `.agents/skills/loongsuite-pilot-insight/schema.md`：真实 project、region、AI Coding 事件 logstore、字段语义、指标口径和公共 CTE；部门维表 logstore / 外表只在团队报表需要时配置。
- `cases/loongsuite-pilot-insight/input/*-spec.md`：某一张报表的目标、模块、指标、筛选器和布局。
- `cases/loongsuite-pilot-insight/output/*-dashboard.json`：生成后的 SLS dashboard JSON。
- `cases/loongsuite-pilot-insight/output/*-report.html`：本地 HTML 预览。
- `AGENTS.md`：给 Agent 看的项目维护规则。

一般不要手工改 `output/` 里的 JSON 或 HTML；更推荐改 schema 或 spec 后重新生成。
