## 1. 配置与类型

- [x] 1.1 实现缺省行为：缺失 `mask` 或缺失 `mask.mode` 时按 `none` 处理，不执行脱敏。
- [x] 1.2 在 `src/types/index.ts` 新增 `MaskMode`、`MaskType`、`MaskConfig`，并把 `mask: MaskConfig` 加到 `AnalyticsConfig`。
- [x] 1.3 在 `src/core/config-loader.ts` 的 `ConfigFile` 中增加顶层 `mask?: { mode?: string; types?: string[] }`。
- [x] 1.4 实现 `buildMaskConfig()`：支持 `all`、`custom`、`none`，过滤本次变更合法 type，并处理默认值和非法值。
- [x] 1.5 增加 config-loader 测试：缺省配置、`all`、`none`、`custom`、空 `types`、非法 mode/type。

## 2. Mask 模块

- [x] 2.1 新建 `src/mask/` 目录。
- [x] 2.2 新增 `src/mask/sensitive-rules.json`，写入 `cloudAccessKey`、`apiKey`、`privateKey`、`databaseUrl` 本次变更规则；`cloudAccessKey` 覆盖 `LTAI`、`AKIA` / `ASIA` / `ABIA` / `ACCA`、`AKID`，`apiKey` 至少包含 `sk-`、GitHub token，`databaseUrl` 覆盖普通带密码 URL 和 JDBC 带密码 URL。
- [x] 2.3 实现 rule loader：加载规则、校验规则结构，支持 `regex`、`block`、`urlWithPassword`，按 `mask.mode/types` 过滤规则并预编译正则。
- [x] 2.4 实现 field whitelist：只扫描 message、tool arguments、tool result、system/tool definitions、agent text、error text 等内容字段，并保持普通元数据字段不变。
- [x] 2.5 实现 string masker：关键词预筛命中后执行规则，替换为 `[ACCESSKEY_MASKED]` / `[APIKEY_MASKED]` / `[PRIVATEKEY_MASKED]` / `[DATABASEURL_MASKED]`。
- [x] 2.6 实现 entry masker：递归遍历 JSON-safe 对象/数组中的字符串；用 `Buffer.byteLength(value, 'utf8')` 判断大小，`<=64 KiB` 的字符串整段扫描，`>64 KiB` 的字符串先定位 `prefilter` 关键词，再扫描关键词前后各 `8 KiB` 的合并窗口；返回新 entry，不修改原 entry。
- [x] 2.7 实现幂等逻辑：已有 `[APIKEY_MASKED]` 等打码文本不再重复打码。
- [x] 2.8 实现大字段窗口命中回写：规则返回原字符串 `[start, end, replacement]` 区间，合并/去重重叠区间后从后往前替换，避免窗口重叠或多次替换导致 offset 错位。

## 3. Collector 接入

- [x] 3.1 在 `src/core/orchestrator.ts` 中把 `config.mask` 传入 `InputManager` 或等价 collector entry 处理链路。
- [x] 3.2 在 `src/core/input-manager.ts` 中按 `applyAgentContentPolicy()` 之后、`dispatchEntries()` 之前的顺序调用 mask。
- [x] 3.3 确认 hook 本地 history 行为不变。
- [x] 3.4 确认现有 SLS endpoint `redact` 行为不变，并与 collector mask 并存。
- [x] 3.5 验证实现符合 baseline 约束：`InputManager` 只做统一调用，规则和扫描细节放在 `src/mask/`。

## 4. 单元测试

- [x] 4.1 更新 `tests/unit/core/config-loader.test.ts`：覆盖缺省配置、`all`、`none`、`custom`、空 `types`、非法 mode/type。
- [x] 4.2 新建 `tests/unit/mask/rule-loader.test.ts`：覆盖合法规则加载、`mask.mode/types` 过滤、非法 regex 定义拒绝。
- [x] 4.3 新建 `tests/unit/mask/string-masker.test.ts`：覆盖 `cloudAccessKey`（`LTAI` / `AKIA` / `ASIA` / `ABIA` / `ACCA` / `AKID`）替换为 `[ACCESSKEY_MASKED]`。
- [x] 4.4 新建 `tests/unit/mask/string-masker.test.ts`：覆盖 `apiKey`（`sk-` / GitHub token）替换为 `[APIKEY_MASKED]`。
- [x] 4.5 新建 `tests/unit/mask/string-masker.test.ts`：覆盖 PEM / OpenSSH 私钥块替换为 `[PRIVATEKEY_MASKED]`。
- [x] 4.6 新建 `tests/unit/mask/string-masker.test.ts`：覆盖普通带密码数据库连接串、JDBC `password` / `pwd` 连接串替换为 `[DATABASEURL_MASKED]`，不带密码地址不替换。
- [x] 4.7 新建 `tests/unit/mask/string-masker.test.ts`：覆盖已打码文本幂等、UTF-8 byte length 大字段判断、大字段中间 secret 窗口命中。
- [x] 4.8 新建 `tests/unit/mask/entry-masker.test.ts`：覆盖字段白名单、对象/数组递归、非内容元数据不变、`mask.mode=custom` 只脱敏选中类型。
- [x] 4.9 新建 `tests/unit/mask/string-masker.performance.test.ts`：覆盖 `64 / 128 / 256 KiB` 阈值和 `4 / 8 / 16 KiB` 窗口组合下，大字段中间 secret 仍能命中。
- [x] 4.10 更新 `tests/unit/core/input-manager.test.ts`：覆盖 collector 分发给 flusher 前 entry 已经脱敏、`captureMessageContent=false` 先删除内容字段。
- [x] 4.11 新建 `tests/unit/core/input-manager-mask-trace.test.ts`：覆盖 OTLP trace 路径中 `convertEventLogToTrace(records)` 收到已脱敏 records。

## 5. 集成验证

- [x] 5.1 验证 collector 链路顺序：`applyAgentContentPolicy()` 之后、`dispatchEntries()` 之前执行 mask。
  Verified: `tests/unit/core/input-manager.test.ts` passed（19 tests）。
- [x] 5.2 验证 JSONL / SLS / HTTP log 输出一致性：MultiFlusher 下三个 child flusher 收到同一份已脱敏 entry。
  Verified: `tests/unit/core/input-manager.test.ts` passed（MultiFlusher case）。
- [x] 5.3 验证 OTLP trace 输出一致性：`OtlpTraceFlusher` 转 span 前收到的 records 已脱敏。
  Verified: `tests/unit/core/input-manager-mask-trace.test.ts` passed（1 test）。
- [x] 5.4 验证 SLS endpoint `redact` 行为不变，并与 collector mask 并存。
  Verified: `tests/unit/normalization/redact.test.ts`、`tests/unit/normalization/serialise.test.ts`、`tests/unit/flushers/sls-flusher.test.ts` passed（33 tests）。
- [x] 5.5 验证 Orchestrator 接入和旧配置兜底。
  Verified: `tests/unit/core/orchestrator.test.ts` passed（8 tests）。

## 6. 文档与验证

- [x] 6.1 更新用户侧配置文档 `README.md`，说明 `mask.mode/types`、默认行为、本次变更支持类型。
- [x] 6.2 文档中说明本次变更不对 hook 本地 history 文件脱敏。
- [x] 6.3 review 并更新 baseline docs：`docs/modules/core.md`、`docs/modules/normalization.md`、`docs/modules/types.md`、`docs/modules/flushers.md`、`docs/modules/mask.md`、`docs/baseline-guide.md`。
- [x] 6.4 运行 `openspec status --change add-collector-mask`，并确认目录只包含 `.openspec.yaml`、`proposal.md`、`design.md`、`tasks.md` 四个文件。
- [x] 6.5 `npm run typecheck` 通过。
- [x] 6.6 运行配置、mask、collector 接入、trace/log 路径的定向测试。
  Verified: 11 test files passed, 125 tests passed.
- [x] 6.7 运行完整测试套件 `npm test`。
  NOTE: Full suite was run. Remaining 7 failures are in updater / e2e helper / hook history integration paths and are unrelated to this collector mask change.
