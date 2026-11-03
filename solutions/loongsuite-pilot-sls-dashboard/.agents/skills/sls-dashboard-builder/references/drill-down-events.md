# 交互事件与下钻报表

用于制作“总览 → 单个对象明细 → 原始日志”等分析路径，以及从图表打开业务系统页面。先确定点击位置、目标资源、参数映射和时间范围，再配置图表。数据源和业务指标仍由上游 skill 或场景 spec 定义。

## 选择跳转方式

先按用户打开报表的产品确定查看环境，不按数据是否存储在 SLS 判断：

| 查看环境 | 跳转方式 |
|---|---|
| 纯 SLS 控制台 | 日志库、仪表盘、快速查询使用对应原生事件；外部业务页面使用自定义 HTTP 链接。 |
| AgentLoop | 当前宿主中的报表跳转暂时仅支持自定义 HTTP URL，使用 `event: link` 指向 AgentLoop 宿主页面，并显式传递所需变量和时间。 |

AgentLoop 的原生跳转宿主适配尚未完成；不能直接复用 SLS 的原生事件作为可用跳转交付。待宿主修复并完成实点验证后再切换，专门用于排查的原生复现盘除外。同一报表需在两种环境中使用时，分别配置并验证对应宿主的交互。

下表按目标列出事件类型，其中前三项原生事件用于纯 SLS 场景：

| 目标 | 控制台事件类型 | modern JSON `event` | 配置重点 |
|---|---|---|---|
| SLS Logstore | 打开日志库 | `logstore` | Project、Logstore、搜索过滤语句 |
| SLS 仪表盘 | 打开仪表盘 | `dashboard` | Project、`dashboardName`（仪表盘资源名）、目标变量映射 |
| SLS 快速查询 | 打开快速查询 | `savedSearch` | Project、`savedSearchName`（快速查询资源名）、查询变量映射 |
| 任意业务页面或 HTTP(S) 地址 | 自定义 HTTP 链接 | `link` | 协议、地址、参数编码、打开方式 |

纯 SLS 场景的前三类目标由原生事件处理资源路由、时间和变量传递，无需手工拼接 SLS URL、`token` JSON 或多次 URL 编码。AgentLoop 仪表盘间跳转使用下文内置的 [AgentLoop URL 配方](#agentloop-仪表盘间跳转)，包含站内路由、变量格式与编码规则，不能照搬 SLS 控制台的 `/lognext/...` 相对路径。任意业务 HTTP(S) 地址使用通用自定义链接。

嵌入其他产品的仪表盘也需确认宿主对事件类型与路由的支持。按宿主能力选择并验证跳转方式；若目标错误，分别检查资源名、权限和宿主路由，不能仅凭独立 SLS 控制台中的成功结果宣称嵌入页面也可用。

## 定义交互契约

每个交互在 spec 中写清以下内容，不依赖图表标题推断：

- 查看环境：纯 SLS 控制台或 AgentLoop；AgentLoop 仪表盘间跳转按本文内置配方配置，在场景 spec 中绑定实际地域、AgentSpace、目标仪表盘与变量名。
- 点击入口：查询标识（如 `A`）、图表类型、绑定字段、事件名称。
- 跳转目标：事件类型、Project、目标资源名或 HTTP 地址。原生仪表盘事件传 `dashboardName`，快速查询事件传 `savedSearchName`；两者均为资源名，不使用展示标题 `displayName` 或另行查找的内部 ID。
- 传参：目标变量名 → 源查询结果列，必要时补充固定变量。
- 上下文：时间范围、是否继承过滤与变量、是否打开新窗口。
- 目标行为：所有受影响的图表如何消费参数，以及未选择、清空和未匹配对象时的行为。

例如，部门总览用“部门”展示名称，用“部门标识”保留完整、稳定的关联键；目标明细使用变量 `dept_id`。表格点击“部门”单元格，柱图点击“请求数”数值系列，两者均从同一结果行取“部门标识”传给 `dept_id`。如果数据源只有部门全称，则传全称并按全称过滤，不能把截短后的轴标签作为关联键。

## 绑定点击位置与参数列

交互绑定决定**哪里能点击**，动态变量决定**传什么值**，两者可以使用不同列。

| 图表入口 | 交互绑定示例 | 动态变量来源示例 |
|---|---|---|
| 表格部门单元格 | `A > 部门` | `dept_id` ← `部门标识` |
| 柱图的请求数柱子 | `A > 请求数` | `dept_id` ← `部门标识` |
| 饼图的请求占比扇区 | `A > 请求数` | `status` ← `状态码` |
| 同一查询的多个数值系列 | 查询级 `A`，不指定字段 | 按点击行读取标识列，逐个系列验证 |

柱图和饼图通常在数值系列上触发事件；只给分类轴字段添加事件，不代表柱子或扇区已配置交互。折线图等其他图表同样按实际触发的系列与数据点选择字段。

动态变量的“值所在列”必须存在于触发查询的结果中，且在点击上下文中可取到。绑定数值系列时，选择“当前字段”会传出数值；要传部门、Session 或资源标识，应显式选择对应结果列。展示标签可使用中文映射，传递值保留目标查询所需的原编码或标识。

表格如需隐藏辅助列，现代 `tablepro` 可通过 `display.queryOptionMap.A.closedKeys` 配置隐藏列；隐藏后仍应实点验证取值。交互统一使用 `display.actionOptions`，不要用未经当前图表验证的列 `link`、`hidden` 属性替代交互事件。

## 配置目标查询与筛选

目标仪表盘或快速查询应先存在，并在查询模板中声明同名变量。动态映射 `key` 是目标变量名，`value` 是源结果列名；静态变量的 `value` 才是固定值。

假设目标查询中的 `dept_id` 已由业务数据源或维表关联产生，单部门明细的 SQL 条件可写为：

```sql
WHERE dept_id = '${{dept_id}}'
```

该条件放在产生 `dept_id` 的查询层、聚合之前；关联后的派生列不能当作原始 Logstore 字段追加到搜索前缀。保留 `chartQueries[].tokenQuery` 中的模板，`query` 按 [query-syntax.md](query-syntax.md) 保存替换后的查询。目标盘的相关卡片、趋势和表格都必须消费同一变量，仅显示一个部门筛选器不能保证查询已过滤。

目标如允许直接打开查看全部对象，应明确空值约定，可使用 SLS 的 `${{变量名|默认值}}` 语法与查询条件配合；默认值应避开真实业务值。验证清空后实际替换的值，不能假设所有嵌入环境都把空值传为空字符串，也不要把某一宿主的字面量 `undefined` 约定推广到所有报表。参数替换是文本替换，源值中的引号等字符应按所在搜索或 SQL 语法处理。

三种上下文各有用途：

- **动态/静态变量**：显式传给目标查询的 token，适合关联后字段或参数化 SQL。
- **继承变量**：沿用源盘已有变量；不能代替点击行的动态映射，避免同名变量冲突。
- **继承过滤 / 过滤语句**：目标原始数据上的搜索条件。仅继承目标数据源能识别的字段；不要把源盘独有的字段或 SQL 别名传给其他 Logstore。

打开日志库时，`searchFilter` 使用目标日志字段名，例如 `session_id: "${{会话ID}}"`，而非源图表的展示列名作为搜索字段。搜索字面量转义与 SQL 字符串转义不同，需分别处理并核对目标实际查询。

## 时间与打开方式

下钻通常选择“继承图表时间”，对应 `timeRange: -1`。绝对时间窗口应保留相同开始、结束时间；相对窗口继承时间预设，目标打开时可能重新计算当前结束时间。需要严格对账时用绝对窗口验证。

自定义链接可使用 `${{__start_time__}}`、`${{__end_time__}}`（Unix 秒）、`${{__interval__}}`（秒）和 `${{__project__}}`，目标参数单位必须与之匹配。不要用点击行的事件时间替代整个图表查询窗口。

按分析路径选择是否打开新窗口（`blank`）；点击图表后可能先显示事件菜单，再选择事件名称。菜单存在、链接样式出现或配置已保存，都不等于目标已成功过滤。

## Modern JSON 配方

以下均为合成资源示例。前三个原生配方用于纯 SLS 场景；AgentLoop 使用自定义 HTTP(S) 链接配方，并替换为宿主实际 URL。添加到图表的 `display` 中并保留其余显示配置；替换资源名、查询标识和结果列名。已有 legacy 图表保持原格式，必要时先在编辑器配置一个同类型事件并读取保存结果，不整体迁移大盘。

### 原生打开仪表盘

柱图按“请求数”系列绑定，传递同一行的部门标识：

```json
{
  "actionOptions": [
    {
      "queryName": "A",
      "name": "请求数",
      "events": [
        {
          "event": "dashboard",
          "values": {
            "name": "查看部门明细",
            "project": "example-project",
            "dashboardName": "department-detail",
            "timeRange": -1,
            "blank": true,
            "filterInherit": false,
            "tokenInherit": false,
            "searchFilter": "",
            "searchToken": [{"key": "dept_id", "value": "部门标识"}],
            "searchStaticToken": []
          }
        }
      ]
    }
  ]
}
```

表格改为 `name: "部门"`；若应用到整个查询，则省略 `name`。`searchToken[].value` 写列名，不写 `${{部门标识}}` 或当前列的样本值。静态变量形如 `{"key":"view_mode","value":"detail"}`，仅在目标查询确有该变量时添加。

### 原生打开日志库

在上面的 `events` 中使用以下事件；源结果应包含“会话ID”，目标日志应有已建索引的 `session_id` 字段：

```json
{
  "event": "logstore",
  "values": {
    "name": "查看会话日志",
    "project": "example-project",
    "logstoreName": "application-events",
    "timeRange": -1,
    "blank": true,
    "filterInherit": false,
    "searchFilter": "session_id: \"${{会话ID}}\""
  }
}
```

### 原生打开快速查询

目标快速查询需在模板中声明 `session_id` 变量，`savedSearchName` 使用快速查询资源名：

```json
{
  "event": "savedSearch",
  "values": {
    "name": "分析会话调用",
    "project": "example-project",
    "savedSearchName": "session-analysis",
    "timeRange": -1,
    "blank": true,
    "filterInherit": false,
    "searchFilter": "",
    "searchToken": [{"key": "session_id", "value": "会话ID"}],
    "searchStaticToken": []
  }
}
```

### 自定义 HTTP(S) 链接

支持任意业务系统地址。下面假设 `resource_id` 为 URL 安全的稳定 ID：

```json
{
  "event": "link",
  "values": {
    "name": "打开资源详情",
    "protocol": "https",
    "link": "example.com/resources/${{resource_id}}?from=${{__start_time__}}&to=${{__end_time__}}",
    "blank": true,
    "slsEncode": false
  }
}
```

此 JSON 格式将协议与地址分开，`link` 不重复写 `https://`；以 `/` 开头的路径依赖当前宿主域名。页面输入格式如有差异，以编辑器保存后的 JSON 为准。

含 `&`、空格、中文、`#`、`%` 等字符的动态值应按目标 URL 的路径段或查询参数分别编码；可在查询中产生专用 URL 参数列，再在链接中引用。已有 `?` 时用 `&` 追加参数。`slsEncode` 对应界面的“是否转码”，不能据此假定任意 URL 参数均已正确编码，应核对真实目标收到的值。原生事件无需预编码变量；自定义链接的编码次数由目标解析约定决定，不默认双重编码。不把鉴权信息或完整日志正文拼进 URL。

### AgentLoop 仪表盘间跳转

AgentLoop 仪表盘使用 AgentSpace 下的站内路由。当前以 `event: link` 按以下配方传递页面地址、变量和时间。

```text
/agentloop/region/<region>/agentspace/<space>/app/dashboard/detail/<dashboard-name>
```

| 路由或参数 | 当前约定 |
|---|---|
| `region` | 目标 AgentSpace 所在地域，如 `cn-shanghai`。 |
| `space` | 目标 AgentSpace 的名称，不是 SLS Project 名。 |
| `dashboard-name` | SLS 仪表盘资源名 `dashboardName`，不是展示标题 `displayName`。 |
| `dashboardSlsSource=agentSpace` | 使用当前 AgentSpace 绑定的 SLS 数据源；此配方针对该来源。 |
| `queryTimeType=99` | 显式指定绝对时间范围。 |
| `startTime` / `endTime` | 源图表查询起止时间，Unix 秒；分别引用 `${{__start_time__}}` / `${{__end_time__}}`。 |
| `token` | 目标查询变量的 `{key,value}` 对象数组，先转为 JSON 字符串，再做两次 URL 编码。 |

例如，目标查询声明 `${{dept_name}}`，点击行的部门全称应作为 `value`。编码前的 token 内容为：

```json
[{"key":"dept_name","value":"示例团队-平台&数据"}]
```

假设源查询已有字符串列 `dept_name`，在最终结果的同一行追加以下辅助列。多个目标变量放在同一数组中；值使用字符串，变量名与目标 `tokenQuery` 一致。

```sql
url_encode(url_encode(json_format(
  CAST(ARRAY[
    map(ARRAY['key','value'], ARRAY['dept_name', dept_name])
  ] AS JSON)
))) AS _jump_token
```

当前 AgentLoop 跳转链路会解析并重写 URL，token JSON 采用双层编码以保留中文、`&` 等字符。单层编码会使特殊字符在传递过程中过早解码，可能导致目标变量截断或匹配不到数据。双层编码仅用于此 AgentLoop URL 配方；纯 SLS 原生事件直接传原始列值。不要编码整条 URL，也不要再对 `_jump_token` 追加编码。

在实际点击字段的 `events` 中配置以下事件，替换地域、AgentSpace 名称和仪表盘资源名 `dashboardName`：

```json
{
  "event": "link",
  "values": {
    "name": "查看部门明细",
    "protocol": "https",
    "link": "/agentloop/region/cn-shanghai/agentspace/example-space/app/dashboard/detail/department-detail?dashboardSlsSource=agentSpace&queryTimeType=99&startTime=${{__start_time__}}&endTime=${{__end_time__}}&token=${{_jump_token}}",
    "blank": true,
    "slsEncode": false
  }
}
```

这里的相对路径沿用 AgentLoop 当前域名；跨域打开时改用目标 AgentLoop 域名，并遵守协议与地址分开的格式。该配方显式传递时间和变量，不依赖原生事件的 `timeRange`、`searchToken` 或继承开关。现有配置中的 `${__start_time__}` / `${__end_time__}` 也是渲染器支持的系统时间写法。

柱图仍绑定数值系列；表格绑定部门列，两者都从点击行取 `_jump_token`。表格可在 `display.queryOptionMap.A.closedKeys` 中加入 `_jump_token` 隐藏辅助列。目标页面需使用相同变量名配置筛选器与查询，所有相关图表均须消费该变量。

目标页面可能将 token 改写为 `key:value` 的地址表示，不要把重写后的浏览器 URL 当作新链接的构造模板；生成链接仍使用上述 JSON 数组。验收时核对目标页面、变量控件、实际查询结果和起止时间，至少包含一个有中文及 `&` 的测试值。此处确认的是仪表盘间跳转；日志库和快速查询在 AgentLoop 中的页面路由需单独核对，不能套用仪表盘详情路径。

## 控制台配置与验收

1. 编辑仪表盘，再进入源图表编辑页，在“交互事件 → 添加字段”选择查询或实际点击系列/单元格字段。
2. 按查看环境选择事件：纯 SLS 目标使用对应原生事件，AgentLoop 暂用自定义 HTTP URL；设置目标、变量映射、时间及适用的继承选项。
3. 点击图表编辑页“确定”，再保存仪表盘。使用 API 更新时先读取最新线上配置，仅修改相应 `actionOptions` 并回读结果。
4. 在查看模式实际点击并选择事件，核对下表。HTML 预览可验证查询与布局，不能替代 SLS 或嵌入宿主中的原生交互验收。

| 检查项 | 通过条件 |
|---|---|
| 点击绑定 | 表格目标单元格、柱/扇区/点的指定系列均有正确事件；不出现“当前暂无配置” |
| 资源与宿主 | 打开预期 Project、资源名和产品页面，不落到首页或其他空间 |
| 行值映射 | 至少选择两个不同对象；目标变量及实际查询结果分别对应点击对象 |
| 特殊值 | 对适用的中文、空格、`&`、引号等值检查参数完整性、查询合法性与结果范围 |
| 时间 | 绝对窗口起止一致；相对窗口预设符合约定，单位正确 |
| 上下文与清空 | 需要的过滤/变量被继承，无关条件未带入；直接打开、清空和未匹配对象行为明确 |
| 目标图表 | 卡片、趋势、明细表均按参数过滤，无查询错误；有数据样本不能意外全空 |
| 持久化 | 保存后重新进入查看模式仍能复现；旧编辑页不会覆盖新配置 |

只回读过 JSON 时报告“配置已保存”；实际完成点击与结果检查后再报告“跳转已验证”。按事件类型分别记录验证范围，不用一种事件的成功替代另外几种。

## 参考资料

- [SLS：为仪表盘添加交互事件实现下钻分析](https://help.aliyun.com/zh/sls/drill-down-events)：原生事件、过滤、变量和控制台操作。
- [SLS：添加过滤器筛选仪表盘与添加变量替换筛选图表](https://help.aliyun.com/zh/sls/add-filter)：字段过滤与变量替换。
- [query-syntax.md](query-syntax.md)：`query` / `tokenQuery` 和查询语法。
