# Design: Remove Internal Flag and Hardcoded SLS Destination

## Overview

将运行时 `internal` flag 的所有职责下沉到安装脚本配置注入层，使运行时代码完全由 config.json 驱动。

## Design Decisions

### D1: SLS 路由完全由 config.json 驱动

**Before:** `internal=true` 时代码自动注入 `INTERNAL_SLS_DESTINATION`，用户配了自有 SLS 时双发。

**After:** `buildSlsConfig()` 统一逻辑——有 user endpoint 配置就启用，没有就 `endpoints = []`。集团版由 `installer-inner.sh` 在安装时将内部 SLS endpoint 写入 config.json。

### D2: 移除 internal 字段，不引入替代字段

不引入 `edition` 或其他运行时字段。开源版与商业版的差异通过编译时 `__INTERNAL_BUILD__`（后续变更）控制，商业版与集团版的差异通过安装脚本注入的 config 控制。

### D3: autoUpdate 无配置则禁用

移除 `resolveDefaultPackageUrl()` 和所有硬编码 OSS 地址常量。`buildAutoUpdateConfig()` 在没有 `packageUrl` 时返回 `enabled: false`。`manifestUrl` 从 `packageUrl` 的自动推导逻辑保留。

### D4: serviceNamePrefix 默认空字符串

移除 `internal ? 'loongsuite-pilot' : ''` 三元判断，直接默认 `''`。安装脚本按需注入。

### D5: Agent gate 不再有特权旁路

移除 `isAgentGatedEnabled()` 中 `if (this.config.internal) return true`。集团版 installer 不填 `config.agents`，利用现有逻辑 `Object.keys(agents).length === 0 → return true` 达到全部启用的效果。

### D6: 内部 SLS 地址硬编码到 installer-inner.sh

`src/internal/sls-destination.ts` 整文件删除。内部 SLS 的 endpoint / project / logstore 值直接写在 `installer-inner.sh` 中。

## Affected Files

| File | Change |
|---|---|
| `src/internal/sls-destination.ts` | DELETE |
| `src/core/config-loader.ts` | 移除 internal 参数、硬编码常量、简化 SLS/autoUpdate 逻辑 |
| `src/core/orchestrator.ts` | 移除 `isAgentGatedEnabled` 中 internal 旁路 |
| `src/types/index.ts` | 移除 `AnalyticsConfig.internal` |
| `deploy/installer-inner.sh` | 注入内部 SLS endpoint 到 config.json |
| `docs/modules/core.md` | 更新 SLS 目的地解析描述 |
| `tests/unit/core/config-loader.sls-resolution.test.ts` | 更新测试 |
| `tests/unit/core/config-loader.test.ts` | 更新测试 |
| `tests/unit/core/orchestrator.test.ts` | 更新测试 |
