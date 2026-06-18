---
name: sls-dashboard-builder
description: 当任务需要创建、修改、扩展或重组阿里云 SLS 的 dashboard JSON 或可导入的大盘配置时使用；尤其适用于线上大盘、强对比的分析看板、已校验的查询包，或需要专业中文标签与指标定义的运维向大盘。
---

# SLS Dashboard Builder

创建或修改完整、可导入的阿里云 SLS dashboard JSON。

**必备运维技能：** 若任务涉及真实 Project 或大盘，且需要通过 `aliyun sls ...` 查看或复用线上大盘，必须基于最新线上 JSON 操作。

## 总览

本技能以**任务**为先，不以「先选图表模板」为先。  
对**线上大盘**，还以**当前线上状态**为先。

若用户已提供以下**任意一项或多项**，不要从随意图表模板起手：

- 已有 dashboard JSON  
- 大盘 URL 或大盘名称  
- 指标需求或查询方案  
- 已校验的查询结果文件  
- 明确的「做这 2 张大盘」之类需求说明  

上述情况下应先还原任务结构，再把每个已校验的视图映射到 SLS 图表，最后拼出 dashboard JSON。  
若大盘已在线存在，应在**最新线上 JSON** 上打补丁，而不是推送更早的本地草稿。

## 何时使用

适用于：

- 新建 dashboard JSON  
- 修改、扩展、重排已有 dashboard  
- 将一份分析 / 监控需求包落实为 1 张或多张 dashboard  
- 生成可直接通过 SLS API 导入的 dashboard 配置  
- 参考现有 dashboard 的成熟写法做最小改造  

不适用于：

- 单纯解释 SQL / PromQL  
- 复杂前端可视化开发  
- 非 SLS dashboard 配置  

## 默认行为

- 默认输出形态：`api-ready`  
- 新建大盘：现代格式（modern）  
- 已有老格式大盘：保持 legacy，仅做最小补丁  
- 用户提供了现有 JSON：保留未知字段与未改动的图表  
- 未明确要求发布，或用户尚未确认预览效果前，只生成或修改本地 dashboard JSON，不 create/update 线上大盘  
- create/update 线上大盘时，以用户确认后的 dashboard JSON 为准  
- 发布到 SLS 时使用插件命令 `aliyun sls update-dashboard` / `create-dashboard`，显式传 `--display-name`、`--charts`、`--description`、`--attribute remark=<具体修改原因> type=grid update=<ms> version=<version>`；不要用 CamelCase OpenAPI 入口 `UpdateDashboard --body-file` 发布。
- 公开 SLS Dashboard API 的 `UpdateDashboard` / `aliyun sls update-dashboard` 是覆盖式更新当前大盘；`attribute.version/update/remark` 只影响当前版本展示元数据，不会自动追加控制台「历史版本」归档。
- 用户说「先给一版」：默认 `single-dashboard-mvp`  
- 用户提供完整任务包或设计文档：默认 `single-dashboard-full`  
- 用户明确要求多张大盘：使用 `multi-dashboard-suite`  

## 模式

### 1. 更新已有大盘

1. 先拉取或读取当前 JSON  
2. 复用现有结构，只改被要求的图表或布局  
3. 不相关的图表与字段保持不动  

### 2. 创建单张大盘

适用于用户需要**一张盘**，包含概览、关键趋势与表格等。

### 3. 创建大盘套件（多张）

适用于用户需要多个决策面，例如 `留存与活跃` + `业务与成本`。

多张盘之间保持命名、筛选器、标题风格与版式节奏一致。

## 任务包工作流

当输入包含需求文档、查询方案、结果文件或参考大盘时，按以下顺序：

1. 判定任务形态：更新、新建，还是套件  
2. 建立视图清单：指标、展示意图、project 或 logstore、时间范围、阻塞项  
3. 若有名称或 URL，优先拉取真实参考大盘  
4. 将视图归组为大盘区块，例如 `概览`、`趋势`、`TOP`、`Cohort`、`钻取`  
5. 按**视图意图**选图表配方，不按产品营销名称选  
6. 仅当图表查询**确实可被过滤或可被 token 替换**时才加筛选器  
7. 受阻指标写成简短 `markdownpro` 说明，或明确省略；**绝不编造**缺失的源数据  
8. 每张大盘输出完整 JSON  

针对此类分析套件任务，请阅读：

- `references/task-driven-workflow.md`  
- `references/view-recipes.md`  

## 视图意图 → 图表配方

- `compare-card` → `statpro`  
  需要具备对比语义的 `display.queryOptionMap`，不能只用裸统计模板。  
- `line`（时间 + 数值）→ `linepro`  
- `line`（时间 + 分组 + 数值）→ 通常为 `aggpro`  
  常见于业务或类目拆解趋势。  
- `top-table` → `tablepro`  
- `cohort-table` → `tablepro`  
- `section title` → `dashboardrow`  
- `blocker`、`assumption` 或 `scope note` → 短说明用 `text`，富文本或长说明用 `markdownpro`  
- `filter` → `droplistpro`  
  仅当原始过滤路径中存在该 key，或查询已用 token 参数化时  

## 工作规则

- 使用真实 JSON `type`，不要用界面展示名  
- 线上补丁工作：仅以最近一次 `dashboard get` 结果为安全更新基线  
- 线上发布必须通过 `aliyun sls update-dashboard` 的结构化参数传递；`attribute.update` 和 `attribute.version` 按字符串传入，并在每次发布前更新为新值。注意这只更新当前版本元数据，不代表已创建控制台历史快照。
- `attribute.remark` 必须写明本次发布的具体修改原因，例如 `对齐Token使用时段分布为HH:00并修复历史版本记录`；不要使用 `修改图表` 这类泛化文案。
- 若用户要求 SLS 控制台「历史版本」可恢复记录，不能仅依赖公开 Dashboard API；必须先确认控制台保存流程或可用的历史版本接口，再发布。
- `chart.title` 必须唯一且对正则安全  
- 用户可见标题放在 `display.basicOptions.displayName`，legacy 用 `display.displayName`  
- TopN、队列（cohort）、明细表优先 `tablepro`  
- 单序列或多指标趋势优先 `linepro`  
- 一列度量 + 一列维度的分组时间趋势优先 `aggpro`  
- 同比对比优先用 `compare(...)`、`ts_compare(...)`；但**跨表 CTE（如维表 JOIN 事件表）时 `compare()` 不可用**——它隐式扩展时间窗口不会同步到其他 logstore 的 CTE，导致对比值为 0。此时改用 `time_base`（`max(__time__)`）+ `cur_agg/prev_agg` 手动分窗口，且先按关联主键 GROUP BY 聚合再 JOIN 维表（减少 JOIN 行数避免超时）  
- SQL 别名应便于运维阅读；不要让 `active_users`、`gt_5_users`、`scene_count` 等裸英文字段名直接成为图例  
- 指标定义对理解很重要时，通过 `display.documentLinkOption.documentLinks[]` 补充  
- 同一张大盘上各图指标定义保持一致，尤其活跃、留存、成本、覆盖率等  
- `tablepro + logstore` 优先显式 `SELECT ...`；schema 或字段需要时用 `scan`  
- 参考文档按需阅读，只读最少必要部分  
- **搜索前缀 `((*))` vs `*|`**：跨表 CTE（查询多个 logstore）时用 `*|` 或 `(*)|`；同一 logstore 内的查询用 `*|` 即可。`((*))` 是旧写法，功能等价但可读性差  
- **预聚合 CTE 的字段可加性**：`sum()`/`count()` 可加；`approx_distinct()` **不可加**——同一实体可能跨多个 GROUP BY 组，对预聚合结果求和会膨胀。需要去重计数时必须在原始事件上 `approx_distinct`  

## 输出前校验清单

输出前检查：

- 顶层结构符合 `api-ready` 或 `editor-ready`  
- `dashboardName` 与每个 `chart.title` 符合命名规则  
- 除非用户要空壳，`charts` 非空  
- 每个图表具备真实 `type`、`search`、`display`  
- 静态组件如 `dashboardrow`、`text` 可不包含 `search.chartQueries`  
- 每个图表具备 `xPos`、`yPos`、`width`、`height`  
- 使用 `queryOptionMap` 时，字段与 SQL 结果列一致  
- 目标受众为中文运维或业务时，图例、轴标签、表头使用规范中文  
- 新改动基于最新线上大盘，而非更旧的本地副本  
- `droplistpro` 非装饰，必须绑定真实 key 或 token 路径  
- 分组趋势不强行塞进错误的图表家族  
- 老格式大盘不静默整体迁到现代结构  
- 使用预聚合 CTE 时，检查外层是否对 `approx_distinct` 结果做了 `sum()`——如果是，该指标需要改为在原始事件上直接去重，或从 CTE 中移除  
- 过滤条件是否在 `WHERE` 中而非 `ON` 中——如果 JOIN 条件含 `OR`（如 `ON a = b OR a = c`），追加的 `AND filter` 只作用于 OR 右侧，不是全局过滤  
- 若任务包含 create/update 线上大盘，确认用户已经看过本地预览或明确认可当前 JSON  

## 上游输入

`sls-dashboard-builder` 不维护业务 schema、公共 CTE、业务脚本或报表产物。  
当上游业务 skill 或用户提供自然语言需求、数据语义、查询方案、已有 JSON 或输出路径时，本 skill 只负责把这些输入落实为 SLS dashboard JSON、图表配置和校验建议。

## Skill Commands

### render-report

将 dashboard JSON 转成可本地打开的 HTML 预览。该命令是 `sls-dashboard-builder` 对业务 skill 暴露的通用能力；业务 skill 通过 `sls-dashboard-builder.render-report` 生成本地预览。

该命令只理解通用 SLS dashboard 结构，不内置业务 schema、CTE 或默认过滤值；按 dashboard JSON 中的查询配置渲染预览结果。

当前实现：

```bash
python3 .agents/skills/sls-dashboard-builder/scripts/render_report.py \
  --case-dir cases/<business-skill> <scenario>
```

常用参数：

- `--dashboard <path>`：指定 dashboard JSON。
- `--output <path>`：指定 HTML 输出路径。
- `--case-dir <path> <scenario>`：按 `cases/<business-skill>/output/<scenario>-dashboard.json` 约定读取并输出。
- `--var key=value`：替换 SQL 中的 `${{key}}` token。
- `--profile test`：指定 aliyun CLI profile；本交付目录默认使用 `test`。
- `--with-diff`：和 git HEAD 中同一路径 dashboard JSON 做 SQL / 结果 diff。

## 参考文档索引

按需阅读：

- `references/task-driven-workflow.md` — 任务包流程、套件拆分、版式节奏  
- `references/view-recipes.md` — 对比卡片、分组趋势、队列表、筛选与说明等配方  
- `references/schema.md` — 顶层结构与输出模式  
- `references/chart-types.md` — 真实 JSON `type`  
- `references/datasources.md` — `chartQueries` 形态  
- `references/layout.md` — 网格或自由布局规则  
- `references/chart-templates.md` — 基础图表模板  
- `references/query-syntax.md` — `query` 与 `tokenQuery` 规则  

## 示例

按需使用：

- `examples/dashboards/modern/` — 现代格式大盘级示例（含分析套件）  
- `examples/dashboards/legacy/` — 老格式大盘；仅用于 legacy 补丁场景  
- `examples/charts/` — 按真实 JSON `type` 拆分的单图示例  

## 常见错误

- 任务里已有校验查询与真实大盘，却仍从空白模板起手  
- 用过期的本地 JSON 更新线上大盘，覆盖用户线上较新的修改  
- 对比卡片用裸 `statpro` 却无对比映射  
- 本可用一条 `compare(...)` 或 `ts_compare(...)` 表达的关系，却拆到多张图里  
- 分组时间趋势该用 `aggpro` 却硬塞进 `linepro`  
- SQL 别名留英文，图例出现 `active_users`、`gt_5_users` 等裸名  
- 同一张盘上同一指标在不同图中使用了不一致的口径  
- 阈值或业务含义不直观时省略指标说明  
- 增加未绑定任何查询路径的筛选器  
- 任务只要求小补丁却重写整张大盘  
- 在 `chart.title` 中使用大小写混杂或中文  
- 对预聚合 CTE 的 `approx_distinct` 结果在外层 `sum()` 求和（详见工作规则-字段可加性）  
- 跨表 CTE JOIN 时用 `compare()` 做同比（详见工作规则-compare 限制）  
- 过滤条件放在 `ON ... OR ... AND filter` 中——`AND` 优先级高于 `OR`，实际只过滤了 OR 右侧匹配的行。过滤必须放在 `WHERE` 中，不能追加到含 `OR` 的 `ON` 子句后面  
- LEFT JOIN + WHERE IS NOT NULL 未简化为 JOIN  
- `group_concat` 不保序，应改为 `array_join(array_sort(array_agg(DISTINCT ...)), ', ')`  
- 需求说明改了但 dashboard JSON 未同步更新  
