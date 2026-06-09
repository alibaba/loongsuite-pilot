## 1. 类型定义

- [x] 1.1 在 `src/types/client-type.ts` 添加 `QoderCn = 'qoder-cn'`（IDE tools 分组）和 `QoderCnHook = 'qoder-cn-hook'`（Hook-based tools 分组）

## 2. QoderCN SQLite Input

- [x] 2.1 创建 `src/inputs/qoder-cn-sqlite/qoder-cn-sqlite-input.ts`：克隆 `qoder-sqlite-input.ts`，替换路径常量（`Qoder` → `QoderCN`）、id、agentType、SOURCE
- [x] 2.2 导出已在 `src/index.ts` 中添加（无需独立 index.ts，与 qoder-sqlite 保持一致）

## 3. QoderCN IDE Input

- [x] 3.1 创建 `src/inputs/qoder-cn/qoder-cn-input.ts`：克隆 `qoder-input.ts`，替换路径常量、id、agentType、stateStore key 前缀、日志路径
- [x] 3.2 导出已在 `src/index.ts` 中添加（无需独立 index.ts，与 qoder 保持一致）

## 4. Hook Script + Agent 定义

- [x] 4.1 创建 `assets/hooks/qodercn-loongsuite-pilot-hook.sh`：复制 qoder 版本，修改默认 AGENT_ID 为 `"qoder-cn"`
- [x] 4.2 创建 `agents.d/qoder-cn.json`：detection paths `["~/.qoder-cn"]`、settingsPath `"~/.qoder-cn/settings.json"`、hookCommand 指向新脚本

## 5. hook-processor 路由

- [x] 5.1 在 `assets/hooks/hook-processor.mjs` 的 `normalizeTranscriptRecord()` 中添加 `'qoder-cn'` 分支，复用 `buildQoderHookRecord()`

## 6. Orchestrator 注册

- [x] 6.1 在 `src/core/orchestrator.ts` 的 `registerAllInputs()` 中注册 `QoderCnSqliteInput` 和 `QoderCnInput`（含 checkAvailability + watchPaths + LISTENER_AGENT_MAP）

## 7. 验证

- [x] 7.1 TypeScript 编译通过（`npx tsc --noEmit` 零错误）
- [ ] 7.2 验证 QoderCN SQLite 数据库可正确读取（手动触发 poll）
- [ ] 7.3 验证 hook 部署后 `~/.qoder-cn/settings.json` 正确写入
