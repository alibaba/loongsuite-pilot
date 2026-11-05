# Layout

`grid` 和 `free` 两种布局模式的规则。

## 1. grid 栅格布局

核心参数：
- 总列数：24
- 行高：36px
- 坐标使用栅格单位（非像素）

```json
{
  "xPos": 0,
  "yPos": 0,
  "width": 8,
  "height": 9
}
```

- `xPos` — 起始列（0-23）
- `yPos` — 起始行
- `width` — 占用列数（最大 24）
- `height` — 占用行数

默认普通图表尺寸：`width = 8, height = 9`（三列均分，一行放 3 个）

### grid 自动布局规则

- 从左到右排，一行放不下就换行
- 普通图表默认 `8 x 9`
- 保持已有图表顺序，不做无关重排
- 示例：3 个图表一行 → `(0,0,8,9)`, `(8,0,8,9)`, `(16,0,8,9)`
- 第 4 个图表换行 → `(0,9,8,9)`

## 2. free 自由布局

坐标使用像素值：

```json
{
  "xPos": 0,
  "yPos": 0,
  "width": 500,
  "height": 300
}
```

默认普通图表尺寸：`width = 500, height = 300`

### free 自动布局规则

- 新图表默认放在已有图表下方
- `xPos = 0`
- `yPos = 当前最大底部 + 10`
- 保持已有图表不动

## 3. dashboardrow 特殊规则

仅用于 grid 布局的折叠行/分组行：

```json
{
  "title": "row-1710000000000",
  "type": "dashboardrow",
  "search": {
    "logstore": "",
    "topic": "",
    "query": "",
    "start": "-900s",
    "end": "now"
  },
  "action": {},
  "display": {
    "basicOptions": {
      "displayName": "分组标题"
    },
    "xPos": 0,
    "yPos": 0,
    "width": 24,
    "height": 1,
    "version": "2"
  }
}
```

- `width` 占满 24 列
- `height` 通常为 1
- free 布局中不建议使用

## 4. 特殊图表尺寸建议

| 图表类型 | grid 建议 | free 建议 |
| --- | --- | --- |
| 普通图表 | `8 x 9` | `500 x 300` |
| `rawlog` | `8 x 4` | 源码默认 `300 x 50`，推荐产出 `500 x 150` |
| `droplistpro` | `6 x 2` | `300 x 50` |
| `markdownpro` | `8 x 6` | `500 x 300` |
| `text` | 短提示 `5 x 1`，长说明 `8 x 2` | `300 x 50` 或 `500 x 100` |
| `statpro` | `4 x 4` 或 `8 x 4` | `250 x 150` |
| `dashboardrow` | `24 x 1` | 不适用 |

用户没指定尺寸时按上述建议输出。
