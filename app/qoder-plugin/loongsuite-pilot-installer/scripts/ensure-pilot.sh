#!/usr/bin/env bash
# loongsuite-pilot-installer 插件 SessionStart hook：
# 幂等检测并安装 loongsuite-pilot。node 运行时由 installer 自行准备，本 hook 不再管。
# 管理员参数从 config/install-params.conf 读取并透传给 installer。
# 用法：ensure-pilot.sh
set -uo pipefail

PLUGIN_ROOT="${QODER_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DATA_DIR="${QODER_PLUGIN_DATA:-$HOME/.loongsuite-pilot-installer}"
LOG_FILE="$DATA_DIR/install.log"
LOCK_DIR="$DATA_DIR/install.lock"
PILOT_BIN="$HOME/.local/bin/loongsuite-pilot"
PILOT_HOME="$HOME/.loongsuite-pilot"   # pilot 数据目录（默认），内含 pid 文件，用于判活

# ---- 插件内置常量：安装器地址（由维护者维护，管理员无需配置） ----
INSTALLER_URL="https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh"

# ---- 管理员参数：仅 INSTALL_ARGS 从 config/install-params.conf 读取 ----
INSTALL_ARGS=()
CONF="$PLUGIN_ROOT/config/install-params.conf"
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"
# --user.id 追加覆盖：installer 顺序解析参数，后出现者生效
# 来源优先级：管理员显式覆盖 > Qoder 注入的 QODER_USER_ID > 解析 hook stdin 的 extra.user.uid
# QODER_USER_ID 仅在 hook 运行时由 Qoder 注入到进程环境（交互 shell 里没有），与 stdin payload 同源
USER_ID="${LOONGSUITE_PILOT_USER_ID:-${QODER_USER_ID:-}}"
# 仅当 stdin 是管道（hook 运行时）才读，避免终端里手动执行时 cat 阻塞
if [ -z "$USER_ID" ] && [ ! -t 0 ]; then
    USER_ID=$(cat 2>/dev/null \
        | grep -o '"uid"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 \
        | sed 's/.*:[[:space:]]*"//;s/"$//')
fi
if [ -n "$USER_ID" ]; then
    INSTALL_ARGS+=(--user.id "$USER_ID")
fi

mkdir -p "$DATA_DIR"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

# Windows 下若本脚本被 Git Bash 拉起，直接让位给 PowerShell hook，避免重复安装
case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) exit 0 ;;
esac

# ---- 参数指纹：判断"要装的参数是否和上次一致"。installer 对 config.json 是合并语义，
# 参数变更时重新 install 覆盖即可（installer 自身会停旧进程 + merge + 重启，故不再 uninstall --purge）。
# 指纹不再单独决定退出：还要结合 pilot 是否在运行，避免"装过但进程已死"被误判为无需处理 ----
FINGERPRINT_FILE="$DATA_DIR/install-args.sha256"

compute_fingerprint() {
    local payload
    payload="url=$INSTALLER_URL"$'\n'"$(printf '%s\n' ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"})"
    if command -v shasum >/dev/null 2>&1; then
        printf '%s' "$payload" | shasum -a 256 | awk '{print $1}'
    else
        printf '%s' "$payload" | sha256sum | awk '{print $1}'
    fi
}

CURRENT_FP=$(compute_fingerprint)

is_installed() {
    [ -x "$PILOT_BIN" ] || [ -x /usr/local/bin/loongsuite-pilot ]
}

fingerprint_matches() {
    [ -f "$FINGERPRINT_FILE" ] && [ "$(cat "$FINGERPRINT_FILE" 2>/dev/null)" = "$CURRENT_FP" ]
}

# pilot 是否在运行：读 pidfile + kill -0（与 installer 自身判活方式一致，毫秒级，不 spawn node）
is_running() {
    local pid
    pid=$(cat "$PILOT_HOME/loongsuite-pilot.pid" 2>/dev/null) || return 1
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# 已安装的可执行路径（~/.local/bin 优先，回退 /usr/local/bin）
pilot_cmd() {
    if [ -x "$PILOT_BIN" ]; then echo "$PILOT_BIN"
    elif [ -x /usr/local/bin/loongsuite-pilot ]; then echo /usr/local/bin/loongsuite-pilot
    fi
}

# ---- run_install：重活（抢锁 + 下载 installer + install + 写指纹；node 由 installer 自备）----
# 由 detach 出的后台子进程（--run-install）执行：脱离 CLI 进程树，不随会话退出而中断，
# 也不占用 hook 返回时间。首次/重装可能数分钟，全在这里。
run_install() {
    # 并发锁：多会话同时启动时只允许一个实例执行安装。
    # 锁目录内写入持锁进程 PID；接管前先判活——只有 PID 确实已死（进程被杀/重启后残留）
    # 才回收。detach 出的安装进程脱离了 CLI、不受 hook 900s 约束，慢装存活时绝不能按时间
    # 误判回收，否则会拉起第二个并发 install 抢写 config.json。TTL 仅兜底“读不到 PID”的
    # 极端情况（如刚 mkdir 尚未写入、pid 文件损坏）：读不到 PID 且超过 15 分钟才强制回收。
    if [ -d "$LOCK_DIR" ]; then
        local lock_pid expired=""
        lock_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
        [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +15 2>/dev/null)" ] && expired=1
        if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
            log "另一实例（pid=$lock_pid）正在安装，跳过"
            return 0
        fi
        if [ -z "$lock_pid" ] && [ -z "$expired" ]; then
            log "锁刚建立（持有者 PID 写入中），跳过"
            return 0
        fi
        log "接管失效锁（pid=${lock_pid:-未知}）"
        rm -rf "$LOCK_DIR" 2>/dev/null || true
    fi
    if ! mkdir "$LOCK_DIR" 2>/dev/null; then
        log "另一实例正在安装，跳过"
        return 0
    fi
    echo "$$" > "$LOCK_DIR/pid"
    # 仅释放自己持有的锁：校验锁内 PID == 自己，避免误删被其它实例接管后重建的锁
    trap '[ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$$" ] && rm -rf "$LOCK_DIR" 2>/dev/null || true' EXIT

    # 拿到锁后重新判定：可能另一实例已经装好了相同配置（并已 start）
    if is_installed && fingerprint_matches; then
        return 0
    fi

    # 未安装 → 直接装；已装但指纹不一致 → 重新 install 覆盖（不再 uninstall --purge）
    if is_installed; then
        log "已安装但参数指纹不一致，按新配置重新 install（install 会停旧进程并 merge 覆盖）"
    fi

    log "installer: $INSTALLER_URL"
    log "install args: ${INSTALL_ARGS[*]+${INSTALL_ARGS[*]}}"

    # ---- 下载 installer ----
    local installer_tmp="$DATA_DIR/installer.sh"
    if ! curl -fsSL "$INSTALLER_URL" -o "$installer_tmp" 2>>"$LOG_FILE"; then
        log "❌ installer 下载失败: $INSTALLER_URL"
        return 1
    fi

    # stdin 必须接 /dev/null：installer 用 [ ! -t 0 ] 判非交互，继承的 stdin 一旦阻塞会挂死
    if bash "$installer_tmp" install ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"} < /dev/null >> "$LOG_FILE" 2>&1; then
        printf '%s' "$CURRENT_FP" > "$FINGERPRINT_FILE"
        local status; status=$("$PILOT_BIN" status 2>&1 || true)
        log "✅ 安装完成。status: $status"
    else
        log "❌ installer 执行失败"
        return 1
    fi
}

# ---- detached 子进程入口：直接执行重活，跳过下面的快路径/detach，避免 fork 炸弹 ----
if [ "${1:-}" = "--run-install" ]; then
    run_install
    exit $?
fi

# ---- 幂等快路径（每次会话启动都会触发本 hook，毫秒级）----
# 已安装 + 参数未变：在跑则秒过；进程已死则直接 start 复活（秒级，无需重新下载/安装）
if is_installed && fingerprint_matches; then
    is_running && exit 0
    log "已安装且参数未变，但服务未运行，尝试拉起"
    CMD=$(pilot_cmd)
    if [ -n "$CMD" ] && "$CMD" start < /dev/null >> "$LOG_FILE" 2>&1; then
        log "✅ 服务已拉起"
    else
        log "⚠️ 服务拉起失败，详见日志"
    fi
    exit 0
fi

# ---- 需要安装/重装：detach 出后台子进程执行重活，hook 立即返回 ----
# 好处：① 不阻塞会话 ② 分钟级安装不随 CLI 退出被腰斩（脱离进程组 + 忽略 SIGHUP）
# uid 靠 env 传给子进程：子进程无 stdin payload，无法再从 stdin 解析 extra.user.uid
export LOONGSUITE_PILOT_USER_ID="$USER_ID"
log "触发后台安装/重装，detach 子进程执行"
if command -v setsid >/dev/null 2>&1; then
    ( setsid bash "$0" --run-install >>"$LOG_FILE" 2>&1 </dev/null & )
else
    # mac 无 setsid：nohup 忽略 SIGHUP + 子 shell 立即退出，使子进程 reparent 到 launchd
    ( nohup bash "$0" --run-install >>"$LOG_FILE" 2>&1 </dev/null & )
fi
# stdout 作为 SessionStart 附加上下文注入对话，让用户知道正在后台安装
echo "loongsuite-pilot 正在后台自动安装，完成后自动生效（详见 $LOG_FILE）"
exit 0
