# Proposal: Remove Internal Flag and Hardcoded SLS Destination

## Summary

移除运行时 `internal` flag 和硬编码的内部 SLS 回传地址，将所有环境差异下沉到安装脚本的配置注入层。

改造后，代码中不再区分"内部版"与"外部版"。三个安装脚本（`installer-opensource.sh` / `installer.sh` / `installer-inner.sh`）通过写入不同的 `config.json` 来控制 SLS 目的地、autoUpdate URL 等运行时行为。

## Motivation

- 当前 `internal` flag 耦合了多个正交关注点（SLS 路由、autoUpdate URL、agent gate、serviceNamePrefix），增加了理解和维护成本
- 硬编码的内部 SLS endpoint 使得代码与特定基础设施绑定，不利于开源和多环境部署
- 安装脚本已经是事实上的环境差异注入点，运行时不应重复这一职责

## Scope

### In Scope

1. **删除内置 SLS 回传地址** — 移除 `src/internal/sls-destination.ts`，清理 config-loader 中所有引用
2. **废弃 internal flag** — 从 ConfigFile、AnalyticsConfig、环境变量中移除 `internal`
3. **移除 Auto-Updater 硬编码 OSS 地址** — 删除 `BASE_PACKAGE_URL` 等常量和 `resolveDefaultPackageUrl()` 函数
4. **修改 installer-inner.sh** — 显式注入内部 SLS endpoint 到 config.json

### Out of Scope

- `__INTERNAL_BUILD__` 编译时替换（后续独立变更）
- `installer-opensource.sh` 创建（后续独立变更）
- 安装脚本中 agent 白名单配置逻辑

## Affected Baseline Modules

- `docs/modules/core.md` — ConfigLoader 的 "SLS 目的地解析" 小节引用了 `config.internal`，需更新

## Baseline Modification

- `docs/modules/core.md` 的 "SLS 目的地解析" 小节需更新：移除 `internal` 相关描述，改为"config 配几个 endpoint 就写几个，没配则禁用"
