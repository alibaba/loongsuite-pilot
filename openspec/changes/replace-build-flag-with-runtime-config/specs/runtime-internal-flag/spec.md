## ADDED Requirements

### Requirement: Runtime internal flag in config.json

系统 SHALL 支持在 `config.json` 顶层配置 `internal: boolean` 字段，用于运行时决定是否启用内部（集团内）行为。

当未显式配置时，默认值 SHALL 为 `true`。

环境变量 `LOONGSUITE_PILOT_INTERNAL` SHALL 覆盖 config.json 中的值。值为 `"false"` 或 `"0"` 时视为 `false`，其他非空值视为 `true`，未设置时回退到 config.json。

#### Scenario: Config file sets internal to true

- **WHEN** config.json 包含 `"internal": true`
- **THEN** 系统行为等同于原 `__INTERNAL_BUILD__ = true`（内部 SLS 启用、内部更新路径、agent 门控放行）

#### Scenario: Config file sets internal to false

- **WHEN** config.json 包含 `"internal": false`
- **THEN** 系统不向内部 SLS 发送日志，使用外部更新路径，agent 门控按 config.agents 配置执行

#### Scenario: Config file omits internal field

- **WHEN** config.json 未包含 `internal` 字段
- **THEN** 系统默认 `internal = true`

#### Scenario: Environment variable overrides config file

- **WHEN** 环境变量 `LOONGSUITE_PILOT_INTERNAL=false` 已设置，且 config.json 包含 `"internal": true`
- **THEN** 系统视 `internal` 为 `false`

### Requirement: Internal SLS endpoint controlled by runtime flag

当 `internal = true` 时，系统 SHALL 将内部 SLS endpoint 包含在 SLS endpoints 列表中。具体行为：

- 若用户未配置自有 SLS 目的地：仅发送到内部 SLS
- 若用户已配置自有 SLS 目的地：同时发送到用户目的地和内部 SLS（双发）

当 `internal = false` 时，系统 SHALL NOT 将内部 SLS endpoint 加入 endpoints 列表。

#### Scenario: Internal true without user SLS config

- **WHEN** `internal = true` 且用户未配置 SLS project/logstore
- **THEN** endpoints 列表仅包含内部 SLS endpoint，SLS 默认 enabled

#### Scenario: Internal true with user SLS config

- **WHEN** `internal = true` 且用户配置了有效的 SLS project + logstore
- **THEN** endpoints 列表包含用户 endpoint 和内部 SLS endpoint（双发）

#### Scenario: Internal false without user SLS config

- **WHEN** `internal = false` 且用户未配置 SLS project/logstore
- **THEN** endpoints 列表为空，SLS 根据 endpoints 有效性判断 enabled

#### Scenario: Internal false with user SLS config

- **WHEN** `internal = false` 且用户配置了有效的 SLS project + logstore
- **THEN** endpoints 列表仅包含用户 endpoint

### Requirement: Update URL controlled by runtime flag

系统 SHALL 根据 `internal` 值选择自动更新包的 OSS 路径：

- `internal = true`：使用内部路径前缀 (`loongsuite/loongsuite-pilot/` 或 `loongsuite-dev/loongsuite-pilot/`)
- `internal = false`：使用外部路径前缀 (`loongsuite-pilot/` 或 `loongsuite-pilot-dev/`)

#### Scenario: Internal true uses internal OSS path

- **WHEN** `internal = true` 且 channel 为 release
- **THEN** 更新包 URL 使用 `loongsuite/loongsuite-pilot/latest/loongsuite-pilot.tar.gz`

#### Scenario: Internal false uses external OSS path

- **WHEN** `internal = false` 且 channel 为 release
- **THEN** 更新包 URL 使用 `loongsuite-pilot/latest/loongsuite-pilot.tar.gz`

### Requirement: Agent gating controlled by runtime flag

当 `internal = true` 时，系统 SHALL 允许所有 agent 运行（绕过 config.agents 门控）。

当 `internal = false` 时，系统 SHALL 按 config.agents 配置执行门控检查。

#### Scenario: Internal true bypasses agent gating

- **WHEN** `internal = true` 且 config.agents 中某 agent 配置为 `enabled: false`
- **THEN** 该 agent 仍被允许运行

#### Scenario: Internal false respects agent gating

- **WHEN** `internal = false` 且 config.agents 中某 agent 配置为 `enabled: false`
- **THEN** 该 agent 不被允许运行

### Requirement: No compile-time build flag

系统 SHALL NOT 依赖任何编译期常量（如 `__INTERNAL_BUILD__`）来区分内部/外部行为。所有此类行为 SHALL 由运行时配置决定。

构建系统 SHALL 只产出一套产物，不区分 internal/external variant。

#### Scenario: Single build output

- **WHEN** 执行 `npm run build`
- **THEN** 产出单一构建产物，内部 SLS 常量始终包含在代码中

#### Scenario: No build variant flags

- **WHEN** 查看 `build.mjs`
- **THEN** 不存在 `--internal` 或 `--external` 参数处理逻辑，不存在 `define: { __INTERNAL_BUILD__: ... }`
