## Why

当前发布流程是全量模型：`latest.json` 一旦更新，所有客户端在下一个轮询周期内同时更新。无法分批发布、爆炸半径不可控、缺乏观察窗口。需要支持按百分比逐步发布新版本，在小范围验证后再扩大，紧急情况下可秒级止血。

## What Changes

- 扩展 `latest.json` 结构，新增可选 `canary` 字段，包含灰度版本信息和 rollout 规则
- 扩展 `config.json`，新增 `installId`（自动生成 UUID）、`autoCanary`/`noCanary` 开关、`canary.hotfix_version`（updater 自动维护）
- 改造 Updater：新增 `resolveTargetVersion()` 分桶路由逻辑，根据 noCanary/autoCanary/bucket 决定目标版本；`needsUpdate()` 增加 hotfix_version 比较；更新完成后写入 config.json
- 新增 `deterministicBucket(installId)` 分桶函数（`hash(installId) % 100`）
- 改造 `deploy/release.sh` 支持 `--canary` 和 `--hotfix` 参数
- 改造 `deploy/upload.sh` 灰度模式下更新 `latest.json` 的 canary 字段
- 新增 `deploy/rollout.sh` 脚本（`--percentage N`、`--promote`）

## Capabilities

### New Capabilities
- `canary-rollout`: 灰度发布核心能力——客户端分桶决策、hotfix_version 比较、installId 管理、canary manifest 解析
- `canary-release-scripts`: 灰度发布脚本——release.sh --canary/--hotfix、rollout.sh --percentage/--promote、upload.sh canary 模式

### Modified Capabilities
（无现有 spec 需要修改）

## Impact

### Affected Baseline Modules
- **updater** (`docs/modules/updater.md`): 核心改造模块。check() 流程插入 resolveTargetVersion() 路由层，needsUpdate() 增加 hotfix_version 逻辑，downloadAndDeploy 后写入 config.json
- **core** (`docs/modules/core.md`): ConfigLoader 扩展 — config.json schema 新增 installId/autoCanary/noCanary/canary 字段，buildAutoUpdateConfig() 输出扩展
- **types** (`docs/modules/types.md`): 新增 CanaryManifest 接口，AutoUpdateConfig 扩展

### Affected Code
- `src/updater/updater.ts` — 主要改造
- `src/updater/version-utils.ts` — 新增 deterministicBucket()
- `src/core/config-loader.ts` — config schema 扩展
- `src/types/index.ts` — 类型扩展
- `deploy/release.sh` — --canary / --hotfix 参数
- `deploy/upload.sh` — canary 模式 latest.json 更新
- `deploy/rollout.sh` — 新增脚本

### Design Constraints
- Forward-only：不支持降级，只升不降
- 所有 canary 逻辑 try/catch 包裹，异常 fallback 到现有 stable-only 行为
- 老 updater 天然安全：不认识 canary 字段，自然忽略
- 不引入新的服务端基础设施，仍基于 OSS 静态文件
