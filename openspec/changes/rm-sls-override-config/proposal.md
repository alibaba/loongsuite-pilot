## Why

集团内版本必须 100% 将遥测数据发往内部 logstore（`ai-coding-devops / loongsuite_pilot_for_ai_coding`），用户配了自有 SLS 目的地时也必须同时发内部——不应有任何开关允许关闭。当前设计通过 `--default-sls-override` 安装参数和 `config.sls.destinationOverride` 字段给予用户"替换内置目的地"的选项，与这个策略矛盾。

同时，集团外版本不应包含任何内部 logstore 的代码（常量、引用）。当前代码中 `INTERNAL_SLS_DESTINATION` 在所有构建产物中都存在，无法满足集团外发布的隔离要求。需要在**不引入分支**的前提下，通过编译期隔离实现单代码库双版本。

## What Changes

- **BREAKING** 删除安装器 `--default-sls-override` 参数及其解析、校验、warning 逻辑
- **BREAKING** 删除 `config.sls.destinationOverride` 字段的读取和写入；该字段在 config.json 中将被忽略
- 引入编译期常量 `__INTERNAL_BUILD__`（`true` / `false`），通过 esbuild `--define` 注入
- 改造 `buildSlsConfig` 解析逻辑：集团内版本始终双发（无开关），集团外版本从不引入内部目的地
- 构建工具链从 `tsc` 产出切换为 `esbuild` 产出（`tsc` 保留做类型检查，`tsc --noEmit`）
- esbuild 的 dead-code elimination 确保集团外产物中不存在 `INTERNAL_SLS_DESTINATION` 相关代码
- 新增两个构建目标：`build:internal`（默认）和 `build:external`
- 更新 README 安装文档，移除 `--default-sls-override` 相关说明

## Capabilities

### New Capabilities
- `build-time-isolation`: 基于 esbuild `--define` + dead-code elimination 的编译期版本隔离机制，支持单代码库生成集团内/集团外两种产物

### Modified Capabilities
- `sls-dual-write`: 移除 `destinationOverride` 逻辑，集团内版本改为无条件双发；集团外版本移除内部目的地
- `sls-installer-flags`: 移除 `--default-sls-override` 参数

## Impact

### 受影响的代码
- `src/core/config-loader.ts` — `buildSlsConfig` 解析逻辑重写
- `src/internal/sls-destination.ts` — 被 `__INTERNAL_BUILD__` 条件守护
- `deploy/loongsuite-pilot-installer.sh` — 删除 `--default-sls-override` 参数
- `deploy/loongsuite-pilot-installer-inner.sh` — 同上
- `package.json` — 构建脚本从 `tsc` 改为 esbuild，新增 `build:internal` / `build:external`
- 新增 `build.mjs` — esbuild 构建配置
- 新增 `src/internal/build-flags.d.ts` — `__INTERNAL_BUILD__` 类型声明

### 受影响的测试
- `tests/unit/core/config-loader.sls-resolution.test.ts` — 用例重写，按 `__INTERNAL_BUILD__` 分组
- `tests/unit/deploy/installer.default-sls-override.test.ts` — 整体删除
- `tests/unit/deploy/installer-sls-config.test.ts` — 移除 `destinationOverride` 相关断言

### 受影响的文档
- `README.md` — 安装命令示例和 SLS 目的地解析规则说明
- `openspec/changes/add-sls-dual-write/` — 标记为被本 change supersede

### 存量用户升级影响
- 配了 `--sls-*` 且 `destinationOverride: true`（或省略）的用户：升级后自动变为双发（内部 logstore 开始收到数据）
- 配了 `--sls-*` + `destinationOverride: false` 的用户：行为不变（仍双发）
- 未配 `--sls-*` 的用户：行为不变（仅内部）
- `config.json` 中残留的 `destinationOverride` 字段不会报错，仅被忽略

### 新增依赖
- `esbuild` — devDependency，用于编译产物生成

### Affected Baseline Modules
- `core.md` — ConfigLoader 的 SLS 目的地解析逻辑变更
- `flushers.md` — SlsFlusher 多目的地派发行为不变，但上游输入的 endpoints 组成逻辑变化
