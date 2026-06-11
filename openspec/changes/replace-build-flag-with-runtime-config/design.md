## Context

当前系统通过 esbuild 的 `define` 功能在编译时注入 `__INTERNAL_BUILD__` 布尔常量，在 4 处源代码中控制行为分支：

1. `sls-destination.ts` — 内部 SLS 常量是否有值
2. `config-loader.ts` (buildSlsConfig) — 是否包含内部 SLS endpoint、enabled 默认值
3. `config-loader.ts` (resolveDefaultPackageUrl) — 使用内部/外部 OSS 路径
4. `orchestrator.ts` (isAgentGatedEnabled) — 内部版本跳过 agent 门控

外部版本通过 dead-code elimination 完全移除内部 SLS 常量。两条独立的打包和上传流水线维护两套产物。

现在需要统一为单一产物，运行时通过 `config.json` 的 `internal` 字段决定行为。

## Goals / Non-Goals

**Goals:**

- 消除两套编译产物，只保留一次构建
- 通过 `config.json` 的 `internal` 字段在运行时控制内部 SLS 日志发送
- 运行时控制更新包 URL 路径（内部/外部 OSS）
- 运行时控制 agent 门控策略
- 保持向后兼容：未配置 `internal` 时默认行为等同于当前内部版本

**Non-Goals:**

- 不涉及修改 SLS flusher 的发送逻辑
- 不涉及修改数据 schema 或 normalization 逻辑
- 不移除 deploy 脚本中区分内部/外部安装环境的能力（installer 仍可根据目标环境设置 `internal` 值）
- 不修改 CI/CD 流水线配置（仅修改被流水线调用的脚本）

## Decisions

### 1. 配置字段位置：顶层 `internal` 字段

将 `internal: boolean` 放在 `config.json` 顶层，与 `enabled`、`dataDir` 等平级。

**理由**：该标志影响多个子系统（SLS、updater、agent gating），不属于任何单一子模块配置。顶层放置语义最清晰。

**替代方案**：嵌套在 `sls.internal` — 但它还影响 updater URL 和 agent 门控，嵌套不合适。

### 2. 默认值：`true`

当 `config.json` 中未设置 `internal` 字段时默认为 `true`。

**理由**：当前所有开发和 CI 环境均使用 `build:internal`，默认 `true` 确保零配置迁移无感知。外部用户由 installer 显式写入 `"internal": false`。

### 3. 支持环境变量覆盖

新增 `LOONGSUITE_PILOT_INTERNAL` 环境变量，优先级高于 config.json。值为 `"false"` 或 `"0"` 时视为 `false`，其他非空值视为 `true`。

**理由**：符合现有三层配置优先级模型（env > file > default），便于 CI 或临时测试覆盖。

### 4. `sls-destination.ts` 无条件导出真实常量

移除条件表达式，始终导出内部 SLS 的 endpoint/project/logstore 值。运行时由 `buildSlsConfig()` 根据 `config.internal` 决定是否将其加入 endpoints 列表。

**理由**：简单直接，常量本身不产生副作用，只有被消费时才有影响。

### 5. 构建统一

- `build.mjs` 移除 `--internal`/`--external` argv 解析和 `define: { __INTERNAL_BUILD__: ... }`
- `package.json` 只保留 `"build": "node build.mjs"`
- `vitest.config.ts` 移除 `__INTERNAL_BUILD__` globals 定义
- 删除 `src/internal/build-flags.d.ts`

### 6. 部署脚本简化

- `deploy/package.sh` 移除 `--external` 分支，始终执行 `npm run build`
- `deploy/upload.sh` 移除 variant 路径选择逻辑，统一使用 internal 路径（因为只有一套产物）
- `deploy/package-external.sh` / `deploy/upload-external.sh` 标记为 deprecated 或删除
- installer 脚本保留内部/外部区分，但区别仅在于写入 config.json 时设置 `"internal": true/false`

## Risks / Trade-offs

**[内部 SLS 常量暴露在外部用户产物中]** → 这些仅为 webtracking 模式的公开 endpoint URL、project、logstore 名称，无安全敏感信息（无 AK/SK）。且 `internal: false` 时不会实际发送请求。可接受。

**[向后兼容]** → 默认 `true` + env var 覆盖确保现有部署无缝切换。installer 脚本是唯一需要更新的外部接触面。

**[测试覆盖]** → 现有使用 `globalThis.__INTERNAL_BUILD__ = false` 的测试需改为 mock config 或传入 `internal: false` 的配置对象。需更新测试但逻辑等价。

## Baseline Documentation Sync

实现完成后同步更新：
- `docs/modules/core.md` "SLS 目的地解析" 小节
- `docs/modules/updater.md` 如提及编译期区分逻辑
