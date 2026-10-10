# Draft release notes: Linux riscv64

Unreleased. Publish after target acceptance and upstream review.

## English

- Add Linux riscv64 installation using system Node/npm with loadable builtin `node:sqlite`, matching current main (#444). Keep the empty `compat/sqlite3` package for old updaters; remove the old addon-build and degraded-collection path. `zstd-napi` is no longer a dependency.
- Preserve custom data/config/runtime paths in systemd services. Validate literal working directories before writing user or privileged units, reject directive-injection and ambiguous path characters, and escape ExecStart/Environment values.
- Preserve the active payload during failed same-version reinstalls. Restart the preserved version after pre-activation deployment failure and give logs/start guidance; only an activated failed candidate requires automatic rollback. Retain public-package rollback and bounded startup diagnostics.
- Make QEMU shutdown tolerate disappearing process/pid files without suppressing ownership, permission or timeout errors.
- Update full-system RISC-V installed acceptance and CI for builtin SQLite, read-only paged production queries, safe unsupported-runtime rejection and real Qwen Hook → JSONL collection. Include compatibility-shim changes in CI triggers, and retain bilingual installation/limitations/troubleshooting guides.

Node18/20 are rejected. A suitable unflagged builtin is required (Node22.13+, Node23.4+ or a suitable newer release); a version string alone is insufficient. The locked guest uses experimental unofficial-builds Node22.22.2 on Ubuntu glibc riscv64 under full-system QEMU with systemd-user. The real Agent test uses Qwen Code0.23.2 and a deterministic local model endpoint. Other distributions, hardware, external models and remote outputs need separate validation. No managed RISC-V Node or prebuilt node_modules is published. The project's Node18+ wording needs scope agreement with the current upstream runtime requirement.

## 中文

- 增加 Linux riscv64 系统 Node/npm 安装路径，要求真实加载内置 `node:sqlite`，与当前主干 #444 一致。保留旧更新器需要的空 `compat/sqlite3` 包，移除旧 addon 构建及降级采集路径；`zstd-napi` 不再是依赖。
- 保留 systemd 自定义 data/config/runtime 路径；在写入用户级或特权 unit 前验证字面工作目录，拒绝指令注入和有歧义的字符，转义 ExecStart/Environment。
- 同版本重装失败保留旧产物；候选启用前部署失败只重启保留版本，提示查看日志及 start；已启用候选启动失败才自动回滚。保留公开包回滚及有界启动诊断。
- QEMU 关停容忍进程/pid 文件已消失，仍上报所有权、权限和超时错误。
- 更新完整系统 RISC-V 安装态验收与 CI，覆盖内置 SQLite、生产只读分页查询、安全拒绝不兼容运行时、真实 Qwen Hook → JSONL；兼容包变更触发 CI，中英文指南明确安装、限制和排障。

Node18/20 会被拒绝；必须具备无需额外参数即可加载的内置 SQLite（Node22.13+、Node23.4+ 或合适更新版本），不能仅看版本号。固定 guest 使用 unofficial-builds 实验 Node22.22.2、Ubuntu glibc riscv64、完整系统 QEMU 与 systemd-user。真实 Agent 测试使用 Qwen Code0.23.2 和本地确定性模型端点。其它发行版、硬件、外部模型和远程输出需单独验收。未发布托管 RISC-V Node 或预编译 node_modules；任务中的 Node18+ 需与当前主干运行时要求协调。
