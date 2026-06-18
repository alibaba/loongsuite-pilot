# Task-Driven Dashboard Workflow

Use this document when the dashboard work is driven by a concrete task package rather than a blank canvas.

Typical task-pack inputs:
- a requirements doc
- a metric catalog or query plan
- validated query result files
- one or more existing dashboards to borrow from

## 1. Build A View Inventory

For each validated view, capture:
- metric
- display intent such as `compare-card`, `line`, `top-table`, `cohort-table`
- project and logstore
- time range
- blocker or assumption
- source dashboard, if one exists

If the task pack already names `source_dashboard`, treat that as a strong hint to reuse query shape and display semantics.

## 2. Recover Real Dashboard Context First

If the task references live dashboards, do not guess their structure from screenshots alone.

Use `aliyun sls` and fetch them first:
- `aliyun sls list-dashboard --project <project> --region <region>`
- `aliyun sls get-dashboard --project <project> --dashboard <name> --region <region>`

Look for:
- section rhythm (`dashboardrow`)
- filter strategy (`droplistpro`)
- compare-card display config
- grouped trend patterns (`aggpro`)
- table layout and sizing
- document-link style metric definitions
- whether the dashboard has already been manually tuned online after your last local draft

## 2.5. Live Patch Rule

When the user has already edited the dashboard online:
- fetch the latest live dashboard JSON again
- diff it against your local draft
- patch the live JSON in place

Do not take an older local JSON and push it wholesale. That will erase the user's newer layout, naming, query, or explanation changes.

## 3. Group Views Into Decision Sections

Do not group charts by logstore. Group them by the decision the viewer is making.

Common sections:
- `概览` - compare cards and scope notes
- `趋势` - time-series views
- `TOP` - ranking tables
- `Cohort` - retention tables
- `钻取` - customer, workspace, request-level drilldown

For a multi-dashboard suite, split by decision surface, not by chart type.

## 4. Layout Rhythm

Default grid rhythm that matches real SLS analytics dashboards well:
- `dashboardrow` -> `24 x 1`
- compare-card `statpro` -> `4 x 3`
- single-metric `linepro` trend -> `8 x 6` or `12 x 6`
- grouped `aggpro` trend -> `12 x 6` or `24 x 6`
- table -> `8 x 6`, `12 x 7`, or `24 x 7`
- markdown note -> `12 x 3` or `24 x 4`

Use a consistent vertical rhythm. Avoid mixing many unrelated chart sizes in the same row.

## 5. Filter Rules

Only add filters when they genuinely work.

Good cases:
- raw filter keys that exist across the target charts
- tokenized queries that already use `${{var}}`

Bad cases:
- decorative filters with no query binding
- filters on joined fields that the charts never expose in the filter path

## 6. Blockers And Partial Metrics

If a metric is blocked because the source data is missing or incomplete:
- do not invent a query
- do not fake a card
- add a short `markdownpro` note, or leave the metric out and state the omission

This is especially important for denominator or mother-population metrics such as penetration rates.

## 6.5. Definition-Sensitive Metrics

Some metrics are easy to misunderstand unless the dashboard spells out the definition.

Typical cases:
- deep-usage thresholds such as `>= 3` categories
- churn definitions such as `上月活跃且本月未再访问`
- retention definitions such as `cohort -> 次周 / 次月`
- comparison tables with `较1天前 / 7天前 / 30天前`

For these, prefer adding a short definition through `documentLinkOption` on the chart, or through a nearby `markdownpro` note when several charts share the same caveat.

## 7. Suite Blueprints For This Task Shape

### `留存与活跃`

Good section order:
1. compare cards for DAU, WAU, MAU
2. active trends
3. comparison tables such as GC or customer segments when growth attribution matters
4. cohort tables
5. deep-usage or churn trends
6. blocker note for missing penetration denominator, if needed

### `业务与成本`

Good section order:
1. compare cards for session volume and token volume
2. grouped business trends for sessions, tokens, and cost
3. customer and workspace drilldown tables
4. short markdown note for cost assumptions
