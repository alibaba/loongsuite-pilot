#!/usr/bin/env bash
# ============================================================
# Remote IDE E2E Test Runner
#
# 通过 SSH 在远程机器上执行 IDE E2E 测试。
# 自动部署脚本、检查依赖、启动 pilot、运行测试、收集结果。
#
# 用法:
#   bash scripts/e2e/run-ide-e2e-remote.sh user@host --password PASSWORD
#   REMOTE_HOST=user@host REMOTE_PASS=pw bash scripts/e2e/run-ide-e2e-remote.sh
#
# 选项:
#   --password PASSWORD    SSH 密码 (需要 sshpass)
#   --deploy-only          只部署脚本, 不运行测试
#   --skip-deploy          跳过部署, 直接运行测试 (脚本已在远端)
#
# 环境变量:
#   REMOTE_HOST            user@host (也可作为第一个位置参数)
#   REMOTE_PASS            SSH 密码 (也可用 --password)
#   REMOTE_PORT            SSH 端口 (默认 22)
#   IDE_E2E_TOOLS          透传: 逗号分隔的工具列表
#   IDE_E2E_PROMPT         透传: 自定义测试 prompt
#   IDE_E2E_FLUSH_TIMEOUT  透传: pilot flush 超时秒数
#   IDE_E2E_JSONL_STRICT   透传: 设为 1 则 JSONL 问题导致失败
#
# 前提:
#   - 远端 IDE 已在桌面环境运行 (需通过 RDP 手动启动)
#   - 远端已安装: loongsuite-pilot, python3, websockets, node
#   - Windows 远端需要安装 Git Bash
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REMOTE_DIR="ide-e2e"

# 需要部署到远端的脚本
DEPLOY_FILES=(
  "$SCRIPT_DIR/ai-chat.sh"
  "$SCRIPT_DIR/run-ide-e2e.sh"
  "$SCRIPT_DIR/enable-cursor-cdp.sh"
)

# ── 日志 ──

log()  { echo "[remote-e2e] $*"; }
ok()   { echo "[remote-e2e] ✓ $*"; }
fail() { echo "[remote-e2e] ✗ $*"; }
die()  { fail "$@"; exit 1; }

# ── 参数解析 ──

DEPLOY_ONLY=false
SKIP_DEPLOY=false
HOST="${REMOTE_HOST:-}"
PASS="${REMOTE_PASS:-}"
PORT="${REMOTE_PORT:-22}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --password)    PASS="$2"; shift 2 ;;
    --deploy-only) DEPLOY_ONLY=true; shift ;;
    --skip-deploy) SKIP_DEPLOY=true; shift ;;
    --port)        PORT="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,/^# =====/{ /^#/s/^# \?//p }' "$0"
      exit 0
      ;;
    *)
      if [[ -z "$HOST" && "$1" == *@* ]]; then
        HOST="$1"; shift
      else
        die "未知参数: $1  (用 --help 查看用法)"
      fi
      ;;
  esac
done

[[ -z "$HOST" ]] && die "需要指定远程主机: run-ide-e2e-remote.sh user@host --password PASSWORD"

# ── SSH/SCP 命令构建 ──

SSH_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=10 -p "$PORT")
SCP_OPTS=(-o StrictHostKeyChecking=no -P "$PORT")

if [[ -n "$PASS" ]]; then
  if ! command -v sshpass >/dev/null 2>&1; then
    die "使用密码登录需要 sshpass。安装: brew install sshpass 或 apt install sshpass"
  fi
  # 用 SSHPASS 环境变量传密码(sshpass -e),避免明文出现在进程命令行(ps aux 可见)
  export SSHPASS="$PASS"
  SSH_CMD=(sshpass -e ssh "${SSH_OPTS[@]}")
  SCP_CMD=(sshpass -e scp "${SCP_OPTS[@]}")
else
  SSH_CMD=(ssh "${SSH_OPTS[@]}")
  SCP_CMD=(scp "${SCP_OPTS[@]}")
fi

# 远端执行命令 (自动检测 Windows 并用 Git Bash)
REMOTE_OS=""
REMOTE_SHELL_PREFIX=""

remote_exec() {
  if [[ -n "$REMOTE_SHELL_PREFIX" ]]; then
    echo "$1" | "${SSH_CMD[@]}" "$HOST" "$REMOTE_SHELL_PREFIX"
  else
    "${SSH_CMD[@]}" "$HOST" "$1"
  fi
}

# ── Phase 1: 连接 & OS 检测 ──

log "=== Remote IDE E2E Test ==="
log "Host: $HOST"
log ""

log "[1/5] 连接远端..."

OS_RAW=$("${SSH_CMD[@]}" "$HOST" "uname -s 2>/dev/null || echo UNKNOWN" 2>/dev/null) || die "SSH 连接失败: $HOST"

case "$OS_RAW" in
  Darwin)
    REMOTE_OS="macos"
    ;;
  Linux)
    REMOTE_OS="linux"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    REMOTE_OS="windows"
    ;;
  *)
    # Windows OpenSSH 默认用 cmd.exe, uname 不可用
    # 尝试检测 Windows
    WIN_CHECK=$("${SSH_CMD[@]}" "$HOST" "echo %OS%" 2>/dev/null || echo "")
    if [[ "$WIN_CHECK" == *"Windows"* ]]; then
      REMOTE_OS="windows"
    else
      REMOTE_OS="linux"
    fi
    ;;
esac

if [[ "$REMOTE_OS" == "windows" ]]; then
  REMOTE_SHELL_PREFIX='"C:\Program Files\Git\bin\bash.exe" -l -s'
  # 验证 Git Bash 可用
  remote_exec "echo git-bash-ok" >/dev/null 2>&1 || die "远端未安装 Git Bash (C:\\Program Files\\Git)"
fi

ok "连接成功 (OS: $REMOTE_OS)"

# ── Phase 2: 部署脚本 ──

if [[ "$SKIP_DEPLOY" == "true" ]]; then
  log "[2/5] 跳过部署 (--skip-deploy)"
else
  log "[2/5] 部署脚本到远端 ~/$REMOTE_DIR/ ..."

  # 创建远端目录
  remote_exec "mkdir -p ~/$REMOTE_DIR" >/dev/null 2>&1

  # scp 部署
  for f in "${DEPLOY_FILES[@]}"; do
    if [[ ! -f "$f" ]]; then
      die "本地文件不存在: $f"
    fi
    "${SCP_CMD[@]}" "$f" "$HOST:$REMOTE_DIR/" || die "scp 失败: $(basename "$f")"
  done
  ok "已部署 ${#DEPLOY_FILES[@]} 个文件"
fi

if [[ "$DEPLOY_ONLY" == "true" ]]; then
  ok "部署完成 (--deploy-only)"
  exit 0
fi

# ── Phase 3: 远端依赖检查 ──

log "[3/5] 检查远端依赖..."

PREFLIGHT_SCRIPT='
MISSING=""
HAS_PYTHON3=false

# Python3 路径探测 (Windows 常见位置)
for p in \
  "$HOME/AppData/Local/Programs/Python/Python312" \
  "$HOME/AppData/Local/Programs/Python/Python311" \
  "$HOME/AppData/Local/Programs/Python/Python310" \
  "$HOME/AppData/Local/Programs/Python/Python39" \
  "/usr/bin" "/usr/local/bin"; do
  if [[ -x "$p/python3" ]] || [[ -x "$p/python3.exe" ]]; then
    export PATH="$p:$p/Scripts:$PATH"
    break
  fi
done

echo "CHECK_START"

# python3
if command -v python3 >/dev/null 2>&1; then
  echo "HAVE python3 $(python3 --version 2>&1)"
  HAS_PYTHON3=true
else
  echo "MISS python3"
fi

# websockets
if $HAS_PYTHON3 && python3 -c "import websockets" 2>/dev/null; then
  echo "HAVE websockets"
else
  echo "MISS websockets (pip3 install websockets)"
fi

# node
if command -v node >/dev/null 2>&1; then
  echo "HAVE node $(node --version 2>&1)"
else
  echo "MISS node"
fi

# jq
if command -v jq >/dev/null 2>&1; then
  echo "HAVE jq"
else
  echo "MISS jq"
fi

# pilot
if command -v loongsuite-pilot >/dev/null 2>&1; then
  echo "HAVE loongsuite-pilot $(loongsuite-pilot status 2>&1 | head -1)"
else
  echo "MISS loongsuite-pilot"
fi

echo "CHECK_END"
'

PREFLIGHT_OUT=$(remote_exec "$PREFLIGHT_SCRIPT" 2>/dev/null)
HAS_CRITICAL_MISS=false

while IFS= read -r line; do
  case "$line" in
    HAVE*)  ok "  ${line#HAVE }" ;;
    MISS*)
      fail "  缺少: ${line#MISS }"
      # python3, node, pilot 是必须的
      case "$line" in
        *python3*|*node*|*loongsuite-pilot*) HAS_CRITICAL_MISS=true ;;
      esac
      ;;
  esac
done <<< "$(echo "$PREFLIGHT_OUT" | sed -n '/CHECK_START/,/CHECK_END/p' | grep -v CHECK_)"

if [[ "$HAS_CRITICAL_MISS" == "true" ]]; then
  die "缺少关键依赖, 请先在远端安装"
fi

# ── Phase 4: Pilot 管理 & 运行测试 ──

log "[4/5] 启动 pilot 并运行测试..."

# 构建远端 env vars
ENV_EXPORTS=""

# Python3 PATH 注入
ENV_EXPORTS+='
for p in \
  "$HOME/AppData/Local/Programs/Python/Python312" \
  "$HOME/AppData/Local/Programs/Python/Python311" \
  "$HOME/AppData/Local/Programs/Python/Python310" \
  "$HOME/AppData/Local/Programs/Python/Python39"; do
  if [[ -x "$p/python3" ]] || [[ -x "$p/python3.exe" ]]; then
    export PATH="$p:$p/Scripts:$PATH"
    break
  fi
done
'

# Windows: 强制 CDP 模式
if [[ "$REMOTE_OS" == "windows" ]]; then
  ENV_EXPORTS+='export QODER_IDE_CDP=true
export CURSOR_CDP=true
'
fi

# 安全转义:用 bash 原生 printf %q,避免值含撇号/引号/$/反引号时破坏远端脚本语法或注入。
# 远端统一由 bash 执行(Windows 走 Git Bash),%q 输出对 bash 可安全重新解析。
shq() { printf '%q' "$1"; }

# 透传用户指定的环境变量(值经安全转义)
[[ -n "${IDE_E2E_TOOLS:-}" ]]         && ENV_EXPORTS+="export IDE_E2E_TOOLS=$(shq "$IDE_E2E_TOOLS")
"
[[ -n "${IDE_E2E_PROMPT:-}" ]]        && ENV_EXPORTS+="export IDE_E2E_PROMPT=$(shq "$IDE_E2E_PROMPT")
"
[[ -n "${IDE_E2E_FLUSH_TIMEOUT:-}" ]] && ENV_EXPORTS+="export IDE_E2E_FLUSH_TIMEOUT=$(shq "$IDE_E2E_FLUSH_TIMEOUT")
"
[[ -n "${IDE_E2E_JSONL_STRICT:-}" ]]  && ENV_EXPORTS+="export IDE_E2E_JSONL_STRICT=$(shq "$IDE_E2E_JSONL_STRICT")
"

TEST_SCRIPT="
$ENV_EXPORTS

# 确保 pilot 在运行
if ! loongsuite-pilot status >/dev/null 2>&1; then
  echo '[remote-e2e] pilot 未运行, 正在启动...'
  loongsuite-pilot start >/dev/null 2>&1 || true
  sleep 3
  if loongsuite-pilot status >/dev/null 2>&1; then
    echo '[remote-e2e] ✓ pilot 已启动'
  else
    echo '[remote-e2e] ✗ pilot 启动失败'
    exit 1
  fi
fi

cd ~/$REMOTE_DIR
bash run-ide-e2e.sh
"

# 执行测试, 同时透传输出
REMOTE_EXIT=0
remote_exec "$TEST_SCRIPT" || REMOTE_EXIT=$?

# ── Phase 5: 结果摘要 ──

log ""
log "============================================"
if [[ "$REMOTE_EXIT" -eq 0 ]]; then
  ok "Remote IDE E2E PASSED ($HOST)"
else
  fail "Remote IDE E2E FAILED ($HOST, exit=$REMOTE_EXIT)"
fi
log "============================================"

exit "$REMOTE_EXIT"
