# 按请求添加自定义属性

[English](../request-attributes.md) | 简体中文

业务调用方可以在每轮发送用户输入前，写入本轮的客户编号、用户编号或任务编号。Pilot 将记录与采集到的原生会话和本轮输入匹配，再把属性添加到本轮事件及 Trace Span。Agent 可以是每次新启动的 CLI，也可以是承接多轮请求的 SDK/RPC 进程；每轮的值由调用方提供，无需修改长驻进程的环境变量。

公共逐轮入口复用[逐轮 Trace 关联](upstream-trace-correlation.md)的关联文件，但不要求已有上游 Trace，也不要求开启 `upstreamLink.enabled`。每个任务启动一次 Grok 时，也可选择下面的子进程环境变量入口。两种入口都不向 Agent 的网络请求注入字段，不从上游 Span 自动复制属性，也不替代 Agent 插件的安装和采集。

## 快速接入：业务 server 每次请求启动 Grok

如果平台通过 HTTP 接收业务请求，再为每次请求 `spawn` 一个 Grok 进程，按以下步骤接入即可。长驻 SDK/RPC 的接入见后文逐轮文件方式。

### 1. 升级指定包，并确认实际 Hook 已更新

先使用**明确包含本功能的 Pilot 包或镜像**。源码分支已有代码，不表示公开下载的 `latest` 包已经包含它；联调交付应同时给出源码 commit、安装包或镜像地址、校验和，以及支持的 Agent 版本。安装与指定包参数见[安装指南](installation.md)。

升级要同时覆盖 Collector 和已部署的 Hook/Plugin 资产，仅替换 Collector 的 `dist` 或重启服务不够。安装流程会更新 Pilot 资产；随后还要核对 Grok 实际加载的 Hook 命令指向新资产。已运行的业务进程不会因 Collector 重启而改变环境，后续请求必须启动带本轮 env 的新 Agent 进程。

**多租户与系统级接入另有部署前提：**默认开源 Grok 部署将 Hook 注册到当前 `$GROK_HOME/hooks/loongsuite-pilot.json`，不等于自动为未来创建的所有子目录注册。使用动态 `GROK_HOME`、共享 managed 配置或定制安装器的平台，必须保留并核验现有 Hook 注册机制，再升级它引用的 Collector/Hook 资产。不能直接用普通单用户安装覆盖这类部署并假定兼容；容器部署应将变更固化到镜像或注入模板，并用新建的租户目录验证。

### 2. 在 Pilot 中允许 `memory.` 字段进入 Span

合并到现有 `config.json`，保留既有 OTLP/CMS 目标，并把 `memory.` **追加**到已有前缀列表：

```json
{
  "otlpTrace": {
    "spanAttributePassthroughPrefixes": ["memory."]
  }
}
```

重启 Collector 加载配置。此子进程入口不需要开启 `requestAttributes.enabled` 或 `upstreamLink.enabled`，也不需要创建关联文件。Trace 上报本身应已经正常工作。

### 3. 业务调用方为每个子进程传入本轮用户

用户值取平台已经认证的身份，跨终端保持稳定，例如 `tenant-001:user-007`；请求编号每次不同。先校验/编码标识，避免包含逗号分隔符。沿用现有命令、参数、工作目录和环境，只修改每次 `spawn` 的参数：

```js
import { spawn } from 'node:child_process';

// 以下值来自本次已认证的业务请求。
const attributes = `memory.user_id=${tenantUserId},memory.request_id=${requestId}`;
const child = spawn(grokCommand, grokArgs, {
  ...existingSpawnOptions,
  env: {
    ...(existingSpawnOptions.env ?? process.env),
    LOONGSUITE_PILOT_SPAN_ATTRIBUTES: attributes,
  },
});
```

每个请求创建独立 env 对象，不修改共享 `process.env`。并发 A/B 请求因此分别把 A/B 的属性传给自己的 Agent 与 Hook。只在 Collector 环境设置这个变量无效；这一轮开始前必须让它进入 Agent 子进程。

### 4. 核对 Trace，再配置记忆归属

让两个用户通过真实业务入口同时发请求，核对它们各自 Trace 的 AGENT Span：`memory.user_id` 对应业务用户，`memory.request_id` 对应本次请求。多租户平台还应在**新创建的租户目录**中重复该检查，确认共享 Hook 注册仍然生效。

用于记忆时，将 userId 映射设为 `$.agent_attributes.attributes["memory.user_id"]`。先读取真实轨迹，确认 `agent_attributes.attributes` 中也包含该字段，再测试映射、提取及召回。默认 userId 映射不会自动采用这个自定义字段；详细边界见后文。**字段进入 Trace、字段进入轨迹、记忆提取/召回成功是三项独立验收。**

## OpenClaw：长驻 Gateway 逐轮注入

已用 OpenClaw **2026.6.5 的 `agent` RPC** 验证：同一个 Gateway 进程中的多轮请求、空属性、并发独立 session，以及同 session 同文并发提交都可分别关联。Gateway 进程环境中的 `LOONGSUITE_PILOT_SPAN_ATTRIBUTES` 是启动时默认值，不能用它切换每次 RPC 的业务用户。

1. 更新并激活 Pilot OpenClaw 插件，重启 Gateway 一次以加载新插件。启用下文的 `requestAttributes.enabled` 和 `memory.` Span 透传，重启 Collector。调用方必须能向 Collector 使用的同一数据目录写入记录；远程 RPC 客户端不能仅靠请求参数替代这一步，可由 Gateway 所在侧的业务适配层写入。
2. 使用真正的原生 `sessionId`；`sessionKey` 是另一种路由标识，不能代替文件名中的 session ID。此版本允许调用方将已确定的 session ID 传入 `agent` RPC；新建或复用会话时需核对实际输出一致。
3. 对此已验证的 RPC，原生 `runId` 等于调用方的 `idempotencyKey`，现代 Pilot 插件以它作为 `gen_ai.turn.id`。每个新逻辑请求使用唯一键，在调用 RPC **之前**写精确记录：

```js
import { randomUUID } from 'node:crypto';

const runId = randomUUID();
writeRequestAttributes({ dataDir, sessionId, turnId: runId,
  attributes: { 'memory.user_id': tenantUserId, 'memory.request_id': requestId } });
await gateway.request('agent', {
  sessionId, sessionKey, message: prompt, idempotencyKey: runId,
});
```

`writeRequestAttributes` 是下文供调用侧适配的文件写入示例，`gateway.request` 是客户已有的 OpenClaw 客户端。不能直接把 `attributes` 对象加到 `agent` RPC；该版本会因不支持的参数而拒绝请求。精确记录允许相同文本、记录逆序和并发提交，不依赖 Collector 按请求到达顺序猜测归属；Gateway 自己仍可能按 session 排队执行。

此处没有验证 `chat.send`、HTTP 兼容接口或旧版 OpenClaw 的相同 ID 语义。早期 Pilot legacy 适配器可能生成不同 turn ID，不能照搬 `idempotencyKey` 规则。先核对实际版本和事件；无法事前取得准确 turn ID 时，使用已确认 session 的文本模式并串行完成本 session 的每轮。

## Codex：CLI 子进程和长驻 app-server

已用 Codex **0.166.0** 验证两种入口：

- 每次请求创建独立 CLI 子进程：给每个子进程独立的 `LOONGSUITE_PILOT_SPAN_ATTRIBUTES`，与前述 Grok 入口一样，无需关联文件和两个关联开关。
- 长驻 app-server：`thread/start` 返回原生 thread ID，它也是 Pilot 关联用的 session ID。在每个新 turn 的 `turn/start` 前，使用用户原始文本写入本 thread 的 `contentHash` 关联记录。开启 `requestAttributes.enabled`；没有属性的轮次也写 `attributes: {}`。

```js
const { thread } = await codex.request('thread/start', existingThreadOptions);
// 后续每轮先写记录；同一个 thread 等 turn/completed 后才发起下一轮。
writeRequestAttributes({ dataDir, sessionId: thread.id, prompt,
  attributes: { 'memory.user_id': tenantUserId, 'memory.request_id': requestId } });
await codex.request('turn/start', {
  threadId: thread.id, input: [{ type: 'text', text: prompt }],
});
```

需要包含 Codex 原生 user provenance 关联修复的 Pilot 版本：app-server 首轮还会写环境上下文，Pilot 根据原生 `content_item_metadata.provenance` 或 `user_message` 取得用户原文 hash，保留完整消息；不能把环境上下文拼入调用侧 hash，也不能靠删除任意 XML 字符串匹配。

不同 thread 可以并发。**同 thread 的 active turn 上再次 `turn/start`，该版本可能将输入加入同一个 turn，返回相同 turn ID，而非创建第二个独立请求。**这种 steering 不能按两个独立 turn 各附一组身份；不要为它预先排入第二条文本 FIFO 记录。需要独立归属的任务使用不同 thread，或等待本 turn 完成。原生 turn ID 在 `turn/start` 后才返回，不能用任意业务请求编号事前冒充精确键。

## 用户归属与并发边界

用于记忆提取时，`memory.user_id` 应来自业务平台已经认证的用户身份。同一用户跨终端使用同一稳定值；有多个租户时使用租户内不冲突的组合标识，例如 `tenant-001:user-007`。`memory.request_id` 每次请求变化，用于排查归属，不能代替稳定的用户标识。Agent 实例编号、容器的 root 用户、工作目录和原生 session ID 都不能直接当作业务用户。

```mermaid
flowchart LR
  A[业务请求中的用户身份] --> B[本次子进程 env 或逐轮关联记录]
  B --> C[Hook 或 Plugin 产生原生事件]
  C --> D[Pilot 按原生 session 和 turn 关联]
  D --> E[脱敏及 Span 字段透传]
  E --> F[AGENT Span 的 memory.user_id]
  F --> G[轨迹 agent_attributes.attributes]
  G --> H[记忆配置的 userId 映射]
```

并发支持取决于能用什么标识区分请求：

| 调用方式 | 本轮字段从哪里来 | 并发条件 |
| --- | --- | --- |
| 每次启动一个 Grok 子进程 | 每个子进程独立的 `env` | 可并发；Hook 必须带当前 `prompt_id`，不得复用服务器共享环境中的临时值 |
| 不同原生 session | 每个 session 的关联文件 | 可并发；各文件独立写入和消费 |
| 同一 session，只能提供输入文本/hash | 文本 FIFO 关联记录 | 按该 session 串行完成每轮；重复输入的乱序并发无法唯一关联 |
| 同一 session，发送前能确定准确的原生 turn ID | 带 `turnId` 的精确关联记录 | Pilot 可处理相同输入和乱序到达；框架本身是否允许同 session 并发仍需另外确认 |

`turnId` 是采集事件中的 **`gen_ai.turn.id`**，不是随意生成的业务请求编号。部分 CLI 只在请求开始后才生成它，因此不能仅增加这个 JSON 字段就让这些入口支持事前精确关联。没有可用原生标识时，应使用独立 session、已验证的子进程入口，或在调用侧增加能拿到原生生命周期的集成。

不同适配器的 turn ID 也不一定等于宿主 API 返回值，须用实际事件核对。例如当前适配器：

| 框架 | 采集侧 `gen_ai.turn.id` | 调用方接入注意点 |
| --- | --- | --- |
| Grok | Hook/updates 中的 `promptId` | 本轮 Hook 可确定它；CLI 调用方不能假设启动前已知，可使用子进程 env |
| Codex | `<原生sessionId>:<宿主turnId>` | 仅拿到宿主 turn ID 还不够，须与采集侧完整值一致 |
| DSH | `<原生sessionId>:<宿主turn序号>` | 先确认真实 SDK/plugin 加载路径及序号语义，不能凭业务请求计数猜测 |
| Pi | Pilot 扩展为本轮生成的 UUID | 外部调用方通常无法提前知道；采用已确认 session 的文本串行模式，或增加生命周期集成 |

这是匹配协议的说明，不表示每个框架都提供了可由调用方事先指定 turn ID 的业务 API。

实际 CLI 接入还需区分 **session ID** 能否事前确定。已验证 Pi 1.5.0 可用 `--session-id <UUID>` 创建新会话：调用方生成 UUID → 先写该 session 的文本关联记录 → 以相同 UUID 启动 Pi。并发用户分别使用不同 UUID。DSH 0.2.1-rc.5 的 CLI `--session-id` 用于恢复已有会话，不能作为新会话 ID 注入入口；验证已有会话的后续逐轮关联，不等于新会话首轮已支持。生产接入应由 SDK 先创建会话再发送，或补相应生命周期集成，不能用一次无归属的业务请求“预热”来代替首轮支持。不同版本须重新核对原生参数和会话行为。

## CLI：每个任务启动一次 Grok

业务 server 每轮启动独立 Grok 子进程时，可给每个子进程单独设置属性，无需提前知道原生会话 ID。Pilot 的 Grok Hook 会把它继承的属性写入当前 Hook 明确 `prompt_id` 对应轮次的事件。例如：

```bash
LOONGSUITE_PILOT_SPAN_ATTRIBUTES='memory.user_id=customer-001,memory.request_id=request-001' \
  grok -p '请介绍项目结构'
```

在客户已有的 `spawn` 调用中，应保留原命令、参数和环境，仅为本次子进程的 `env` 对象增加该变量。不要为并发任务轮流修改 server 进程的共享 `process.env`。

```js
// 每个 HTTP 请求各调用一次；原 args、cwd 和其他 env 沿用客户现有配置。
const childEnv = {
  ...existingEnv,
  LOONGSUITE_PILOT_SPAN_ATTRIBUTES:
    `memory.user_id=${tenantUserId},memory.request_id=${requestId}`,
};
const child = spawn('grok', args, { cwd, env: childEnv });
```

上例标识值应提前校验，不能包含此格式的逗号分隔符。A、B 两个请求分别构造自己的对象后，即使同时运行，A 的 Hook 继承 A 的用户值，B 的 Hook 继承 B 的值；Collector 无需根据进程启动顺序猜测。

Pilot 仍需允许对应 Span 前缀：

```json
{
  "otlpTrace": {
    "spanAttributePassthroughPrefixes": ["memory."]
  }
}
```

此入口与已有 Claude Code/Codex 等环境变量入口相同，独立于 `requestAttributes.enabled` 和 `upstreamLink.enabled`；变量应到达 **Agent 及其 Hook**，只设置在 Collector 进程上不会给业务调用附加属性。环境变量使用 `key=value,key=value` 格式，值为字符串且不能包含逗号，单个值最长 512 字符。Grok 还执行下文的 64 个字段、8 KiB 总预算及 128 字符 key 限制；这些动态字段进入后续脱敏处理。

同一个 Grok 进程如果继续接收多轮请求，这组进程环境并不会随请求变化。长驻进程中的多个用户应采用下文公共逐轮文件入口。不能把 Grok 的支持范围扩展为 Pi、DSH 也已读取这组环境变量。

如果 Hook 补导出其他历史轮次，不会用当前进程的值回填那些轮次；缺少明确 `prompt_id` 时省略这组属性，正常采集继续。应通过客户实际入口确认当前请求 Hook 提供了该标识。

## 1. 逐轮文件：确认调用方能定位本轮

接入前需要同时满足：

- Agent 已能被 Pilot 正常采集，首批标准事件在输出前可提供本轮用户输入，或调用方能提供准确的原生 turn ID。
- 调用方在发送输入前取得 **Pilot 采集使用的原生 `gen_ai.session.id`**，例如 SDK/ACP 创建会话返回的 ID；先用已有事件确认两者一致。
- 调用方与 Pilot 能访问同一份数据目录，且调用方可以在其中追加关联记录。

业务会话编号不能直接替代原生会话 ID；自定义输出身份也不改变关联时使用的原生 ID。如果直接启动 CLI 时无法提前取得它的原生会话 ID，应先确认框架是否支持先创建会话、传入原生会话 ID 或其他可靠调用入口。不能仅凭“每次启动一个子进程”就判断文件关联已可用；受支持 Agent 的进程环境变量路径见 [Trace 输出](trace-output.md#自定义-span-属性)。

不带 `turnId` 时，关联依赖采集事件中的输入，而不是某个 HTTP 请求的到达时间。同一原生会话中重复输入按关联文件顺序消费；**同一会话中并发发送完全相同输入，无法仅靠文本唯一识别请求**。文本模式要求上游按原生会话串行执行“写本轮记录 → 发送本轮输入 → 等待本轮完成”；独立原生会话可各自写入和并发运行。

使用文本 FIFO 模式时，**每一轮都必须先写 `turn` 记录，没有业务属性也写 `"attributes": {}` 作为本轮占位**。不能漏写中间一轮却提前写入未来同文请求的记录，否则中间一轮可能消费未来的属性。空对象会和对应本轮一起消费，防止相同输入导致属性向前错配。仅包含精确记录的 session，无属性的 turn 可不写记录；若同一 session 混有文本 FIFO 记录，须为无属性 turn 写带其 `turnId` 的 `attributes: {}`，防止回退消费同文 FIFO 记录。推荐一个 session 统一采用一种关联模式。

## 2. 开启请求属性与 Span 透传

合并到 Pilot 的既有 `config.json`，保留现有上报目标等配置：

```json
{
  "requestAttributes": { "enabled": true },
  "otlpTrace": {
    "spanAttributePassthroughPrefixes": ["memory."]
  }
}
```

重启 Pilot 加载配置。Kubernetes 部署应修改会生成该配置的注入模板或配置源，避免 Pod 重建后丢失设置。

`requestAttributes.enabled` 默认关闭，也可通过采集进程的 `LOONGSUITE_PILOT_REQUEST_ATTRIBUTES=true` 开启。它控制将关联属性添加到输出事件。`spanAttributePassthroughPrefixes` 控制哪些普通字段继续进入 Span：没有匹配的透传前缀时，字段仍可出现在事件输出中，但不会通过该机制进入 Span。正常 Trace 上报仍需已配置的 CMS/OTLP 目标以及 `collectTrace`。

## 3. 每轮发送前写入属性

文件位于 Pilot 数据目录下：

```text
<dataDir>/acp-correlate/<原生sessionId>.jsonl
```

同一会话每轮追加一行完整 JSON，并以换行结束；无属性的一轮同样追加空对象占位。例如：

```json
{"type":"turn","sessionId":"session-demo","contentPrefix":"请介绍项目结构","attributes":{"memory.user_id":"customer-001","memory.request_id":"request-001","memory.attempt":1}}
```

文本模式的 `contentHash` 推荐使用用户原始文本 UTF-8 SHA-256 的前 16 位十六进制结果；`contentPrefix` 仅作为可选前缀兜底，避免过短或重复前缀。至少提供其中一个。业务自定义属性放在 `attributes` 对象中，`traceparent` 可以省略。

若调用方可在发送前确定准确原生 turn ID，优先使用精确模式，输入文本可以省略：

```json
{"type":"turn","sessionId":"session-demo","turnId":"native-turn-002","attributes":{"memory.user_id":"tenant-001:user-007","memory.request_id":"request-002"}}
```

精确记录只匹配该 session 下相同的原生 turn ID，不进入文本 FIFO，也不会被其他同文请求消费。相同 turn 的相同记录重试允许；首次解析可见的同 turn 记录存在不同属性或不同上下文时，该 turn 的文件关联被拒绝并告警。所有本轮记录必须在首次采集前完整提交，首次解析后关联结果冻结；后续追加的冲突记录不会使已缓存的结果重新判定，事件和 Span 也不会回溯修改。仍应使用单写者或跨进程协调，保证每行完整写入。

以下 Node.js 示例供调用方适配，`send` 是客户已有的 SDK/RPC 发送函数，不是 Pilot 提供的新业务接口。该示例假定上游已按原生会话串行写入；多个进程写同一会话文件时，应由平台提供统一单写者或跨进程写入协调。

```js
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

function writeRequestAttributes({ dataDir, sessionId, turnId, prompt, attributes }) {
  try {
    const dir = path.join(dataDir, 'acp-correlate');
    const name = path.basename(String(sessionId))
      .replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
    const record = {
      type: 'turn',
      sessionId,
      ...(turnId ? { turnId } : {
        contentHash: createHash('sha256').update(prompt, 'utf8')
          .digest('hex').slice(0, 16),
      }),
      attributes,
    };
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${name}.jsonl`),
      JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch {
    // 可观测写入失败不重发业务请求；本轮可能没有自定义属性。
    return false;
  }
}

async function sendTurn({ dataDir, sessionId, prompt, attributes = {}, send }) {
  const attributesWritten = writeRequestAttributes({
    dataDir, sessionId, prompt, attributes,
  });
  // 完整写入后，再通过原有 SDK/RPC 发送同一个 prompt。
  const result = await send(prompt);
  return { result, attributesWritten };
}
```

`send` 应在本轮业务完成后返回；若现有 API 仅返回接收确认，需要调用方另外等待该轮完成再发送下一轮。针对同一 session 的相同 prompt，按以下顺序分别调用 `sendTurn`，每次都先写记录：

| 请求顺序 | 写入的 `attributes` | 本轮请求属性 |
| --- | --- | --- |
| A | `{"memory.user_id":"U001","memory.request_id":"R001"}` | U001 / R001 |
| B | `{}` | 无本轮附加值，不继承 A |
| C | `{"memory.user_id":"U003","memory.request_id":"R003"}` | U003 / R003 |

这里“不继承上一轮”以 B 的空对象占位、producer 没有同名默认字段为前提，不能扩大为漏写任意轮次也安全。`attributes: {}` 只占位，不会清除 Hook/Plugin 或全局配置已经提供的字段；长驻多用户进程不要把动态的 `memory.user_id` 配成环境或全局默认值。同一原生 turn 的断点重放可以恢复其已匹配的记录。保留 Pilot 在同目录生成的消费标记，不覆盖已有历史文件，不在请求完成后才补写记录；已经输出的数据不会被回溯修改。共享关联目录的过期清理由 `upstreamLink.ttlMs` 控制（默认 24 小时），即使没有开启上游 Trace 关联也会运行。

关联目录及消费标记必须可写。记录或消费标记写入失败时，采集按 best effort 降级，本轮属性可能丢失，业务继续运行；这不构成权限故障和恢复过程中相同输入仍能无条件正确匹配的保证。调用方应监控 `attributesWritten`，修复目录可写性后重新核验请求与属性归属，不能重发已完成的业务请求来补遥测。

请求属性模式下，单个关联文件最多 32 MiB，单条完整 JSONL 行最多 64 KiB。整文件超预算，或任意完整行超预算时，Pilot 都会明确告警并拒绝**本次整个文件的新读取**，已有缓存中的原有匹配保持；它不会只跳过大行或静默只读取前 N 行。上游应控制记录大小和会话寿命，使用新的原生 session 对应的新文件，或等待正常 TTL 清理。禁止替换、截断或手工轮换仍活跃的 append-only 会话文件，以免破坏消费标记与轮次归属。

## 4. 与上游 Trace、字段策略的关系

需要同时关联上游 Trace 时，另外开启 `upstreamLink.enabled`，并在 **同一条本轮记录**中加入真实上游 `traceparent`。关闭上游关联时，属性仍可生效，原有 Trace/父子关系保持不变。有效原生子 Agent 父工具上下文也不会因添加业务属性而被改写。

属性值支持字符串、有限数值和布尔值，不支持对象、数组或 `null`。key 最长 128 字符，字符串值最长 512 字符；单组最多 64 个属性，JSON UTF-8 大小不超过 8 KiB。使用 `memory.*` 等自有命名空间；保留前缀（例如 `gen_ai.`、`user.`、`agent.`、`git.`、`workspace.`、`event.`、`trace_`、`cost_`）和敏感命名（例如 token、secret、password）不能作为普通业务属性写入。非法单个字段会被丢弃；整组超过数量或字节预算时，整组属性被拒绝，不截取其中一部分。

显式本轮文件属性优先于 producer 已有的同名普通字段，包括 Grok 环境变量提供的默认值，并在后续公共脱敏处理之前附加到事件。Span 透传使用处理后的事件值。该机制不修改标准 `user.id` 或会话身份；如记忆系统使用 `memory.user_id`，应将记忆归属映射指向 Agent 属性中的该字段，例如 `$.agent_attributes.attributes["memory.user_id"]`，并用真实轨迹样本确认映射结果。

记忆归属的默认 `userId` 路径读取 `user.id`、再回退 `enduser.id`，不会自动读取 `memory.user_id`。字段名带点时必须使用上面的方括号路径。自定义映射只使用配置路径，不会自动沿用默认回退。先在 AGENT Span 和轨迹中的 `agent_attributes.attributes` 两处确认该字段，再用记忆配置里的样本测试核对 userId。

跨终端统一记忆还应核对 `agentId`、`appId` 的映射和召回过滤：默认 Agent 名称及首个 service 名称可能随框架而变化。仅让 userId 相同，不能证明不同 Agent 的记忆一定可互相召回。映射样本测试也只证明字段取值；正式提取、落库和跨终端召回需要单独验收。业务会话应按用户隔离，避免把不同用户的对话上下文放进同一个 Agent 会话；本功能只负责遥测字段归属，不会隔离 Agent 自己的上下文。

## 5. 验收与故障定位

先用两个原生会话分别写入不同的 `memory.user_id`，通过客户实际业务入口运行新请求：

1. 在 Pilot 标准事件中核对原生 session、turn、业务用户和任务编号。
2. 在本地 OTLP debug 或接收端核对该轮 AGENT、LLM、TOOL 等实际生成的 Span 属性。
3. 在 CMS/OTLP 后端回读同一 Trace，核对属性原生类型及完整父子关系，再测试记忆归属映射。
4. 测同一会话同文输入的 A（有值）→ B（空对象占位）→ C（新值）、并发独立会话和 Collector 重启重放。有准确原生 turn ID 的入口再测试同文、乱序以及同 turn 冲突拒绝；再测目录不可写时业务继续、属性降级及恢复后重新核验。

没有属性时，依次检查：开关是否加载、两端数据目录是否相同、原生 session ID、原始输入 hash、记录是否先写完、首批采集事件是否有用户输入，以及 Span 前缀是否允许该字段。插件没有加载或尚未产生标准事件时，应先恢复 Agent 采集；调整关联文件不能解决采集入口缺失。
