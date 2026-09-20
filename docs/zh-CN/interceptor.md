# 本地拦截模块

[Qoder CLI Hooks Reference](https://docs.qoder.com/cli/hooks-reference) · [Qoder Hooks](https://docs.qoder.com/extensions/hooks)

Interceptor 是 Pilot 的第三个同级服务，和 collector / updater 一样由 launchd、systemd 或 Windows Task Scheduler 在安装时启动并守护。它不依赖第一次 hook 触发，也不作为 collector 子进程。

现有 Qoder transcript 采集 hook 保持独立，拦截判定走第二条 hook。

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
共享 interceptor daemon（127.0.0.1）
        │
        ▼
顺序规则引擎（首个 block 短路）
```

OpenClaw 不走 stdin command hook：采集插件在进程内调用同一 daemon。

```
OpenClaw Gateway（≥ 2026.5.12）
        │ api.on(before_agent_run / before_tool_call / tool_result_persist)
        ▼
assets/plugins/openclaw/plugin.mjs
        │ 采集 JSONL 之后，进程内问 daemon（4s；runtime 缺失则静默 fail-open）
        ▼
共享 interceptor daemon（127.0.0.1）
        │
        ▼
{ outcome:"block" } / { block:true, blockReason } / { message }
```

- 源码：`src/interceptor/`
- 运行态：`~/.loongsuite-pilot/interceptor/{runtime.json,interceptor.pid,logs}`
- 访问日志：`~/.loongsuite-pilot/interceptor/logs/access.log`（每次 hook 判定一行 JSONL）
- 构建产物：`dist/interceptor/cli.cjs`、`dist/interceptor/daemon.cjs`
- 规则开关：现有 `~/.loongsuite-pilot/config.json` 的扁平 `interceptor` 对象，daemon **启动时读一次**，不热加载

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

## OpenClaw 协议

OpenClaw 是 `plugin-inject`，不能安装第二条 `interceptor-hook.sh`。拦截判定复用采集插件，只覆盖现代 adapter（OpenClaw ≥ 2026.5.12）。3.8 legacy 路径保持 sync/void，不拦截。

| OpenClaw hook | 对应 interceptor 事件 | 拦截信号 |
|---------------|----------------------|----------|
| `before_agent_run` | `UserPromptSubmit` | `{ outcome: "block", reason, message }`。`reason` 是内部原因（如 `[APIKEY_MASKED]`），`message` 是包装后的用户可见文本 |
| `before_tool_call` | `PreToolUse` | `{ block: true, blockReason }` |
| `tool_result_persist` | `PostToolUse` | `{ message }`，替换回写给模型的工具结果。该 hook 必须同步，因此走 `interceptor-cli hook --agent openclaw` 的 spawnSync |

daemon 请求超时仍是 4 秒。`before_tool_call` 在 OpenClaw 上超时会 **fail-closed**，所以插件在 4 秒内 abort 并 fail-open，避免落到宿主 15 秒默认超时。interceptor runtime 缺失时静默放行，不写 access.log（采集插件始终在跑，不能把「未启用拦截」当成失败刷屏）。

规则 reason 的中文包装与 Qoder 相同。CLI `--agent openclaw` 用于同步 persist 路径和单测。

## 规则开关

```json
{
  "interceptor": {
    "cloudAccessKey": true,
    "apiKey": true,
    "privateKey": true,
    "databaseUrl": true
  }
}
```

- 只有 `interceptor[rule.id] === true` 的已注册规则会执行
- 缺失、`false` 或未知 key 均 bypass
- 敏感信息规则复用采集脱敏的 `src/mask/sensitive-rules.json`，开关按 **type** 打开（不是子规则 id）。命中时 interceptor reason 为对应替换 token：`cloudAccessKey` → `[ACCESSKEY_MASKED]`，`apiKey` → `[APIKEY_MASKED]`，`privateKey` → `[PRIVATEKEY_MASKED]`，`databaseUrl` → `[DATABASEURL_MASKED]`。与 `mask.types` 独立，默认关闭，打开后需重启 interceptor
- 按注册顺序执行，首个拦截立即短路
- 规则抛错视为该次判定 fail-open

后续新增规则：实现 `LocalRule`，加入 `src/interceptor/rules/registry.ts`，然后在 `config.json` 里把同名 key 设为 `true`。

预留有序 evaluator / provider 接口给未来远程判定，首版不产生任何远程请求。

## 服务生命周期

Interceptor 与 collector 使用同一系统服务管理层级：

| 平台 | 单元 / 任务 | 重启策略 |
|------|-------------|----------|
| macOS | `com.loongsuite-pilot.interceptor` | launchd `KeepAlive` |
| Linux systemd | `loongsuite-pilot-interceptor.service` | `Restart=on-failure` |
| Linux init.d | `/etc/init.d/loongsuite-pilot-interceptor-<user>` | init.d |
| Windows | `LoongsuitePilotInterceptor-<tag>` | Task Scheduler 重复触发 + `RestartCount` |

运维命令：

```bash
loongsuite-pilot start              # 安装/启动三个同级服务
loongsuite-pilot status
loongsuite-pilot restart-interceptor
loongsuite-pilot start-interceptor
```

升级时 updater 在 `current` 指针切换后重启 collector 与 interceptor，并等待两者 heartbeat / 版本一致。CLI **不会**自行拉起 daemon；runtime 缺失或连不上立即 fail-open。

整体 `stop` / 卸载会同时停止并清理 interceptor。

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
| 想打开某条规则 | 确认 `config.json` 里 `"interceptor": { "<id>": true }` 后**重启 interceptor** |
| stdout 被吃掉 | Windows 拦截 hook 禁止 `Out-Null`；不要复用采集 processor |
| 端口冲突 | daemon 优先绑定 `127.0.0.1:18791`，占用则改绑 `0` 并把实际端口写入 runtime |
