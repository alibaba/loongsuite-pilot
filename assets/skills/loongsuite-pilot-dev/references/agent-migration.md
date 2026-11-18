# 将现有 Agent 迁入 Rust SDK

从可写的 Rust 版本 Git 工作区根目录开始。你需要目标 Agent 的名称、要支持的客户端形态和平台、对照的正式发行版，以及一个该 Agent 能生成的脱敏小会话。仓库里的 Qoder 固定样本和测试可直接运行，用它先认识发布入口和验收方式。真实客户端一时不可用时，先完成可复跑的回归，将缺少的实机验收记为待验证。

## 1. 建立目标 Agent 的迁移契约

在改代码前填好下列项目。用目标版本源码、宿主文档和实际输入分别核对，标明仍有疑问的字段和能力。

- **身份和部署**。在 `agents.d/` 找 Agent 定义，核对稳定 ID、别名、用户和系统配置位置、发现条件、Hook 信任机制以及用户自有项。列明支持的 Agent 版本和平台。
- **数据来源**。为消息、工具、结束原因、token 和 Trace 分别确定权威源、可用的回退源及可连接的 ID。记录文件增长、截断、轮转和中断时可见什么。用一个正常回合、一个工具回合和一个中断或父子回合确认。空数据、缺值和真实零值各自保留语义。
- **Hook 协议**。列出每个事件的真实触发点、可观察或可裁决、工具 matcher、输入字段、stdout／stderr 和退出码。分别写明允许、拒绝、无端点和超时的实际效果。同一 Agent 的不同客户端需要分别核对。
- **进度和交付**。写出旧状态位置、游标含义、稳定文件与事件 ID、未交付批次的归属、导入和回滚时的交接条件。为所有对照选择一份可复用的输入和预期输出。
- **验收与资源基线**。列出目标 Agent 已有的功能、测试样本、对照版本和平台，以及可比较的负载口径。性能按该 Agent 的相同输入比较，Qoder 提供采集、可靠性和性能验收方法。

## 2. 跑通 Qoder 参考实现

依赖准备和构建见[架构与调试](runtime.md)。以下命令从仓库根目录运行。SDK 测试加载真实动态库，先构建同一提交的库和两个可执行入口。测试 HOME 只在子 shell 中改变。

```sh
python3 scripts/build/prepare-rust-dependencies.py
cargo build --locked --all-features --lib --bin loongsuite-pilot --bin loongsuite-pilot-sdk-hook
(
  set -eu
  export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
  pilot_test_home=$(mktemp -d)
  trap 'rmdir "$pilot_test_home" 2>/dev/null || true' EXIT
  export HOME="$pilot_test_home" USERPROFILE="$pilot_test_home"
  cargo test --locked --all-features \
    --test qoder_native_wakeup --test qoder_native_transcript_input \
    --test qoder_533_durability_pipeline --test qoder_533_recovery_pipeline \
    --test sdk_dynamic --test interceptor_native -- --test-threads=1
)
```

在 Windows 上可使用相同 Cargo 命令和 GitHub Actions 的 Bash 隔离做法，验证安装和服务时使用实际 PowerShell 与 Windows 服务入口。

| 从哪开始 | 示范了什么 | 去哪看结果 |
| --- | --- | --- |
| `agents.d/qoder.json`、`src/deployment/hook_strategy.rs` 中的 `qoder_exec_args` | 命令和参数原样传递，观察和本地裁决分路，替换自有 Hook | `tests/qoder_native_wakeup.rs`、`tests/interceptor_native.rs` |
| `src/core/orchestrator.rs` 的 `register_sdk_qoder`、`src/core/sdk_agent.rs` | 完整版配置来源与隐私选项，SDK 回调接现有输出，队列排空才导出进度 | `tests/sdk_dynamic.rs` 中的 `full_pilot_sdk_observe_preserves_qoder_wakeup_context`，以及[安装验收](verification.md) |
| `src/sdk/policy.rs`、`src/sdk/runtime.rs`、`src/sdk/outbox.rs` | 校验 `qoder_trace_v1` 和授权来源，实例化采集器，事务提交活动与游标 | `qoder_native_wakeup_transcript_and_checkpoint_share_the_dynamic_delivery_path` 与 `qoder_native_batch_preserves_activity_across_retry_ack_and_restart` |
| `src/hook_process/qoder_wakeup.rs`、`src/inputs/qoder-trace/` | Hook 唤醒和轮询兜底，按源增量扫描，关联 transcript、SQLite 和 token | `tests/qoder_native_transcript_input.rs`、`tests/qoder_533_recovery_pipeline.rs` |
| `src/sdk/agent_hooks.rs`、`src/sdk/hook_protocol.rs`、`src/sdk/hook_bin.rs` | 可信事件能力、Host 侧裁决协议、Agent 回包及截止时间 | `tests/sdk_dynamic.rs` 的无端点、重试、并发和阻断回包测试 |

预期各套件有实际通过的用例，且无失败。固定输入应能配对请求、响应与工具事件。用例分别检查唤醒、token 回退、Trace、状态提交和重启回放。真实客户端是否执行工具需要第 4 节的验收。

## 3. 迁移目标 Agent

1. **复用现有采集器与事件转换。** 先用第 1 节的样本跑出基线，复用 `src/inputs/`、`src/normalization/` 和 `src/types/` 的契约。让 SDK 的策略解析注册 Agent＋profile 并约束来源，在运行时实例化采集器。同一来源只能有一个采集器推进进度。宿主继续负责发现、配置和输出，两个入口复用同一 SDK 实现。给新增来源验证路径归属、符号链接和越界情况。
2. **建立可恢复的交付边界。** 保留稳定事件 ID。用 SDK outbox 将活动和游标一起持久化。回调 ACK 表示整批已交接，RETRY 保留同一批原字节和 ID。把旧游标导入空的对应命名空间，已有快照时继续使用其进度。兼容导出前确认 SDK 队列已排空，保留旧版本可读的游标。中途失败、重启或重试时不能提前推进游标，也不能让两个采集者同时持有同一来源。
3. **迁移 Hook 与配置。** 新 Agent 沿 `src/sdk/agent_hooks.rs` 注册 ID 和事件。复用已有 Hook 传输、超时和请求 ID。观察只提交有界通知，解析和扫描在采集器中完成。按真实端的回包协议扩展 `hook_protocol.rs`，保持内部裁决和 Agent 协议的转换明确。部署须幂等，保留用户与第三方项及信任记录。检查含空格和 Unicode 的路径。成功、失败和卸载都按同一所有权规则清理。
4. **替换旧运行入口。** 完整版沿 SDK 入口启停，新旧采集能按状态交接。逐项核对旧配置、输出和回滚，确认原生路径从已安装的二进制运行。清理只服务于旧路径的脚本与依赖前，核对部署清单、更新回滚事务、宿主插件要求和历史入口。用同一次构建产出的外壳、动态库和 Hook 验证。

### Codex 的映射示例

当前完整壳在 `src/core/orchestrator.rs` 注册 `CodexTranscriptInput` 与 `CodexAbortedTurnInput`，其 rollout 和中断补采可以复用。分别为默认和会话专用 `CODEX_HOME`、唤醒目录、span 上下文及补采状态建立可验证的来源授权。先保留现有 Hook 信任、用户／系统 scope 和配置所有权。通过 `src/core/codex_sdk_migration.rs` 了解已有批次与游标交接，再按本次外壳到 SDK 的方向设计接管。通过目标 Codex 版本证实允许与拒绝实际生效后，才将相应裁决能力标为支持。

```sh
cargo test --locked --all-features \
  --test codex_checkpoint_backpressure_history --test codex_journal_recovery \
  --test codex_standard_event_output_history --test codex_subagent_lifecycle
```

## 4. 按同一标准验收能力

- **采集对账**。独立缓存从同一固定输入运行基线、完整壳和 SDK 测试宿主。以会话、回合、step、事件类型及工具调用 ID 对账。核对字段集、稳定值、实际 token 归属、父子关系和隐私开关。观测时间、独立生成的 Trace ID 以关联关系判断。允许的宿主附加字段另列。固定输入无缺失，成功接收后的事件无逻辑重复。
- **恢复与交付**。写半行、继续写、轮转、背压、慢回调、RETRY、拒绝 ACK、强制退出及重启都要有定向用例。字节和游标按实际交付情况核对。允许未确认批次按同一 ID 重投，接收端据此去重。有交叉升级支持时，使用正式发行版跑同一会话的升级、候选启动失败后自动回滚、成功升级、重启和显式回滚。实际进程、版本指针、Hook 与用户配置都要核对。[安装验收步骤](verification.md)
- **真实客户端**。用自建测试目录和无敏感内容的 marker。每个声明支持的客户端检查真实数据源、会话续采和工具关联。声明同步拦截时，对照放行和拒绝，检查工具是否真实产生副作用。工具执行后的拒绝只验证该 Agent 对结果的处理。测无 SDK、失效端点、超时和并发，确认不会拖挂 Agent。并发用接收及回调时间证明请求实际重叠，用请求 ID 对齐每条输入与结果。
- **部署与运行时**。覆盖安装、更新、清理、第三方配置保留、ABI 启停与卸载。检查同一动态库和 Hook 在各声明平台的实际加载。无法运行的环境或能力保留待验状态。测试样本、实机与平台 CI 的证据分别记录。
- **签收标准**。核对所承诺能力逐项满足，有可重跑的测试和数值对照，再更新 README 的支持声明。只提交可脱敏的 fixture、回归和通用文档，阶段记录保留在本地。

## 5. 用同一方法达到性能目标

先通过第 4 节的数据质量检查，再做同机 A/B。同编译模式、输入字节与事件构成、轮询、负载、预热、窗口、采样和排空。基线和候选分别保存构建身份。用本 Agent 的同口径数据判断 CPU、RSS、吞吐和延迟变化。先约定负载、吞吐和资源预算，确认测量结果反映同样的有效采集与交付量。每档先用 smoke 验明实际采集链，再测空闲、低负载和高负载。详见[性能测试与报表](performance.md)。

- **先按阶段查热点。** 分开看扫描与读盘、唤醒及轮询、解析和 token 关联、checkpoint、活动交付。空闲重点看唤醒次数、目录 I/O 和定时任务。峰值看每个采样区间，平均看完整窗口。
- **选小改动复测。** 推进持久增量偏移，合并重复通知；按需解析与缓存索引，按文件身份、轮转、截断和进程重启验证失效；在单条记录或同步回调内借用 `&str`／`&[u8]`，跨任务或持久化时持有所有权。批次复用已序列化字节，慢 ACK 时核对待交付内存和背压。
- **记录同一组指标与质量。** 平均／峰值 CPU 和 RSS、实际输入与输出速率、延迟、积压与排空状态，以事件、token、Trace、游标和 ACK/RETRY 的结果判断优化是否可接受。单轮只用于初筛，多轮对照用于结论。若一方超出承载能力，将资源、积压和已交付数据质量一起报告。

### Linux 下复跑性能 smoke

用准备好公开构建依赖的工作区和 Docker。对照用两个独立工作区，分别切到待测提交。以下命令复用 GitHub 流水线的运行目录结构。统一使用已拉取的同一镜像，记录镜像 ID。首次需要时可在测试机执行 `docker pull node:22-bookworm-slim`。

```sh
git diff --quiet HEAD -- || { echo "use an isolated checkout of the source commit"; exit 1; }
cargo build --release --locked --lib --bin loongsuite-pilot --bin loongsuite-pilot-sdk-hook
pilot_perf_dir=$(mktemp -d)
mkdir -p "$pilot_perf_dir/runtime/bin"
git archive HEAD | tar -x -C "$pilot_perf_dir/runtime"
pilot_perf_build="${CARGO_TARGET_DIR:-target}/release"
cp "$pilot_perf_build/loongsuite-pilot" "$pilot_perf_build/loongsuite-pilot-sdk-hook" \
   "$pilot_perf_build/libloongsuite_pilot.so" "$pilot_perf_dir/runtime/bin/"
pilot_perf_sha=$(git rev-parse HEAD)
pilot_perf_version=$(python3 -c 'import re; print(re.search(r"(?m)^version *= *\"([^\"]+)\"", open("Cargo.toml").read()).group(1))')
pilot_perf_image=node:22-bookworm-slim
docker image inspect --format '{{.Id}}' "$pilot_perf_image"
python3 scripts/performance/pilot_history.py \
  --package "$pilot_perf_dir/runtime" --image "$pilot_perf_image" \
  --runtime rust --kind dev --version "$pilot_perf_version" \
  --commit "$pilot_perf_sha" --source-repository alibaba/loongsuite-pilot --source-ref "$pilot_perf_sha" \
  --benchmark-method github-full-pilot-qoder-native-v2 \
  --output "$pilot_perf_dir/qoder-smoke" --smoke-only
```

Qoder 成功时在输出目录得到 `smoke.json`，其中 `classification: compatible` 且 `confirmed: true`。测 Codex 时使用 `scripts/performance/codex_history.py` 和独立输出目录，移除 Qoder 的 `--benchmark-method` 参数。Codex 的 `smoke.json` 应有 `status: passed`、`smoke_only: true`、`quality.passed: true` 和 `report_node: false`。测三档时移除 `--smoke-only` 并换输出目录。其他 Agent 按[性能扩展步骤](performance.md)实现独立可校验的 fixture 和 driver。两边测试完成后清理各自创建的目录。
