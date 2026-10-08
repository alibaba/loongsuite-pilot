# Draft release notes: Linux riscv64

Unreleased. Publish only after the target acceptance and upstream review are complete.

## English

- Add Linux riscv64 installation using an existing RISC-V Node/npm and local native builds. sqlite3 uses N-API6 and zstd-napi uses N-API8 for the tested Node18/22 compatibility path.
- Keep Hook/session collection available when SQLite cannot load. The startup probe isolates native crashes, disables affected SQLite capabilities and records a repair instruction. `status/info` show the most recent startup result.
- Preserve custom data/config/runtime paths in systemd services, confirm stable startup, and fix rollback to public packages that intentionally omit the background updater daemon.
- Preserve the active payload during same-version reinstall failures, and restart it when candidate deployment fails before activation. Use the installer's selected npm, retain full native build logs with bounded output forwarding, and clean up compiler processes on logging failure.
- Add a full-system QEMU installed-artifact workflow for relevant PRs/main updates and as a release prerequisite, with English/Chinese RISC-V setup, limitations and troubleshooting documentation.

New deployments should use the tested Node22 runtime. The existing locked GenAI dependency declares Node >=20; Node18 runtime tests do not override that declaration, and `engine-strict=true` rejects Node18 installation. Formal Node18 support remains a maintainer decision; user engine settings are preserved.

The tested target is Ubuntu glibc riscv64 under full-system QEMU with systemd-user. RISC-V Node binaries used in validation are experimental unofficial-builds. Agent compatibility has separate runtime requirements; the real CLI acceptance uses Qwen Code 0.23.2 and a local deterministic model endpoint. Other distributions, hardware, live model providers and remote output services require additional validation. No RISC-V managed Node or prebuilt node_modules download is introduced.

## 中文

- 增加 Linux riscv64 安装路径，使用已有 RISC-V Node/npm 并在目标机器构建原生模块；sqlite3 固定 N-API6，zstd-napi 固定 N-API8，覆盖实测 Node18/22 兼容路径。
- SQLite 加载失败时保留 Hook/会话文件采集。启动探针隔离原生崩溃、关闭受影响的 SQLite 能力并记录恢复建议；`status/info` 显示最近一次启动的能力状态。
- 修复 systemd 自定义数据/配置/运行时路径传递、启动短命 PID 误判，以及缺少后台 updater daemon 的有效公开包无法回滚的问题。
- 同版本重装失败时保留旧产物；候选启用前的部署失败重启原服务。原生构建使用安装器选定的 npm，保留完整日志并限制转发量，日志失败时清理编译进程。
- 增加覆盖相关 PR/main 更新并作为发布前置检查的完整系统 QEMU 安装态 workflow，以及中英文 RISC-V 安装、限制和排障说明。

新部署建议使用已测 Node22。现有锁定的 GenAI 依赖声明 Node >=20，Node18 运行测试不能覆盖该声明，`engine-strict=true` 会拒绝 Node18 安装。正式 Node18 支持范围仍需维护者确认；用户的 engine 设置保持不变。

实测目标为完整系统 QEMU 中的 Ubuntu glibc riscv64，服务使用 systemd-user。所用 RISC-V Node 是 unofficial-builds 实验构建。Agent 的运行时要求单独判断；真实 CLI 验收使用 Qwen Code 0.23.2 与本地确定性模型端点。其它发行版、硬件、外部模型与远程输出通道仍需补充验证；未增加 RISC-V 托管 Node 或预编译 node_modules 下载。
