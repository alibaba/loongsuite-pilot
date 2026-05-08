#!/bin/bash

# 更稳健的 shell 行为：保留显式错误处理，不使用 -e 以便单个失败不影响批量
set -o pipefail

# ---------------- 配置 ----------------
PATCHELF_BIN="$HOME/.local/bin/patchelf"
NEW_INTERPRETER="$HOME/.local/sysroot/lib/ld-2.28.so"
NEW_RPATH="$HOME/.local/sysroot/lib"

# 服务器 bin 根目录（包含按版本哈希分隔的子目录）
ALL_SERVER_DIRS=(
  "${HOME}/.vscode-server/bin"
  "${HOME}/.kiro-server/bin"
  "${HOME}/.cursor-server/bin"
  "${HOME}/.qoder-server/bin"
)

# NVM Node.js 根目录
NVM_DIR="$HOME/.nvm/versions/node"

# 选项
DRY_RUN=false
VERIFY=false
SERVER_DIRS=("${ALL_SERVER_DIRS[@]}")
PROCESS_NVM=true

usage() {
  cat <<'EOF'
用法: ./node_patch.sh [选项]

选项：
  -n, --dry-run      仅显示将要执行的变更，不实际写入
  -v, --verify       每个目标完成后运行 ldd 简要校验
      --vscode-only  仅处理 ${HOME}/.vscode-server/bin 下的版本
      --kiro-only    仅处理 ${HOME}/.kiro-server/bin 下的版本
      --cursor-only  仅处理 ${HOME}/.cursor/bin 下的版本
      --qoder-only   仅处理 ${HOME}/.qoder-server/bin 下的版本
      --nvm-only     仅处理 nvm 安装的 Node.js 版本
  -h, --help         显示本帮助

本脚本会以批量方式为以下路径结构的所有版本执行 patchelf：
  ${HOME}/.vscode-server/bin/<hash>/node
  ${HOME}/.kiro-server/bin/<hash>/node
  ${HOME}/.cursor-server/bin/<hash>/node
  ${HOME}/.qoder-server/bin/<hash>/node
  ~/.nvm/versions/node/<version>/bin/node

将写入：
  Interpreter = $HOME/.local/sysroot/lib/ld-2.28.so
  RPATH       = $HOME/.local/sysroot/lib
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--dry-run) DRY_RUN=true ;;
    -v|--verify)  VERIFY=true ;;
    --vscode-only)  
      SERVER_DIRS=("${HOME}/.vscode-server/bin")
      PROCESS_NVM=false
      ;;
    --kiro-only)  
      SERVER_DIRS=("${HOME}/.kiro-server/bin")
      PROCESS_NVM=false
      ;;
    --cursor-only)
      SERVER_DIRS=("${HOME}/.cursor-server/bin")
      PROCESS_NVM=false
      ;;
    --qoder-only) 
      SERVER_DIRS=("${HOME}/.qoder-server/bin")
      PROCESS_NVM=false
      ;;
    --nvm-only)   
      SERVER_DIRS=()
      PROCESS_NVM=true
      ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "未知参数: $1"; usage; exit 1 ;;
  esac
  shift
done

# ---------------- 预检查与依赖安装 ----------------
install_dependencies() {
  local INSTALL_DIR="$HOME"
  local FILENAME="x86_64-linux-4_19_90-gnu-glibc-2.28_patchelf.tar.gz"
  local DOWNLOAD_URL="https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/prebuilt-dependencies/$FILENAME"
  local EXPECTED_MD5="3bce6290e580d0f7f12555b3f364b521"

  echo "开始安装依赖..."
  echo "安装目录设置为: $INSTALL_DIR"

  cd "$INSTALL_DIR" || { echo "错误：无法切换到目录 $INSTALL_DIR"; return 1; }

  if [ ! -f "$FILENAME" ]; then
    echo "正在下载 $FILENAME ..."
    wget "$DOWNLOAD_URL" -O "$FILENAME" || { echo "错误：下载文件失败。"; return 1; }
    echo "下载完成。"
  else
    echo "检测到已存在压缩包，跳过下载：$FILENAME"
  fi

  echo "正在校验 $FILENAME 的 MD5 ..."
  local ACTUAL_MD5
  ACTUAL_MD5=$(md5sum "$FILENAME" | cut -d ' ' -f 1)
  if [ "$ACTUAL_MD5" != "$EXPECTED_MD5" ]; then
    echo "错误：MD5 校验失败！"
    echo "期望值: $EXPECTED_MD5"
    echo "实际值: $ACTUAL_MD5"
    return 1
  fi
  echo "MD5 校验成功。"

  echo "正在解压 $FILENAME ..."
  tar -xzf "$FILENAME" -C "$INSTALL_DIR" || { echo "错误：解压文件失败。"; return 1; }
  echo "解压完成。"

  echo "依赖安装完成。"
  return 0
}

need_install=false
[[ ! -x "$PATCHELF_BIN" ]] && need_install=true
[[ ! -f "$NEW_INTERPRETER" ]] && need_install=true
[[ ! -d "$NEW_RPATH" ]] && need_install=true

if [[ "$need_install" == true ]]; then
  if [[ "$DRY_RUN" == true ]]; then
    echo "检测到依赖缺失，但当前为 dry-run 模式。请去掉 --dry-run 后再执行以自动安装依赖。"
    exit 1
  fi
  install_dependencies || { echo "错误：依赖安装失败。"; exit 1; }
fi

# 安装后复检
if [[ ! -x "$PATCHELF_BIN" ]]; then
  echo "错误：patchelf 工具未找到或不可执行：$PATCHELF_BIN"
  exit 1
fi
if [[ ! -f "$NEW_INTERPRETER" ]]; then
  echo "错误：新的解释器不存在：$NEW_INTERPRETER"
  exit 1
fi
if [[ ! -d "$NEW_RPATH" ]]; then
  echo "错误：新的 RPATH 目录不存在：$NEW_RPATH"
  exit 1
fi

# bash 通配无匹配时返回空数组而非字面量
shopt -s nullglob

patch_one() {
  local binary_path="$1"
  local version_dir
  version_dir="$(dirname "$binary_path")"
  local version_hash
  version_hash="$(basename "$version_dir")"

  echo "----------------------------------------"
  echo "目标: $binary_path"
  echo "版本: $version_hash"

  if [[ "$DRY_RUN" == true ]]; then
    echo "[dry-run] $PATCHELF_BIN --set-interpreter $NEW_INTERPRETER $binary_path"
    echo "[dry-run] $PATCHELF_BIN --set-rpath $NEW_RPATH $binary_path"
    return 0
  fi

  "$PATCHELF_BIN" --set-interpreter "$NEW_INTERPRETER" "$binary_path"
  local rc1=$?
  if [[ $rc1 -ne 0 ]]; then
    echo "错误：设置解释器失败 (rc=$rc1)"
    return $rc1
  fi

  "$PATCHELF_BIN" --set-rpath "$NEW_RPATH" "$binary_path"
  local rc2=$?
  if [[ $rc2 -ne 0 ]]; then
    echo "错误：设置 RPATH 失败 (rc=$rc2)"
    return $rc2
  fi

  if [[ "$VERIFY" == true ]]; then
    echo "验证 ldd 输出（节选）："
    ldd "$binary_path" | sed -n '1,20p'
  fi

  return 0
}

# ---------------- 主流程 ----------------
# 收集所有需要处理的 node 可执行文件
all_nodes=()

# 收集服务器目录中的 Node.js
for base_dir in "${SERVER_DIRS[@]}"; do
  if [[ ! -d "$base_dir" ]]; then
    echo "提示：目录不存在，跳过：$base_dir"
    continue
  fi
  
  echo "扫描目录：$base_dir"
  # 结构: base_dir/<hash>/node
  nodes=( "$base_dir"/*/node )
  if [[ ${#nodes[@]} -eq 0 ]]; then
    echo "在 $base_dir 下未发现任何 node 可执行文件"
    continue
  fi
  
  all_nodes+=( "${nodes[@]}" )
done

# 收集 nvm 安装的 Node.js
if [[ "$PROCESS_NVM" == true ]] && [[ -d "$NVM_DIR" ]]; then
  echo "扫描 nvm Node.js 版本目录：$NVM_DIR"
  # 结构: NVM_DIR/<version>/bin/node
  nvm_nodes=( "$NVM_DIR"/*/bin/node )
  if [[ ${#nvm_nodes[@]} -eq 0 ]]; then
    echo "在 $NVM_DIR 下未发现任何 node 可执行文件"
  else
    all_nodes+=( "${nvm_nodes[@]}" )
  fi
elif [[ "$PROCESS_NVM" == true ]] && [[ ! -d "$NVM_DIR" ]]; then
  echo "提示：NVM 目录不存在，跳过 nvm Node.js 处理：$NVM_DIR"
fi

# 处理所有收集到的 node 可执行文件
total=0
success=0
failed=0

echo "========================================"
echo "总共找到 ${#all_nodes[@]} 个 node 可执行文件需要处理"

for node_bin in "${all_nodes[@]}"; do
  if [[ ! -f "$node_bin" ]]; then
    continue
  fi
  ((total++))
  if patch_one "$node_bin"; then
    ((success++))
  else
    ((failed++))
  fi
done

echo "========================================"
echo "处理完成：总计 $total，成功 $success，失败 $failed"
if [[ "$DRY_RUN" == true ]]; then
  echo "注意：dry-run 模式未对任何文件进行实际修改。"
fi

if [[ $failed -ne 0 ]]; then
  exit 2
fi

exit 0
