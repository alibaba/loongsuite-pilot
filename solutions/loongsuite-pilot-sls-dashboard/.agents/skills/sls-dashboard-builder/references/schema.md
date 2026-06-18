# Schema

SLS dashboard JSON 的顶层结构、图表关键字段，以及两种输出模式的区别。

## 顶层结构

```json
{
  "dashboardName": "dashboard-1710000000000-123456",
  "displayName": "业务监控总览",
  "description": "",
  "attribute": {
    "type": "grid"
  },
  "charts": []
}
```

```ts
interface DashboardDefine {
  attribute?: { type?: 'grid' | 'free' }  // 可选，object
  charts: DashboardChart[]                 // 必填，array
  dashboardName?: string                   // 创建时必填，更新时从 URL 取
  description?: string                     // 可选
  displayName?: string                     // 可选，最大 512 字符
}
```

## DashboardChart 关键字段

```ts
interface DashboardChart {
  title: string    // 必填，内部唯一标识
  type: string     // 必填，真实图表类型（参照 chart-types.md）
  search: object   // 必填，必须是 object（不能是 null）
  display: object  // 必填，必须是 object（不能是 null）
  action?: object  // 可选，如果存在必须是 object
}
```

`search` 必须是 object，但不代表每个图表都必须有 `search.chartQueries`。静态组件如 `dashboardrow`、`text` 可以没有查询。

## 后端验证规则

### dashboardName

- 正则：`^[0-9a-z][0-9a-z_-]{0,126}[0-9a-z]$`
- 只允许小写字母、数字、下划线 `_`、连字符 `-`
- 首尾必须是小写字母或数字
- 长度 2-128 字符
- 创建时必填，更新时不需要（从 URL 路径取）

### chart.title

- 正则：`^[0-9a-z][0-9a-z_-]{0,98}[0-9a-z]$`
- 只允许小写字母、数字、下划线 `_`、连字符 `-`
- 首尾必须是小写字母或数字
- 长度 2-100 字符
- 同一 dashboard 内不能重复

生成建议：使用 `chart-时间戳-序号` 格式，如 `chart-1710000000000-01`。不要直接用 mixed-case 的 `type` 做前缀（如 `timeseriesPro` 含大写字母，不合法）。

### displayName

- 可选
- 最大长度 512 字符

### charts

- 必填，必须是 array
- 允许空数组，但通常只有在 scaffold / 占位模式下才建议这样做
- 正常生成可用 dashboard 时，默认至少输出 1 个 chart
- 有最大图表数量限制

## `chart.title` 与 `display.basicOptions.displayName`

二者不要混淆：

- `chart.title` — 内部唯一标识，必须符合上述正则
- `display.basicOptions.displayName` — 用户可见标题，无格式限制

示例：

```json
{
  "title": "chart-1710000000000-01",
  "type": "linepro",
  "search": {},
  "action": {},
  "display": {
    "basicOptions": {
      "displayName": "请求延迟趋势",
      "showTitle": true,
      "showBorder": true,
      "showBackground": true,
      "showTime": true
    }
  }
}
```

## `api-ready` 与 `editor-ready`

### `api-ready`（默认）

适用场景：通过 SLS API 创建/更新 dashboard。

创建时必填字段：`dashboardName`, `charts`
更新时必填字段：`charts`（`dashboardName` 从 URL 取）
推荐字段：`displayName`, `description`, `attribute`

### `editor-ready`

适用场景：在 SLS 控制台 JSON 编辑器中粘贴导入。

推荐字段：`displayName`, `attribute`, `charts`

如果用户没指定模式，默认输出 `api-ready` 创建模式。
