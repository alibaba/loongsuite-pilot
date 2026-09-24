# 本地拦截模块

[Qoder CLI Hooks Reference](https://docs.qoder.com/cli/hooks-reference) · [Qoder Hooks](https://docs.qoder.com/extensions/hooks) · [请求与响应协议](interceptor-protocol.md)

Interceptor 的 HTTP 服务跑在 collector 进程里，随 collector 启动和退出。Hook CLI 仍是 IDE 拉起的短进程，通过 loopback HTTP 访问 collector。它不依赖第一次 hook 触发。

现有 Qoder / 千问办公 transcript 采集 hook 保持独立，拦截判定走第二条 hook。

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
- 工具判定：collector 进程内按 `session id + tool call id + phase` 保存最近 30 分钟，checkpoint 为 `~/.loongsuite-pilot/interceptor/tool-verdicts.json`（详见 [请求与响应协议](interceptor-protocol.md#tool-判定与-transcript-关联)）
- 构建产物：`dist/interceptor/cli.cjs`、`dist/interceptor/daemon.cjs`
- 规则开关：`config.json` 的 `interceptor` 对象与 `mask` 相同（`mode` + `types`），collector **启动时读一次**，不热加载

## Qoder 协议

CLI 识别 `qoder-auto`，通过祖先进程链区分 Desktop（`qoder`）和 CLI（`qodercli`）。首版覆盖 `UserPromptSubmit`、`PreToolUse` 与 `PostToolUse`。

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

正常放行、未知事件、runtime 缺失、daemon 不健康、超时、坏响应、规则抛错一律 **fail-open**：`exit 0` 且 stdout 为空。每次判定（拦截 / 放行 / fail-open）写一行 JSONL 到 `~/.loongsuite-pilot/interceptor/logs/access.log`，至少包含 `event`（hook 类型）、`input`（请求输入）、`result`（判定结果）。运维日志仍在 `interceptor/logs/interceptor.log`。

Qoder hook timeout：`UserPromptSubmit` 15 秒，`PreToolUse` / `PostToolUse` 10 秒。CLI 请求 daemon 的超时是 4 秒。

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

## OpenClaw 协议

OpenClaw 是 `plugin-inject`，不能安装第二条 `interceptor-hook.sh`。拦截判定复用采集插件，只覆盖现代 adapter（OpenClaw ≥ 2026.5.12）。3.8 legacy 路径保持 sync/void，不拦截。

| OpenClaw hook | 对应 interceptor 事件 | 拦截信号 |
|---------------|----------------------|----------|
| `before_agent_run` | `UserPromptSubmit` | `{ outcome: "block", reason, message }`。`reason` 是内部原因（如 `[APIKEY_MASKED]`），`message` 是包装后的用户可见文本 |
| `before_tool_call` | `PreToolUse` | `{ block: true, blockReason }` |
| `registerAgentToolResultMiddleware` | `PostToolUse` | `{ result }`，替换**当前回合**回给模型的工具结果。可 await，走进程内 HTTP。宿主没有该 API 或拒绝 installed 插件注册时静默跳过 |
| `tool_result_persist` | `PostToolUse` | `{ message }`，只改 session transcript 落盘。该 hook 必须同步，因此走 `interceptor-cli hook --agent openclaw` 的 spawnSync；与 middleware 按 `toolCallId` 短缓存共用判定 |

`tool_result_persist` **不能**当成 Qoder `updatedToolOutput`：它不改当前 ReAct 循环里模型正在看的那份结果。没有 middleware API 的 OpenClaw 上，PostToolUse 当轮拦截不可用，落盘仍可替换。Codex-native 工具记录 middleware 也改不到模型。

daemon 请求超时仍是 4 秒。`before_tool_call` 在 OpenClaw 上超时会 **fail-closed**，所以插件在 4 秒内 abort 并 fail-open，避免落到宿主 15 秒默认超时。interceptor runtime 缺失时静默放行，不写 access.log（采集插件始终在跑，不能把「未启用拦截」当成失败刷屏）。middleware 抛错或返回非法 shape 会被宿主 fail-closed 成 failure 结果，所以拦截失败必须 `return undefined`，不要 throw。

规则 reason 的中文包装与 Qoder 相同。CLI `--agent openclaw` 用于同步 persist 路径和单测。

商业版同步与是否加云端策略，见 [OpenClaw 拦截适配说明](interceptor-openclaw.md)。

## 规则开关

配置格式与 [数据脱敏](masking.md) 完全对齐：`mode` + `types`。区别只是 interceptor 的 `types` 是 mask 的密钥子集，不含 `idCard`、`phone`、`email`、`ipAddress`、`bankCard`。

安装参数：

```bash
bash /tmp/loongsuite-pilot-installer.sh install --interceptor-mode all
```

自定义模式安装参数：

```bash
bash /tmp/loongsuite-pilot-installer.sh install --interceptor-mode custom --interceptor-types apiKey,cloudAccessKey,privateKey,databaseUrl
```

Windows 对应 `-InterceptorMode` / `-InterceptorTypes`。

安装 interceptor 时，安装器会把已启用的拦截类型自动补进 `mask`：`mask.mode=all` 已覆盖全部类型则不动；否则写成 `custom`，并并入这些 type（`interceptor.mode=all` 会并入全部拦截类型）。这样被拦截的密钥在采集输出里也会被脱敏。

配置文件：

```json
{
  "interceptor": {
    "mode": "all"
  }
}
```

自定义模式：

```json
{
  "interceptor": {
    "mode": "custom",
    "types": ["apiKey", "cloudAccessKey", "privateKey", "databaseUrl"]
  }
}
```

等价环境变量：

```bash
export LOONGSUITE_PILOT_INTERCEPTOR_MODE=custom
export LOONGSUITE_PILOT_INTERCEPTOR_TYPES=apiKey,cloudAccessKey,privateKey,databaseUrl
```

| 模式 | 行为 |
|------|------|
| `none` | 不拦截。未配置 interceptor mode 时默认使用该模式。 |
| `all` | 开启全部 interceptor 类型（mask 的密钥子集）。 |
| `custom` | 只开启 `interceptor.types` 中列出、且属于 interceptor 子集的类型。未知或 PII 类型会被忽略。 |

| 类型 | 覆盖内容 |
|------|----------|
| `cloudAccessKey` | 阿里云、AWS、腾讯云风格的 Access Key ID。 |
| `apiKey` | OpenAI-compatible 和 GitHub 风格 API Key。 |
| `privateKey` | PEM 或 OpenSSH 私钥块。 |
| `databaseUrl` | 包含密码的数据库 URL。 |

敏感信息规则复用采集脱敏的 `src/mask/sensitive-rules.json`。命中时 interceptor reason 为对应替换 token：`cloudAccessKey` → `[ACCESSKEY_MASKED]`，`apiKey` → `[APIKEY_MASKED]`，`privateKey` → `[PRIVATEKEY_MASKED]`，`databaseUrl` → `[DATABASEURL_MASKED]`。与 `mask` 独立，默认关闭，修改后需重启 collector。

按注册顺序执行，首个拦截立即短路。规则抛错视为该次判定 fail-open。

后续新增规则：实现 `LocalRule`，加入 `src/interceptor/rules/registry.ts`，并把它登记到 `SUPPORTED_INTERCEPTOR_TYPES`（必须是已有 mask type 的子集）。

预留有序 evaluator / provider 接口给未来远程判定，首版不产生任何远程请求。

## 服务生命周期

Interceptor HTTP 属于 collector 生命周期，不注册独立的 launchd / systemd / init.d / 计划任务。

`interceptor/runtime.json` 里的 pid 是 collector 的 pid。`status` 在 collector 正在运行，且这份 runtime 的 pid、`status=ok` 与 collector 一致时，显示 interceptor running。

运维命令：

```bash
loongsuite-pilot start     # 启动 collector（拦截 HTTP 在同一进程内）
loongsuite-pilot status
loongsuite-pilot restart   # 重新加载拦截配置
```

CLI 不会自行拉起 HTTP 服务。runtime 缺失或连不上时立即 fail-open。`stop` / 卸载停掉 collector，拦截 HTTP 一起退出。

## 新增 AgentAdapter / LocalRule

1. 在 `src/interceptor/adapters/` 增加 adapter：解析宿主 stdin、渲染该宿主的 block JSON。
2. 如需自动识别运行面，扩展 CLI `--agent` 与 surface 解析。
3. 实现 `LocalRule` 并注册到 `builtinRules()`。
4. Hook 型 Agent：在对应 `agents.d/*.json` 增加独立的 `hook.interceptor` 声明（events、command、timeout、`insert: "head"`），不要改采集 `hookCommand`。插件型 Agent（如 OpenClaw）：在采集插件里对接同一 daemon，不要假装再装一条 command hook。
5. 补测试：开关、顺序、短路、该宿主的精确 stdout / 插件返回值、fail-open。

## 排障

| 现象 | 检查 |
|------|------|
| hook 总是放行 | `loongsuite-pilot status` 是否显示 interceptor running；`~/.loongsuite-pilot/interceptor/runtime.json` 是否新鲜；`interceptor/logs/access.log` 是否有对应 `event`/`result` |
| 看每次判定 | `~/.loongsuite-pilot/interceptor/logs/access.log`：`event`、`input`、`result.action`（`block` / `allow` / `fail-open`） |
| 想打开拦截 | 确认 `config.json` 里 `"interceptor": { "mode": "all" }`（或 `custom` + `types`）后**重启 collector** |
| stdout 被吃掉 | Windows 拦截 hook 禁止 `Out-Null`；不要复用采集 processor |
| 端口冲突 | daemon 优先绑定 `127.0.0.1:18791`，占用则改绑 `0` 并把实际端口写入 runtime |
