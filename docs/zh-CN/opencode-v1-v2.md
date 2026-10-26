# OpenCode V1 / V2 采集

Pilot 将本地目录 `~/.loongsuite-pilot/plugins/opencode` 注入 OpenCode。
目录入口的默认导出同时提供 `server()` 和 `setup()`：V1 调用原有
`server()`，V2 调用独立的 `setup()` 适配器。无需根据 PATH 中的
`opencode --version` 选择全局配置，因此同一配置可供两个版本使用。
已验证 OpenCode V1 1.14.29 和 V2 2.0.16；更早的 V1 不在本次验证范围。

## 事件来源

V1 保留现有 hooks、会话状态、token 口径和插件日志格式。输入归一化仅将
工具字段中有效的 JSON 字符串还原为原生对象/数组，保留实际内容，普通文本
和截断文本不变。V2 使用公开 API：

| 数据 | V2 来源 |
|---|---|
| 用户输入 | `session.inbox.enqueued/delivered`，模型 `context` hook |
| LLM 请求/响应 | `session.step.started/ended/failed` |
| LLM 流结束时间 | `session.step.streamed`（可用时） |
| 输出和推理 | `session.text.ended`、`session.reasoning.ended` 的完整值 |
| 工具参数及结果 | `session.tool.input.started/called/success/failed` |
| 轮次收尾 | `session.execution.succeeded/failed/interrupted` |

模型步骤使用原生 `assistantMessageID` 关联，工具使用原生调用 ID。
累计的 `session.usage.*` 不重复计入单次模型用量。为保持现有 Pilot
口径，输入 token 包含 cache read/write，reasoning 独立记录。
执行取消时只封闭已观察到的请求和工具，不生成模型输出或虚构 token。

V2 容忍 token 对象内缺失或为空的 cache 字段，缺省计数沿用 V1 的零值
口径；非法计数及依赖它的合计不输出，整个 token 对象缺失时不虚构用量。
用量异常不能阻止该步文本响应生成。

V1/V2 均遵循当前 Pilot 主线的统一内容采集策略，旧
`captureMessageContent` 开关不再生效。提示词、回复、推理、工具参数/结果
和错误文本经公共归一化及脱敏链路上报；插件原始日志包含未脱敏内容，
应按敏感数据保护本地数据目录。

## 升级与卸载

旧 `.../plugins/opencode/plugin.mjs` 配置会迁移到目录入口；保留该文件，
以兼容旧安装引用。迁移识别字符串、V1 tuple 和 V2 `{ package, options }`
形式，并清理同一配置文件中 `plugin`、`plugins` 两个数组里的 Pilot 重复项。
其他插件不受影响。自动维护和卸载均识别新旧入口。
升级后应重启对应 OpenCode 实例，使其重新加载插件。

## 本地真实 CLI 验证

构建候选包后，在隔离 HOME/XDG 中运行：

```bash
npm run typecheck
npm test
npm run build

# DASHSCOPE_API_KEY 通过环境提供，不写入配置或日志。
OPENCODE_V1_BIN=/path/to/v1/opencode \
OPENCODE_V2_BIN=/path/to/v2/opencode \
PILOT_COMPAT_PACKAGE=/path/to/installed/loongsuite-pilot \
node scripts/e2e/opencode-compat.mjs
```

测试使用真实 Qwen Plus 请求，让 CLI 读取临时文件并回复唯一标记；
经候选包的 postinstall、deploy 和 collector 验证原始日志及最终 JSONL，
并运行公共 JSONL 严格校验器。临时目录保留版本、部署结果、CLI 输出、
collector 日志、校验结果和统计，不修改宿主 Pilot 或 OpenCode 配置。
这项本地验收不等同于 SLS/ARMS 后端验收。
