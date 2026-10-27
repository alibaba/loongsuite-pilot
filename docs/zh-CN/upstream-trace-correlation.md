# Pilot 逐轮 Trace 上下文关联接入

上游应用在发送每轮用户请求前，写入一条关联记录。Pilot 采集到该轮数据后，根据会话 ID 和用户输入找到记录，让该轮调用链沿用上游 Trace ID，并挂到指定的上游 Span 下。

在 OpenClaw / Hermes 上使用本文方案，需要同时满足以下部署条件：

- **采集器**：安装包含 [PR #508](https://github.com/alibaba/loongsuite-pilot/pull/508) 全部修复的构建或后续正式版本。发布前请使用该 PR 验证通过的完整提交构建；不能仅凭“高于 v1.13.0”判断支持。修复包括 OpenClaw 前置生命周期事件过滤、空文本不消耗 session 兜底和逐轮关联状态恢复。
- **Hermes 插件**：更新 Hermes 实际加载的 Pilot 插件，并重启 Hermes 进程。只升级采集器或只替换磁盘文件，不会更新已运行进程中的插件。新插件从本轮用户消息生成输入事件，在截断正文前计算关联 hash。
- **关联记录**：上游仍需在每轮请求前写入本文的 `turn` 记录，目录须对上游和 Pilot 均可访问。

`TRACEPARENT` 环境变量是另一种首轮 session 关联方式，仅对调用 `recordUpstreamContextOnce` 写入 session 记录的 Hook 生效。OpenClaw / Hermes 的 Pilot 插件本身不直接读取该环境变量，设置变量不能代替逐轮关联文件。

已有有效父工具上下文的子代理保留原生 trace / parent 关系，不用子会话关联文件覆盖父工具链路。

```text
上游创建 Span → 写入关联记录 → 向 Agent 发送请求 → Pilot 采集并关联 → 输出 Trace
```

## 1. 开启配置

在 `~/.loongsuite-pilot/config.json` 中合并以下配置，保留其他已有配置：

```json
{
  "upstreamLink": {
    "enabled": true
  }
}
```

执行 `loongsuite-pilot restart` 使配置生效。需要在后端查看调用链时，还应按现有部署配置好 OTLP Trace 输出。

Kubernetes 注入部署应通过注入模板或配置源持久设置开关，例如给 Pilot 采集进程设置 `LOONGSUITE_PILOT_UPSTREAM_LINK=true`。如果启动流程会重建 `config.json`，只修改容器内文件会在 Pod 重建后失效。

## 2. 获取会话 ID

使用 **Pilot 采集事件中的原生 `gen_ai.session.id`**。例如，ACP 场景可使用 `session/new` 返回的会话 ID，但需确认它与采集值一致。

关联协议不限定 Agent 类型，但实际能否生效取决于 Agent 的事件类型、顺序及用户文本是否在关联阶段可用。应使用目标 Agent 做真实逐轮验收，不能仅凭存在会话 ID 和输入字段判断已支持；OpenClaw、Hermes 的版本要求见文首。

不要使用自定义业务会话 ID 替代原生会话 ID；即使输出中配置了会话 ID 覆盖，关联时仍使用原生值。

## 3. 每轮发送请求前写入记录

默认文件位置：

```text
~/.loongsuite-pilot/acp-correlate/<sessionId>.jsonl
```

同一会话使用同一个文件，**每轮追加一行完整 JSON 并换行，不覆盖历史内容**。如果 Pilot 使用自定义数据目录，文件必须写到对应目录的 `acp-correlate/` 下；容器部署时需确保 Pilot 能读到同一份文件。

Pilot 会在同一目录保存私有消费标记。标记随关联文件过期清理；关联文件仍活跃时会保留，避免重启后重复消费旧记录。同一原生 turn 的断点重放会恢复原关联，新 turn 即使输入相同也使用下一条记录。请保留这些由 Pilot 管理的标记，并确保目录可写。

| 字段 | 说明 |
| --- | --- |
| `type` | 必填，固定为 `"turn"` |
| `sessionId` | 原生会话 ID；查找文件时实际以文件名为准 |
| `traceparent` | 上游 W3C 上下文：`00-<32位traceId>-<16位spanId>-<2位flags>`，ID 不能全零 |
| `contentHash` | 推荐填写：用户原始文本的 UTF-8 SHA-256，取十六进制结果前 16 位 |
| `contentPrefix` | 可选兜底：用户输入前缀；采集文本必须以它开头，避免使用过短或重复前缀 |

`contentHash` 和 `contentPrefix` 至少提供一个。精确 hash 匹配优先，匹配不到时尝试前缀。

以下 Node.js 示例可放入上游调用方中：

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

function writeTurnContext({ sessionId, prompt, traceparent, dataDir }) {
  const dir = path.join(dataDir, 'acp-correlate');
  // 与 Pilot 的文件名规则保持一致。
  const name = path.basename(String(sessionId))
    .replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
  const record = {
    type: 'turn',
    sessionId,
    traceparent,
    contentHash: createHash('sha256').update(prompt, 'utf8')
      .digest('hex').slice(0, 16),
    contentPrefix: prompt.slice(0, 128),
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${name}.jsonl`),
    JSON.stringify(record) + '\n', 'utf8');
}

const prompt = '请介绍当前项目结构';
writeTurnContext({
  sessionId: 'session-demo', // 替换为实际原生会话 ID。
  prompt,
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  dataDir: path.join(os.homedir(), '.loongsuite-pilot'),
});
// 写入完成后，再通过实际 Agent 的 SDK、ACP 或其他接口发送同一个 prompt。
```

生产环境中，`traceparent` 应由上游当前 Span 的上下文生成；每轮写入该轮对应的上下文。不要在 Agent 已处理请求后才补写记录，Pilot 不会自动回溯修正已输出的数据。

## 4. 验证是否生效

发送一轮请求后，检查 Pilot 的 JSONL 输出或 Trace 后端：

- 该轮事件的 `trace_id` 应为示例中的 `4bf92f3577b34da6a3ce929d0e0e4736`。
- 该轮用户输入事件的 `parent_span_id` 应为 `00f067aa0ba902b7`。
- 导出的入口 Span 应挂到该上游 Span 下，内部 Agent、LLM、Tool Span 继续形成子链路。

未关联时，优先检查开关、数据目录、原生会话 ID 和用户文本是否一致。关联失败会保留原有采集流程。

对于其他 Agent，若无文本事件已在前一个批次输出，后续关联不会回写已输出的数据；接入时须验证首批标准事件就能取得用户输入。本次 OpenClaw 修复通过排除冗余的 `before_model_resolve` 标准事件，使 `before_agent_run` 成为输入入口，原始插件日志仍保留前置事件。

Hermes 修复在首个 `llm.request` 前追加一次携带用户输入的 `other` 事件（`agent.hermes.hook=turn_start`），使用此时已确定的原生 turn/task ID。模型重试与后续 LLM 调用复用同一轮关联结果，不会重复写入该输入事件。这是逐轮关联文件的支持，不代表新增了 `TRACEPARENT` 环境变量接入。

注意：当前逐轮关联使用 `traceparent` 中的 Trace ID 和 Parent Span ID，不完整透传采样标志和 `tracestate`；也不会自动把上下文注入 Agent 发出的网络请求。
