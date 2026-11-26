# 本地拦截模块

[English](../interceptor.md) · [Qoder CLI Hooks Reference](https://docs.qoder.com/cli/hooks-reference) · [Qoder Hooks](https://docs.qoder.com/extensions/hooks)

Interceptor 的 HTTP 服务跑在 collector 进程内的独立 Worker 线程里，仅在启动配置 `interceptor.mode` 为 `all` 时随 collector 启动和退出。Worker 直接监听 loopback HTTP，collector 主线程里的同步 SQLite、进程查询或批量采集不会占住它的事件循环。Hook CLI 仍是 IDE 拉起的短进程，不依赖第一次 hook 触发来启动服务。

Qoder、千问办公和 WorkBuddy 分别部署采集 hook 与同步拦截 hook。

## 架构

```
Qoder Desktop / CLI
        │ stdin hook JSON
        ▼
interceptor-hook.sh / .ps1
        │
        ▼
dist/interceptor/cli.cjs  hook --agent qoder-auto
        │ loopback HTTP（4s）
        ▼
collector 进程内 interceptor HTTP（127.0.0.1）
        │
        ▼
顺序规则引擎（首个 block 短路）
```

千问办公（QwenWorkCN，`qwen-work-cn`）本地走独立 command hook，**不能**用 `qoder-auto`（surface 解析会把 QwenWork 进程排除）。企业控制台只收 `type:http`，daemon 另开 `/v1/hooks/qwenwork`，不自动写进 `~/.qwenworkcn/settings.json`。

```
QwenWorkCN 桌面（本地 settings.json）
        │ stdin hook JSON
        ▼
interceptor-qwenworkcn-hook.sh / .ps1
        │
        ▼
dist/interceptor/cli.cjs  hook --agent qwen-work-cn
        │ loopback HTTP（4s）
        ▼
collector 进程内 interceptor HTTP（127.0.0.1）
        │
        │ 企业 HTTP：POST /v1/hooks/qwenwork
        │ （始终 HTTP 200；fail-open 为 {}）
        ▼
顺序规则引擎（首个 block 短路）
```

OpenClaw 不走 stdin command hook：采集插件在进程内调用同一 daemon。

```
OpenClaw Gateway（≥ 2026.5.12）
        │ api.on(before_agent_run / before_tool_call / tool_result_persist)
        │ api.registerAgentToolResultMiddleware  （当轮 PostToolUse，宿主支持时）
        ▼
assets/plugins/openclaw/plugin.mjs
        │ 采集 JSONL 之后问 daemon（4s；runtime 缺失则静默 fail-open）
        ▼
collector 进程内 interceptor HTTP（127.0.0.1）
        │
        ▼
{ outcome:"block" } / { block:true, blockReason } / { result } / { message }
```

- 源码：`src/interceptor/`
- 运行态：`~/.loongsuite-pilot/interceptor/{runtime.json,interceptor.pid,logs}`
- 访问日志：`~/.loongsuite-pilot/interceptor/logs/access.log`（每次 hook 判定一行 JSONL）。单个文件超过 10MB 时切到 `access.log.1` … `access.log.5`，更旧的丢弃。
- 裁决缓存：工具按 `session id + tool call id + phase` 关联；放行的提示词关联原生 `llm.request`（见下方“提示词关联与 Agent 身份”），缓存不保存提示词正文。两类裁决共用最近 30 分钟、最多 10000 条的容量（满时淘汰最早写入的记录），checkpoint 为 `~/.loongsuite-pilot/interceptor/tool-verdicts.json`，每 15 秒仅在变化后异步落盘。运行期间 Worker 是唯一写入者，主线程镜像负责采集关联（输出字段见 [输出事件 Schema](output-event-schema.md)）。
- 构建产物：`dist/interceptor/cli.cjs`、`dist/interceptor/worker.cjs`；`dist/interceptor/daemon.cjs` 保留为独立兼容入口，collector 不再直接调用它。
- 规则开关：`config.json` 的 `interceptor.mode` 在 collector **启动时读一次**；`configs/managed/interceptor.json` 的本地规则每 3 秒热更新（见 [本地文件规则](#本地文件规则)）

## 拦截自监控告警

启用拦截后，本地托管规则缓存不可读或非法时进入 `MANAGED_CONFIG_ALARM`，
并继续保留内存中上一版有效规则。
每次实际加载失败都参与告警计数；本地 warning 的文本去重不影响 collector 的冷却和累计次数。
正则在匹配 Worker 内执行耗时达到 50ms 时产生 `INTERCEPTOR_REGEX_ALARM`（`code=regex_slow`）。
正则请求超过预算（默认 200ms，包含排队及 Worker 启动时间）时记录 `code=regex_timeout`，
继续按原有逻辑跳过当前规则；其他匹配线程故障记录 `code=regex_failed`。
正常停机主动取消的匹配继续 fail-open，不产生线程故障或超时告警。

两类告警级别均为 2，`input_name=interceptor`，`endpoint_name` 为诊断 code。
`alarm_message` 是 JSON，包含诊断来源、原因分类，以及适用的配置版本、规则 ID/版本、耗时和阈值；
不携带 prompt、正则正文、配置/脚本内容或凭证。详细校验错误仍在本地日志中。
告警沿用 collector 的 30 秒刷新链路，落到 `logs/metric_alarm/pilot-alarms-YYYY-MM-DD.jsonl`。
开源构建只落本地文件；远端上报由发行版的 alarm sender 实现负责。

为避免重复上报，每个 collector 中同一诊断 code 首次立即入队，之后冷却 10 分钟；
规则 ID 或版本变化不会绕过冷却。窗口内仅累计次数，冷却结束后再次出现该类异常时，
`alarm_count` 包含此前被抑制的次数。若异常不再出现，不会定时补发历史异常；collector 重启会重置冷却。
Worker 重启不重置冷却。Worker 转发仍受单批 ACK 背压限制，并按固定诊断 code 合并、保留次数，
不会因规则数量或异常请求量增长无限队列。

## Status 中的拦截指标

`pilot_status` 的顶层 `interceptor` JSON 对象随现有 L1 status 在启动、每 10 分钟和退出时上报；
本地同一份数据位于 `logs/metric_alarm/pilot-metrics-YYYY-MM-DD.jsonl`。开源构建沿用本地落盘。
启动首报在首次拦截启动尝试结束后采样，直接反映成功、失败或关闭状态，无需等待十分钟周期。

| 字段 | 含义 |
|------|------|
| `enabled` / `running` | 启动配置是否开启 / Worker 当前是否正在监听；可区分已开启但服务不可用 |
| `collection_status` / `sampled_at` | `ok`、`disabled` 或 `unavailable`；最后实际采样时间。不可用时可能保留旧快照，不能当作当前正常数据 |
| `worker_started_at` / `worker_restarts_total` | 当前 Worker 起点 / 本 collector 生命周期内的重新启动次数 |
| `rules.configured` / `rules.config_valid` | 最后一次合法文档的规则总数（含其他平台）/ 当前缓存能否合法读取 |
| `rules.effective` | 当前平台实际可执行的托管规则数 |
| `rules.pattern`、`regex`、`substring`、`script`、`audit`、`enforce` | 当前可执行规则的类型、执行方式计数 |
| `rules.pending_scripts` / `rules.unsupported_http` | 当前平台等待脚本正文的规则数 / 配置中暂不支持的 HTTP 规则数 |
| `activity.evaluations_total`、`blocked_total`、`matched_total`、`audit_hits_total` | 完成判定、拦截、命中请求、审计规则命中次数；一次请求可以命中多条审计规则 |
| `activity.fail_open_total` / `evaluation_errors_total` | 降级放行次数 / 判定抛出异常次数。正常停机取消也计入降级次数，不产生故障告警 |
| `activity.duration_ms_total`、`duration_ms_avg`、`duration_ms_max` | 完整托管规则判定的总耗时、平均值和最大值，不包含 HTTP 读取、网络和结果写出 |
| `activity.duration_ms_p95_upper` / `duration_over_3500ms_total` | 固定直方图的 P95 桶上界 / 超过 3500ms 的判定次数 |
| `diagnostics` | Worker 中各固定诊断 code 的实际发生次数，包含被告警冷却抑制的重复事件 |

规则数量不要求相加相等：等待新版脚本时，旧版规则仍可继续生效。

activity、耗时及 diagnostics 都是当前 Worker 生命周期内的累计值，热更新规则不重置，Worker 重启会重置；
按 `worker_started_at` 区分起点，不能跨 Worker 直接相减。无判定时平均、最大和 P95 为 null；
P95 落入超过 3500ms 的溢出桶时也为 null，可结合溢出计数识别。有限桶上界为
1、5、10、25、50、100、200、500、1000、3500ms，P95 是近似上界。

status 采样只读取 Worker 内存，不扫描日志、配置正文或发送逐请求统计消息；
并发采样合并为一个请求，最多等待 2 秒，失败不阻止基础 status 输出。正常退出会保留最终快照。
禁用时或尚无可用 Worker 快照时，rules/activity/diagnostics 为 null。统计不包含 prompt、正文、规则 ID 或凭证。

## Qoder 协议

### Worker 与采集线程

HTTP 监听、规则引擎、规则热加载、runtime 心跳和裁决 checkpoint 都由 Worker 持有。主线程只负责生命周期管理、部署 hook，以及采集上报。两者共享 collector PID，但不共享普通 Map 对象。

Worker 判定工具调用后，通过 `parentPort.postMessage()` 发送包含原始 `recordedAt` 的裁决，主线程合并进镜像缓存；HTTP 响应不等待主线程处理或确认。裁决与上报共用有界、按序的异步批次，每批最多 128 项，最多一批未确认，其余裁决按调用 ID 合并。被拦截提示词最多暂存 8 条，溢出写运维警告。同步屏障覆盖调用前已经接受的裁决和被拦截提示词；采集侧仅处理受支持 Agent 的工具事件时等待该屏障（2 秒超时），超时沿用已到达的缓存。该屏障不会进入 HTTP 判定路径。

主线程还设有独立的有限上报队列：最多等待 256 条、总计 8MiB，最多一个异步消费任务执行；每个任务等待真实 git enrichment / flusher Promise 完成后才启动下一个。ACK 表示队列已有限接收或明确计数丢弃，不表示外发已完成；镜像屏障不等待外部 I/O，显式 `flushEvents()` 可等待已接收的外发任务。关闭 Worker 后、关闭 flusher 前，服务会等待该队列排空，最长 5 秒；超时取消消费信号、丢弃尚未启动项并记录未完成数量。迟到的 git enrichment 在取消后不会继续发送；无法取消的外部 sink 会记录未完成，不能据此声称数据已持久化。队列满或字节超限会记录累计丢弃数量，不启动无界 Promise。被拦截提示词在替换身份之前执行 workspace 隐私过滤，继承原生 session / agent 的粘性排除结果。

访问日志在有界异步队列中按顺序脱敏和写盘，不在 HTTP 回调里同步写文件。队列满时跳过多余日志，并追加 `event=audit-overflow` 的丢弃计数；服务停止会排空已接受的日志。规则本身的扫描 CPU、大请求序列化和机器 CPU/磁盘竞争仍可能影响 Worker，因此隔离线程不能保证固定响应时间。

Worker 异常退出时，collector 清掉失效的 interceptor runtime，按 1 秒至 30 秒退避重启，并使用主线程镜像与 checkpoint 恢复裁决。恢复前 hook 连接失败继续 fail-open；主线程阻塞时重启和消息处理要等它恢复。Unix sh 规则由一次性 Node guardian 持有进程组，Worker 与 guardian 之间的私有 fd3 管道关闭或独立期限到达时，guardian 回收自己的整组；因此即使脚本 shell 提前退出、后台子进程仍持有 stdout，也能在 Worker 退出后回收。正常完成码通过该管道回传，不改变脚本判定语义；每次 sh 调用会增加一次 Node 启动开销。子进程的启动/关闭控制消息用于父线程兜底清理，父线程只在异步核对仍属本 collector 且命令匹配后回收进程/进程组。此控制流不属于裁决主体批次的背压范围。正常停止先关闭监听、排空请求，再最终落盘并同步镜像；停不下来的 Worker 有超时 terminate 兜底。collector 整个进程退出或进程级内存耗尽时，Worker 也会退出。

CLI 识别 `qoder-auto`，通过祖先进程链区分 Desktop（`qoder`）和 CLI（`qodercli`）。首版覆盖 `UserPromptSubmit`、`PreToolUse` 与 `PostToolUse`。

Qoder CN 通过 `agents.d/qoder-cn.json` 向 `~/.qoder-cn/settings.json` 部署独立拦截 hook，原有采集 hook 保留。CN hook 使用 `--agent qoder-cn-auto`，优先采用宿主 `parent_business_info.product=cli/app`，其次识别 `LOONGSUITE_QODERCLI_FLAVOR=qoderclicn` 和祖先进程：Desktop 为 `qoder-cn`，CLI 为 `qoderclicn`，分别使用下表的 `block` / `deny` 协议；无法识别时按 CN Desktop 处理。托管规则配置 `"agents": ["qoder-cn", "qoderclicn"]` 可覆盖两端。两端的采集事件、被拦提示词和提示词裁决关联均保持 `gen_ai.agent.type=qoder-cn`，不归入国际版或 `qoder-app`。关闭拦截时只移除拦截 hook，保留采集。

拦截时 stdout 必须是单一 JSON 行：

| 运行面 | 事件 | stdout |
|--------|------|--------|
| Desktop | `UserPromptSubmit` | `{"decision":"block","reason":"..."}` |
| CLI | `UserPromptSubmit` | `{"decision":"deny","reason":"..."}` |
| 两者 | `PreToolUse` | `hookSpecificOutput.hookEventName="PreToolUse"`，`permissionDecision="deny"`，`permissionDecisionReason` |
| 两者 | `PostToolUse` | `hookSpecificOutput.hookEventName="PostToolUse"`，`updatedToolOutput` |

规则返回的 `reason` 原样保留。CLI 在写给宿主前按事件包装：

| 事件 | 宿主看到的 reason |
|------|-------------------|
| `UserPromptSubmit` | `检测到敏感信息：{rule reason}，本轮对话终止` |
| `PreToolUse` | `检测到非预期行为：{rule reason}，本次工具调用终止，且不允许通过其它手段重新发起直接或间接调用。` |
| `PostToolUse` | `检测到非预期行为：{rule reason}，本次工具调用结果已拦截，且不允许通过其它手段重新发起直接或间接调用。` |

规则未给 reason 时省略中间细节，例如 `检测到敏感信息，本轮对话终止`。

`PostToolUse` 发生在工具已经执行之后，拦不住已发生的副作用；拦截是替换回给模型的工具结果。Desktop 对 PostToolUse 的强制力弱于 CLI。

正常放行和仅 `log` 命中时 `exit 0` 且 stdout 为空，不提示宿主。未知事件、runtime 缺失、daemon 不健康、超时、坏响应、规则抛错继续 **fail-open**。每次判定通过异步队列写一行 JSONL 到 `~/.loongsuite-pilot/interceptor/logs/access.log`，包含 `event`、`input`、`result`；托管规则的 `result.matches` 保留所有已发生的命中。`log` 命中不等于失败放行，只有发生检查错误才设置 `failOpen`。运维日志仍在 `interceptor/logs/interceptor.log`。

Qoder hook timeout 为 `UserPromptSubmit` 15 秒，`PreToolUse` / `PostToolUse` 10 秒。CLI 先进行健康检查，默认超时 500ms，再发送判定请求，超时 4 秒。两次请求串行，合计预算约 4.5 秒，另需计入 hook 进程启动及调度耗时。健康检查超时会记录 fail-open 并直接放行。

## 千问办公（QwenWork）协议

[千问办公企业 Hooks](https://help.aliyun.com/zh/qwenwork/hooks)

三个拦截点与 Qoder 相同：`UserPromptSubmit`、`PreToolUse`、`PostToolUse`。采集仍只装 `Stop`（`qwenworkcn-loongsuite-pilot-hook`）。拦截是 `agents.d/qwen-work-cn.json` 里独立的 `hook.interceptor`，写入 `~/.qwenworkcn/settings.json` 的 nested `type:command`（本机已验证可用）。

官方企业控制台只接受 `type:http`。本机部署**不**把 HTTP hook 写进 settings；企业管理员若要把控制台 URL 指到本机 daemon，使用 `POST http://127.0.0.1:<port>/v1/hooks/qwenwork`（默认端口 18791，以 `runtime.json` 为准）。

请求体与 Qoder 相同：snake_case 的 `hook_event_name` / `event`、`prompt`、`tool_name`、`tool_input`、`tool_response`。CLI `--agent qwen-work-cn`。

拦截时的控制 JSON（command-hook stdout 与 HTTP 响应体同一套）：

| 事件 | 控制 JSON |
|------|-----------|
| `UserPromptSubmit` | `{"decision":"block","reason":"..."}`（没有 CLI `deny`） |
| `PreToolUse` | `hookSpecificOutput.permissionDecision="deny"` + `permissionDecisionReason` |
| `PostToolUse` | `hookSpecificOutput.updatedToolOutput`。官方文档写明 `decision:"block"` **不保证**屏蔽原始工具结果，所以不用 `decision:block` |

规则 reason 的中文包装与 Qoder 相同，在 QwenWork adapter 内完成（不要在 CLI 再包一层）。

fail-open：

- 本地 command hook：与 Qoder 相同，`exit 0` + 空 stdout
- 企业 HTTP：官方约定 **HTTP 2xx + 非法 JSON 会 fail-close PreToolUse**。因此 `/v1/hooks/qwenwork` 在非法 JSON、不支持的事件、规则抛错、放行时一律返回 **HTTP 200 `{}`**，拦截时也是 200 + 控制 JSON。不要对该路径回 4xx/5xx。

Hook timeout 与 Qoder 相同：`UserPromptSubmit` 15 秒，工具事件 10 秒。

## WorkBuddy 协议

启用拦截后，Pilot 在 `~/.workbuddy/settings.json` 部署独立的 command hook，通过 `interceptor-hook.sh` / `.ps1` 调用 `--agent workbuddy`。工具事件沿用 WorkBuddy 的正则 matcher `.*`。规则配置使用 `"agents": ["workbuddy"]`。

- `UserPromptSubmit` 命中时返回 `continue: false` 与 `stopReason`，终止当前提示词请求。
- `PreToolUse` 命中时返回 `hookSpecificOutput.permissionDecision: "deny"` 与 `permissionDecisionReason`，阻止本次工具调用。
- `PostToolUse` 命中时返回 `hookSpecificOutput.updatedToolOutput`，替换发给模型的工具结果。此时工具已经执行。

放行、规则执行失败或 Worker 不可用时，hook 以状态码 0 退出且 stdout 为空。关闭拦截后，部署流程会移除这三条拦截 hook。匹配到 session 与调用 ID 的工具采集事件会附带 `gen_ai.guardrail.*` 裁决。

[腾讯云 Hook 配置参考](https://cloud.tencent.com/document/product/1831/137030)

## OpenClaw 协议

OpenClaw 是 `plugin-inject`，不能安装第二条 `interceptor-hook.sh`。拦截判定复用采集插件，只覆盖现代 adapter（OpenClaw ≥ 2026.5.12）。3.8 legacy 路径保持 sync/void，不拦截。

| OpenClaw hook | 对应 interceptor 事件 | 拦截信号 |
|---------------|----------------------|----------|
| `before_agent_run` | `UserPromptSubmit` | `{ outcome: "block", reason, message }`。`reason` 是规则原因（如 `[PATTERN_BLOCKED]`），`message` 是包装后的用户可见文本 |
| `before_tool_call` | `PreToolUse` | `{ block: true, blockReason }` |
| `registerAgentToolResultMiddleware` | `PostToolUse` | `{ result }`，替换**当前回合**回给模型的工具结果。可 await，走进程内 HTTP。宿主没有该 API 或拒绝 installed 插件注册时静默跳过 |
| `tool_result_persist` | `PostToolUse` | `{ message }`，只改 session transcript 落盘。该 hook 必须同步，因此走 `interceptor-cli hook --agent openclaw` 的 spawnSync；与 middleware 按 `toolCallId` 短缓存共用判定 |

`tool_result_persist` **不能**当成 Qoder `updatedToolOutput`：它不改当前 ReAct 循环里模型正在看的那份结果。没有 middleware API 的 OpenClaw 上，PostToolUse 当轮拦截不可用，落盘仍可替换。Codex-native 工具记录 middleware 也改不到模型。

daemon 请求超时仍是 4 秒。`before_tool_call` 在 OpenClaw 上超时会 **fail-closed**，所以插件在 4 秒内 abort 并 fail-open，避免落到宿主 15 秒默认超时。interceptor runtime 缺失时静默放行，不写 access.log（采集插件始终在跑，不能把「未启用拦截」当成失败刷屏）。middleware 抛错或返回非法 shape 会被宿主 fail-closed 成 failure 结果，所以拦截失败必须 `return undefined`，不要 throw。

规则 reason 的中文包装与 Qoder 相同。CLI `--agent openclaw` 用于同步 persist 路径和单测。

商业版同步与是否加云端策略，见 [OpenClaw 拦截适配说明](interceptor-openclaw.md)。

## 规则开关

拦截开关只有 `all` 和 `none`。`all` 开启已配置的本地文件规则。`custom` 不再是拦截模式，按 `none` 处理。

安装参数：

```bash
bash /tmp/loongsuite-pilot-installer.sh install --interceptor-mode all
```

Windows 对应 `-InterceptorMode`。`--interceptor-mode all` 会绑定回环端口并写入拦截 hook。仅 `all` 开启拦截。不传、`none` 或其他值均关闭整个拦截功能，不创建拦截 Worker、不监听端口、不加载或执行本地文件规则，也不部署拦截 hook。

开启拦截时，安装器和运行时配置加载都会确保 `mask` 覆盖 `cloudAccessKey`、`apiKey`、`privateKey`、`databaseUrl`。`mask.mode=all` 不变；其他模式转为 `custom`，并入已有自定义类型、去重且保留替换格式。环境变量覆盖和手动修改配置同样受此保护，不依赖是否命中拦截规则。访问日志继续对凭证脱敏。

配置文件：

```json
{
  "interceptor": {
    "mode": "all"
  }
}
```

等价环境变量：

```bash
export LOONGSUITE_PILOT_INTERCEPTOR_MODE=all
```

| 模式 | 行为 |
|------|------|
| `none` | 关闭全部拦截，包括缓存的托管规则；不创建 Worker、不监听端口、不加载本地文件规则。未配置或其他值均按此模式处理。 |
| `all` | 开启已配置的本地文件规则，并绑定回环端口；没有可执行规则时放行。 |

只有启动时生效的 `mode` 严格等于 `all` 才开启拦截。其他值均关闭，collector 会清掉 `interceptor/runtime.json`，`status` 显示 `interceptor: stopped`。已部署的拦截 hook 会在下一次 collector 启动或 deploy 时卸掉；本地托管规则缓存保留，供下次开启时使用，但不会自行启动服务或执行。采集 hook 不变。修改 `config.json` 的 `mode` 后需要重启 collector；已开启状态下，托管规则仍支持热更新。端口被占用时改绑随机端口，实际端口写入 runtime。

内置敏感信息拦截规则已移除。没有可执行的托管规则时，即使输入包含密钥、私钥或数据库连接串也会放行。需要拦截或记录这些内容时，请在下述本地文件中配置 pattern 或 script 规则。

## 本地文件规则

在 `<dataDir>/configs/managed/interceptor.json` 写入规则。目录名 `managed` 是本地格式约定；本地引擎不依赖远端配置服务。先写好脚本正文，再原子替换规则文件。仅启动配置 `interceptor.mode=all` 时加载规则。

```json
{
  "interceptor": {
    "rules": [
      {
        "kind": "pattern",
        "id": "command-preview",
        "version": "1",
        "agents": ["qoder", "qodercli"],
        "events": ["UserPromptSubmit", "PreToolUse", "PostToolUse"],
        "action": "log",
        "match": "substring",
        "keywords": ["RULE_PROBE", "SECOND_PROBE"],
        "title": "命令规则预览",
        "message": "操作命中本地规则"
      },
      {
        "kind": "script",
        "id": "command-policy-sh",
        "version": "1",
        "agents": ["qoder", "qodercli"],
        "events": ["PreToolUse"],
        "shell": "sh",
        "action": "block",
        "message": "操作不符合本地规则"
      }
    ]
  }
}
```

每条规则的 `id` 在列表内唯一，`id` 和 `version` 只允许 ASCII 字母、数字、点、下划线和连字符。`agents` 和 `events` 必须是非空数组。

文档顶层、`interceptor` 和各条规则中的未知字段直接忽略，不参与执行、不保留到归一化后的本地配置，也不因这些扩展字段报错。已知字段仍校验类型、必填值与取值范围；未知 `kind` 或不支持的 agent/event 等属于已知字段的非法值，仍拒绝本次配置并保留上一份有效配置。

| 字段 | 取值 |
|------|------|
| `agents` | `qoder`、`qodercli`、`qoder-cn`、`qoderclicn`、`openclaw`、`qwen-work-cn`、`workbuddy` |
| `events` | `UserPromptSubmit`、`PreToolUse`、`PostToolUse` |
| `action` | 默认 `block`，命中后拦截并停止；`log` 记录命中后放行，继续检查后续规则，不提示宿主 |
| `severity` | 可选风险等级字符串，仅用于本地诊断，不上报到采集事件 |
| `kind` | `pattern`、`script`；`http` 仅保留格式占位，记录警告并跳过，不发请求 |
| `match` | pattern 规则的 `substring` 或 `regex` |
| `keywords` | `substring` 必填：非空字符串列表，每项不能为空且最多 2000 字符；任一项命中即可，区分大小写并保留空格 |
| `pattern` | `regex` 必填的字符串，最多 2000 字符；`substring` 忽略此字段 |
| `shell` | script 规则的 `sh` 或 `powershell`，本机仅执行平台匹配的脚本 |

规则固定按用户输入、工具名、工具输入、工具输出的顺序合并文本；对象递归提取字符串、数字和布尔叶子。`raw`、会话等元数据及规则的 title/message 不参与匹配。旧 `fields` 键兼容接受并忽略，不能缩小范围。

子串仅读取 `keywords`，采用区分大小写的字面匹配；旧子串配置需将 `pattern` 的值迁移为单元素 `keywords` 数组。每代规则加载时将各条子串规则的关键词转义后组合为正则分块：小列表仍为单个正则，每块内部最多 2000 个源字符；单个关键词转义后超过此预算时，在 Worker 内对该项做字面扫描。此执行计划不新增列表大小限制。正则规则使用 JavaScript RegExp 语法并拒绝前瞻和后顾。两种匹配都在同一独立 Worker 中执行，每条规则默认 200ms 预算，包括排队、编译和线程启动时间，并受单次请求 3.5 秒共享预算约束；同一条规则的全部分块和字面扫描在单个任务内共享一次预算，不按分块重置。Worker 使用有界缓存复用已编译的表达式。超时终止线程，确认退出后按需重建。终止失败时告警并停止后续 pattern 检查，重启 collector 恢复。pattern 命中原因为 `[PATTERN_BLOCKED]`。

### 正则与接口转义

`pattern` 保存正则源文本，不包含 `/.../` 分隔符。配置生成端先构造对象，再用 `JSON.stringify`（或对应语言的 JSON 序列化库）编码整个配置，不手工替换反斜杠。例如正则源文本 `\.aliyun/config\.json` 在配置 JSON 中应写成：

```json
"pattern": "\\.aliyun/config\\.json"
```

本地落盘使用 `JSON.stringify` 编码配置，读取时用 `JSON.parse` 还原，随后将得到的 `pattern` 原样交给 `RegExp`。每次读写成对处理，正则源文本保持不变。

若其他接口把配置 JSON 文档再放进外层 JSON 的字符串字段，外层序列化会再增加一层转义，这是正常的。读取方先解析外层响应，仅当协议定义 `content` 为 JSON 文档字符串时再解析该字段。调试时区分实际字段内容与日志中 `JSON.stringify` 后的展示，不能只数日志里的反斜杠。

不要对 `pattern` 再做 `JSON.parse`、全局反斜杠替换或循环反转义。`\s`、`\b`、Windows 路径及匹配字面量 `\n` 的正则都有各自语义，客户端无法可靠猜测多出的反斜杠是传输问题还是作者本意。配置字段已被过度转义时，应修正生成端；不合法 JSON（例如 `\_`）同样需要在生成端修正，下划线无需转义。

### 脚本文件与缓存格式

默认脚本路径为 `configs/managed/scripts/<id>@<version>.sh` 或 `.ps1`。上例需先写入 `configs/managed/scripts/command-policy-sh@1.sh`：

```sh
#!/bin/sh
cat >/dev/null
printf '%s\n' '{"matched":false}'
```

脚本 stdin 为一个 JSON 对象 `{"prompt":"<完整合并文本>"}`。stdout 必须恰好一行 `{"matched":false}` 或 `{"matched":true,"reason":"..."}`，退出码应为 0。返回非法内容、非零退出或超时将跳过该条，继续检查，保留此前已知 log 命中。所有文件规则共享 3.5 秒预算，耗尽后停止后续检查并 fail-open。log 脚本实际运行，具有相同执行开销和副作用。

macOS/Linux 使用 `sh <file>`，由一次性 Node guardian 持有进程组，并在私有租约断开或超时后回收后台进程。Windows 最多预热两个 PowerShell 执行器，使用进程级 `ExecutionPolicy Bypass`，创建时即原子加入 kill-on-close Job Object。每次请求结束后整体回收执行器及其原生后代，再补充预热容量；成功、超时、停止和崩溃均执行回收。私有租约与 guardian 独立期限同时覆盖 interceptor Worker 退出，确认进程树清理后才替换执行器；启动和清理时间都计入请求预算。输入的非 ASCII 字符转义为 `\uXXXX`，脚本可用 `ConvertFrom-Json` 读取。原生 Job 能力需要 Windows 10 / Server 2016 或更新系统；CLM/WDAC 禁止初始化时，在用户脚本运行前以 `Windows Job Object unavailable` 明确 fail-open，绝不降级到无所有权的执行器。仅传入 PATH、HOME、TEMP 等受限环境变量。脚本按 collector 所属用户权限运行，不提供操作系统沙箱；委托给服务或 WMI 创建的进程不属于原生子进程所有权范围。

PowerShell 5.1 的 `.ps1` 正文含非 ASCII 字符时，应使用带 BOM 的 UTF-8 编码。stdin 请求的 JSON 转义只保护请求内容，不会改变 PowerShell 对脚本文件自身的解码方式。

Windows 启动器不继承 `PSModulePath`，由 PowerShell 5.1 重建自身模块路径，避免从 PowerShell 7 经 Node 启动 collector 时加载错误版本的模块。启动命令显式导入 `$PSHOME` 下的系统模块清单，避免启动时扫描无关模块。参见 [微软模块路径说明](https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_psmodulepath#starting-windows-powershell-from-powershell-7)。

本地文档还接受可选的 `interceptor.scriptCache`：64 位小写十六进制字符串，用于选择 `configs/managed/scripts/<scriptCache>/` 命名空间。不设置时使用根目录。生成命名空间的配置提供方需先放齐该目录的所有脚本，再发布规则文档。本地执行器只校验格式和路径，不解释命名空间的来源。

每 3 秒检查本地文件，内容变化后生成新引擎。加载时检查普通文件和真实路径，每次执行前再次拒绝符号链接。新脚本未就绪或规则文件不合法时保留可执行的上一代，并记录日志。进行中的请求持有发起时的引擎和执行器；最后一个请求结束后释放旧执行器。改为纯 pattern 或清空规则同样回收脚本资源。

### 判定与采集事件

按文件中的数组顺序执行规则。响应的 `matches` 保留全部已发生的 log 与 block 命中。顶层元数据代表最终 block 拦截规则，或放行时的首条 log 命中。完整检查无命中才有 `matched=false`；检查失败且没有已知命中时省略 matched。log 命中后发生错误可同时有 `matched=true` 和 `failOpen=true`。

规则命中不再单独上报 `guardrail.evaluation`。工具事件通过 `gen_ai.guardrail.*` 关联最终裁决；放行的提示词回填到该轮首个原生 `llm.request`，后续工具续轮不重复标注提示词裁决；被拦截的 Qoder 用户提示仍补报 `llm.request`。逐条 log / block 命中保留在 HTTP 响应和本地 access log 的 `matches` 中。

采集事件不再上报规则的 `reason`、`message`、`matched`、`enforcement`、`title`、`severity` 和 `match`。保留 `rule_id`、`rule_version`；`gen_ai.guardrail.action` 为 `block`（强制拦截）、`log`（log 命中但放行）或 `allow`（其余已知裁决）。`triggered=true` 仍表示存在检查裁决，不等于命中。规则文案仍可用于宿主阻断诊断和本地 access log。

规则命中使用文件中配置的 ID 和版本，覆盖提示词补报和工具事件关联。

采集事件的 action 描述最终代表裁决。例如先命中 log、再命中 block，上报 `block`；仅 log 命中上报 `log`。HTTP 响应仍使用 `allow` / `block` 控制宿主行为。UserPromptSubmit log 在原生请求上报 `gen_ai.guardrail.action: "log"`，不新增请求事件；Qoder block 拦截仍补发 `llm.request`。关联发生在消息内容隐私处理之前，内部关联摘要在输出前移除，因此关闭消息内容采集时仍可关联。

Hook 的 `parent_business_info.product=app` 时，Qoder 被拒 Prompt 使用 `qoder-app` 身份。输出前沿用原生 agent/session 的工作区排除状态，App 与 CLI 即使 session id 相同也分别匹配隐私状态。

### 提示词关联与 Agent 身份

拦截协议的 `agent` 是规则和宿主协议的路由标识，Qoder 使用 `qoder` / `qodercli`；它与事件的 `gen_ai.agent.type` 不要求逐字相同。原生采集根据当前提示词的 `businessIdentity.product` 或该轮 Hook 上下文识别产品，App 保留 `qoder-app`，CLI 保留 `qoder-cli`。拦截记录缺少产品信息时，不把路由 `qoder` 当作已证明的 IDE 身份来排除 App；已明确的 App 与 CLI 身份仍不能相互借用裁决。

提示词关联使用 session、提示词 SHA-256 摘要及请求身份。有可比较的请求 ID 时优先精确匹配；原生 `requestSetId` 和 Hook `request_set_id` 均只传递 SHA-256 摘要，私有关联字段在输出前移除，不改写 `gen_ai.request.id`。两侧都有明确 ID 且不相同时，不回退到其他请求。

新收到的 Qoder Hook 缺少请求 ID 时，缓存会显式记录缺失来源；原生事件即使有 ID，也只能在同 session、兼容产品、同提示词摘要、原生提示词时间前后 5 秒内寻找唯一候选。旧记录不会仅因 ID 看起来像 UUID 就被视为缺失身份。规则执行前登记的检查中、失败和阻断尝试也参与歧义判断。首次成功关联后，匿名裁决绑定到该原生请求，重复输出可重用，其他请求不能复用；绑定通过 IPC 回传唯一写入者并随 checkpoint 恢复。存在歧义时不回填。

正常停机时，collector 先确认所有 Worker 写入者已经退出并排空已接收输出，再独占接管 checkpoint。镜像含提示词绑定时，会异步读取最新磁盘记录、合并镜像并原子保存，保留旧 Worker 已落盘而镜像尚未收到的记录，也覆盖 Worker 崩溃后、重启前才创建的绑定。未确认 Worker 退出时禁止接管；读取、校验或写入失败会使停机操作报错，不会静默丢弃绑定。

如果提示词在提交前被阻止，且 Hook 未提供产品信息，就没有原生提示词或后续 Stop 上下文可用于证明 App/CLI。此时合成阻断事件仍使用既有 `qoder-cli` 回退类型，不能据此认定具体产品；明确 `product=app` 时才使用 `qoder-app`。

### 升级与回退

旧 `interceptor.mode=custom` 升级后按 `none` 处理，整个拦截功能关闭。启用已配置的规则需在重启 collector 前显式改为 `all`；不再支持 `--interceptor-types` 或对应环境变量。mask 仍支持 custom 模式，开启拦截时自动补齐凭证脱敏类型。

规则只接受 `action: block/log`，默认 `block`，不接受旧 `enforcement` 字段。非法规则文档会被拒绝，并保留上一份可执行配置。

## 服务生命周期

Interceptor HTTP 属于 collector 生命周期，不注册独立的 launchd / systemd / init.d / 计划任务。

`status` 在 collector 正在运行，且 `interceptor/runtime.json` 的 `status=ok` 时，显示 `interceptor: running`。监听失败或 collector 未运行时显示 `interceptor: stopped`。

运维命令：

```bash
loongsuite-pilot start     # 启动 collector（拦截 HTTP 在同一进程内）
loongsuite-pilot status
loongsuite-pilot restart   # 重新加载拦截配置
```

CLI 不会自行拉起 HTTP 服务。runtime 缺失或连不上时立即 fail-open。`stop` / 卸载停掉 collector，拦截 HTTP 一起退出。

## 新增 AgentAdapter / 规则

1. 在 `src/interceptor/adapters/` 增加 adapter：解析宿主 stdin、渲染该宿主的 block JSON。
2. 如需自动识别运行面，扩展 CLI `--agent` 与 surface 解析。
3. 将新 Agent / 事件接入托管规则的配置校验与匹配，再通过本地文件配置 pattern 或 script 规则。
4. Hook 型 Agent：在对应 `agents.d/*.json` 增加独立的 `hook.interceptor` 声明（events、command、timeout、`insert: "head"`），不要改采集 `hookCommand`。插件型 Agent（如 OpenClaw）：在采集插件里对接同一 daemon，不要假装再装一条 command hook。
5. 补测试：开关、顺序、短路、该宿主的精确 stdout / 插件返回值、fail-open。

## 排障

| 现象 | 检查 |
|------|------|
| hook 总是放行 | `loongsuite-pilot status` 是否显示 interceptor running；`~/.loongsuite-pilot/interceptor/runtime.json` 是否新鲜；`interceptor/logs/access.log` 是否有对应 `event`/`result` |
| 看每次判定 | `~/.loongsuite-pilot/interceptor/logs/access.log`：`event`、`input`、`result.action`（`block` / `allow` / `fail-open`） |
| 想开启拦截 | `config.json` 里 `"interceptor": { "mode": "all" }` 后**重启 collector**，并配置托管规则。已有规则缓存不会自行开启服务，必须显式选择 all |
| stdout 被吃掉 | Windows 拦截 hook 禁止 `Out-Null`；不要复用采集 processor |
| 端口冲突 | daemon 优先绑定 `127.0.0.1:18791`，占用则改绑 `0` 并把实际端口写入 runtime |
