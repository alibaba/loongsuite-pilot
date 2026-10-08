# Linux RISC-V64

[English](../riscv64.md) | 简体中文

本分支增加 Linux `riscv64` 安装与原生依赖处理。改动尚未发布到公开安装器地址；发布前请使用同一 checkout 的安装器与安装包。下文的 fresh-run 入口会归档命令结果和 guest 证据，包括失败记录；本地验证、上游 CI 与正式发布分别记录。

## 实测范围

| 项目 | 已执行环境 |
| --- | --- |
| 系统 | 完整系统 QEMU 8.2.2；Ubuntu 24.04.4，镜像 build 20260826；glibc 2.39；Linux riscv64 |
| 资源 | 4 vCPU、8 GiB RAM、24 GiB 可写磁盘；systemd-user + linger |
| Pilot 运行时 | Node 22.22.2、18.20.8，来自 unofficial-builds；属于实验构建，不代表官方架构支持承诺 |
| 编译链 | GCC 13.3.0、Python 3.12.3；省略 optional 包后实际使用 npm 10.9.7 内置 node-gyp 11.5.0 |
| 原生模块 | sqlite3 5.1.7，固定 N-API6；zstd-napi 0.0.12，固定 N-API8 |
| 真实 Agent | Qwen Code CLI 0.23.2 的实际 bundled CLI，独立使用 Node22、本地 OpenAI 协议模型桩 |
| 数据链路 | 安装后 Hook → 输入 → 归一化 → JSONL；只截取新增 Qwen 记录做 strict 验证 |

Node18 用于历史兼容验证，不作为新部署推荐。锁定的生产依赖 `@loongsuite/otel-util-genai@0.1.0-beta.13` 声明 `Node >=20`，这一约束在 RISC-V 改动前就已存在。Node18.20.8 的核心采集实测不等于依赖正式支持：npm 默认策略会警告，`engine-strict=true` 会拒绝安装。本分支保留用户的 engine 校验设置，不修改依赖声明；新部署使用已验证的 Node22。将 Node18 纳入正式支持范围仍需依赖维护者确认或兼容发布。

Agent 与 Pilot 的 Node 要求分别计算：Qwen 0.23.2 需要 Node22，即使 Pilot 使用 Node18。验收直接解包真实 bundled CLI，不安装非交互测试不需要的 PTY/音频/图像 optional 模块。

未声明 musl、openEuler、RISC-V 真机、其它 Agent 二进制、外部真实模型、SLS/HTTP/OTLP 发送或全部 init 模式已通过。systemd-system unit 模板有单元测试，实际服务验收及解析器检查使用 systemd-user。本改动不发布 RISC-V 托管 Node 或预编译 node_modules 包。

## 从本分支制品安装

在已有 Node/npm 的开发机源码根目录构建：

```bash
npm ci --ignore-scripts
npm rebuild sqlite3 zstd-napi
bash deploy/package-opensource.sh --output /tmp/loongsuite-pilot-riscv64.tar.gz
sha256sum /tmp/loongsuite-pilot-riscv64.tar.gz
```

把压缩包和该 checkout 的 `deploy/installer-opensource.sh` 传到 RISC-V 机器，按构建端记录的 SHA256 校验压缩包。制品包含 JavaScript 与资源，原生依赖在目标机器编译。

目标机先准备 RISC-V Node/npm 并加入 PATH，以下工具链安装命令适用于 Ubuntu：

```bash
uname -m
node -p 'process.platform + "/" + process.arch + " " + process.version'
npm --version
sudo apt-get update
sudo apt-get install -y build-essential python3 pkg-config curl ca-certificates
bash ./installer-opensource.sh install \
  --package-url file:///tmp/loongsuite-pilot-riscv64.tar.gz \
  --prefer-system-node --agents qwen-code-cli
```

两个架构探针都应为 `riscv64`。安装器会在覆盖 data-dir 内的 Node pin 前拒绝错误架构。需要先安装可运行的 Agent，才能发现并实际采集。

自定义数据目录增加 `--data-dir /absolute/path/to/pilot-data`；之后调用 CLI 时设置 `LOONGSUITE_PILOT_DATA_DIR` 为该路径。systemd unit 显式传递 config/data/cache 路径，能找到安装器在自定义配置旁写下的 Node pin。公开手动升级仍要求默认缓存目录 `~/.loongsuite-pilot`；自定义数据目录与自定义缓存目录是不同选项。

## 原生构建与降级

安装器和后台更新器共用 `scripts/install-riscv64-deps.mjs`：先安装 production JS 依赖并禁用 lifecycle，再分别源码构建 sqlite3/zstd，执行隔离功能探针；正常资源 postinstall 仍由调用方完成。helper 优先使用安装器选择的 npm，独立运行时允许从 PATH 查找 npm；不要求它必须与 Node 位于同一目录。

实测首轮 sqlite3 604 秒、zstd 170 秒，完整重复安装约 15分35秒。这是当前 guest 的测量值，不能保证其它机器相同。helper 总上限 30 分钟，JS 安装最多 5 分钟，每个原生构建最多 20 分钟且受剩余总时间约束；超时/中断会结束对应构建进程组。JS 依赖失败必须失败；原生失败会明确标为 degraded，保留 JS 主链路。

手动重建不要省略 N-API 版本。实测 Node22/npm 默认构建出了 N-API10 文件，在 Node18 下会 SIGSEGV。使用共用 helper 修复：

```bash
PILOT_DATA="${LOONGSUITE_PILOT_DATA_DIR:-$HOME/.loongsuite-pilot}"
PILOT_VERSION="$(cat "$HOME/.loongsuite-pilot/current")"
PILOT_PACKAGE="$HOME/.loongsuite-pilot/versions/$PILOT_VERSION"
loongsuite-pilot stop
node "$PILOT_PACKAGE/scripts/install-riscv64-deps.mjs" \
  --package-dir "$PILOT_PACKAGE" --log-dir "$PILOT_DATA/logs/native-install"
loongsuite-pilot start
```

用 Pilot 选中的同一 Node 执行修复，需要能访问依赖仓库和编译工具。排障保留 `logs/native-install/<时间>-<PID>/` 中的完整 npm/build/probe/result 日志。终端转发的单条命令输出限制为 64 KiB，防止更新器输出缓冲溢出；文件日志保留完整输出。日志无法创建时不启动构建，写入失败时结束构建进程组。

Linux riscv64 在启动时先用子进程探测 SQLite，再由 collector 按需加载。缺包、坏 ELF 或不兼容 addon 会关闭 SQLite-only 输入及 SQLite token 补充；Hook/会话文件采集可以继续，失败 SQL 读取不推进其 checkpoint。修复原生文件后重启 Pilot 才会重新判断能力。zstd 会安装并做功能测试，但当前 collector 源码没有导入它，因此不作为核心启动前提。

## 服务、升级与诊断

```bash
loongsuite-pilot status
loongsuite-pilot info
loongsuite-pilot restart
```

`status/info` 展示 `native-capabilities.json` 的最近启动时间、SQLite 能力、原因与恢复建议；它是保存的启动观察结果。服务失败检查 `logs/last-restart-failure-collector.json`、`logs/last-startup-crash.json` 和 `journalctl --user -u loongsuite-pilot.service`。`restart-collector` / `restart-updater` 在入口清除自己的旧标记，失败时写入新标记。启动采用有界稳定 PID 检查，仅注册服务不能认定启动成功。

已发布版本使用 `loongsuite-pilot upgrade --version <version>` 和 `loongsuite-pilot rollback`。本地发布前验收只将固定的公开 installer 下载重定向到本地文件，随后仍调用真实 CLI/安装器，使用本地 A/B/故障包验证；测试版本不会上传。公开包不含后台 updater daemon，回滚接受这种有效包结构。后台 updater 的 RISC-V 分支另有单元/集成测试。

## 完整复现与 CI

开发宿主准备 Node/npm、Python3.11+、QEMU system riscv64、qemu-img、xorriso、SSH、curl、zip：

```bash
sudo apt-get install -y qemu-system-misc qemu-utils xorriso openssh-client python3 zip
npm ci --ignore-scripts
npm rebuild sqlite3 zstd-napi
python3 scripts/riscv64/fresh-run.py \
  --work-dir e2e-artifacts/riscv64-fresh-01 \
  --cache-dir e2e-artifacts/riscv64-cache
```

work-dir 必须是新目录。输入由 `scripts/riscv64/environment.lock.json` 固定，每次复用缓存都校验摘要。入口创建独立 SSH key 和新可写磁盘，运行具有 RISC-V shell/compiler/子 Node 的完整 guest；从公开打包到安装态验收失败时返回非零，归档证据后停止 guest。`--keep-guest` 保留虚拟机排查，归档前仍停止 collector，避免日志变化破坏归档。

检查保留的 fresh guest 时，使用该 work-dir 写下的有效 manifest，其中包含本次 SSH 端口：

```bash
bash scripts/riscv64/run-qemu.sh ssh \
  --work-dir e2e-artifacts/riscv64-fresh-01 \
  --manifest e2e-artifacts/riscv64-fresh-01/environment.lock.json -- uname -m
```

`smoke.sh --case all` 要求完整 installer、安装包、B/启动故障/依赖故障包、真实 Agent、Node18 路径，依次执行安装、生命周期、安装边界（含同版本重装失败时保留旧产物）、升级/回滚增量连续性、fixture、真实 Agent、原生故障/恢复、Node18 全新依赖安装、Node18 运行及恢复后采集。Node18 安装检查分别记录严格 engine 策略的结果、默认策略的原生源码构建和真实 GenAI 转换调用；已知 engine 拒绝会单独记录，不标作正式兼容。单项 case 使用 `--artifacts <新目录>` 和 `--data-dir <已安装数据目录>`。这些检查会停服务并注入故障，只在隔离验收 guest 内运行。

`.github/workflows/riscv64.yml` 在相关 PR、main/master 更新、手动触发时调用同一新 guest 入口，覆盖公共源码、资源、安装与测试脚本，成功和失败都归档日志、manifest 与公开制品。Release workflow 复用该检查，并在通过后执行发布。提供 workflow 和本地复现证据，不等于已经在上游 GitHub Actions 运行通过。
