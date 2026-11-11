# Rust SDK 接口与运行方式

Pilot 提供同一份采集核心的两种使用方式：完整 Pilot 通过原生外壳加载动态库；嵌入宿主通过 C ABI 加载动态库，交接活动、监控和拦截裁决。现有完整模式的配置、部署、输出、服务、界面和更新入口继续保留。

同一目标平台、版本类型和构建提交使用同一份动态库产物。Pilot 专用壳调用函数表的 `host_main` 进入完整运行模式；云壳调用 `start`、`dispatch`、`stop` 等嵌入接口，采集实现留在库内。`host_main` 是进程级同步入口，不与嵌入实例混用。

## 构建与文件

使用仓库固定的 Rust 工具链和依赖准备步骤：

```sh
python3 scripts/build/prepare-rust-dependencies.py
cargo build --locked --release --lib --bin loongsuite-pilot
```

动态库名称分别是 `libloongsuite_pilot.so`、`libloongsuite_pilot.dylib` 和 `loongsuite_pilot.dll`。完整发行包把原生外壳和动态库放在同一 `bin` 目录，并按原有 schema 1 清单登记摘要；安装、升级和回滚都处理这两个文件。不要只复制外壳。运行时不需要安装 Rust。

正式接口见 `include/pilot_sdk.h`，最小 C 宿主见 `examples/pilot_sdk_host.c`。SDK 原生 CI 在六个受支持平台构建、加载并运行验收；它不发布正式版本。

## 生命周期与内存

通过 `aah_collector_get_api_v2()` 获取只读函数表，检查 `abi_version == 2` 和 `struct_size`。能力位分别表示当前活动格式、UDP Hook 和监控回调。宿主保留库、回调函数及 context，直到实例销毁成功。

调用顺序：

1. 调用 `api->start(init, policy, callbacks..., context, &handle)`；OK 表示受理。
2. 受理调用返回后，在宿主控制线程反复调用 `dispatch(handle, 0)`，接收一次 `on_start`。
3. 使用完整策略快照调用 `apply_policy`，或通过 `snapshot` 查看状态。非法策略返回 BAD_ARGUMENT，保留原配置。
4. 调用 `stop(handle, drain_ms)` 受理停止，再派发 `dispatch`，等待一次 `on_stop`。
5. 完成回调返回后重试 `destroy`，直到 OK，然后释放 context 并卸载库。启动失败的实例也走停止、销毁流程。

同一句柄的控制调用串行。生命周期回调只复制结果和通知控制线程；回调内销毁返回 BUSY。`snapshot` 可以在回调中调用。活动、监控和 Hook 回调在不同的 SDK 工作线程执行，宿主实现必须线程安全；异常不能穿越 C 边界。

JSON 输入和事件视图都是 UTF-8 地址加字节长度，不要求 NUL。输入及回调视图只在当前调用期间有效。SDK 分配的报告使用同一动态库的 `string_free` 释放一次，不能用宿主的释放函数。

停止时，SDK 会等待采集、传输和已经进入的回调退出。外部回调长期阻塞时，实例保持 Stopping，销毁返回 BUSY；宿主不能强行卸载仍在执行代码的动态库。`drain_ms` 是停止新增采集后的活动积压交付等待预算，不是强杀回调的期限。

### 宿主控制线程与动态库卸载

需要在宿主进程内卸载或切换 SDK 动态库时，建议由一个宿主专用控制线程串行执行实例的 `start`、`apply_policy`、`snapshot`、`stop`、`dispatch`、`destroy`，并在该线程完成 SDK 报告的复制与 `string_free`。其他业务线程把控制请求交给它；SDK 工作线程上的回调只处理约定业务或通知控制线程。停止受理后继续 `dispatch`，等停止完成通知、所有回调返回且 `destroy` 返回 OK，再退出并 join 控制线程；最后关闭动态库句柄并释放回调及 context。不得在回调尚未退出时卸载，也不能把“停止已受理”当成“停止已完成”。这是方便管理卸载边界的宿主接入方式，不改变接口已声明的线程安全范围。

Linux 动态加载器可能因为外部调用线程上的线程局部存储（TLS）而暂时保留库映射。`destroy` 成功表示实例可以安全销毁；关闭库句柄成功不等于该时刻代码映射一定立即解除。退出并 join 专用控制线程可以结束该线程的 TLS 生命周期，但最终是否立即解除映射仍取决于平台加载器和其他引用。观察到映射保留时，应核查这些生命周期条件，不直接将其认定为 SDK 内存泄漏。

## 初始化和 HCD

初始化参数示例：

```json
{
  "data_dir": "/var/lib/pilot-sdk/instance-a",
  "resource_dir": "/opt/pilot-sdk",
  "home_dir": "/home/example",
  "user_id": "example-user"
}
```

目录为绝对路径，资源目录必须存在。只有使用 `~/` 时才需要显式提供 `home_dir`；SDK 不从宿主 HOME 扩大采集范围。同一状态目录只能有一个活动实例。不同实例使用不同目录。

宿主关闭 `dynamic_observe_enabled` 时，应停止、销毁实例并停止加载 SDK。显式启动示例：

```json
{
  "version": "policy-1",
  "dynamic_observe_enabled": true,
  "agents": ["qoder", "codex"],
  "hcd": {
    "agent_configs": {
      "qoder": {
        "collection": {
          "enabled": true,
          "profile": "qoder_trace_v1",
          "allowed_roots": ["/home/example/.qoder", "/var/lib/agent-hooks/qoder"],
          "sources": [
            {"id": "native", "type": "transcript", "path": "/home/example/.qoder/projects"},
            {"id": "history", "type": "hook_jsonl", "path": "/var/lib/agent-hooks/qoder"}
          ],
          "limits": {"max_files": 512, "max_read_bytes": 8388608, "poll_interval_ms": 1000},
          "output": {"schema": "aah.activity.v2", "mode": "async_observe"}
        }
      },
      "codex": {
        "collection": {
          "enabled": true,
          "profile": "codex_rollout_v1",
          "allowed_roots": ["/home/example/.codex"],
          "sources": [{"id": "sessions", "type": "transcript", "path": "/home/example/.codex/sessions", "read_mode": "tail"}]
        }
      }
    }
  },
  "sdk_options": {
    "hooks": {"blocking_agents": ["qoder", "qodercli"], "sync_wait_enabled": true, "local": {"mode": "all", "types": []}},
    "mask": {"mode": "none", "types": []},
    "delivery": {"max_events_per_batch": 128, "max_batch_bytes": 8388608, "max_event_bytes": 8388608}
  }
}
```

路径也可按 `linux`、`darwin`、`windows` 提供平台对象。SDK 校验实际打开的文件和目录边界，拒绝采集中的符号链接或 reparse 跳转。资源目录不授予额外的采集权限。源暂时不存在时报告 waiting，不创建 Agent 的源目录；出现后继续启动。来源或 profile 改变会使用新的进度命名空间；限额、脱敏参数调整保留来源身份，只重建受影响的输入。

云壳嵌入模式保证 Qoder 和 Codex 两个 profile；完整模式的其他 Agent 继续沿用原实现。Qoder 的 `hook_jsonl` 是现有 `qoder-YYYY-MM-DD.jsonl` 历史事件目录，最多一个；`transcript` 是授权的原生 transcript 目录，需通过 SDK Hook 发布现有 Qoder 唤醒元数据。还可显式提供 `sqlite`、`segments`、`intercept` Token 来源。Codex 使用一个原生 rollout 目录。未列出的默认目录不会作为兜底读取。

启动普通版 Qoder CLI 时在进程环境中设置 `QODER_EXPOSE_TOKEN_USAGE=true`，SDK 直接从授权 transcript 的逐响应 `message.usage` 读取真实用量。Qoder CLI 1.1.76 已验证。完整 Pilot 的既有 Unix 启动入口会设置该变量，云壳管理 Qoder 进程时应在启动时传入。Qoder 设置文件里的 `env` 对该开关无效。没有正数用量的原生占位记录不作为计量来源。现有诊断 segments 和历史 sidecar 仍可用于兼容读取，Qoder IDE 沿用 SQLite。

`max_files` 默认 512，上限 16384，限制每次采集打开的不同文件，包含必要的元数据；`max_read_bytes` 默认 8 MiB，上限 64 MiB，应用于原生输入的单文件/单次读取预算；轮询默认 1000ms，上限 300000ms。超限保留进度并报告，不静默截断。原生输入本身的边界、历史基线与去重规则继续生效。

脱敏沿用原 `MaskConfig` 和处理管道。启用本地拦截的敏感类型也会纳入活动脱敏。嵌入实例使用库内置规则，不从宿主工作目录或 HOME 搜索规则文件。SDK 日志按实例保存、轮转并脱敏，不接管宿主日志出口。

## 活动、监控与背压

`on_activity` 接收多条独立 JSON 视图，沿用现有 Pilot 事件格式作为 `aah.activity.v2` 的兼容基线。数据在交付前序列化一次，SQLite 事务同时接收事件和对应进度；重试、恢复复用原始字节及 `event.id`。

返回 ACK 表示宿主接受整批数据，SDK 可记账并释放；返回 RETRY 或未知值保留数据，未知值另外报告协议异常。宿主 ACK 后的存储、转发和去重由宿主负责。如果宿主已经 ACK 而 SDK 尚未完成记账就崩溃，允许重放原事件。

`sdk_options.delivery` 支持启动和运行时完整快照更新，默认值为：

- 批次 128 条、8 MiB，单条 8 MiB；组批等待 1000ms。
- 待交付内存预算 16 MiB，磁盘队列未确认 JSON 负载预算 256 MiB；SQLite 页、WAL 和进度文件存在额外开销，这两个参数不是整个宿主的内存或磁盘总额。
- 重试从 1000ms 指数退避到 30000ms，加入抖动。
- 高/低水位 80%/50%；持续重试 60000ms 后告警，每 300000ms 限频重复，容量不足立即告警。

对应字段为 `flush_interval_ms`、`queue_memory_bytes`、`queue_disk_bytes`、`retry_initial_ms`、`retry_max_ms`、`backpressure_high_percent`、`backpressure_low_percent`、`retry_alarm_after_ms` 和 `alarm_repeat_ms`。批次数有效范围为 1～4096，批字节上限 64 MiB，内存上限 256 MiB，队列负载上限 4 GiB；内存及磁盘预算至少能容纳一个合法批次，单条不能大于批次，低水位必须低于高水位。

降低限额不驱逐原有积压。已有事件超出新限额时保留并报告，等待调大参数；持续 RETRY 会暂停可暂停的采集，积压回落后恢复，不阻塞 Agent，也不改变 Hook 截止。不可暂停的裁决记录入口容量耗尽时报告异常，不能无限缓存。

监控独立于活动交付，复用现有 L1/L2 指标，并报告队列、来源和 SDK 告警。CPU/RSS 标注 `metrics_scope=host_process`；安装、更新器等不适用于嵌入模式的指标标为 not-applicable。监控状态可以合并，持久告警直到其实际批次 ACK 后才移除。

完整版与 SDK 共用进程资源采样器。Mac/Windows 的完整版 L1 同样使用当前进程的实际 CPU/RSS，内存保持整数 MiB 字符串；CPU 尚无有效区间时省略数值并标记不可用，不再输出占位值。Linux 保留原有采样和字段口径。

SDK 的自监控包括以下字段与口径：

- `pilot.metrics.l1`：宿主进程 CPU/RSS/FD、实例身份、输入输出窗口，以及 SDK 数据目录的有界磁盘采样。Linux 沿用 `/proc`；Mac/Windows 使用已依赖的 sysinfo，仅刷新当前宿主 PID。`cpu_available`、`mem_available`、`open_fd_available` 说明可用性，CPU 首次采样尚无时间区间或采样失败时不伪造零值；不提供受管运行时的堆指标。目录采样沿用 30 秒首次延迟、10 分钟周期和已有资源告警阈值；未知大小不伪造为零。队列 `disk_bytes` 包含 SQLite、WAL 和 SHM 的物理文件大小，`pending_bytes` 仍是未 ACK 的 JSON 负载。
- `pilot.metrics.l2`：Agent/Input/callback 指标，以及 cloud/local 两路 Hook 的次数、总耗时和最大耗时。Hook 行带 `hook_channel`、原 `hook_event` 与 `timing_scope=sdk_verdict`；它测量 SDK 裁决段，不是 bin 冷启动到 Agent 收到结果的整条耗时。callback 的 `total_delay_ms` 是成功 ACK 事件从入队到交接的累计延迟；另列 `callback_duration_ms_total`、启动时间及最近 ACK 时间。
- `pilot.token_usage`：按 Agent、UTC 日期持久累计的 `llm_responses_total`、`responses_with_usage`、input/output/cache tokens。它与来源进度、outbox 同事务提交，活动 RETRY、恢复重放及 ACK 不重复累计。`usage_basis=accepted_normalized_llm_response`、`source_scan_performed=false` 明确其基于 SDK 接受的归一化响应，不是独立扫描 Agent 原生文件，不用于替代其他口径的计费核对。升级前已接收的活动不会倒推补计；`since_unix` 标明起点。缺少 token 的响应不冒充已知的零用量。
- `pilot.trace_runtime`：`buffer_scope=sdk_delivery_outbox` 下的待交付数量、字节及最老积压时长。活动回调模式不运行 OTLP 转换器，因此 `converter_available=false`，不虚构完整模式的转换缓冲或转换耗时。完整 Pilot 的 OTLP 监控继续走原实现。
- `pilot.alarm`：保留 SDK 专有告警，并补齐旧告警的 `alarm_type`、`alarm_level`、`alarm_count`、`alarm_message`、`user_id`、`ip`、`ver`、`__time__`。CPU/内存告警标为宿主进程口径，队列、来源及 SDK 数据目录告警标为实例口径。告警不含活动正文。

活动在首次持久交付前补充 SDK `version`；与完整模式的 SLS 出口一致，该已知元数据使用 SDK 版本覆盖同名来值，其余未知字段保留。裁决审计事件也带 `version` 和 `user.id`。因此版本筛选和旧告警字段不需要云壳另补 SDK 本身已知的信息；宿主仍负责其安全上下文和接收端存储。

## 两条 Hook 与截止

SDK 分别发布 `sdk-hooks-cloud.json` 和 `sdk-hooks-local.json`，包含进程号、实际 loopback UDP 端口、实例标识和随机 token。两个入口各自最多同时运行 8 个裁决工作，互不占用对方的并发额度。

可直接使用原生外壳作为短命 Hook 客户端，此命令不加载采集动态库：

```sh
loongsuite-pilot sdk-hook --data-dir /var/lib/pilot-sdk/instance-a \
  --channel cloud --agent qoder --event PreToolUse
```

Qoder CLI 可以把 Pilot 可执行文件的绝对路径作为 `command`，并用 `args` 分别传入这些参数。Agent JSON 从 stdin 输入。`--channel local` 使用 SDK 本地规则，`cloud` 使用 `on_hook`。Qoder CLI 输出协议使用 `--agent qodercli`。完整 Pilot 的 `interceptor hook` 命令保留其 HTTP 和 Agent 协议，也经过同一原生硬截止外壳。

采集唤醒的 `Stop` Hook 可以直接调用同一个可执行文件，参数为 `hook-process qoder --wakeup-only --agent-id qoder --log-prefix qoder --data-dir /var/lib/pilot-sdk/instance-a`。它写入实例的有界唤醒元数据，采集器按 transcript 进度继续读取。

大输入不直接塞进 UDP。客户端把最多 1 MiB JSON 放在实例私有的 `hook-requests-cloud/local` 目录，用最多 16 个跨进程租约限制未完成请求，再发小于 4096 字节的关联报文。SDK 校验 token、进程/实例关联、请求 ID、长度、期限及文件边界。回包不超过 32 KiB；需要自己实现客户端时，报文定义见 `src/sdk/hook_protocol.rs`，发送与租约处理见 `src/sdk/hook_bin.rs`。

SDK 归一化 `trace_id`、`client_event_id`、`agent`、`event`、`session_id`、工具/命令/提示等字段，保留未知字段；`supports_blocking` 来自可信策略和真实 Agent 能力。`on_hook` 写入 `{"action":"allow"}` 或 `{"action":"block","reason":"..."}`。不支持阻断、失败、无效响应和迟到结果一律放行。

bin 在端口描述不存在、进程已退出或端口拒绝连接时立即放行。支持接收回执的 SDK 在确认收到请求前最多等待 200 ms，避免残留端口描述指向无响应的端口时拖慢 Agent。收到回执后才等待裁决。bin 从程序入口计算 3 秒截止，包含 stdin、通信和冷启动。工作线程做等待，主线程独占 Agent 输出，独立截止守卫保证阻塞 stdin 或输出时也结束整个进程。裁决记录异步交接，不等待活动 ACK；SDK 丢弃迟到裁决。整条 Agent Hook 的 4 秒目标仍需结合宿主调度验证。
