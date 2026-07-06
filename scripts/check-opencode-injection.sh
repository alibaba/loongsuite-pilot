#!/usr/bin/env bash
#
# check-opencode-injection.sh
# ---------------------------------------------------------------------------
# 独立检测脚本：判断本机 loongsuite-pilot 是否已为 OpenCode 注入采集能力。
# 零依赖，拷贝到目标机器直接运行即可：
#
#     bash check-opencode-injection.sh
#
# 退出码：
#   0  = 已注入且已产出采集数据（链路完全打通）
#   1  = 已注入但尚未产出数据（配置就绪，等待一次真实会话）
#   2  = 未注入 / 注入不完整
# ---------------------------------------------------------------------------

set -u

# ---- 颜色（非 TTY 时自动关闭）----
if [ -t 1 ]; then
  RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLU=$'\033[36m'; BLD=$'\033[1m'; RST=$'\033[0m'
else
  RED=''; GRN=''; YLW=''; BLU=''; BLD=''; RST=''
fi

ok()   { printf "  ${GRN}✔${RST} %s\n" "$1"; }
warn() { printf "  ${YLW}!${RST} %s\n" "$1"; }
bad()  { printf "  ${RED}✘${RST} %s\n" "$1"; }
hdr()  { printf "\n${BLD}${BLU}== %s ==${RST}\n" "$1"; }

# ---- 路径解析 ----
PILOT_DATA="${LOONGSUITE_PILOT_DATA_DIR:-$HOME/.loongsuite-pilot}"
PLUGIN_FILE="$PILOT_DATA/plugins/opencode/plugin.mjs"
LOG_DIR="$PILOT_DATA/logs/opencode"
MARKERS='loongsuite-pilot-opencode|plugins/opencode/plugin.mjs'
CFG_CANDIDATES=(
  "$HOME/.config/opencode/opencode.jsonc"
  "$HOME/.config/opencode/opencode.json"
  "$HOME/.config/opencode/config.json"
)

printf "${BLD}OpenCode 采集注入检测${RST}\n"
printf "主机: %s   用户: %s   时间: %s\n" "$(hostname 2>/dev/null || echo '?')" "$(whoami 2>/dev/null || echo '?')" "$(date '+%Y-%m-%d %H:%M:%S')"
printf "PILOT_DATA: %s\n" "$PILOT_DATA"

config_injected=0
plugin_ready=0
logs_present=0

# ---- 1) OpenCode 配置是否注入插件 spec ----
hdr "1) OpenCode 配置注入"
found_cfg=""
for f in "${CFG_CANDIDATES[@]}"; do
  [ -f "$f" ] || continue
  found_cfg="yes"
  if grep -Eq "$MARKERS" "$f" 2>/dev/null; then
    ok "已注入: $f"
    grep -En "$MARKERS" "$f" 2>/dev/null | sed 's/^/       /'
    config_injected=1
  else
    warn "存在但未注入 pilot 插件: $f"
  fi
done
if [ -z "$found_cfg" ]; then
  bad "未找到任何 OpenCode 配置文件（检查过: ${CFG_CANDIDATES[*]}）"
  warn "可能 OpenCode 从未启动过，或配置目录不在默认位置"
fi

# ---- 2) 注入目标插件文件是否就绪 ----
hdr "2) 插件文件"
if [ -f "$PLUGIN_FILE" ]; then
  size=$(wc -c < "$PLUGIN_FILE" 2>/dev/null | tr -d ' ')
  mtime=$(date -r "$PLUGIN_FILE" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo '?')
  ok "存在: $PLUGIN_FILE (${size} bytes, 更新于 ${mtime})"
  plugin_ready=1
else
  bad "缺失: $PLUGIN_FILE"
  warn "pilot 尚未部署插件文件，注入的 spec 会指向一个不存在的文件"
fi

# ---- 3) 是否已真正产出采集数据（最可信）----
hdr "3) 采集数据 (JSONL)"
if [ -d "$LOG_DIR" ]; then
  jsonl_count=$(find "$LOG_DIR" -maxdepth 1 -name 'opencode-*.jsonl' -type f 2>/dev/null | grep -vc 'error' )
  # 上一行在无匹配时 grep 返回 0 计数，稳妥起见重算：
  jsonl_files=$(find "$LOG_DIR" -maxdepth 1 -name 'opencode-*.jsonl' ! -name '*error*' -type f 2>/dev/null)
  if [ -n "$jsonl_files" ]; then
    logs_present=1
    total_lines=0
    while IFS= read -r jf; do
      [ -n "$jf" ] || continue
      lc=$(wc -l < "$jf" 2>/dev/null | tr -d ' ')
      total_lines=$((total_lines + lc))
      ok "$(basename "$jf"): ${lc} 条记录"
    done <<< "$jsonl_files"
    latest=$(find "$LOG_DIR" -maxdepth 1 -name 'opencode-*.jsonl' ! -name '*error*' -type f -exec ls -t {} + 2>/dev/null | head -1)
    if [ -n "$latest" ]; then
      printf "  ${BLU}最新一条记录预览:${RST}\n"
      tail -1 "$latest" 2>/dev/null | cut -c1-200 | sed 's/^/       /'
      printf "       ...\n"
    fi
    printf "  合计: ${BLD}%s${RST} 条采集记录\n" "$total_lines"
  else
    warn "日志目录存在但为空: $LOG_DIR"
    warn "说明: 注入已就绪，但注入后还没有真实跑过 OpenCode 会话"
  fi

  # 错误日志
  err_files=$(find "$LOG_DIR" -maxdepth 1 -name 'opencode-error-*.log' -type f 2>/dev/null)
  if [ -n "$err_files" ]; then
    printf "\n  ${YLW}发现插件错误日志:${RST}\n"
    while IFS= read -r ef; do
      [ -n "$ef" ] || continue
      warn "$(basename "$ef") (最后 3 行):"
      tail -3 "$ef" 2>/dev/null | sed 's/^/       /'
    done <<< "$err_files"
  fi
else
  warn "日志目录不存在: $LOG_DIR"
  warn "说明: 插件从未写过数据（未运行过，或注入未生效）"
fi

# ---- 环境信息 ----
hdr "环境信息"
if command -v opencode >/dev/null 2>&1; then
  ok "opencode 已安装: $(command -v opencode)"
  ver=$(opencode --version 2>/dev/null | head -1)
  [ -n "$ver" ] && printf "       版本: %s\n" "$ver"
else
  warn "PATH 中未找到 opencode 命令（不影响已注入的判断）"
fi

# ---- 结论 ----
hdr "结论"
if [ "$config_injected" -eq 1 ] && [ "$plugin_ready" -eq 1 ] && [ "$logs_present" -eq 1 ]; then
  printf "  ${GRN}${BLD}✔ 已注入且采集链路已打通${RST}（配置✔ 文件✔ 数据✔）\n"
  exit 0
elif [ "$config_injected" -eq 1 ] && [ "$plugin_ready" -eq 1 ]; then
  printf "  ${YLW}${BLD}! 已注入，等待数据${RST}（配置✔ 文件✔ 数据✘）\n"
  printf "  下一步: 正常用 opencode 发起一轮对话后重新运行本脚本，应能看到 JSONL 记录。\n"
  exit 1
else
  printf "  ${RED}${BLD}✘ 未注入 / 注入不完整${RST}"
  printf "（配置%s 文件%s 数据%s）\n" \
    "$( [ "$config_injected" -eq 1 ] && echo '✔' || echo '✘')" \
    "$( [ "$plugin_ready" -eq 1 ] && echo '✔' || echo '✘')" \
    "$( [ "$logs_present" -eq 1 ] && echo '✔' || echo '✘')"
  printf "  下一步: 确认 loongsuite-pilot 已启动并成功执行过部署（deployAll）。\n"
  exit 2
fi
