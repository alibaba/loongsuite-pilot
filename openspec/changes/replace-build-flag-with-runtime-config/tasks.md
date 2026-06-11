## 1. 移除编译期常量

- [x] 1.1 删除 `src/internal/build-flags.d.ts`
- [x] 1.2 从 `build.mjs` 中移除 `--internal` argv 解析和 `define: { __INTERNAL_BUILD__: ... }` 配置
- [x] 1.3 从 `vitest.config.ts` 中移除 `globals: { __INTERNAL_BUILD__: 'true' }` 定义
- [x] 1.4 从 `tsconfig.json` 或相关 TS 配置中移除对 `build-flags.d.ts` 的引用（如有）

## 2. 统一构建脚本

- [x] 2.1 `package.json` 中移除 `build:internal` 和 `build:external` scripts，只保留 `build`（执行 `node build.mjs`）
- [x] 2.2 确认 `build.mjs` 在无任何 flag 时正常编译三个 entry point

## 3. 添加运行时 `internal` 配置

- [x] 3.1 在 `config-loader.ts` 的 `ConfigFile` interface 中添加 `internal?: boolean` 字段
- [x] 3.2 在 `loadConfig()` 中解析 `internal` 字段：读取环境变量 `LOONGSUITE_PILOT_INTERNAL` > config.json > 默认 `true`
- [x] 3.3 将解析后的 `internal` 布尔值传递到需要消费它的函数中（通过 AnalyticsConfig 或独立参数）

## 4. 更新 SLS 目的地逻辑

- [x] 4.1 修改 `src/internal/sls-destination.ts`：移除条件表达式，始终导出真实的内部 SLS 常量
- [x] 4.2 修改 `buildSlsConfig()` 中的 endpoints 构建逻辑：将 `__INTERNAL_BUILD__` 判断替换为 `config.internal`
- [x] 4.3 修改 `buildSlsConfig()` 中的 `enabled` 默认值逻辑：将 `__INTERNAL_BUILD__` 判断替换为 `config.internal`
- [x] 4.4 修改 `buildUserSlsEndpoint()` 中的 fallback endpoint 逻辑：将 `__INTERNAL_BUILD__` 替换为 `config.internal`

## 5. 更新 Auto-Update URL 逻辑

- [x] 5.1 修改 `resolveDefaultPackageUrl()` 中的 URL 选择：将 `__INTERNAL_BUILD__` 替换为 `config.internal` 参数
- [x] 5.2 确保 `buildAutoUpdateConfig()` 能获取到 `internal` 配置值并传入 URL 解析

## 6. 更新 Agent 门控逻辑

- [x] 6.1 修改 `orchestrator.ts` 中 `isAgentGatedEnabled()`：将 `__INTERNAL_BUILD__` 替换为从 config 读取 `internal`

## 7. 更新测试

- [x] 7.1 更新所有引用 `__INTERNAL_BUILD__` 的单元测试，改为通过 config 注入 `internal` 值
- [x] 7.2 确保 SLS 解析测试覆盖 `internal: true` 和 `internal: false` 两种场景
- [x] 7.3 运行完整测试套件确认通过

## 8. 部署脚本简化

- [x] 8.1 `deploy/package.sh`：移除 `--external` 分支，统一调用 `npm run build`
- [x] 8.2 `deploy/upload.sh`：更新注释说明 --external 是 deploy target 而非 build variant
- [x] 8.3 标记 deprecated：`deploy/package-external.sh`
- [x] 8.4 更新 installer 脚本（`deploy/installer-inner.sh`, `deploy/installer.sh`）在写入 config.json 时设置 `"internal"` 字段

## 9. 基准文档更新

- [x] 9.1 更新 `docs/modules/core.md` "SLS 目的地解析" 小节：描述从编译期常量改为运行时 `config.internal`
- [x] 9.2 检查并更新 `docs/modules/updater.md` 中与编译期区分相关的描述（无需修改）
