## Why

当前通过编译期常量 `__INTERNAL_BUILD__` 区分内部/外部版本，产出两套不同的构建产物。这增加了发布和维护复杂度（两条打包流水线、两套 installer 脚本）。需求变更为：只维护一套代码和一套构建产物，通过运行时配置 `config.json` 中的 `internal` 字段控制是否向内部 SLS 发送日志。

## What Changes

- **BREAKING**: 移除编译期常量 `__INTERNAL_BUILD__` 及其类型声明 (`build-flags.d.ts`)
- **BREAKING**: 移除 `build.mjs` 中的 `--internal` / `--external` 参数逻辑，统一为单一构建
- 移除 `package.json` 中的 `build:internal` / `build:external` 脚本，只保留 `build`
- `config.json` 新增顶层字段 `internal: boolean`（默认 `true`）
- `sls-destination.ts` 始终导出真实的内部 SLS 常量（不再条件编译）
- `config-loader.ts` 中所有 `__INTERNAL_BUILD__` 判断替换为读取运行时 `config.internal`
- `orchestrator.ts` 中 agent 门控逻辑改为读取运行时配置
- 部署脚本（`package.sh`, `upload.sh`）移除 `--external` 分支，统一为单一流水线
- installer 脚本根据部署上下文写入 `"internal": true` 或 `"internal": false`

## Capabilities

### New Capabilities

- `runtime-internal-flag`: 运行时 `internal` 配置项，控制是否启用内部 SLS 日志发送、内部更新源、agent 门控放行

### Modified Capabilities

_(无现有 spec 需要修改)_

## Impact

- **代码**: `src/internal/sls-destination.ts`, `src/core/config-loader.ts`, `src/core/orchestrator.ts`, `build.mjs`, `src/internal/build-flags.d.ts`
- **构建**: `package.json` scripts, `vitest.config.ts` globals 定义
- **部署**: `deploy/package.sh`, `deploy/upload.sh`, `deploy/package-inner.sh`, `deploy/package-external.sh`, `deploy/upload-inner.sh`, `deploy/upload-external.sh`
- **安装器**: `deploy/installer-inner.sh`, `deploy/installer.sh`
- **测试**: 所有引用 `__INTERNAL_BUILD__` 的测试用例需更新

## Affected Baseline Modules

- `core.md` — ConfigLoader SLS 目的地解析逻辑描述需更新（从编译期常量改为运行时配置）
- `updater.md` — 更新包 URL 解析逻辑描述需更新

## Baseline Documentation Updates

实现完成后需同步更新：
- `docs/modules/core.md` — "SLS 目的地解析" 小节：将 `__INTERNAL_BUILD__` 描述替换为 `config.internal` 运行时读取
- `docs/modules/updater.md` — 如有提及编译期区分的描述需更新
