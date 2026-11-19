# 将现有 Agent 迁入 Rust SDK

从可写的 Rust 版本 Git 工作区根目录开始。你需要目标 Agent 的名称、要支持的客户端形态和平台、对照的正式发行版，以及一个该 Agent 能生成的脱敏小会话。仓库里的 Qoder 固定样本和测试可直接运行，用它先认识发布入口和验收方式。真实客户端一时不可用时，先完成可复跑的回归，将缺少的实机验收记为待验证。

## 1. 建立目标 Agent 的迁移契约

在改代码前填好下列项目。用目标版本源码、宿主文档和实际输入分别核对，标明仍有疑问的字段和能力。

- **身份和部署**。在 `agents.d/` 找 Agent 定义，核对稳定 ID、别名、用户和系统配置位置、发现条件、Hook 信任机制以及用户自有项。列明支持的 Agent 版本和平台。
- **数据来源**。为消息、工具、结束原因、token 和 Trace 分别确定权威源、可用的回退源及可连接的 ID。记录文件增长、截断、轮转和中断时可见什么。用一个正常回合、一个工具回合和一个中断或父子回合确认。空数据、缺值和真实零值各自保留语义。
- **Hook 协议**。列出每个事件的真实触发点、可观察或可裁决、工具 matcher、输入字段、stdout／stderr 和退出码。分别写明允许、拒绝、无端点和超时的实际效果。同一 Agent 的不同客户端需要分别核对。
- **宿主模式**。分别核对完整 Pilot 和独立加载动态库的宿主能否启用同一能力。对每个主源、补采源和 Hook，明确哪个入口注册、哪个 profile 启用、文件读写由谁授权、进度和诊断保存在哪里。SDK 中已有的处理函数，只有经目标宿主的实际策略、回调和客户端入口运行，才能计入该模式的验收范围。
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

动态测试从实际宿主加载 SDK。构建目录有多份库时，通过 `PILOT_TEST_SDK_LIBRARY` 给 `sdk_dynamic` 指定本次构建的库绝对路径。先确认宿主、库、Hook 与资源同提交、同架构，并用该平台的原生加载测试确认 ABI。若在采集前就加载失败，先核对运行镜像、C 运行库和动态依赖，再排查采集逻辑。

| 从哪开始 | 示范了什么 | 去哪看结果 |
| --- | --- | --- |
| `agents.d/qoder.json`、`src/deployment/hook_strategy.rs` 中的 `qoder_exec_args` | 命令和参数原样传递，观察和本地裁决分路，替换自有 Hook | `tests/qoder_native_wakeup.rs`、`tests/interceptor_native.rs` |
| `src/core/orchestrator.rs` 的 `register_sdk_qoder`、`src/core/sdk_agent.rs` | 完整版配置来源与隐私选项，SDK 回调接现有输出，队列排空才导出进度 | `tests/sdk_dynamic.rs` 中的 `full_pilot_sdk_observe_preserves_qoder_wakeup_context`，以及[安装验收](verification.md) |
| `src/sdk/policy.rs`、`src/sdk/runtime.rs`、`src/sdk/outbox.rs` | 校验 `qoder_trace_v1` 和授权来源，实例化采集器，事务提交活动与游标 | `qoder_native_wakeup_transcript_and_checkpoint_share_the_dynamic_delivery_path` 与 `qoder_native_batch_preserves_activity_across_retry_ack_and_restart` |
| `src/hook_process/qoder_wakeup.rs`、`src/inputs/qoder-trace/` | Hook 唤醒和轮询兜底，按源增量扫描，关联 transcript、SQLite 和 token | `tests/qoder_native_transcript_input.rs`、`tests/qoder_533_recovery_pipeline.rs` |
| `src/sdk/agent_hooks.rs`、`src/sdk/hook_protocol.rs`、`src/sdk/hook_bin.rs` | 可信事件能力、Host 侧裁决协议、Agent 回包及截止时间 | `tests/sdk_dynamic.rs` 的无端点、重试、并发和阻断回包测试 |

预期各套件有实际通过的用例，且无失败。固定输入应能配对请求、响应与工具事件。用例分别检查唤醒、token 回退、Trace、状态提交和重启回放。真实客户端是否执行工具需要第 4 节的验收。

## 3. 迁移目标 Agent

1. **复用现有采集器与事件转换。** 先用第 1 节的样本跑出基线，复用 `src/inputs/`、`src/normalization/` 和 `src/types/` 的契约。让 SDK 的策略解析注册 Agent＋profile 并约束来源，在运行时实例化采集器。同一来源只能有一个采集器推进进度。宿主继续负责发现、配置和输出，两个入口复用同一 SDK 实现。给新增来源验证路径归属、符号链接和越界情况。若主 transcript、Hook、异常补采或历史回放能看到同一回合，先逐条确认正常、取消和异常退出各由谁发出事件。确认正常采集开启时补采不会重复发布，并覆盖仅启用补采时的行为及历史待交付批次。
2. **建立可恢复的交付边界。** 保留稳定事件 ID。用 SDK outbox 将活动和游标一起持久化。回调 ACK 表示整批已交接，RETRY 保留同一批原字节和 ID。首次迁移、SDK 自身恢复和交还后的再次接管采用各自的进度来源。按下文的状态交接要求保留旧版本可读的游标，确保同一来源在任一时刻只有一个采集者推进进度。
3. **迁移 Hook 与配置。** 新 Agent 沿 `src/sdk/agent_hooks.rs` 注册 ID 和事件。复用已有 Hook 传输、超时和请求 ID。观察只提交有界通知，解析和扫描在采集器中完成。按真实端的回包协议扩展 `hook_protocol.rs`，保持内部裁决和 Agent 协议的转换明确。部署须幂等，保留用户与第三方项及信任记录。检查含空格和 Unicode 的路径。成功、失败和卸载都按同一所有权规则清理。
4. **替换旧运行入口。** 完整版沿 SDK 入口启停，新旧采集能按状态交接。逐项核对旧配置、输出和回滚，确认原生路径从已安装的二进制运行。清理只服务于旧路径的脚本与依赖前，核对部署清单、更新回滚事务、宿主插件要求和历史入口。用同一次构建产出的外壳、动态库和 Hook 验证。

### 切换宿主与退役旧入口

先用同一提交的动态库和共享 Hook 做两次独立启动。第一次由完整 Pilot 加载，第二次由动态库测试宿主加载，分别核对 API 生效策略、活动回调、Hook 注册和生效的端点。对补采来源做单源与双源验证，给每个来源和 profile 使用各自明确授权的目录与进度命名空间。检查缺失目录等待、替换策略、重启和状态恢复。独立宿主的试验不借用完整 Pilot 的默认目录、环境变量或隐式授权。

对配置安装、更新、查询与清理使用同一份所有权规则。实际启动客户端验证命令及参数的顺序、作用域和信任，与配置文件存在分别记录。客户端需要独立信任文件时，核对注册与信任更新失败后的恢复，以及卸载时只撤回对应条目。用同一个 SDK 实例启用、禁用并再次启用目标 Agent，确认原配置和第三方条目留存，期间还应覆盖已启动客户端与 SDK 不可达的行为。

定位旧入口的所有调用者，包含已安装的 Hook、修复任务、启动脚本和回滚恢复。验证新入口在原配置和游标上接管，并用正式发行版验证安装失败自动回滚。能够观测新入口已被客户端调用、旧配置能够正确清理并回滚后，再删除旧入口与依赖。

### 长记录、读盘预算与交付大小

分别确定每轮扫描预算、原始记录／回合上限和单事件／单批交付上限。扫描到半条记录时，区分已读位置和最后一条完整记录的边界。保留有界的半行状态及文件身份，下一轮接着读，或在预算外有界地补齐首条合法记录。若用半行状态，重启可从最后已提交边界恢复，轮转、截断或内容替换后按文件身份和边界证据作废旧状态。只有读到完整记录、完成转换并持久交付后才能推进对应业务游标。

对于超过支持上限的记录，明确诊断并制定处理方式。允许隔离时，继续寻找记录结束边界，记下来源标识、偏移和原因，后续合法记录能继续采集。不得因每轮只读到相同前缀而无限重试，也不能把仍在写入的半条记录当作超限丢弃。SDK outbox 的超限反压和告警是独立防线。源记录合法时还要验证其编码后的活动能按合法批次投递，不能因为解析成功就算通过。

回归使用生产入口和实际生效的配置。把单条合法记录设为大于单轮预算，再追加短记录，两条都应按顺序交付一次。再测恰好到上限、超过上限、跨多轮追加换行、跨轮重启，以及原文件被截断或替换。超限按约定产生可观测结果，之后的短记录和其他来源继续交付。单独覆盖含多条短记录、总量超过每轮预算的 Stop 或唤醒，确认后续通知继续处理。记录扫描位置的推进和读盘／内存上界，同时对账事件 ID、字段和 token。

### 先验已有状态的接管

先确定业务游标的唯一所有者。SDK 正在使用或意外中断时，以 outbox 中和活动一起持久化的游标为准。收到 RETRY、ACK 丢失或还有未提交活动时，保留原批次及游标，不用宿主进度覆盖，重启后按原字节和 ID 重投。确认停止采集、完成交付后，将游标原子写入旧版本可读的状态，再持久记录交接完成。正式 Node.js 版在这之后拥有进度，可以在同一来源上继续写游标。再次进入 SDK 时，识别已完成的交接并导入当时的旧版本游标，不能因私有快照已存在就跳过。多来源按各自身份和命名空间确认交接，不能取两个字节偏移的较大值来解决轮转或跨源冲突。

回归使用同一文件、同一真实会话和同一安装根。按正式 Node.js → Rust SDK → 正式 Node.js → 同一 Rust 候选依次写入可辨识的 A、B、C、D 四段。每段核对新增事件、token、关系、实际游标和待交付记录，尤其确认 D 不重放回滚期间已经交付的 C。也要覆盖候选启动失败触发自动回滚、一次普通 SDK 重启、带 RETRY 的恢复，以及支持通过配置切换的新旧采集入口。有未 ACK 批次时，先验证旧状态不会覆盖它，确认 ACK 并完成干净交接后再验证下一位采集者可接续。正式安装的版本指针、进程、Hook 和配置按第 4 节核对。

真实中断要发生在 Agent 正处理测试回合时，只结束该测试客户端或按该客户端的正常取消方式操作。确认原始记录确实出现取消或未完成信号，恢复后按稳定 ID 核对取消响应和已发生的工具活动各出现一次。

### Codex 的映射示例

完整壳由 `register_sdk_codex` 注册 rollout 和中断补采 profile，两者复用现有的 `CodexTranscriptInput` 与 `CodexAbortedTurnInput`。从 `src/sdk/policy.rs` 核对 `CODEX_HOME` 和 Pilot 元数据的授权范围，从 `src/sdk/outbox.rs` 核对旧批次、待确认活动及外壳游标的交接。Hook 的信任、用户／系统 scope 和配置所有权由完整壳管理。用实际客户端分别检查提示拒绝、工具执行前拒绝、以及工具执行后结果替换。后置裁决生效时，已发生的工具副作用会保留。真实取消可用 rollout 的 `turn_aborted` 确认。对照客户端 `turn.completed.usage` 时，若它是会话累计值，使用同一会话相邻快照的差值核对输入、缓存及输出 token。用 `call_id` 对齐模型收到的工具结果与 CLI 的原始工具记录。

```sh
cargo test --locked --all-features \
  --test codex_aborted_batch_history \
  --test codex_checkpoint_backpressure_history --test codex_journal_recovery \
  --test codex_standard_event_output_history --test codex_subagent_lifecycle
cargo test --locked --all-features --test cli_native \
  packaged_codex_explicit_home_keeps_trust_and_hooks_together
cargo test --locked --all-features --test sdk_dynamic \
  codex_sdk_observe_delivery_retry_and_interception_share_the_native_library
```

## 4. 按同一标准验收能力

- **采集对账**。独立缓存从同一固定输入运行基线、完整壳和 SDK 测试宿主。以会话、回合、step、事件类型及工具调用 ID 对账。核对字段集、稳定值、实际 token 归属、父子关系和隐私开关。先确认使用量的统计粒度。会话累计量按同一统计周期的相邻快照取差，逐回合用量直接对账。对缺失、真实零值和计数重置分别处理。观测时间、独立生成的 Trace ID 以关联关系判断。允许的宿主附加字段另列。固定输入无缺失，成功接收后的事件无逻辑重复。
- **恢复与交付**。写半行、继续写、轮转、背压、慢回调、RETRY、拒绝 ACK、强制退出及重启都要有定向用例。字节和游标按实际交付情况核对。允许未确认批次按同一 ID 重投，接收端据此去重。有交叉升级支持时，使用正式发行版跑同一会话的升级、候选启动失败后自动回滚、成功升级、重启和显式回滚。实际进程、版本指针、Hook 与用户配置都要核对。[安装验收步骤](verification.md)
- **真实客户端**。在隔离的 Agent 配置和项目中用正式安装入口注册 Hook，确认客户端实际加载了配置并识别信任记录。用会话 ID、回合 ID 或请求 ID 串起 Agent 原始事件、SDK 裁决和动作结果。前置拦截用放行和拒绝分别验证无害的文件标记出现和缺失。提示提交拦截核对下游请求是否发出。后置拦截核对同一工具调用交给模型的结果及已发生的副作用，工具原始 stdout 可能仍出现在审计中。测无 SDK、失效端点、超时和并发，确认不会拖挂 Agent。离线放行后用同一会话验证 SDK 恢复时可续采。并发用接收及回调时间证明请求实际重叠。
- **独立宿主裁决**。让宿主的裁决回调按请求 ID 记录接收和响应，用真实客户端对每种拦截点核对最终行为。分别验证运行时规则和宿主回调的路径。仅调用 Hook 二进制并检查 stdout 的用例用来验证协议，真实生效另查客户端有无发出请求、执行工具或收到替换结果。
- **部署与运行时**。覆盖安装、更新、清理、第三方配置保留、ABI 启停与卸载。检查同一动态库和 Hook 在各声明平台的实际加载。路径模板变化时，用生产加载器验证默认与显式目录最终写到哪里，同时保留旧默认路径的清理契约。增加 Hook 事件时，逐个验证配置命令、信任条目与重装幂等性，并检查查询保持只读。无法运行的环境或能力保留待验状态。测试样本、实机与平台 CI 的证据分别记录。
- **签收标准**。该 Agent 的真实安装态验收通过后，在验收 PR 一并更新根目录 README.md 和 README.zh-CN.md 的 Rust Agent 支持表。按实测列出采集、拦截和平台范围，仍待验证的能力保留当前状态。Review 时核对对应验收证据和两份支持表。只提交可脱敏的 fixture、回归和通用文档，阶段记录保留在本地。

## 5. 用同一方法达到性能目标

先通过第 4 节的数据质量检查，再做同机 A/B。同编译模式、输入字节与事件构成、轮询、负载、预热、窗口、采样和排空。基线和候选分别保存构建身份。用本 Agent 的同口径数据判断 CPU、RSS、吞吐和延迟变化。先约定负载、吞吐和资源预算，确认测量结果反映同样的有效采集与交付量。每档先用 smoke 验明实际采集链，再测空闲、低负载和高负载。详见[性能测试与报表](performance.md)。

预热完成应有采集侧证据，例如目标采集器已认领来源、预热记录已交付。迁移后检查性能脚本等待的新入口及进度位置，避免用旧日志或固定睡眠判定就绪。固定窗口内输入生成不足时，记录实际产量并按基准的重试规则重跑。排空失败时，沿当前采集路径核对权威游标、持久待交付队列和已输出事件，分清原始数据未读取、已读待交付和缺失，按性能脚本的质量规则判定是否超出承载能力。

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
