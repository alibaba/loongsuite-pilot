# IDE E2E 测试说明

## 概述

IDE E2E 测试验证桌面 IDE 工具的数据采集链路：向 IDE 发送真实对话 → IDE 产生数据 → loongsuite-pilot 采集并写入 JSONL。

与 Docker/CLI E2E 不同，IDE 测试**必须在本地桌面环境运行**（需要 GUI 和运行中的 IDE 应用）。

## 支持的 IDE 工具

| 工具 | 通信协议 | 端口发现 | 前置条件 |
|------|----------|----------|----------|
| QoderWork | JSON-RPC (MCP) | `~/.qoderwork/mcp-adaptor.config` 读 url+token | 桌面端运行 + `jq` |
| Qoder IDE | CDP | 动态端口：进程扫描 + `DevToolsActivePort` fallback | 桌面端运行 + `python3 websockets` |
| Cursor | CDP | 固定端口（默认 9222，需手动配置） | 桌面端运行 + CDP 已开启 + `python3 websockets` |

## 快速开始

```bash
# 1. 确保 pilot 在运行
loongsuite-pilot status

# 2. 安装 python3 websockets（Qoder IDE / Cursor 需要）
pip3 install websockets

# 3. 运行测试（自动检测可用工具）
bash scripts/e2e/run-ide-e2e.sh

# 4. 只测试某个工具
IDE_E2E_TOOLS=cursor bash scripts/e2e/run-ide-e2e.sh
```

## 测试流程（run-ide-e2e.sh）

```
Phase 1  Preflight       检查 pilot、node、python3 websockets 等依赖
Phase 2  Probe           逐个探测 IDE 工具是否可用（--status）
Phase 3  Baseline        记录各工具 JSONL 文件的当前行数
Phase 4  Chat            遍历所有可用工具，发送测试消息并获取回复
Phase 5  Flush           等待 pilot 将数据写入 JSONL（最长 120s）
Phase 6  Reply Check     验证每个工具都收到了非空回复
Phase 7  JSONL Check     验证新增 JSONL 条目的必填字段完整性
Phase 8  Summary         汇总结果，全部通过则 exit 0
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `IDE_E2E_TOOLS` | 自动检测 | 逗号分隔：`qoderwork,cursor,qoder-ide` |
| `IDE_E2E_PROMPT` | `e2e-ide-test: explain what is 1+1...` | 自定义测试 prompt |
| `IDE_E2E_FLUSH_TIMEOUT` | `120` | 等待 pilot flush 的超时秒数 |
| `IDE_E2E_JSONL_STRICT` | `0` | 设为 `1` 则 JSONL 字段问题导致失败 |
| `CURSOR_CDP_PORT` | `9222` | Cursor CDP 端口覆盖 |
| `QODER_IDE_CDP_REPLY_TIMEOUT` | `90` | Qoder IDE 等待回复的超时秒数 |
| `CURSOR_CDP_REPLY_TIMEOUT` | `90` | Cursor 等待回复的超时秒数 |

## 脚本清单

| 文件 | 用途 |
|------|------|
| `scripts/e2e/run-ide-e2e.sh` | E2E 主入口：编排测试流程 + 数据验证 |
| `scripts/e2e/ai-chat.sh` | 统一对话脚本：封装三个 IDE 的通信协议 |
| `scripts/e2e/enable-cursor-cdp.sh` | 一键开启 Cursor CDP（patch + 配置 + 重启） |

## 各工具通信详情

### QoderWork — JSON-RPC (MCP)

QoderWork 通过本地 MCP 适配器暴露 JSON-RPC 接口，不需要 CDP。

**对话流程**：
1. 读取 `~/.qoderwork/mcp-adaptor.config` 获取 MCP 服务地址和 token
2. 调用 `qoder_cron` 创建任务并立即运行 → 获得 `chatId`
3. 调用 `qoder_get_task_detail` 轮询回复（等待 status 变为 completed）

**数据链路**：
```
MCP JSON-RPC 调用
  → QoderWork 处理对话
    → pilot QoderWorkInput 采集
      → ~/.loongsuite-pilot/logs/output/qoder-work-YYYY-MM-DD.jsonl
```

### Qoder IDE — CDP (动态端口)

Qoder IDE 基于 VS Code，renderer 进程自带 `--remote-debugging-port=0`（随机端口），无需手动配置。

**端口发现**：
1. 找 `Qoder.app/Contents/MacOS/Electron` 进程 PID
2. `lsof`/`ss`/`netstat` 列出该进程所有 LISTEN 端口
3. 排除 `--inspect` 端口（Node.js 调试端口，不是 CDP）
4. 逐个 `curl /json/version` 验证哪个是 CDP
5. Fallback：读 `$QODER_IDE_DATA_DIR/DevToolsActivePort` 文件第一行

**对话流程**：
1. 连接 CDP WebSocket → 找到 title 含 "chat" 的 page target
2. 找到 `.chat-input-contenteditable` 输入框（优先选可见的；若都不可见则用 JS `focus()` 聚焦）
3. `Input.insertText` + `Enter` 发送消息
4. 轮询最后一个 `[class*="prose"]` 元素的文本变化检测回复（text-based，因为 Qoder IDE 虚拟滚动下 DOM 元素数量不增加）

**数据链路**：
```
CDP Input.insertText + Enter
  → Qoder IDE chat 面板处理对话
    → pilot QoderInput 通过 transcript 文件采集
      → ~/.loongsuite-pilot/logs/output/qoder-YYYY-MM-DD.jsonl
```

### Cursor — CDP (固定端口，需手动配置)

Cursor 默认不开启 CDP，需要两步手动操作。可用 `enable-cursor-cdp.sh` 一键完成。

**对话流程**：
1. 连接 CDP WebSocket (默认 `localhost:9222`)
2. `Cmd+N` 打开新对话（避免复用旧对话导致检测混淆）
3. `Cmd+A + Backspace` 清空输入框（可能有残留文字）
4. `Input.insertText` + `Enter` 发送消息
5. 轮询 `.ui-markdown__paragraph` 元素，用 text-based baseline 检测新回复（过滤宽度 ≤50px 的 "Auto" UI 标签）

**数据链路**：
```
CDP Input.insertText + Enter
  → Cursor IDE UI 处理对话
    → hooks.json 事件: beforeSubmitPrompt → afterAgentResponse → stop
      → cursor-loongsuite-pilot-hook.sh
        → cursor-hook-processor.mjs
          → ~/.loongsuite-pilot/logs/cursor/history/cursor-YYYY-MM-DD.jsonl
            → pilot CursorHookInput 转换
              → ~/.loongsuite-pilot/logs/output/cursor-cli-YYYY-MM-DD.jsonl
```

## Cursor CDP 配置

### 为什么需要手动配置

Cursor 基于 Electron，但默认没有开启 CDP。它的 `main.js` 中有一个白名单数组，只有白名单中的参数才会从 `~/.cursor/argv.json` 读取并通过 `app.commandLine.appendSwitch()` 注入到 Chromium 启动参数。`remote-debugging-port` 不在默认白名单中。

白名单代码（`/Applications/Cursor.app/Contents/Resources/app/out/main.js`，压缩后）：
```javascript
const t = ["disable-hardware-acceleration","force-color-profile","disable-lcd-text","proxy-bypass-list"];
// ...
Object.keys(i).forEach(c => {
    const l = i[c];
    if (t.indexOf(c) !== -1) {
        // ...
        else if (typeof l == "string" && l)
            Ge.commandLine.appendSwitch(c, l);
    }
});
```

两个关键点：
1. `t.indexOf(c) !== -1` — 参数名必须在白名单数组中
2. `typeof l == "string"` — argv.json 中的值**必须是字符串**（`"9222"`），不能是数字（`9222`）

### 一键配置

```bash
bash scripts/e2e/enable-cursor-cdp.sh        # 默认端口 9222
bash scripts/e2e/enable-cursor-cdp.sh 9333    # 自定义端口
```

脚本自动完成：patch main.js → 配置 argv.json → 重启 Cursor → 验证 CDP。

### 手动配置（两步）

**第一步：Patch main.js 白名单**

在 `main.js` 中找到 `"proxy-bypass-list"`，在其后添加 `"remote-debugging-port","remote-allow-origins"`：

```bash
# macOS Ventura+ 需先授权终端:
# 系统设置 → 隐私与安全性 → App Management → 勾选 Terminal/iTerm

# 备份
cp /Applications/Cursor.app/Contents/Resources/app/out/main.js \
   /Applications/Cursor.app/Contents/Resources/app/out/main.js.bak

# Patch
sed -i '' 's/"proxy-bypass-list"/"proxy-bypass-list","remote-debugging-port","remote-allow-origins"/' \
   /Applications/Cursor.app/Contents/Resources/app/out/main.js
```

**第二步：配置 argv.json**

在 `~/.cursor/argv.json` 中添加（值必须是字符串）：

```json
{
    "remote-debugging-port": "9222"
}
```

配置完成后重启 Cursor，验证：

```bash
curl -s http://localhost:9222/json/version | python3 -m json.tool
```

### 注意事项

- **Cursor 更新会覆盖 patch** — 每次 Cursor 自动更新后 `main.js` 被重写，需重新执行 `enable-cursor-cdp.sh`
- **macOS 权限** — Ventura+ 修改 `/Applications` 需要在 系统设置 → 隐私与安全性 → App Management 中给终端授权
- **安全性** — CDP 开启后本地任何进程可通过 `localhost:9222` 控制 Cursor，仅在开发/测试环境使用
- **端口冲突** — 若 9222 被占用（如 Chrome CDP），改用其他端口

## 常见问题

### Cursor CDP 不可用

运行 `ai-chat.sh cursor --status` 会自动诊断，检查：
1. Cursor 是否在运行
2. `~/.cursor/argv.json` 是否配置了 `remote-debugging-port`（值是否为字符串）
3. `main.js` 白名单是否已 patch

### Qoder IDE 回复检测超时

可能原因：
- **chat 面板未打开** — 需要在 Qoder IDE 中先打开 chat 面板
- **虚拟滚动** — 回复检测用 text-based（最后一个 prose 元素文本变化），不是 count-based（DOM 元素数量不增加）
- **输入框不可见** — 脚本会自动 fallback 用 JS `focus()` 聚焦隐藏的输入框

### JSONL 数据不产生

- 确认 `loongsuite-pilot` 正在运行：`loongsuite-pilot status`
- 检查对应的 hooks 是否配置正确
- 查看 pilot 日志：`~/.loongsuite-pilot/logs/`
