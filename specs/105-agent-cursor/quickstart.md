# Quickstart: Cursor Hook Agent

**Feature**: `105-agent-cursor`

## 1) 环境准备

```bash
nvm use 22
npm install --legacy-peer-deps
npm run typecheck
```

## 2) 配置 Cursor hooks

在你的 Cursor 生效配置里（项目级或用户级）确认目标事件均指向：

`/Users/<your-user>/.loongsuite-pilot/hooks/cursor-hook.sh`

如在仓库本地调试，可先使用项目内脚本路径进行验证，再切回安装路径。  
说明：该配置属于本机环境配置，通常不建议作为仓库必需文件提交。

若要让 `collector` 主程序消费这些 Cursor hook 日志并上报到 SLS/JSONL，请确认配置中的监听器开启：

```json
{
  "listeners": {
    "cursor-hook": { "enabled": true, "pollInterval": 60000 }
  }
}
```

## 3) 本地冒烟验证

```bash
export LOONGSUITE_PILOT_DATA_DIR="/tmp/loongsuite-pilot-cursor-hook-test"
rm -rf "$LOONGSUITE_PILOT_DATA_DIR"

printf '%s' '{"hook_event_name":"postToolUse","session_id":"sess-1","generation_id":"turn-1","model":"gpt-test","tool_name":"Shell","tool_input":{"command":"pwd"},"tool_output":"{\"ok\":true}","cursor_version":"1.0.0"}' \
  | bash "./assets/hooks/cursor-hook.sh"
```

预期：

- stdout 返回 `{}`  
- 生成文件：`/tmp/loongsuite-pilot-cursor-hook-test/logs/cursor-hook/history/cursor-YYYY-MM-DD.jsonl`  
- 文件中新增 1 行 JSON 记录，包含 `clientType=CursorHook`

## 4) 异常路径验证（Fail-Open）

```bash
printf '%s' 'not-json' | bash "./assets/hooks/cursor-hook.sh"
```

预期：

- stdout 返回 `{}`  
- 退出码为 0  
- 不阻塞调用流程

## 5) 关键核验点

- `hookEvent` 是否正确归一化  
- `session.id` 是否由 `session_id`/`conversation_id` 映射而来  
- `request.model`、`usage.*`、`input.messages_delta`、`output.messages` 是否符合统一 schema  
- 被消费源字段是否从 `data` 中移除  
- 未映射字段是否被保留  

## 6) 事件覆盖核验

在安装目录的 hooks 配置中核对关键事件是否绑定到同一命令（需显式传入本机配置路径）：

```bash
CURSOR_HOOKS_JSON="/absolute/path/to/your/effective/hooks.json" \
node -e 'const fs=require("fs");const p=process.env.CURSOR_HOOKS_JSON;if(!p){throw new Error("CURSOR_HOOKS_JSON is required");}const o=JSON.parse(fs.readFileSync(p,"utf8"));const keys=Object.keys(o.hooks||{});const expected=["preToolUse","postToolUse","postToolUseFailure","beforeShellExecution","afterShellExecution","beforeMCPExecution","afterMCPExecution","beforeReadFile","afterFileEdit","beforeSubmitPrompt","preCompact","stop","sessionStart","sessionEnd","subagentStart","subagentStop","afterAgentResponse","afterAgentThought","beforeTabFileRead","afterTabFileEdit"];const missing=expected.filter(k=>!keys.includes(k));console.log(JSON.stringify({count:keys.length,missing},null,2));'
```

预期：

- `missing` 为空数组  
- 所有事件命令指向同一个 `cursor-hook.sh`

## 7) 保留策略说明

- 正文类原始字段默认完整保留（不自动脱敏）  
- 保留天数策略可配置，默认 90 天  
- 具体清理执行任务在后续 `/speckit-tasks` 阶段实现

## 8) Input + SLS/JSONL 通路核验（扩展范围）

1. 确认 `config.json` 或环境变量中启用了 `listeners.cursor-hook`。  
2. 启动 collector 主程序（示例：`npm run dev` 或项目当前启动命令）。  
3. 触发一次 Cursor hook 写入（可复用第 3 节命令）。  
4. 核验 collector 输出：
   - 若启用 `jsonl` flusher：`logs/output/*.jsonl` 中出现 `agentType=cursor-hook` 相关记录；
   - 若启用 `sls` flusher：对应 endpoint 日志中出现同批次上报数据。

说明：本节用于验证“hook 落盘 -> CursorHookInput -> InputManager -> Flusher(SLS/JSONL)”闭环。
