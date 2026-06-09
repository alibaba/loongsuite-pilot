## Context

当前集团版（inner）安装流程中，内置 SLS endpoint（`ai-coding-devops`）和用户自定义 SLS endpoint 都写入同一个 `~/.loongsuite-pilot/config.json` 的 `sls` 字段。这导致：

1. 用户手动编辑 config.json 时可能误删内置 endpoint
2. 迁移脚本（`migrate-internal-config.js`）需要在同一字段内区分内置 vs 用户 endpoint
3. 内置配置与用户配置耦合，无法独立管理

**现状关键文件：**
- `src/core/config-loader.ts`：三层优先级配置加载，`buildSlsConfig()` 从 `config.json` 的 `sls` 字段解析出 `SlsEndpoint[]`
- `deploy/installer-inner.sh`：`write_config()` 将内置 SLS 和用户 SLS 一起写入 config.json
- `scripts/migrate-internal-config.js`：升级时确保内置 SLS 存在于 config.json
- `scripts/postinstall.js`：触发迁移脚本

## Goals / Non-Goals

**Goals:**
- 内置 SLS endpoint 存储在独立文件 `~/.loongsuite-pilot/configs/inner/data_config.json`
- ConfigLoader 合并两个文件的 SLS endpoints，去重后得到完整列表
- 安装脚本正确写入各自的目标文件
- 现有用户升级时自动迁移，无需手动操作
- 商业版（external）完全不受影响

**Non-Goals:**
- 不涉及 `configs/local/` 目录（未来需求，不在本次范围）
- 不改变 SlsFlusher 的消费逻辑
- 不改变环境变量覆盖机制
- 不改变 JSONL/HTTP 等其他 flusher 配置

## Decisions

### Decision 1: data_config.json 文件结构

采用最小结构，只包含 `sls` 数组：

```json
{
  "sls": [
    {
      "name": "internal-sls",
      "endpoint": "https://cn-heyuan.log.aliyuncs.com",
      "project": "ai-coding-devops",
      "logstore": "loongsuite_pilot_for_ai_coding",
      "mode": "webtracking"
    }
  ]
}
```

**Rationale:** 该文件当前仅用于内置 SLS endpoint，保持最简结构。未来如需扩展（如加入其他内置配置），可在此基础上增加字段。`sls` 字段统一使用数组格式（`SlsEndpointEntry[]`），避免单对象/数组的二义性。

**Alternative considered:** 使用与 config.json 相同的完整 ConfigFile 结构 → 冗余字段过多，增加维护负担。

### Decision 2: ConfigLoader 合并策略

在 `buildSlsConfig()` 中，加载 `configs/inner/data_config.json` 的 SLS endpoints，与 `config.json` 的 SLS endpoints 合并：

1. 先解析 `config.json` 的 `sls`（已有逻辑不变）
2. 读取 `~/.loongsuite-pilot/configs/inner/data_config.json`，解析其 `sls` 数组为 `SlsEndpoint[]`
3. 将两者 concat 后调用已有的 `dedupSlsEndpoints()` 去重（按 `endpoint|project|logstore` 组合键）
4. `config.json` 的 endpoints 排在前面，确保用户配置优先（去重时保留先出现的）

**Rationale:** 复用已有的 `dedupSlsEndpoints()` 和 `parseSlsEndpointEntry()`，改动最小。用户 endpoints 排在前面确保去重时用户配置优先。

**Alternative considered:** 在 `loadConfig()` 层面合并完整 config 对象 → 过度设计，当前只需合并 SLS。

### Decision 3: data_config.json 文件路径确定

路径为 `{dataDir}/configs/inner/data_config.json`，其中 `dataDir` 从 env var 或 config.json 的 `dataDir` 字段获取，默认 `~/.loongsuite-pilot`。

在 `buildSlsConfig()` 中需要传入 `dataDir` 参数（当前没有），调整函数签名。

### Decision 4: installer-inner.sh 写入拆分

`write_config()` 函数拆分为两步写入：
1. 内置 SLS → `configs/inner/data_config.json`（新增）
2. 用户自定义 SLS → `config.json`（保留）
3. 如果用户未指定自定义 SLS，`config.json` 中不写入 `sls` 字段

需要在 `write_config()` 中先 `mkdir -p "$DATA_DIR/configs/inner"`。

### Decision 5: 迁移策略

`migrate-internal-config.js` 新增迁移逻辑：

1. 读取 `config.json`
2. 识别 `sls` 中的内置 endpoint（`name === 'internal-sls'` 或 `project === 'ai-coding-devops'`）
3. 将内置 endpoint 写入 `configs/inner/data_config.json`
4. 从 `config.json` 的 `sls` 中删除内置 endpoint
5. 如果 `sls` 数组删除后为空，移除整个 `sls` 字段
6. 如果 `sls` 数组只剩一个 endpoint，保持数组格式（不转回单对象，避免复杂度）
7. 如果 `sls` 是单对象且是内置 endpoint，移除整个 `sls` 字段
8. 已有的 `autoUpdate.packageUrl` 和 `internal` 字段迁移逻辑保持不变

迁移必须是幂等的——重复执行不会产生副作用。

### Decision 6: 确保 data_config.json 在每次升级时刷新

除了迁移旧数据，`migrate-internal-config.js` 还需确保 `configs/inner/data_config.json` 始终包含最新的内置 SLS endpoint（endpoint URL、logstore 名称可能在未来版本中变更）。如果文件已存在，用最新的硬编码值覆盖。

## Risks / Trade-offs

**[Risk] 迁移脚本失败导致数据丢失** → Mitigation: 迁移采用原子写入（写临时文件再 rename），且只在确认写入 data_config.json 成功后才从 config.json 中删除内置 endpoint。

**[Risk] 部分升级场景下 data_config.json 未创建** → Mitigation: ConfigLoader 对 data_config.json 的读取采用容错处理——文件不存在或解析失败时静默跳过，不影响 config.json 中的配置。

**[Risk] 用户手动在 config.json 中添加了与内置相同的 SLS endpoint** → Mitigation: `dedupSlsEndpoints()` 按 `endpoint|project|logstore` 去重，重复的会被合并，不会双写。

**[Trade-off] ConfigLoader 需要额外一次文件 I/O** → 可接受：只在启动时加载一次，且是 async readFile，对性能影响可忽略。

## Migration Plan

1. **新版本安装（全新用户）**：installer-inner.sh 直接写入拆分后的两个文件
2. **老版本升级**：postinstall.js 触发 migrate-internal-config.js → 自动迁移
3. **回滚**：如果用户降级到旧版本，旧版 ConfigLoader 不知道 data_config.json 的存在，但旧版 migrate-internal-config.js 会在 postinstall 时将内置 SLS 写回 config.json，所以降级是安全的

## Open Questions

（无——所有关键决策已与用户确认）
