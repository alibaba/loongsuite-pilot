#!/bin/bash
# ============================================================
# 统一 AI Coding Agent 编程式对话脚本
# 支持: QoderWork / Qoder IDE / Cursor
#
# 用法:
#   ./ai-chat.sh <tool> <prompt>            发送一条消息并获取回复
#   ./ai-chat.sh <tool> --new <prompt>      强制创建新会话
#   ./ai-chat.sh <tool> --list              列出会话 (QoderWork only)
#   ./ai-chat.sh <tool> --status            检查工具状态
#
# tool = qoderwork | qoder-ide | cursor
#
# 示例:
#   ./ai-chat.sh qoderwork "分析一下这段代码的性能问题"
#   ./ai-chat.sh cursor "explain this function" --mode ask
#   ./ai-chat.sh qoder-ide "重构这个模块" --mode agent
#   ./ai-chat.sh cursor --new "hello world"
#
# 通信协议与端口发现:
#   - QoderWork:  JSON-RPC (MCP)
#                 从 ~/.qoderwork/mcp-adaptor.config 读取 url + token,
#                 通过 curl POST 调用 MCP tools (qoder_cron / qoder_send_message 等)
#   - Qoder IDE:  CDP (Chrome DevTools Protocol)
#                 动态端口 (启动时 --remote-debugging-port=0, 每次不同):
#                 1) 找 Electron 进程 PID → lsof/ss/netstat 取 LISTEN 端口 → 排除 --inspect 端口 → curl /json/version 验证
#                 2) fallback: 读 $QODER_IDE_DATA_DIR/DevToolsActivePort 文件第一行
#   - Cursor:     CDP (Chrome DevTools Protocol)
#                 固定端口 (需手动配置, 默认 9222):
#                 用户需 patch main.js 白名单 + 在 ~/.cursor/argv.json 配置 "remote-debugging-port": "9222"
#                 可通过 CURSOR_CDP_PORT 环境变量覆盖, 参见 docs/ide-e2e-testing.md
#
# 前置条件:
#   - QoderWork: 桌面端运行 + jq
#   - Qoder IDE: 桌面端运行 + python3 websockets
#   - Cursor:    桌面端运行 + CDP 已开启 + python3 websockets
# ============================================================

set -euo pipefail

# ===== 平台检测 =====
detect_platform() {
  case "$(uname -s)" in
    Darwin)  echo "macos" ;;
    Linux)   echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *)
      # Git Bash on Windows reports MINGW, but check for Windows paths
      if [[ -d "/c/Users" ]] || [[ -n "${WINDIR:-}" ]]; then
        echo "windows"
      else
        echo "linux"  # 默认 fallback
      fi
      ;;
  esac
}

PLATFORM="$(detect_platform)"

# ===== 全局配置 (按平台适配) =====
QODERWORK_CONFIG="$HOME/.qoderwork/mcp-adaptor.config"
POLL_INTERVAL=5
POLL_TIMEOUT=300

case "$PLATFORM" in
  macos)
    QODER_IDE_CLI="/Applications/Qoder.app/Contents/Resources/app/bin/code"
    CURSOR_AGENT="$HOME/.local/bin/cursor-agent"
    CURSOR_CLI="/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
    # DevToolsActivePort 路径
    QODER_IDE_DATA_DIR="$HOME/Library/Application Support/Qoder"
    ;;
  linux)
    # Linux: Qoder IDE 常见安装路径 (允许环境变量覆盖)
    if [[ -z "${QODER_IDE_CLI:-}" ]]; then
      for _p in /usr/share/qoder/bin/code /opt/qoder/bin/code /usr/bin/qoder; do
        [[ -x "$_p" ]] && QODER_IDE_CLI="$_p" && break
      done
      [[ -z "${QODER_IDE_CLI:-}" ]] && QODER_IDE_CLI="$(command -v qoder 2>/dev/null || echo "/usr/bin/qoder")"
    fi
    CURSOR_AGENT="${CURSOR_AGENT:-$HOME/.local/bin/cursor-agent}"
    if [[ -z "${CURSOR_CLI:-}" ]]; then
      for _p in /usr/share/cursor/bin/cursor /opt/cursor/bin/cursor /usr/bin/cursor; do
        [[ -x "$_p" ]] && CURSOR_CLI="$_p" && break
      done
      [[ -z "${CURSOR_CLI:-}" ]] && CURSOR_CLI="$(command -v cursor 2>/dev/null || echo "/usr/bin/cursor")"
    fi
    QODER_IDE_DATA_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/Qoder"
    ;;
  windows)
    # Windows (Git Bash / MSYS2): 转换路径
    local_app="${LOCALAPPDATA:-$HOME/AppData/Local}"
    app_data="${APPDATA:-$HOME/AppData/Roaming}"
    QODER_IDE_CLI="${QODER_IDE_CLI:-$local_app/Programs/Qoder/bin/code}"
    [[ -x "$QODER_IDE_CLI" ]] || QODER_IDE_CLI="$(command -v qoder 2>/dev/null || echo "$local_app/Programs/Qoder/bin/code.cmd")"
    CURSOR_AGENT="$HOME/.local/bin/cursor-agent.exe"
    [[ -x "$CURSOR_AGENT" ]] || CURSOR_AGENT="$(command -v cursor-agent 2>/dev/null || echo "$local_app/Programs/cursor-agent/cursor-agent.exe")"
    CURSOR_CLI="${CURSOR_CLI:-$local_app/Programs/Cursor/bin/cursor}"
    QODER_IDE_DATA_DIR="$app_data/Qoder"
    ;;
esac

# ===== Python 命令 (Windows 通常只有 python, macOS/Linux 用 python3) =====
if command -v python3 >/dev/null 2>&1; then
  PYTHON3="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON3="python"
else
  PYTHON3=""  # CDP 模式不可用，其他功能不受影响
fi

# ===== 依赖检查 (延迟到实际使用时检查) =====
require_cmd() {
  local cmd="$1" hint="${2:-}"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "缺少依赖: $cmd${hint:+ ($hint)}"
    return 1
  fi
}
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { printf "${BLUE}[INFO]${NC} %s\n" "$*" >&2; }
ok()    { printf "${GREEN}[OK]${NC} %s\n" "$*" >&2; }
warn()  { printf "${YELLOW}[WARN]${NC} %s\n" "$*" >&2; }
err()   { printf "${RED}[ERROR]${NC} %s\n" "$*" >&2; }

# ================================================================
#                         QODERWORK
# ================================================================
# 接口: MCP JSON-RPC @ 127.0.0.1:52345
# 方式: 完全 headless，结构化 JSON 输入输出

qoderwork_preflight() {
  require_cmd jq "https://jqlang.github.io/jq/download/" || return 1
  require_cmd curl || return 1
  if [[ ! -f "$QODERWORK_CONFIG" ]]; then
    err "QoderWork 未运行 ($QODERWORK_CONFIG 不存在)"
    return 1
  fi
}

qoderwork_call_tool() {
  local tool_name="$1" arguments="$2"
  local url token
  url=$(jq -r '.url' "$QODERWORK_CONFIG")
  token=$(jq -r '.token' "$QODERWORK_CONFIG")
  curl -s -X POST "$url" \
    -H "Content-Type: application/json" \
    -H "x-api-key: $token" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"$tool_name\",\"arguments\":$arguments},\"id\":1}"
}

qoderwork_status() {
  qoderwork_preflight || return 1
  local url token
  url=$(jq -r '.url' "$QODERWORK_CONFIG")
  token=$(jq -r '.token' "$QODERWORK_CONFIG")
  local result
  result=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$url" \
    -H "Content-Type: application/json" \
    -H "x-api-key: $token" \
    -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}')
  if [[ "$result" == "200" ]]; then
    ok "QoderWork 在线 (MCP @ $url)"
  else
    err "QoderWork MCP 不可达 (HTTP $result)"
    return 1
  fi
}

qoderwork_list() {
  qoderwork_preflight || return 1
  local result
  result=$(qoderwork_call_tool "qw_query" '{"key":"qoderwork.tasks","params":{"limit":15}}' 2>/dev/null)
  if echo "$result" | jq -e '.result.content[0].text | fromjson | .data.tasks' >/dev/null 2>&1; then
    echo "$result" | jq -r '
      .result.content[0].text | fromjson | .data.tasks[] |
      "\(if .status == "running" then "🟢" elif .status == "completed" then "✅" else "⏸️" end) [\(.chatId)] \(.title // "untitled") (\(.status))"
    '
  else
    err "qw_query qoderwork.tasks 不可用 (QoderWork 版本可能不支持)"
  fi
}

qoderwork_create_task() {
  local message="$1"
  local escaped
  escaped=$(printf '%s' "$message" | jq -Rs .)
  local job_name="chat-$(date +%s)"

  # Step 1: 创建远未来 cron job
  local add_result
  add_result=$(qoderwork_call_tool "qoder_cron" "{\"action\":\"add\",\"job\":{\"name\":\"$job_name\",\"schedule\":{\"kind\":\"at\",\"at\":\"2099-01-01T00:00:00Z\"},\"payload\":{\"kind\":\"agentTurn\",\"message\":$escaped}}}")
  local job_id
  job_id=$(echo "$add_result" | jq -r '.result.content[0].text | fromjson | .taskId // empty' 2>/dev/null || true)
  [[ -n "$job_id" ]] || { err "创建 cron job 失败"; echo "$add_result" | jq . >&2; return 1; }

  # Step 2: 立即 run → chatId
  local run_result
  run_result=$(qoderwork_call_tool "qoder_cron" "{\"action\":\"run\",\"jobId\":\"$job_id\"}")
  local chat_id
  chat_id=$(echo "$run_result" | jq -r '.result.content[0].text | fromjson | .chatId // empty' 2>/dev/null || true)
  [[ -n "$chat_id" ]] || { err "触发任务失败"; return 1; }

  # Step 3: 清理
  qoderwork_call_tool "qoder_cron" "{\"action\":\"remove\",\"jobId\":\"$job_id\"}" >/dev/null 2>&1
  echo "$chat_id"
}

qoderwork_find_idle() {
  local result
  result=$(qoderwork_call_tool "qw_query" '{"key":"qoderwork.tasks","params":{"limit":10}}' 2>/dev/null || true)
  [[ -z "$result" ]] && return 0
  echo "$result" | jq -r '
    .result.content[0].text | fromjson | .data.tasks[] |
    select(.status == "completed") | .chatId
  ' 2>/dev/null | head -1 || true
}

qoderwork_send() {
  local chat_id="$1" message="$2"
  local escaped
  escaped=$(printf '%s' "$message" | jq -Rs .)
  qoderwork_call_tool "qoder_send_message" "{\"chatId\":\"$chat_id\",\"message\":$escaped}" >/dev/null
}

qoderwork_wait_reply() {
  local chat_id="$1" elapsed=0
  while [[ $elapsed -lt $POLL_TIMEOUT ]]; do
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
    local result
    result=$(qoderwork_call_tool "qoder_get_task_detail" "{\"chatId\":\"$chat_id\",\"limit\":1}" 2>/dev/null || true)
    [[ -z "$result" ]] && continue
    local status
    status=$(echo "$result" | jq -r '.result.content[0].text | fromjson | .status' 2>/dev/null || true)
    if [[ "$status" == "completed" ]]; then
      printf "\r%*s\r" 40 "" >&2
      echo "$result" | jq -r '
        .result.content[0].text | fromjson |
        .messages[0] | select(.role == "assistant") | .text // empty
      '
      return 0
    fi
    printf "\r⏳ %ds/%ds" "$elapsed" "$POLL_TIMEOUT" >&2
  done
  echo "" >&2
  warn "超时 (${POLL_TIMEOUT}s). chatId=$chat_id"
  return 1
}

qoderwork_chat() {
  local message="$1" create_new="${2:-false}"
  local chat_id

  if [[ "$create_new" == "true" ]]; then
    info "创建新任务..."
    chat_id=$(qoderwork_create_task "$message")
    ok "Task: $chat_id"
    qoderwork_wait_reply "$chat_id"
  else
    chat_id=$(qoderwork_find_idle)
    if [[ -n "$chat_id" ]]; then
      info "复用已有任务: $chat_id"
      qoderwork_send "$chat_id" "$message"
      qoderwork_wait_reply "$chat_id"
    else
      info "无空闲任务，创建新的..."
      chat_id=$(qoderwork_create_task "$message")
      ok "Task: $chat_id"
      qoderwork_wait_reply "$chat_id"
    fi
  fi
}

# ================================================================
#                         QODER IDE
# ================================================================
# 接口: CLI `qoder chat` 子命令 (GUI 触发)
# 方式: 在 IDE 窗口中打开 chat 面板并发送 prompt

qoder_ide_status() {
  if [[ ! -x "$QODER_IDE_CLI" ]]; then
    err "Qoder IDE CLI 不存在: $QODER_IDE_CLI"
    return 1
  fi
  # 检查 IDE 是否运行 (跨平台)
  local running=false
  case "$PLATFORM" in
    macos)   pgrep -f "Qoder.app" >/dev/null 2>&1 && running=true ;;
    linux)   pgrep -f "qoder" >/dev/null 2>&1 && running=true ;;
    windows) tasklist.exe 2>/dev/null | grep -qi "qoder" && running=true ;;
  esac

  if [[ "$running" == "true" ]]; then
    local ver
    ver=$("$QODER_IDE_CLI" --version 2>/dev/null | head -1 || echo "unknown")
    ok "Qoder IDE 在线 (v$ver)"
    local active_port
    active_port=$(head -1 "$QODER_IDE_DATA_DIR/DevToolsActivePort" 2>/dev/null || echo "?")
    ok "CDP @ 127.0.0.1:$active_port"
  else
    err "Qoder IDE 未运行"
    return 1
  fi
}

qoder_ide_chat() {
  local message="$1"
  local mode="${CHAT_MODE:-agent}"
  local use_cdp="${QODER_IDE_CDP:-false}"

  if [[ "$use_cdp" == "true" ]]; then
    qoder_ide_cdp_send "$message"
  else
    info "发送到 Qoder IDE (mode=$mode)..."
    if [[ -n "${ADD_FILE:-}" ]]; then
      "$QODER_IDE_CLI" chat -r -m "$mode" -a "$ADD_FILE" "$message"
    else
      "$QODER_IDE_CLI" chat -r -m "$mode" "$message"
    fi
    ok "已在 Qoder IDE 中打开 chat (结果在 IDE 窗口查看)"
    echo "[GUI] 消息已发送到 Qoder IDE chat 面板，请在 IDE 中查看回复。"
  fi
}

# CDP 方式: 通过 Chrome DevTools Protocol 向已打开的 chat 面板注入文本并提交
qoder_ide_cdp_send() {
  local message="$1"

  # 检查 python 依赖
  if [[ -z "$PYTHON3" ]]; then
    err "CDP 模式需要 python3 (或 python). 请安装 Python 3"
    return 1
  fi

  # 获取 CDP 端口 (跨平台)
  local cdp_port=""
  
  case "$PLATFORM" in
    macos)
      # macOS: 找 Qoder Electron 主进程 → lsof 取 LISTEN 端口 → 排除 inspect → 验证
      local qoder_pid
      qoder_pid=$(ps ax -o pid,command | grep "Qoder.app/Contents/MacOS/Electron" | grep -v grep | awk '{print $1}' | head -1 || true)
      if [[ -n "$qoder_pid" ]]; then
        local inspect_port
        inspect_port=$(ps -p "$qoder_pid" -o command= 2>/dev/null | grep -oE '\-\-inspect=[^[:space:]]+' | grep -oE '[0-9]+$' || true)
        local ports
        ports=$(lsof -i -P -n 2>/dev/null | awk "/^Electron[[:space:]]+${qoder_pid}[[:space:]]/ && /LISTEN/" | awk '{print $9}' | grep -oE '[0-9]+$' || true)
        for port in $ports; do
          [[ "$port" == "$inspect_port" ]] && continue
          if curl -s --connect-timeout 1 "http://127.0.0.1:$port/json/version" 2>/dev/null | grep -q "webSocketDebuggerUrl"; then
            cdp_port="$port"
            break
          fi
        done
      fi
      ;;
    linux)
      # Linux: 找 qoder/electron 进程 → ss 取端口 → 验证
      local qoder_pid
      qoder_pid=$(pgrep -f "qoder.*--type=browser" 2>/dev/null | head -1 || true)
      [[ -z "$qoder_pid" ]] && qoder_pid=$(pgrep -f "[Qq]oder" 2>/dev/null | head -1 || true)
      if [[ -n "$qoder_pid" ]]; then
        local inspect_port
        inspect_port=$(tr '\0' '\n' < /proc/"$qoder_pid"/cmdline 2>/dev/null | grep -oE '\-\-inspect=[0-9.]+:[0-9]+' | grep -oE '[0-9]+$' || true)
        local ports
        # ss -tlnp 格式: LISTEN  0  128  127.0.0.1:49716  ...  users:(("electron",pid=XXX,...))
        ports=$(ss -tlnp 2>/dev/null | grep "pid=$qoder_pid" | grep -oE '127\.0\.0\.1:[0-9]+' | grep -oE '[0-9]+$' || true)
        for port in $ports; do
          [[ "$port" == "$inspect_port" ]] && continue
          if curl -s --connect-timeout 1 "http://127.0.0.1:$port/json/version" 2>/dev/null | grep -q "webSocketDebuggerUrl"; then
            cdp_port="$port"
            break
          fi
        done
      fi
      ;;
    windows)
      # Windows (Git Bash): netstat 取 Qoder.exe (非 QoderWork) LISTEN 端口 → 验证
      local qoder_pid
      qoder_pid=$(tasklist.exe 2>/dev/null | grep -i "^Qoder\.exe" | awk '{print $2}' | head -1 || true)
      if [[ -n "$qoder_pid" ]]; then
        local ports
        # netstat -ano 最后一列是 PID, $2 是 Local Address (ip:port)
        ports=$(netstat.exe -ano 2>/dev/null | awk -v pid="$qoder_pid" '/LISTENING/ && $NF == pid && /127\.0\.0\.1/' | awk '{print $2}' | grep -oE '[0-9]+$' || true)
        for port in $ports; do
          if curl -s --connect-timeout 1 "http://127.0.0.1:$port/json/version" 2>/dev/null | grep -q "webSocketDebuggerUrl"; then
            cdp_port="$port"
            break
          fi
        done
      fi
      ;;
  esac

  # fallback: DevToolsActivePort 文件 (所有平台)
  if [[ -z "$cdp_port" ]]; then
    local fallback_port
    fallback_port=$(head -1 "$QODER_IDE_DATA_DIR/DevToolsActivePort" 2>/dev/null || true)
    if [[ -n "$fallback_port" ]] && curl -s --connect-timeout 1 "http://127.0.0.1:$fallback_port/json/version" 2>/dev/null | grep -q "webSocketDebuggerUrl"; then
      cdp_port="$fallback_port"
    fi
  fi

  if [[ -z "$cdp_port" ]]; then
    err "无法找到 Qoder IDE CDP 端口 (确认 Qoder IDE 正在运行)"
    return 1
  fi

  info "Qoder IDE CDP (port=$cdp_port) 注入消息..."

  # 通过环境变量安全传递消息(避免 shell 引号转义问题)
  local msg_b64
  # macOS base64 不换行; Linux GNU base64 默认换行需 -w0; 统一用 tr 去掉换行
  msg_b64=$(printf '%s' "$message" | base64 | tr -d '\n')

  local reply_timeout="${QODER_IDE_CDP_REPLY_TIMEOUT:-90}"

  CDP_PORT="$cdp_port" MSG_B64="$msg_b64" REPLY_TIMEOUT="$reply_timeout" $PYTHON3 << 'PYEOF'
import json, asyncio, os, sys, base64
try:
    import websockets
except ImportError:
    print("ERROR: pip3 install websockets", file=sys.stderr)
    sys.exit(1)
import urllib.request

async def send_and_wait():
    message = base64.b64decode(os.environ["MSG_B64"]).decode("utf-8")
    cdp_port = os.environ["CDP_PORT"]
    reply_timeout = int(os.environ.get("REPLY_TIMEOUT", "90"))

    try:
        version = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{cdp_port}/json/version", timeout=3).read())
        browser_ws = version["webSocketDebuggerUrl"]
        targets = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{cdp_port}/json", timeout=3).read())
    except Exception as e:
        print(f"ERROR: CDP connect failed: {e}", file=sys.stderr)
        sys.exit(1)

    pages = [t for t in targets if t.get("type") == "page"]
    if not pages:
        print("ERROR: No page target", file=sys.stderr); sys.exit(1)

    async with websockets.connect(browser_ws, max_size=10*1024*1024, open_timeout=5) as ws:
        msg_id = 0
        async def cmd(method, params=None, sid=None):
            nonlocal msg_id; msg_id += 1
            c = {"id": msg_id, "method": method}
            if params: c["params"] = params
            if sid: c["sessionId"] = sid
            await ws.send(json.dumps(c))
            while True:
                try:
                    r = json.loads(await asyncio.wait_for(ws.recv(), timeout=8))
                    if r.get("id") == msg_id: return r
                except asyncio.TimeoutError: return None

        # 智能选择 chat panel target: 逐个 page 探测, 优先选有 input+prose 的
        chat_target = None; sid = None; fallback_target = None; fallback_sid = None
        for t in pages:
            r = await cmd("Target.attachToTarget", {"targetId": t["id"], "flatten": True})
            test_sid = r.get("result",{}).get("sessionId","") if r else ""
            if not test_sid: continue
            r = await cmd("Runtime.evaluate", {
                "expression": """(function(){
                    var input = document.querySelectorAll('.chat-input-contenteditable').length;
                    var prose = document.querySelectorAll('[class*="prose"]').length;
                    return JSON.stringify({input: input, prose: prose});
                })()""",
                "returnByValue": True
            }, test_sid)
            info = json.loads(r.get("result",{}).get("result",{}).get("value",'{"input":0,"prose":0}')) if r else {"input":0,"prose":0}
            if info["input"] > 0 and info["prose"] > 0:
                chat_target = t; sid = test_sid
                print(f"[qoder-ide-cdp] target: {t.get('title','')[:50]} (input={info['input']}, prose={info['prose']})", file=sys.stderr)
                break
            if info["input"] > 0 and not fallback_target:
                fallback_target = t; fallback_sid = test_sid
            else:
                await cmd("Target.detachFromTarget", {"sessionId": test_sid})

        if not chat_target and fallback_target:
            chat_target = fallback_target; sid = fallback_sid
            print(f"[qoder-ide-cdp] target (fallback): {chat_target.get('title','')[:50]}", file=sys.stderr)
        elif not chat_target:
            chat_target = pages[0]
            r = await cmd("Target.attachToTarget", {"targetId": chat_target["id"], "flatten": True})
            sid = r.get("result",{}).get("sessionId","") if r else ""

        if not sid:
            print("ERROR: attach failed", file=sys.stderr); sys.exit(1)

        # baseline: 记录最后一个回复元素的文本 (虚拟滚动下元素数量不增加)
        reply_sel = '[class*="prose"]'
        r = await cmd("Runtime.evaluate", {
            "expression": f"""(function(){{
                var els = document.querySelectorAll('{reply_sel}');
                if (!els.length) return JSON.stringify({{count: 0, lastText: ''}});
                var last = els[els.length - 1];
                return JSON.stringify({{count: els.length, lastText: (last.innerText||'').trim().substring(0,2000)}});
            }})()""",
            "returnByValue": True
        }, sid)
        baseline = json.loads(r.get("result",{}).get("result",{}).get("value",'{"count":0,"lastText":""}')) if r else {"count":0,"lastText":""}
        baseline_last_text = baseline["lastText"]
        print(f"[qoder-ide-cdp] baseline: {baseline['count']} prose, last=\"{baseline_last_text[:60]}\"", file=sys.stderr)

        # 找输入框: 优先选可见的, 否则用 JS focus 聚焦任意 contenteditable
        r = await cmd("Runtime.evaluate", {
            "expression": """(function(){
                var inputs = document.querySelectorAll('.chat-input-contenteditable');
                var bestVisible = null, anyEditable = null;
                for (var i = inputs.length - 1; i >= 0; i--) {
                    var el = inputs[i];
                    if (el.contentEditable !== 'true') continue;
                    if (!anyEditable) anyEditable = el;
                    var rect = el.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        bestVisible = el; break;
                    }
                }
                var target = bestVisible || anyEditable;
                if (!target) return 'null';
                if (!bestVisible) target.focus();
                var rect = target.getBoundingClientRect();
                return JSON.stringify({x: Math.round(rect.left+rect.width/2), y: Math.round(rect.top+rect.height/2),
                                       w: Math.round(rect.width), h: Math.round(rect.height), focused: !bestVisible});
            })()""",
            "returnByValue": True
        }, sid)
        input_info = json.loads(r.get("result",{}).get("result",{}).get("value","null")) if r else None
        if not input_info:
            print("ERROR: No chat input found (确认 chat 面板已打开)", file=sys.stderr); sys.exit(1)

        if input_info.get("w", 0) > 0 and input_info.get("h", 0) > 0:
            await cmd("Input.dispatchMouseEvent", {"type":"mousePressed","x":input_info["x"],"y":input_info["y"],"button":"left","clickCount":1}, sid)
            await cmd("Input.dispatchMouseEvent", {"type":"mouseReleased","x":input_info["x"],"y":input_info["y"],"button":"left","clickCount":1}, sid)
            await asyncio.sleep(0.1)

        await cmd("Input.insertText", {"text": message}, sid)
        await asyncio.sleep(0.2)
        await cmd("Input.dispatchKeyEvent", {"type":"keyDown","key":"Enter","code":"Enter","windowsVirtualKeyCode":13}, sid)
        await cmd("Input.dispatchKeyEvent", {"type":"keyUp","key":"Enter","code":"Enter","windowsVirtualKeyCode":13}, sid)
        print(f"[qoder-ide-cdp] 消息已发送: {message[:80]}", file=sys.stderr)

        # 轮询等待回复 (text-based: 最后一个 prose 元素文本变化即为新回复)
        elapsed = 0; last_text = ""; stable = 0
        while elapsed < reply_timeout:
            await asyncio.sleep(2); elapsed += 2
            r = await cmd("Runtime.evaluate", {
                "expression": f"""(function(){{
                    var els = document.querySelectorAll('{reply_sel}');
                    if (!els.length) return '';
                    var last = els[els.length - 1];
                    return (last.innerText||'').trim().substring(0,2000);
                }})()""",
                "returnByValue": True
            }, sid)
            text = (r.get("result",{}).get("result",{}).get("value","") if r else "").strip()
            if text and text != baseline_last_text:
                if text == last_text: stable += 1
                else: stable = 0; last_text = text
                if stable >= 2: break

        if last_text:
            print(f"[qoder-ide-cdp] 回复 ({elapsed}s): {last_text[:200]}", file=sys.stderr)
            print(last_text)
        else:
            print(f"[qoder-ide-cdp] 超时 ({reply_timeout}s) 未收到回复", file=sys.stderr)
            sys.exit(1)

asyncio.run(send_and_wait())
PYEOF
}

# ================================================================
#                         CURSOR (CDP)
# ================================================================
# 接口: Chrome DevTools Protocol — 通过 Cmd+N 开新对话, insertText + Enter 提交
# 前置条件: Cursor main.js 白名单已 patch, argv.json 配置 "remote-debugging-port": "9222"
# 参见: docs/ide-e2e-testing.md

cursor_cdp_diagnose() {
  # 检查 Cursor CDP 前置配置, 输出诊断信息到 stderr
  local cdp_port="${CURSOR_CDP_PORT:-9222}"
  local issues=0

  # 1) Cursor 是否在运行
  local cursor_running=false
  case "$PLATFORM" in
    macos)   pgrep -f "Cursor.app/Contents/MacOS" >/dev/null 2>&1 && cursor_running=true ;;
    linux)   pgrep -f "cursor.*--type=browser" >/dev/null 2>&1 && cursor_running=true ;;
    windows) tasklist.exe 2>/dev/null | grep -qi "^Cursor\.exe" && cursor_running=true ;;
  esac
  if [[ "$cursor_running" != "true" ]]; then
    err "Cursor 未运行"
    issues=$((issues + 1))
  fi

  # 2) argv.json 是否配置了 remote-debugging-port (字符串值)
  local argv_json="$HOME/.cursor/argv.json"

  if [[ ! -f "$argv_json" ]]; then
    err "argv.json 不存在: $argv_json"
    err "  → 创建文件并写入: {\"remote-debugging-port\": \"$cdp_port\"}"
    issues=$((issues + 1))
  elif ! grep -q '"remote-debugging-port"' "$argv_json" 2>/dev/null; then
    err "argv.json 未配置 remote-debugging-port"
    err "  → 在 $argv_json 中添加: \"remote-debugging-port\": \"$cdp_port\""
    issues=$((issues + 1))
  elif grep -qE '"remote-debugging-port"\s*:\s*[0-9]' "$argv_json" 2>/dev/null && \
       ! grep -qE '"remote-debugging-port"\s*:\s*"' "$argv_json" 2>/dev/null; then
    err "argv.json 中 remote-debugging-port 的值必须是字符串 (\"$cdp_port\"), 不能是数字 ($cdp_port)"
    err "  → Cursor 源码用 typeof l === \"string\" 判断, 数字类型不会触发 appendSwitch"
    issues=$((issues + 1))
  fi

  # 3) main.js 白名单是否已 patch
  local main_js=""
  case "$PLATFORM" in
    macos)   main_js="/Applications/Cursor.app/Contents/Resources/app/out/main.js" ;;
    linux)
      for _p in /usr/share/cursor/resources/app/out/main.js /opt/cursor/resources/app/out/main.js; do
        [[ -f "$_p" ]] && main_js="$_p" && break
      done
      ;;
    windows) main_js="${LOCALAPPDATA:-$HOME/AppData/Local}/Programs/Cursor/resources/app/out/main.js" ;;
  esac

  if [[ -n "$main_js" && -f "$main_js" ]]; then
    if ! grep -q '"remote-debugging-port"' "$main_js" 2>/dev/null; then
      err "main.js 白名单未 patch — remote-debugging-port 不在白名单中"
      err "  → 在 $main_js 中找到 \"proxy-bypass-list\":{type:\"string\"}, 在其后添加:"
      err "    ,\"remote-debugging-port\":{type:\"string\"},\"remote-allow-origins\":{type:\"string\"}"
      if [[ "$PLATFORM" == "macos" ]]; then
        err "  → macOS Ventura+ 需先在 系统设置 → 隐私与安全性 → App Management 中给终端授权"
      fi
      err "  → patch 后需重启 Cursor; Cursor 更新会覆盖 patch, 需重新操作"
      issues=$((issues + 1))
    fi
  fi

  return $issues
}

cursor_cdp_status() {
  local cdp_port="${CURSOR_CDP_PORT:-9222}"
  if curl -s --connect-timeout 2 "http://127.0.0.1:$cdp_port/json/version" 2>/dev/null | grep -q "webSocketDebuggerUrl"; then
    ok "Cursor CDP 可用 (port=$cdp_port)"
  else
    err "Cursor CDP 不可用 (port=$cdp_port)"
    err ""
    err "=== 诊断 ==="
    cursor_cdp_diagnose
    err ""
    err "完整文档: docs/ide-e2e-testing.md"
    return 1
  fi
}

cursor_cdp_chat() {
  local message="$1"
  local cdp_port="${CURSOR_CDP_PORT:-9222}"
  local reply_timeout="${CURSOR_CDP_REPLY_TIMEOUT:-90}"

  if [[ -z "$PYTHON3" ]]; then
    err "CDP 模式需要 python3"
    return 1
  fi

  local msg_b64
  msg_b64=$(printf '%s' "$message" | base64 | tr -d '\n')

  info "Cursor CDP (port=$cdp_port) 发送消息..."

  CDP_PORT="$cdp_port" MSG_B64="$msg_b64" REPLY_TIMEOUT="$reply_timeout" AI_CHAT_PLATFORM="$PLATFORM" $PYTHON3 << 'PYEOF'
import json, asyncio, os, sys, base64
try:
    import websockets
except ImportError:
    print("ERROR: pip3 install websockets", file=sys.stderr)
    sys.exit(1)
import urllib.request

async def send_and_wait():
    message = base64.b64decode(os.environ["MSG_B64"]).decode("utf-8")
    cdp_port = os.environ["CDP_PORT"]
    reply_timeout = int(os.environ.get("REPLY_TIMEOUT", "90"))
    platform = os.environ.get("AI_CHAT_PLATFORM", "macos")
    # macOS 用 Meta/Cmd(4);Windows/Linux 用 Ctrl(2)
    cmd_mod = 4 if platform == "macos" else 2

    try:
        version = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{cdp_port}/json/version", timeout=3).read())
        browser_ws = version["webSocketDebuggerUrl"]
        targets = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{cdp_port}/json", timeout=3).read())
    except Exception as e:
        print(f"ERROR: CDP connect failed: {e}", file=sys.stderr)
        sys.exit(1)

    pages = [t for t in targets if t.get("type") == "page"]
    target = pages[0] if pages else None
    if not target:
        print("ERROR: No page target", file=sys.stderr)
        sys.exit(1)

    async with websockets.connect(browser_ws, max_size=10*1024*1024, open_timeout=5) as ws:
        msg_id = 0
        async def cmd(method, params=None, sid=None):
            nonlocal msg_id; msg_id += 1
            c = {"id": msg_id, "method": method}
            if params: c["params"] = params
            if sid: c["sessionId"] = sid
            await ws.send(json.dumps(c))
            while True:
                try:
                    r = json.loads(await asyncio.wait_for(ws.recv(), timeout=8))
                    if r.get("id") == msg_id: return r
                except asyncio.TimeoutError: return None

        r = await cmd("Target.attachToTarget", {"targetId": target["id"], "flatten": True})
        sid = r.get("result",{}).get("sessionId","") if r else ""
        if not sid:
            print("ERROR: attach failed", file=sys.stderr); sys.exit(1)

        # Cmd+N (macOS) / Ctrl+N (Windows) → 开新对话
        await cmd("Input.dispatchKeyEvent", {"type":"keyDown","key":"n","code":"KeyN","windowsVirtualKeyCode":78,"modifiers":cmd_mod}, sid)
        await cmd("Input.dispatchKeyEvent", {"type":"keyUp","key":"n","code":"KeyN","windowsVirtualKeyCode":78,"modifiers":cmd_mod}, sid)
        await asyncio.sleep(2)

        # baseline: 记录现有回复文本
        # macOS 用 .ui-markdown__paragraph, Windows 用 .markdown-root — 动态探测
        r = await cmd("Runtime.evaluate", {
            "expression": """(function(){
                var sels = ['.ui-markdown__paragraph', '.markdown-root'];
                for (var i = 0; i < sels.length; i++) {
                    var els = document.querySelectorAll(sels[i]);
                    if (els.length > 0) {
                        var texts = [];
                        for (var j = 0; j < els.length; j++) texts.push((els[j].innerText||'').trim().substring(0,200));
                        return JSON.stringify({sel: sels[i], texts: texts});
                    }
                }
                return JSON.stringify({sel: '', texts: []});
            })()""",
            "returnByValue": True
        }, sid)
        probe = json.loads(r.get("result",{}).get("result",{}).get("value",'{"sel":"","texts":[]}')) if r else {"sel":"","texts":[]}
        reply_sel = probe["sel"] or '.ui-markdown__paragraph'
        baseline_texts = probe["texts"]
        baseline_set_js = json.dumps(baseline_texts)
        print(f"[cursor-cdp] reply selector: {reply_sel} ({len(baseline_texts)} baseline)", file=sys.stderr)

        # 找最大可见输入框
        r = await cmd("Runtime.evaluate", {
            "expression": """(function(){
                var candidates = document.querySelectorAll('.aislash-editor-input[role="textbox"]');
                if (!candidates.length) candidates = document.querySelectorAll('[contenteditable="true"]');
                var best = null, bestArea = 0;
                for (var i = 0; i < candidates.length; i++) {
                    var rect = candidates[i].getBoundingClientRect();
                    var area = rect.width * rect.height;
                    if (rect.width > 30 && rect.height > 8 && area > bestArea) { best = candidates[i]; bestArea = area; }
                }
                if (!best) return 'null';
                var rect = best.getBoundingClientRect();
                return JSON.stringify({x: Math.round(rect.left+rect.width/2), y: Math.round(rect.top+rect.height/2)});
            })()""",
            "returnByValue": True
        }, sid)
        input_info = json.loads(r.get("result",{}).get("result",{}).get("value","null")) if r else None
        if not input_info:
            print("ERROR: no chat input found", file=sys.stderr); sys.exit(1)

        # 点击聚焦 → 清空 → 输入 → 回车
        await cmd("Input.dispatchMouseEvent", {"type":"mousePressed","x":input_info["x"],"y":input_info["y"],"button":"left","clickCount":1}, sid)
        await cmd("Input.dispatchMouseEvent", {"type":"mouseReleased","x":input_info["x"],"y":input_info["y"],"button":"left","clickCount":1}, sid)
        await asyncio.sleep(0.3)

        # Cmd+A (macOS) / Ctrl+A (Windows) + Backspace 清空残留
        await cmd("Input.dispatchKeyEvent", {"type":"keyDown","key":"a","code":"KeyA","windowsVirtualKeyCode":65,"modifiers":cmd_mod}, sid)
        await cmd("Input.dispatchKeyEvent", {"type":"keyUp","key":"a","code":"KeyA","windowsVirtualKeyCode":65,"modifiers":cmd_mod}, sid)
        await asyncio.sleep(0.1)
        await cmd("Input.dispatchKeyEvent", {"type":"keyDown","key":"Backspace","code":"Backspace","windowsVirtualKeyCode":8}, sid)
        await cmd("Input.dispatchKeyEvent", {"type":"keyUp","key":"Backspace","code":"Backspace","windowsVirtualKeyCode":8}, sid)
        await asyncio.sleep(0.2)

        await cmd("Input.insertText", {"text": message}, sid)
        await asyncio.sleep(0.3)
        await cmd("Input.dispatchKeyEvent", {"type":"keyDown","key":"Enter","code":"Enter","windowsVirtualKeyCode":13}, sid)
        await cmd("Input.dispatchKeyEvent", {"type":"keyUp","key":"Enter","code":"Enter","windowsVirtualKeyCode":13}, sid)
        print(f"[cursor-cdp] 消息已发送: {message[:80]}", file=sys.stderr)

        # 轮询等待回复 (过滤 baseline 中已有的文本)
        elapsed = 0
        last_text = ""
        stable = 0
        while elapsed < reply_timeout:
            await asyncio.sleep(2)
            elapsed += 2

            r = await cmd("Runtime.evaluate", {
                "expression": f"""(function(){{
                    var els = document.querySelectorAll('{reply_sel}');
                    var baseline = new Set({baseline_set_js});
                    var newTexts = [];
                    for (var i = 0; i < els.length; i++) {{
                        var t = (els[i].innerText||'').trim();
                        var rect = els[i].getBoundingClientRect();
                        if (t.length > 0 && rect.width > 50 && !baseline.has(t.substring(0,200))) newTexts.push(t.substring(0,2000));
                    }}
                    return JSON.stringify({{n: newTexts.length, t: newTexts.length ? newTexts[newTexts.length-1] : ''}});
                }})()""",
                "returnByValue": True
            }, sid)
            info = json.loads(r.get("result",{}).get("result",{}).get("value",'{"n":0,"t":""}')) if r else {"n":0,"t":""}
            text = info["t"].strip()

            if info["n"] > 0 and text:
                if text == last_text:
                    stable += 1
                else:
                    stable = 0; last_text = text
                if stable >= 2:
                    break

        if last_text:
            print(f"[cursor-cdp] 回复 ({elapsed}s): {last_text[:200]}", file=sys.stderr)
            print(last_text)
        else:
            print(f"[cursor-cdp] 超时 ({reply_timeout}s) 未收到回复", file=sys.stderr)
            sys.exit(1)

asyncio.run(send_and_wait())
PYEOF
}

# ================================================================
#                         CURSOR (CLI)
# ================================================================
# 接口: cursor-agent CLI (headless --print 模式)
# 方式: 完全 headless，支持结构化输出

cursor_find_agent() {
  if [[ -x "$CURSOR_AGENT" ]]; then
    echo "$CURSOR_AGENT"
  elif command -v cursor-agent >/dev/null 2>&1; then
    command -v cursor-agent
  else
    return 1
  fi
}

cursor_status() {
  local agent_bin
  agent_bin=$(cursor_find_agent) || { err "cursor-agent 未安装。运行: cursor agent (首次会自动安装)"; return 1; }

  local status_out
  status_out=$("$agent_bin" status 2>&1 || true)
  if echo "$status_out" | grep -q "Logged in"; then
    ok "Cursor Agent 已登录: $(echo "$status_out" | sed -n 's/.*as //p')"
    echo "  Binary: $agent_bin" >&2
  else
    err "Cursor Agent 未登录。运行: cursor agent login"
    return 1
  fi
}

cursor_chat() {
  local message="$1" create_new="${2:-false}"
  local mode="${CHAT_MODE:-}"
  local model="${CURSOR_MODEL:-}"
  local workspace="${CURSOR_WORKSPACE:-$(pwd)}"
  local output_format="${CURSOR_OUTPUT_FORMAT:-text}"

  local agent_bin
  agent_bin=$(cursor_find_agent) || { err "cursor-agent 未安装"; return 1; }

  local args=(--print --trust --workspace "$workspace" --output-format "$output_format")

  [[ -n "$mode" ]] && args+=(--mode "$mode")
  [[ -n "$model" ]] && args+=(--model "$model")
  [[ "$create_new" == "true" ]] || {
    # 尝试恢复上一个会话 (--continue)
    [[ "${CURSOR_CONTINUE:-}" == "true" ]] && args+=(--continue)
  }

  info "Cursor Agent (workspace=$workspace, format=$output_format)..."
  "$agent_bin" "${args[@]}" "$message"
}

# 高级: 创建空会话并返回 chatId
cursor_create_chat() {
  local agent_bin
  agent_bin=$(cursor_find_agent) || { err "cursor-agent 未安装"; return 1; }
  "$agent_bin" create-chat 2>&1
}

# 恢复指定会话
cursor_resume() {
  local chat_id="$1" message="${2:-}"
  local agent_bin
  agent_bin=$(cursor_find_agent) || { err "cursor-agent 未安装"; return 1; }

  local args=(--print --trust --resume "$chat_id")
  [[ -n "$message" ]] && args+=("$message")
  "$agent_bin" "${args[@]}"
}

# ================================================================
#                         MAIN
# ================================================================

usage() {
  cat <<'EOF'
统一 AI Coding Agent 编程式对话脚本

用法:
  ./ai-chat.sh <tool> <prompt>               发消息获取回复
  ./ai-chat.sh <tool> --new <prompt>         创建新会话
  ./ai-chat.sh <tool> --list                 列出会话 (QoderWork)
  ./ai-chat.sh <tool> --status               检查状态

  tool = qoderwork | qoder-ide | cursor

环境变量:
  CHAT_MODE         聊天模式 (ask/edit/agent, 默认 agent)
  QODER_IDE_CDP     Qoder IDE 使用 CDP 注入模式: true/false (默认 false)
  CURSOR_MODEL      Cursor 模型 (e.g., gpt-5.4-mini-medium)
  CURSOR_WORKSPACE  Cursor 工作区路径 (默认 pwd)
  CURSOR_OUTPUT_FORMAT  输出格式: text/json/stream-json (默认 text)
  CURSOR_CONTINUE   是否恢复上一会话: true/false
  ADD_FILE          附加文件路径 (Qoder IDE)
  POLL_TIMEOUT      QoderWork 轮询超时秒数 (默认 300)

示例:
  # QoderWork - 完全 headless
  ./ai-chat.sh qoderwork "分析代码性能"
  ./ai-chat.sh qoderwork --new "新任务"

  # Cursor - headless CLI
  ./ai-chat.sh cursor "explain this code"
  CHAT_MODE=ask ./ai-chat.sh cursor "what does this function do"
  CURSOR_MODEL=claude-opus-4-8-high ./ai-chat.sh cursor "refactor"

  # Qoder IDE - GUI 触发 (默认) 或 CDP 注入
  ./ai-chat.sh qoder-ide "重构这个模块"
  ADD_FILE=./main.ts ./ai-chat.sh qoder-ide "优化这个文件"
  QODER_IDE_CDP=true ./ai-chat.sh qoder-ide "分析代码"

各工具能力对比:
  ┌────────────┬──────────────────┬────────────────────┬───────────────────┐
  │            │ QoderWork        │ Qoder IDE          │ Cursor            │
  ├────────────┼──────────────────┼────────────────────┼───────────────────┤
  │ 接口       │ JSON-RPC :52345  │ CLI / CDP          │ cursor-agent CLI  │
  │ Headless   │ ✅               │ ⚡ CDP (半headless) │ ✅                │
  │ 结构化输出 │ ✅ JSON          │ ❌                 │ ✅ json/stream    │
  │ 会话管理   │ ✅ create/resume │ ❌                 │ ✅ create/resume  │
  │ 模型选择   │ 服务端配置       │ IDE 内选择         │ ✅ --model        │
  │ 文件上下文 │ ❌               │ ✅ -a file         │ ✅ --workspace    │
  │ 鉴权       │ 文件 token(自动) │ 无需               │ cursor agent login│
  └────────────┴──────────────────┴────────────────────┴───────────────────┘
  注: Qoder IDE CDP 模式可无需 GUI 交互发送消息，但回复仍需在 IDE 中查看。
EOF
}

# 解析参数
TOOL="${1:-}"
shift || true

case "$TOOL" in
  qoderwork|qw)
    case "${1:-}" in
      --status)  qoderwork_status ;;
      --list)    qoderwork_list ;;
      --new)     shift; qoderwork_chat "${1:?需要 prompt}" "true" ;;
      --help|-h) usage ;;
      "")        usage ;;
      *)         qoderwork_chat "$1" "false" ;;
    esac
    ;;

  qoder-ide|qide|ide)
    case "${1:-}" in
      --status)  qoder_ide_status ;;
      --help|-h) usage ;;
      "")        usage ;;
      *)         qoder_ide_chat "$1" ;;
    esac
    ;;

  cursor|cr)
    if [[ "${CURSOR_CDP:-}" == "true" ]]; then
      case "${1:-}" in
        --status)  cursor_cdp_status ;;
        --help|-h) usage ;;
        "")        usage ;;
        *)         cursor_cdp_chat "$1" ;;
      esac
    else
      case "${1:-}" in
        --status)      cursor_status ;;
        --new)         shift; cursor_chat "${1:?需要 prompt}" "true" ;;
        --create-chat) cursor_create_chat ;;
        --resume)      shift; cursor_resume "${1:?需要 chatId}" "${2:-}" ;;
        --help|-h)     usage ;;
        "")            usage ;;
        *)             cursor_chat "$1" "false" ;;
      esac
    fi
    ;;

  --status|status)
    echo "=== 工具状态检查 ===" >&2
    qoderwork_status 2>&1 || true
    echo "" >&2
    qoder_ide_status 2>&1 || true
    echo "" >&2
    cursor_status 2>&1 || true
    ;;

  --help|-h|"")
    usage
    ;;

  *)
    err "未知工具: $TOOL (可选: qoderwork, qoder-ide, cursor)"
    usage
    exit 1
    ;;
esac
