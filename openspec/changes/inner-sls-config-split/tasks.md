## 1. ConfigLoader 合并逻辑

- [x] 1.1 在 `config-loader.ts` 的 `buildSlsConfig()` 函数中新增 `dataDir` 参数，读取 `{dataDir}/configs/inner/data_config.json` 文件并解析其 `sls` 数组
- [x] 1.2 将 `data_config.json` 中的 SLS endpoints 与 `config.json` 的 SLS endpoints 合并（config.json 在前），调用已有的 `dedupSlsEndpoints()` 去重
- [x] 1.3 调整 `loadConfig()` 中 `buildFlushersConfig()` 或 `buildSlsConfig()` 的调用，传入 `dataDir` 参数
- [x] 1.4 添加 ConfigLoader 合并逻辑的单元测试：覆盖双文件合并、去重、data_config.json 不存在、data_config.json 格式错误等场景

## 2. 安装脚本调整

- [x] 2.1 修改 `deploy/installer-inner.sh` 的 `write_config()` 函数：将内置 SLS endpoint 写入 `{DATA_DIR}/configs/inner/data_config.json`
- [x] 2.2 调整 `write_config()` 中的 config.json 写入逻辑：用户指定了 SLS 时只写用户 SLS 到 config.json；未指定时不写入 `sls` 字段
- [x] 2.3 更新 `tests/unit/deploy/installer-sls-config.test.ts` 安装脚本相关测试

## 3. 迁移脚本调整

- [x] 3.1 修改 `scripts/migrate-internal-config.js`：新增从 config.json 识别并提取内置 SLS endpoint 的逻辑
- [x] 3.2 实现原子写入 `configs/inner/data_config.json`（先写临时文件再 rename），并确保写入成功后才从 config.json 中删除内置 endpoint
- [x] 3.3 处理各种迁移场景：sls 为数组（含内置）、sls 为单对象（是内置）、sls 数组删除后为空、data_config.json 已存在
- [x] 3.4 保持迁移幂等性：重复执行结果一致
- [x] 3.5 添加迁移脚本的单元测试：覆盖上述所有迁移场景

## 4. Postinstall 调整

- [x] 4.1 确认 `scripts/postinstall.js` 中迁移逻辑的触发不受影响（当前通过动态 import `migrate-internal-config.js` 执行）
- [x] 4.2 如有需要，在 postinstall 中确保 `configs/inner/` 目录存在

## 5. 验证与回归

- [x] 5.1 运行全量单元测试，确保现有 SLS 相关测试（包括 `sls-flusher.test.ts`、`sls-flusher.dual-write.test.ts`）不受影响
- [x] 5.2 TypeScript 类型检查通过（`npm run typecheck`）
