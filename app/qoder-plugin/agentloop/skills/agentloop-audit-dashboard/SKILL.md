---
name: agentloop-audit-dashboard
description: |
  基于 LoongSuite Pilot 采集的 AI Agent 事件生成事件洞察、组织洞察、数据质量、研发效能和 AI Native 使用类 SLS 报表时使用；包含 agent-event / agent-event-webtracking 应用事实、audit-event 意图审计与 incident-event 风险事件语义，以及团队报表可选的部门维表、dept_user 组织关系、指标口径和公共 CTE，通常与 sls-dashboard-builder 一起使用。
  Triggers: "报表", "生成报表", "HTML 报表", "审计报表", "大盘", "dashboard", "事件洞察", "团队报表".
---

# 审计报表

## 查询知识与执行环境

查询数据模型、枚举与 SQL 参考见 [agentloop-audit-query](../agentloop-audit-query/SKILL.md)。按本次需求组织指标、图表与交互，使用 [sls-dashboard-builder](../sls-dashboard-builder/SKILL.md) 生成 SLS 配置。事件与团队示例见 [examples/](examples/)。

- 沿用 Query Skill 已确认的时间、范围、筛选与查询；用户没有确认时间时先询问。超过一天的新查询先窄窗验证，再按目标范围取数。
- Project、Region 与登录使用插件本地环境绑定；组织、账单等外表的字段与关联键按用户目标确认。
- 默认将 spec、dashboard JSON 和 HTML 写入当前项目的 `output/audit/reports/`；用户指定目录时使用指定目录。调用脚本时保留项目工作目录，使用插件脚本的绝对路径。
- 执行 `python3 <插件目录>/scripts/run.py report --dashboard <json>` 生成预览，Windows 使用 `<插件目录>/scripts/run.ps1 report`。发布先运行 `python3 <插件目录>/scripts/run.py publish --dashboard <json> --remark "<修改原因>"` 查看将创建还是覆盖；用户确认预览后加 `--confirm`。
- 临时查询、验证 SQL 或 SDK 接入材料走 Query Skill，不为这些任务生成 dashboard JSON。内置面板参考中的调用口径不能默默覆盖原报表模型响应口径。

## References

| 参考 | 读取范围 |
|---|---|
| [共享 schema](../agentloop-audit-query/references/schema.md) | 先读 Data Source Bindings 和 Source Composition，再按任务读取所需 Source 和查询构件；组织关联读 dept_roster，枚举展示读“枚举展示与交互” |
| [枚举字典](../agentloop-audit-query/references/value-labels.md) | 生成枚举标签时查对应字段及父子分类表；普通 Token 报表无需读取 |
| [核心面板目录](../agentloop-audit-query/references/catalog.md) | 选择内置面板参考，按条目口径组合查询；先对齐数据源与统计口径 |
| `sls-dashboard-builder` | 构建图表 JSON、预览或发布时，读取其入口及必要参考 |
| [筛选器与变量替换](../sls-dashboard-builder/references/filters-and-variables.md) | 配置筛选器或查询参数时先读；确定作用范围、模板、原值与标签、默认值和候选来源，再应用业务枚举 |
| [交互事件与下钻报表](../sls-dashboard-builder/references/drill-down-events.md) | 制作总览与明细联动、日志下钻或业务页面链接时读取；先按查看环境选择纯 SLS 原生事件或 AgentLoop URL，场景 spec 写明点击入口、目标资源、变量映射和时间范围 |

## Inputs And Outputs

- 默认需求入口：`output/audit/reports/<scenario>-spec.md`
- 默认 dashboard 输出：`output/audit/reports/<scenario>-dashboard.json`
- 默认预览输出：`output/audit/reports/<scenario>-report.html`

## Workflow

1. 确定 `<scenario>`，读取或创建场景 spec。
2. 按 References 与 Query Skill 的核心面板目录确定数据源、口径和查询构件，完成字段与代表性查询验证。
3. 解析 spec，将自然语言需求转成视图清单：指标、SQL、图表类型、布局、筛选器和说明块。
4. 使用 `sls-dashboard-builder` 生成或更新 dashboard JSON。
5. 生成本地 HTML 预览，调用方式见 Preview。
6. 用户确认预览没问题后，再按「在本插件里」的发布命令 create 或 update 线上 SLS 报表；不要跳过预览直接发布。

## Dashboard Spec

spec 描述本次报表的目标、范围、指标口径和交互，结构参考 [examples/](examples/) 中的 `*-spec.md`。

最小骨架：

````markdown
---
output: dashboard
dashboard:
  name: <stable-dashboard-name>
  displayName: "<dashboard display name>"
  defaultTimeRange: "-604800s"
  layout: grid
data:
  sources:
    - agent_events
---

# <dashboard display name>

用自然语言描述业务目标、数据范围和全局口径。

## Section: <module name>

### <chart/control/text title>

```yaml
intent: <stat-card|line|bar|pie|top-table|filter|text>
type: <sls-chart-type>
size: <w>x<h>
```
````

规则：

- `data.sources` 引用 `schema.md` 中的 logical source，例如 `agent_events`、`dept_roster`。
- `dashboard.name` 是生成 SLS dashboard JSON 的稳定名称，`dashboard.displayName` 是大盘展示名。
- `dashboard.defaultTimeRange` 使用 SLS 相对时间，例如 `-604800s`、`-86400s`、`-2592000s`。
- `dashboard.layout` 默认使用 `grid`。
- Project、Region、表名与组织、账单映射使用本次目标的配置。
- dashboard 模块统一使用 `## Section:`；筛选器、静态说明块和普通图表都放在 section 下。
- 图表元信息优先写 `intent`、`type`、`size`，按需补 `format`、`unit`、`orientation`、`key`、`filterType`、`globalFilter`。

## Preview

在当前项目目录调用插件脚本，路径含空格时加引号：

```bash
python3 "<插件目录>/scripts/run.py" report --dashboard output/audit/reports/<scenario>-dashboard.json
```

Windows 用 `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "<插件目录>/scripts/run.ps1" report`，参数相同。修改已有 dashboard 时带 `--with-diff` 生成 HTML SQL / 结果 diff；如报表 SQL 使用 token 参数，通过 `--var key=value` 传入本地预览值。`--var` 只替换精确的 `${{key}}`。图表 `project`、`logstore` 留空时用当前查询目标；要查别的表就写进该图的 `chartQueries[].logstore`。若查询失败，应修复查询、凭据或网络问题后重新生成预览。stdout 最后一行是 `report_html=<绝对路径>`。用浏览器打开。

## Guardrails

- 不编造不存在的字段或 logstore。
- 当 spec 的 `data.sources` 只有 `agent_events` 时，不要生成总在册人数、覆盖率、未产生日志员工列表、部门或团队 TopN；这些都需要 `dept_roster` 或客户自定义外表。
- 组织结构与个人账单均为可选外表。先确认表结构、用户映射及有效时间；组织提供人群与部门，账单提供实际费用。`department` 的 `work_no`、`name`、`dept_name` 仅为组织示例。
- 应用事实合并 `agent-event` / `agent-event-webtracking`，正常事件 ID 唯一，不额外增加去重；Token 仅按模型响应粒度统计，兼容 Help 与实际历史事件名。
- 缓存指标同时提供有效样本口径、字段覆盖率与异常样本数；输入 Token 已包含缓存，不重复相加。
- Skill 优先检查 Help 披露的 `gen_ai.skill.name` 非空覆盖；工具路径推断只作为标注过的兼容方案，不能把调用意图当作执行事实。
- 意图报表读取 `intent_events` 并限定意图事件名；Session 与模型用量关联先预聚合，再关联意图标签，显示关联覆盖并说明跨意图不可相加。
- 风险报表读取 `incident_events`，使用 `incident_event_id` 引用明细，Session 使用 `evidence_session_id`；不从风险 JOIN 后的行重复累加 Token。
- 跨表 JOIN 使用 `dept_user` 时，不要直接使用 `compare()` 做同比；按 `sls-dashboard-builder` 中的手动时间窗口规则处理。
- `active_user` 中的 token、events 可加；去重类指标不要对预聚合结果求和。
- 图表标题、图例、表头默认使用中文。
