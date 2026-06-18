# LoongSuite Pilot Dashboard 项目

本目录是对外交付版 SLS Dashboard 工作区。`README.md` 面向使用者，业务语义和工作流下沉到 `loongsuite-pilot-insight` skill；本文件只保留仓库级硬边界。

## Skill 路由

- LoongSuite Pilot / AI Coding Agent 报表需求默认使用 `.agents/skills/loongsuite-pilot-insight`。
- 通用 SLS dashboard 结构、图表配方、发布规则和 HTML 预览能力来自 `.agents/skills/sls-dashboard-builder`。
- `sls-dashboard-builder` 必须保持通用，不写入 LoongSuite Pilot 业务 schema、公共 CTE、脚本或报表产物。

## 文件边界

- 真实 project、region、logstore、字段语义、指标口径和公共 CTE 放在 `.agents/skills/loongsuite-pilot-insight/schema.md`。
- 单次报表需求放在 `cases/loongsuite-pilot-insight/input/<scenario>-spec.md`。
- 生成产物只写入 `cases/loongsuite-pilot-insight/output/`，不要写入 skill 目录。
- 同一数据语义下新增报表时，不新增 skill；只新增一个 `<scenario>-spec.md`。

## 执行边界

- 生成 HTML 预览时调用 `sls-dashboard-builder.render-report`。
- 如因网络沙箱导致 SLS 查询或发布失败，应请求网络权限后重跑。
- 发布线上 SLS 报表时使用 `aliyun sls create-dashboard` / `update-dashboard`。
