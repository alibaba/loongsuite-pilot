## Why

QoderWork CN 是独立于 QoderWork 的国内版桌面应用（API endpoint: `gateway.qoder.com.cn`，App bundle: `QoderWork CN.app`）。当前 Pilot 只采集 QoderWork（国际版）的数据，无法观测 CN 版用户的 agent 活动。两者共享相同的底层 SDK 和数据库 schema，但使用不同的数据目录路径。

## What Changes

- 新增 `ClientType.QoderWorkCN = 'qoder-work-cn'` 枚举值。
- 新增 `agents.d/qoder-work-cn.json` agent 描述文件，声明 hook 注入路径、检测路径和 input 配置。
- 参数化现有三个 QoderWork input class，使其同时支持 QoderWork 和 QoderWork CN 两个实例：
  - `QoderWorkInput`（Hook JSONL）— 通过 constructor options 接收不同的 logDir、logPrefix。
  - `QoderWorkLogInput`（SDK log tail）— 通过 constructor options 接收不同的 dataRoot。
  - `QoderWorkSqliteInput`（SQLite polling）— 通过 constructor options 接收不同的 dataRoot/dbPath。
- 新增 `assets/hooks/qoderworkcn-loongsuite-pilot-hook.sh` hook 入口脚本（复用 hook-processor.mjs）。
- Hook 注入目标：`~/.qoderworkcn/settings.json`，事件 `Stop`，nested format。
- 在 `config-loader` / `orchestrator` 中注册 CN 版 input 实例。
- 更新 `agent-system-map` 添加 CN 版映射。

## Capabilities

### New Capabilities
- `qoder-work-cn-data-collection`: 通过三种方式（Hook JSONL、SDK log、SQLite）采集 QoderWork CN agent 活动数据。

### Modified Capabilities
- 无（参数化不改变现有功能行为）

## Impact

- 新增一个 ClientType 枚举值和 agent 描述文件
- 参数化现有 QoderWorkInput / QoderWorkLogInput / QoderWorkSqliteInput constructors（向后兼容，默认值保持不变）
- 新增一个 hook shell 脚本
- orchestrator / config-loader 需要为 CN 版实例化三个 input
- 不引入新的运行时依赖

## Affected Baseline Modules

- `docs/modules/inputs.md` — 代码布局需要更新（新增 qoder-work-cn 相关说明或注明参数化支持两个变体）
- `docs/modules/hooks.md` — 运行时安装布局需增加 `qoder-work-cn/history/` 路径

## Baseline Documentation Updates

实现完成后需更新：
- `docs/modules/inputs.md`：在代码布局中说明 QoderWork inputs 现在参数化支持 QoderWork + QoderWork CN 两个实例
- `docs/modules/hooks.md`：在运行时布局中增加 `qoder-work-cn/history/` 目录
- `src/types/client-type.ts` 枚举变更自动反映到 `docs/modules/types.md`

## Data Paths (Reference)

| 项目 | QoderWork | QoderWork CN |
|------|-----------|--------------|
| Home config | `~/.qoderwork` | `~/.qoderworkcn` |
| App Support (Mac) | `~/Library/Application Support/QoderWork` | `~/Library/Application Support/QoderWork CN` |
| App Support (Linux) | `~/.config/QoderWork` | `~/.config/QoderWork CN` |
| Settings (hook) | `~/.qoderwork/settings.json` | `~/.qoderworkcn/settings.json` |
| SDK logs | `.../logs/<session>/main.log` | `.../logs/<ts>/main.log` |
| SQLite DB | `.../data/agents.db` | `.../data/agents.db` |
| Hook history | `~/.loongsuite-pilot/logs/qoder-work/history/` | `~/.loongsuite-pilot/logs/qoder-work-cn/history/` |
