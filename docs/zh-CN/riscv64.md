# Linux RISC-V64

[English](../riscv64.md) | 简体中文

本分支增加 Linux `riscv64` 安装、服务管理和安装态验收，并适配当前主干 #444 的 `node:sqlite` 实现。改动尚未发布；正式发布前使用同一 checkout 的安装器和安装包。本地验证、上游 CI 和发布状态分别记录。

## 运行时与依赖要求

Pilot 需要无需额外启动参数即可加载 `node:sqlite` 的 RISC-V Node.js，以及 npm。Node 22 系列的 22.13+、23 系列的 23.4+ 或合适的更新版本可以满足要求，最终以真实加载探针为准。Node 18/20、较早的 22/23 和不含 SQLite 的构建，在安装或升级启用前会被拒绝。检查要使用的运行时：

```bash
uname -m
node -p 'process.platform + "/" + process.arch + " " + process.version'
node -e "require('node:sqlite')"
npm --version
```

两个架构探针均应为 `riscv64`。安装器在覆盖运行时 pin 前拒绝错误架构。本改动不下载 RISC-V 托管运行时，需自行准备合适的系统 Node/npm 并加入 PATH。

SQLite 由 Node 提供，Pilot 不再编译或加载 `sqlite3` 原生模块。依赖中的 `sqlite3` 指向 `compat/sqlite3`：这是一个空 JavaScript 兼容包，仅保留旧更新器的 `require('sqlite3')` 检查，不实现 SQLite API，公开包必须保留它。当前主干已经移除 `zstd-napi`，不再安装。此安装路径不需要原生模块编译器或 N-API 版本选择。

所有架构都将内置 SQLite 缺失视为启动失败，不再提供“关闭 SQLite 后继续采集”的降级模式。启动会记录 fatal 诊断；升级探针失败不启用候选版本。修复时选择含内置 SQLite 的 Node，再以 `--prefer-system-node` 重跑安装器。旧 PR 在 Node18 下采集成功，不能证明当前实现兼容 Node18；正式声明支持之前，需要与导师协调任务中的 Node18+ 与当前主干要求。

## 验收环境与限制

| 项目 | 固定验收环境 |
| --- | --- |
| 系统 | 完整系统 QEMU 8.2.2；Ubuntu 24.04.4，镜像 build 20260826；glibc 2.39；Linux riscv64 |
| 资源 | 4 vCPU、8 GiB RAM、24 GiB 可写磁盘；systemd-user + linger |
| Pilot 运行时 | unofficial-builds 的 Node 22.22.2，属于实验架构构建 |
| 反向运行时 | Node 18.20.8、关闭 SQLite 的 Node22；仅验证安全拒绝 |
| 真实 Agent | Qwen Code CLI 0.23.2 bundled CLI；本地确定性 OpenAI 协议模型服务 |
| 数据链路 | 安装后 Hook → 输入 → 归一化 → JSONL，严格校验新增事件 |
| SQLite | 真实内置只读查询、从同一源码编译的生产 reader；1,501 行分页查询及事件循环让步 |

Agent 的要求独立于 Pilot：Qwen 0.23.2 使用 Node22，非交互验收省略其 PTY/音频/图像 optional 模块。实验 RISC-V Node 不代表官方架构支持承诺。musl、openEuler、真机、其它 Agent 二进制、外部模型及 SLS/HTTP/OTLP 发送仍需单独验证。systemd-system 模板有回归测试，完整 guest 服务验收使用 systemd-user；未增加 RISC-V 预编译 node_modules 下载。

## 从分支制品安装

在具有合适 Node/npm 的开发机源码根目录构建：

```bash
npm ci --ignore-scripts
bash deploy/package-opensource.sh --output /tmp/loongsuite-pilot-riscv64.tar.gz
sha256sum /tmp/loongsuite-pilot-riscv64.tar.gz
```

把压缩包和该 checkout 的 `deploy/installer-opensource.sh` 传到目标机，并按记录的 SHA256 校验。准备好 RISC-V Node/npm 与可运行的 Agent 后安装：

```bash
bash ./installer-opensource.sh install \
  --package-url file:///tmp/loongsuite-pilot-riscv64.tar.gz \
  --prefer-system-node --agents qwen-code-cli
loongsuite-pilot status
loongsuite-pilot info
loongsuite-pilot restart
```

自定义数据目录增加 `--data-dir /absolute/path/to/pilot-data`；之后调用 CLI 时设置 `LOONGSUITE_PILOT_DATA_DIR` 为该路径。systemd unit 显式携带 config/data/cache 路径，可找到配置旁的运行时 pin。公开手动升级仍要求默认缓存目录 `~/.loongsuite-pilot`；自定义数据目录是独立设置。

systemd 工作目录保留空格、路径中间的引号/反斜杠及字面 `%`。含 CR/LF、以反斜杠或空白结尾的路径会在写入任何 unit 之前被拒绝。`WorkingDirectory` 按字面路径解析，给整个值加引号会改变路径。验证失败时改用受支持的绝对缓存路径。

## 恢复与排障

- `node -e "require('node:sqlite')"` 失败：替换选定 Node 为包含内置 SQLite 的合适 RISC-V 构建。重编旧 sqlite3 addon 无法修复内置模块缺失。
- JavaScript 依赖安装失败：保留安装器输出并检查依赖仓库访问；安装会失败，不标为降级成功。
- 服务失败：检查 `logs/last-restart-failure-collector.json`、`logs/last-startup-crash.json`、`daemon.fatal` 及 `journalctl --user -u loongsuite-pilot.service`。重启命令先清旧标记，失败时记录 stage，并等待稳定进程。
- 候选启用前部署失败：`current` 已指向保留版本，恢复只重启该版本。重启仍失败时运行 `loongsuite-pilot logs` 查看原因，再执行 `loongsuite-pilot start`；额外 rollback 可能切换到更老的产物。

发布版本使用 `loongsuite-pilot upgrade --version <version>` 和 `loongsuite-pilot rollback`。发布前验收只把公开 installer 下载重定向到本地固定文件，再用真实 CLI 和本地 A/B/故障包验证；不会发布测试版本。公开包不含后台 updater daemon，回滚接受这种包结构。后台更新器另有单元/集成覆盖。

## 完整复现与 CI

Ubuntu 宿主准备 Node/npm 与 Python3.11+：

```bash
sudo apt-get install -y qemu-system-misc qemu-utils xorriso openssh-client python3 zip
npm ci --ignore-scripts
python3 scripts/riscv64/fresh-run.py \
  --work-dir e2e-artifacts/riscv64-fresh-01 \
  --cache-dir e2e-artifacts/riscv64-cache
```

work-dir 必须是新目录。`scripts/riscv64/environment.lock.json` 固定镜像、运行时及真实 Agent，复用缓存前重新校验。入口构建公开包和生产 SQLite reader，记录摘要及源码 commit/patch hash，创建新可写磁盘，并归档成功或失败证据。未提交 checkout 会标为 dirty。apt 包只记录实际版本，未锁定版本。

`--case all` 的九项必跑验收覆盖：安装；systemd 生命周期及注入启动失败；下载/归档/架构/依赖/同版本重装失败边界；升级回滚与 checkpoint 连续性；合成采集；真实 Qwen 采集；内置 SQLite 与生产只读分页查询；不兼容运行时拒绝及原 runtime pin/版本/存活 PID 保留；恢复后真实 Agent 采集。Node18 仅做反向测试。生产 reader 是单独编译的测试附件，不是新的公开 API；子进程超时检查验证验收脚本的进程组清理，不再模拟生产原生编译器。

单项 case 使用 `--artifacts <新目录>`、`--data-dir <安装数据目录>`；`all` 还需要 installer、A/B/故障包、Agent 入口和运行时、Node18 与编译后的 SQLite reader。这些检查会停服务、注入故障，只能在隔离 guest 中运行。入口归档后停止虚拟机，`--keep-guest` 可保留排查。检查保留 guest 时使用其有效 manifest：

```bash
bash scripts/riscv64/run-qemu.sh ssh \
  --work-dir e2e-artifacts/riscv64-fresh-01 \
  --manifest e2e-artifacts/riscv64-fresh-01/environment.lock.json -- uname -m
```

`.github/workflows/riscv64.yml` 在相关 PR、main/master 更新和手动触发时调用同一 fresh-run，包含兼容包变更，失败时也上传日志、manifest 和公开制品；release workflow 等待此检查。主 CI 使用 Node22/23/24，RISC-V guest 固定 Node22。本地证据和 workflow 定义不等于上游 Actions 已通过。
