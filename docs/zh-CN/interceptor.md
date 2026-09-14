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

- 源码：`src/interceptor/`
- 运行态：`~/.loongsuite-pilot/interceptor/{runtime.json,interceptor.pid,logs}`
- 构建产物：`dist/interceptor/cli.cjs`、`dist/interceptor/daemon.cjs`
- 规则开关：现有 `~/.loongsuite-pilot/config.json` 的扁平 `interceptor` 对象，daemon **启动时读一次**，不热加载

## Qoder 协议

CLI 识别 `qoder-auto`，通过祖先进程链区分 Desktop（`qoder`）和 CLI（`qodercli`）。首版覆盖 `UserPromptSubmit` 与 `PreToolUse`。

拦截时 stdout 必须是单一 JSON 行：

| 运行面 | 事件 | stdout |
|--------|------|--------|
| Desktop | `UserPromptSubmit` | `{"decision":"block","reason":"..."}` |
| CLI | `UserPromptSubmit` | `{"decision":"deny","reason":"..."}` |
| 两者 | `PreToolUse` | `hookSpecificOutput.hookEventName="PreToolUse"`，`permissionDecision="deny"`，`permissionDecisionReason` |

正常放行、未知事件、runtime 缺失、daemon 不健康、超时、坏响应、规则抛错一律 **fail-open**：`exit 0` 且 stdout 为空。诊断只写 interceptor 日志。

Qoder hook timeout：`UserPromptSubmit` 15 秒，`PreToolUse` 10 秒。CLI 请求 daemon 的超时是 4 秒。

## 规则开关

```json
{
  "interceptor": {
    "rule-id": true
  }
}
```

- 只有 `interceptor[rule.id] === true` 的已注册规则会执行
- 缺失、`false` 或未知 key 均 bypass
- 首版注册表为空，因此默认全部放行
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
4. 在对应 `agents.d/*.json` 增加独立的 `hook.interceptor` 声明（events、command、timeout、`insert: "head"`），不要改采集 `hookCommand`。
5. 补测试：开关、顺序、短路、该宿主的精确 stdout、fail-open。

## 排障

| 现象 | 检查 |
|------|------|
| hook 总是放行 | `loongsuite-pilot status` 是否显示 interceptor running；`~/.loongsuite-pilot/interceptor/runtime.json` 是否新鲜 |
| 想打开某条规则 | 确认 `config.json` 里 `"interceptor": { "<id>": true }` 后**重启 interceptor** |
| stdout 被吃掉 | Windows 拦截 hook 禁止 `Out-Null`；不要复用采集 processor |
| 端口冲突 | daemon 优先绑定 `127.0.0.1:18791`，占用则改绑 `0` 并把实际端口写入 runtime |
