# QwenPaw 原生可观测接入

Pilot 通过 QwenPaw 原生插件与 AgentScope Middleware 采集真实请求、Agent、推理步骤、模型和工具生命周期，再通过现有 JSONL 输入、checkpoint 和 OTLP 输出链路上报。无需 AgentCore，也无需 Python instrumentation；同一业务进程避免重复启用两套采集。

## 部署

```bash
export QWENPAW_WORKING_DIR=/absolute/path/to/qwenpaw
export LOONGSUITE_PILOT_DATA_DIR=/absolute/path/to/pilot-data
export AGENT_DATA_COLLECTION_CONFIG="$LOONGSUITE_PILOT_DATA_DIR/config.json"
node /absolute/path/to/pilot/dist/index.js deploy --require qwenpaw --json
node /absolute/path/to/pilot/dist/index.js
```

插件部署到 `$QWENPAW_WORKING_DIR/plugins/loongsuite-pilot`（默认 `~/.qwenpaw/plugins/loongsuite-pilot`）。首次部署或更新后重启 QwenPaw，让原生 PluginLoader 加载当前文件。采集器与 QwenPaw 进程须使用相同的 Pilot 数据目录。

QwenPaw 2.2.1 的应用服务启动时会自动加载该插件，已验证 `/api/console/chat` 的多轮和工具调用。`qwenpaw task` 是独立的 headless 入口，在该版本中不加载 PluginLoader，业务执行成功也不会产生本插件事件；ACP 等其他入口尚未完成安装态验证。

配置示例：

```json
{
  "collectTrace": true,
  "collectLog": false,
  "serviceName": "qwenpaw-demo",
  "agents": {"qwenpaw": {"enabled": true, "captureMessageContent": true}},
  "listeners": {"qwenpaw-log": {"enabled": true, "pollInterval": 1000}},
  "otlpTrace": {
    "endpoint": "http://127.0.0.1:4318/v1/traces",
    "captureMessageContent": true
  }
}
```

认证头通过现有 `otlpTrace.headers` 私有配置提供；不要将凭证写入提交或日志。使用 CMS 时从对应工作空间的接收配置派生 endpoint 和 headers。

## 采集契约

- Runtime Hook 提供请求 ENTRY 和原生会话/user/turn 身份；正常请求在 POST_RESPONSE（终态响应 yield 前）完成采集，FINALLY 为错误、取消及短路请求幂等收尾；Middleware 提供 AGENT → STEP → LLM/TOOL 的真实父子关系。
- 多轮会话保持 session/conversation，request ID 标识单轮。同会话重叠请求独立缓冲，LLM finish reason 不会提前关闭整个请求。
- 记录可得的模型/provider、usage/cache usage、system instructions、工具定义、参数/结果和实际首次非空流式 delta 的 TTFT。非流式不伪造 TTFT。
- 仅在原生响应明确提供模型 finish reason 时上报；AgentScope 的 `completed` 不区分正常结束、长度限制和内容过滤，不据此填充 `stop`。取消和错误仍记录其实际状态。
- 对取消和工具/模型错误保留实际结果；后台 Dream 与 helper Agent 在兼容接口存在时补充覆盖。
- 不解析 AgentCore Task/run 字段，不要求 Qoder UUID Context。不自动导出整个 request_context。
- converter 能使用已提供的外部 trace_id/parent_span_id，但插件当前没有请求入口 traceparent 的完整提取链路。
- QwenPaw 2.2.1 的 `spawn_subagent` 前台、后台和嵌套请求可各自产生 Trace，但子请求当前不会关联到父 `spawn_subagent` TOOL；工具结果中的子 session 文本不能替代结构化父子关系。暂不支持跨子 Agent 的完整调用树。

内部 `agent.qwenpaw.*` 字段保留在本地 JSONL，用于生命周期配对和树重建，不默认透传到 OTLP span attributes；云端关系由标准 trace/span/parent 上下文表达。会话 ID 不作为 `gen_ai.agent.id`，未取得明确业务 Agent 身份时省略该属性。

## Skill 与 Dream

原生 `Skill({"skill": name})` 调用作为 TOOL span 采集；`gen_ai.skill.id/name/description/version` 从 QwenPaw SkillRegistry、loader 缓存及声明元数据解析，与 LoongSuite Python 0.9.0 AgentScope v2 Middleware 一致。

通过旧 `ReMeLightMemoryManager.dream(...)` 或新 `run_action("auto_dream", ...)` 入口，后台执行的 `gen_ai.agent.name` 使用所属 Agent 配置名，避免把多个业务 Agent 的用量聚合到内部 `DreamOptimizer` 名称。空配置名回退 `QwenPaw`；配置加载失败或名称非法时不覆盖原生 Agent 名称。后台请求使用独立 scope，不继承已完成前台请求。旧入口的命名行为已与 LoongSuite Python 0.9.0 的真实 Skill/Dream 运行对照；新入口沿用同一归属规则并单独验收，不表示 Python 0.9.0 已适配 `run_action`。

一次 Dream 可能按原生执行事实在同一个 ENTRY 下产生多个并列 helper AGENT。当前独立 Trace 校验器要求一个根 AGENT，因此这一场景的完整结构校验仍报错；需先明确双方采用的拓扑契约，不能用虚构的 Agent 隐藏差异。

QwenPaw 2.2.1b1 将 Dream 入口迁移到通用 `run_action("auto_dream", ...)`，能力没有取消。插件优先适配存在的旧异步 `dream`，不存在时适配异步 `run_action`，每个安装仅包装一个入口以避免重复根节点。新入口只处理 `auto_dream`，其他 action 原样执行；原始返回值和异常不变，返回失败或未启动时记录失败状态。

## 开关和隐私

`LOONGSUITE_PILOT_ENABLED=false`、全局 `enabled=false` 或 `agents.qwenpaw.enabled=false` 停止生产事件。配置包含 qwenpaw 且 collectLog/collectTrace 均明确为 false 时同样停写。配置文件按写入读取，恢复开关后可继续生产；这不代表 Collector 的上报路由或资源身份支持热切换。

`agents.qwenpaw.captureMessageContent=false` 在源端剥离消息、system/tools、工具参数/结果和错误文本。Collector 继续使用 Pilot 公共内容策略与脱敏。主效果验收设置 SPAN_ONLY 并启用上述内容选项；SPAN_ONLY 是验收约定，插件实际内容控制由 Pilot 配置负责。

事件目录/文件权限为 0700/0600。写入抛出异常时不改变业务结果。当前写入和配置读取在回调中同步执行：磁盘或文件系统调用变慢时会阻塞该 Python 事件循环及同进程的其他会话，尚未满足慢盘隔离要求，不应将异常 fail-open 等同于慢 I/O 隔离。入口消息转换失败只省略内容并诊断，保留原生请求身份、ENTRY 边界和子调用关联，不从 LLM 提示词反填原始请求。Collector 正常退出前执行一次有界的最终读取；未读完的积压在下次启动时从 checkpoint 继续。进程强杀不保证补齐所有 span，也不承诺跨崩溃 exactly-once。

每轮最多轮询四个进程文件、每文件读取 16 MiB，超过 16 MiB 的单条记录会告警并跳过；不完整尾行会等待后续写入。长轮次正文暂存在本机临时文件并按预算分批转换和导出，避免在内存中同时展开全部 Span。原始日志只有在消费进度已持久化、文件足够旧且写入进程已退出时才会回收；活动或未消费日志可能继续增长，请监控数据目录空间。

启用 OTLP 时，未结束轮次保存在 `logs/qwenpaw-pending-turns/`，其容量与 Codex/Hermes/OpenClaw 的 journal 分开，默认上限为 512 MiB。`LOONGSUITE_CODEX_PENDING_MAX_BYTES` 可同时调整各 journal 的独立上限；达到上限时暂停推进对应输入的 checkpoint，保留来源等待恢复。journal 包含经内容策略和脱敏处理后的事件，并在完整导出成功后确认和清理；若 OTLP 内容捕获关闭，journal 不保留消息和工具内容。启动时若 QwenPaw 的 journal 无法读取，该输入会保留 checkpoint 并等待修复后重启，其他 Agent 的 journal 不受影响。

## 兼容和验证

插件按需要的原生接口启用，不对 QwenPaw/AgentScope 作精确版本等值拒绝。核心注册失败会诊断并停用本次采集；可选 helper/Dream 接口不支持时仅跳过对应覆盖。已注册但无法通过原生 API 注销的回调变为 inactive。测试依赖版本固定用于复现，不等于运行时唯一允许版本。

已测接口基线为 QwenPaw 2.1.0 / AgentScope 2.0.4.post1，以及 QwenPaw 2.2.1b1 / AgentScope 2.0.7.post1；后者已使用真实模型、安装产物与 CMS 读回验证。版本测试不保证所有未来接口均兼容；两个异步 Dream 入口都缺失时才跳过对应能力并诊断。其他版本仍以实际接口与运行验证为准，原生 PluginLoader 还应用自己的 manifest 兼容策略。

POST_RESPONSE 以响应生成完成为 ENTRY 结束边界；发生在该钩子之后的宿主 finalizer/envelope 错误只诊断，不改写已发送的 ENTRY。QwenPaw 2.2.1b1 在消费者停止于终态时仍可能输出 `async generator ignored GeneratorExit`，不加载 Pilot 的对照也能复现；插件完成钩子避免因此遗漏正常请求的结束事件，不会替宿主吞掉业务异常。

```bash
npm run typecheck
npm run build
npm test -- tests/unit/inputs/qwenpaw-log-input.test.ts tests/unit/flushers/qwenpaw-trace-converter.test.ts tests/unit/flushers/qwenpaw-lifecycle-flusher.test.ts
/path/to/qwenpaw-venv/bin/python tests/unit/hooks/qwenpaw-plugin/test_plugin.py
```

真实原生模型、工具、多轮、并发及故障矩阵见 [E2E 说明](../../scripts/e2e/qwenpaw-parity/README.md)。从安装产物部署插件并读取真实接收端数据后，才能宣称该版本接入通过。原有 fork/AgentCore 验收不自动成为当前提取版本的验收。

卸载/回滚仅清理 managed marker 属于本 Pilot 安装的插件，保留用户文件、其他安装实例和符号链接。
