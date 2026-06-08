# Module: mask

> Last verified: 2026-06-04

## 职责 (Responsibility)

collector 侧字段内 secret 打码模块。它在 InputManager 分发给 flusher 前运行，对高置信敏感内容做不可逆替换，使 JSONL / SLS / HTTP log 和 OTLP trace 使用同一份已脱敏 `AgentActivityEntry`。

## 公共接口 (Public Interface)

- **sensitive-rules.json** — 规则文件，集中配置 `cloudAccessKey`、`apiKey`、`privateKey`、`databaseUrl` 的规则。
- **loadEnabledRules** — 加载、校验并按 `mask.mode/types` 过滤规则。
- **maskString** — 对单个字符串执行关键词预筛、规则匹配和区间替换。
- **maskAgentActivityEntry** — 对白名单字段中的 JSON-safe 字符串递归执行打码，返回新 entry，不修改输入 entry。
- **shouldMaskField** — 判断 flusher 前 `AgentActivityEntry` 字段是否进入 mask 扫描。

## 内部设计 (Internal Design)

### 代码布局 (Code Layout)

```
src/mask/
├── sensitive-rules.json
├── rule-loader.ts
├── field-whitelist.ts
├── string-masker.ts
├── entry-masker.ts
└── types.ts
```

### 执行顺序

```
AgentActivityEntry
  -> 字段白名单
  -> 递归遍历 JSON-safe 字符串
  -> 关键词预筛
  -> regex / block / urlWithPassword 规则
  -> 区间合并
  -> 从后往前替换
```

### 大字段处理

字符串大小按 `Buffer.byteLength(value, 'utf8')` 判断。`<= 64 KiB` 整段扫描；`> 64 KiB` 先定位启用规则的 `prefilter` 关键词，只扫描关键词前后各 `8 KiB` 的合并窗口。命中结果映射回原字符串 offset 后统一回写，避免窗口重叠导致替换错位。

## 依赖关系 (Dependencies)

| 依赖模块 | 导入内容 |
|---------|---------|
| types | `AgentActivityEntry`, `MaskConfig`, `MaskType` |
| node:fs | 读取规则文件 |

## 约束 (Constraints)

1. **不处理 hook 本地 history**：mask 只作用于 collector 上报前 entry。
2. **不扫描普通元数据字段**：字段白名单外的 model、token、duration、workspace、git 等字段保持不变。
3. **规则必须有 prefilter**：避免每个字符串无条件跑所有正则。
4. **大字段不得整段反复跑复杂规则**：必须使用关键词窗口和区间回写。
5. **替换文本固定为不可逆 token**：例如 `[APIKEY_MASKED]`，不记录原值指纹。
