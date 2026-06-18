---
name: loongsuite-pilot-insight
description: 基于 LoongSuite Pilot / AI Coding Agent 日志生成事件洞察、组织洞察、数据质量、研发效能和 AI Native 使用类 SLS 报表时使用；包含 AI Coding 事件表语义，以及团队报表可选的部门维表、dept_user 组织关系、指标口径和公共 CTE，通常与 sls-dashboard-builder 一起使用。
---

# LoongSuite Pilot Insight

## Purpose

将 LoongSuite Pilot / AI Coding Agent 日志转化为可复用的报表语义。用户应直接使用本 skill；本 skill 负责业务数据语义、指标口径和场景需求解释，再调用 `sls-dashboard-builder` 的通用能力生成或修改 SLS dashboard JSON。

## Boundaries

- 业务语义放在本 skill：`schema.md`、`cases/loongsuite-pilot-insight/input/<scenario>-spec.md`、业务脚本。
- 通用 SLS dashboard JSON 结构、图表配方、布局和校验规则来自 `sls-dashboard-builder`。
- 生成产物只写入 `cases/loongsuite-pilot-insight/output/`，不要写入 skill 目录。
- `*-report.html` 是 dashboard JSON 生成后的固定本地预览产物，不作为独立 spec。
- 不要把 LoongSuite Pilot 业务 schema、CTE、脚本或产物写进 `sls-dashboard-builder`。

## Inputs And Outputs

- 默认需求入口：`cases/loongsuite-pilot-insight/input/<scenario>-spec.md`
- 默认 dashboard 输出：`cases/loongsuite-pilot-insight/output/<scenario>-dashboard.json`
- 默认预览输出：`cases/loongsuite-pilot-insight/output/<scenario>-report.html`
- 数据语义入口：`schema.md`

若用户只给自然语言需求，先选择或创建一个清晰的 `<scenario>-spec.md`，再按标准流程生成 dashboard 和预览。

## Workflow

1. 确定 `<scenario>`，读取或创建 `cases/loongsuite-pilot-insight/input/<scenario>-spec.md`。
2. 读取 `schema.md`，确认 Data Source Bindings、字段语义、公共 CTE、指标可加性和风险点。
3. 解析 spec，将自然语言需求转成视图清单：指标、SQL、图表类型、布局、筛选器和说明块。
4. 使用 `sls-dashboard-builder` 生成或更新 `cases/loongsuite-pilot-insight/output/<scenario>-dashboard.json`。
5. 调用 `sls-dashboard-builder.render-report`，以 `cases/loongsuite-pilot-insight` 为 case-dir，生成 `cases/loongsuite-pilot-insight/output/<scenario>-report.html`。
6. 用户确认预览没问题后，再 create 或 update 线上 SLS 报表；不要跳过预览直接发布。

新增同类报表时只新增 `cases/loongsuite-pilot-insight/input/<scenario>-spec.md`，不要新增 skill。真实 project、region、logstore 统一维护在 `schema.md`。

## Dashboard Spec

spec 用来描述某一次 dashboard 报表需求，结构与 `cases/loongsuite-pilot-insight/input/*-spec.md` 保持一致。详细业务口径写在 spec 正文或 `schema.md`，不要塞进 `SKILL.md`。

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
    - ai_coding_events
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

- `data.sources` 引用 `schema.md` 中的 logical source，例如 `ai_coding_events`、`dept_roster`。
- `dashboard.name` 是生成 SLS dashboard JSON 的稳定名称，`dashboard.displayName` 是大盘展示名。
- `dashboard.defaultTimeRange` 使用 SLS 相对时间，例如 `-604800s`、`-86400s`、`-2592000s`。
- `dashboard.layout` 默认使用 `grid`。
- 不在 spec 中重复维护真实 project、region、logstore；这些放在 `schema.md` 的 Data Source Bindings。
- 不为构建归档、HTML 预览等后续产物维护独立 spec。
- dashboard 模块统一使用 `## Section:`；筛选器、静态说明块和普通图表都放在 section 下。
- 图表元信息优先写 `intent`、`type`、`size`，按需补 `format`、`unit`、`orientation`、`key`、`filterType`、`globalFilter`。

## Preview

生成本地预览时调用 `sls-dashboard-builder.render-report`，case-dir 使用 `cases/loongsuite-pilot-insight`；修改已有 dashboard 时带 `--with-diff` 生成 HTML SQL / 结果 diff；如报表 SQL 使用 token 参数，通过 `--var key=value` 传入本地预览值。若查询失败，应修复查询、凭据或网络问题后重新生成预览。

## Guardrails

- 不编造不存在的字段或 logstore。
- 生成任何部门、团队或覆盖率类报表前，必须读取 `schema.md`。
- `dept_user` 是部门类报表的关键语义；生成部门类报表前必须确认 `schema.md` 中的定义。
- 当 spec 的 `data.sources` 只有 `ai_coding_events` 时，不要生成总在册人数、覆盖率、未产生日志员工列表、部门或团队 TopN；这些都需要 `dept_roster` 或客户自定义外表。
- 部门维表只依赖 `department` 的 `work_no`、`name`、`dept_name` 三个索引字段。
- Skill 统计使用 `schema.md` 中从 `gen_ai.tool.call.arguments` 的 `file_path` 动态解析出的 `skill_name`，不要使用 `gen_ai.skill.name`。
- 跨表 JOIN 使用 `dept_user` 时，不要直接使用 `compare()` 做同比；按 `sls-dashboard-builder` 中的手动时间窗口规则处理。
- `active_user` 中的 token、events 可加；去重类指标不要对预聚合结果求和。
- 图表标题、图例、表头默认使用中文。
