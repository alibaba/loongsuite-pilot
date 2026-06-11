## Why

集团版（inner）用户的内置 SLS endpoint（ai-coding-devops）当前与用户自定义 SLS 混放在 `~/.loongsuite-pilot/config.json` 的 `sls` 字段中。这导致内置配置和用户配置耦合——用户手动编辑 config.json 时可能误删或覆盖内置 endpoint，且升级迁移逻辑需要在同一个字段内区分"哪些是内置的、哪些是用户的"。将内置 SLS 拆分到独立文件 `~/.loongsuite-pilot/configs/inner/data_config.json`，实现内置配置与用户配置的物理隔离，降低维护和迁移复杂度。

## What Changes

- **新增内置配置文件**：集团版安装时在 `~/.loongsuite-pilot/configs/inner/data_config.json` 写入内置 SLS endpoint，不再写入 `config.json`
- **ConfigLoader 合并逻辑**：`config-loader.ts` 加载时额外读取 `configs/inner/data_config.json`，将其中的 SLS endpoints 与 `config.json` 中的用户 SLS endpoints 合并去重
- **安装脚本调整**：`installer-inner.sh` 的 `write_config()` 将内置 SLS 写入 `configs/inner/data_config.json`，用户自定义 SLS 仍写入 `config.json`
- **迁移脚本调整**：`migrate-internal-config.js` 在升级时将 `config.json` 中的内置 SLS endpoint 移动到 `configs/inner/data_config.json`，并从 `config.json` 中删除
- **postinstall 调整**：确保升级时迁移逻辑和目录创建正确触发

## Capabilities

### New Capabilities

- `inner-data-config`: 集团版内置 SLS 配置的独立文件管理——包括文件结构定义、ConfigLoader 合并逻辑、安装脚本写入、升级迁移

### Modified Capabilities

（无已有 spec 需要修改）

## Impact

- **配置加载**：`src/core/config-loader.ts` — 新增读取 `configs/inner/data_config.json` 并合并 SLS endpoints 的逻辑
- **安装脚本**：`deploy/installer-inner.sh` — `write_config()` 函数拆分内置 SLS 写入目标
- **迁移脚本**：`scripts/migrate-internal-config.js` — 新增从 config.json 迁移内置 SLS 到 data_config.json 的逻辑
- **postinstall**：`scripts/postinstall.js` — 可能需要确保 `configs/inner/` 目录存在
- **商业版（external）**：完全不受影响
- **SlsFlusher**：不需要改动，它只消费 normalized 后的 endpoints 数组

## Affected Baseline Modules

- `docs/modules/core.md` — ConfigLoader 的配置加载和 SLS 目的地解析逻辑将扩展为多文件合并
- `docs/modules/flushers.md` — 不需要改动，但需确认 SlsFlusher 对合并后 endpoints 的消费无影响
