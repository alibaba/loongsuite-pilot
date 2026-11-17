# 架构与调试

## 运行入口和职责

- CLI 在 `src/cli/`。完整 Pilot 启动、发现和管理 Agent 由 `src/core/orchestrator.rs` 组织。`src/core/config_loader.rs` 负责配置兼容和默认值。
- Agent 声明在 `agents.d/`，解析和部署在 `src/deployment/`。`src/core/agent_discovery_service.rs` 启动时刷新，并在运行期间由 watcher 与全局轮询发现变化。`src/core/input_manager.rs` 管理采集实例。
- `src/inputs/` 读取 Hook、transcript、SQLite 或插件数据。`src/normalization/` 构造标准事件及回合关联。`src/checkpoints/` 保存源偏移与去重快照。`src/flushers/` 负责 JSONL、SLS、HTTP、OTLP 输出。数据字段查 `docs/zh-CN/output-event-schema.md`。
- `include/pilot_sdk.h` 定义 C ABI。两个宿主共用同一构建的动态库和 `loongsuite-pilot-sdk-hook`。完整 Pilot 管理配置、发现、服务和输出，`src/core/sdk_agent.rs` 通过 ABI 控制 SDK 并把活动交给现有 flusher。云壳通过相同函数表传入 HCD 和 Agent 策略并接收活动，参考 `examples/pilot_sdk_host.c`。ABI 以头文件中的版本、结构体大小、指针有效期和所有权约定为准。
- Qoder 默认路径由 `register_sdk_qoder` 选择 `qoder_trace_v1`，将本机授权来源、采集开关、轮询、排除目录和屏蔽配置交给 SDK。默认 transcript、SQLite、token 和子 Agent 关联均由 SDK 处理。完整 Pilot 仍为上游 link 和 Qoder 多模态配置保留兼容路径，迁移这些配置前要验证各自的输出契约。
- 完整 Pilot 的 SDK 数据在 `state/standalone-qoder-sdk`，其下按来源配置生成采集命名空间，outbox 与采集 checkpoint 共用持久接管边界。保存原 `logs/input-state.json` 的相应偏移用于 Node.js 升级和回滚。回写前读 SDK snapshot、校验命名空间并确认待交付事件为零。
- SDK 启停返回受理结果。宿主控制线程按头文件调用 `dispatch(handle, 0)` 直到对应生命周期回调完成。等待 stop 完成和回调返回，处理 destroy 的 BUSY 并在成功后卸载。Activity 的 ACK 接受整批，RETRY 重交原始数据和 event.id。SDK 的本地拦截与云壳 on_hook 裁决是独立链路。宿主回调必须及时返回。
- `deploy/` 和 `src/updater/` 负责安装、升级与回滚。安装默认非交互，省略 Agent 白名单时持续发现。Dashboard 与菜单栏各自显式启用。排查时关注 `logs/runtime.json`、服务日志、版本指针及最新一次重启失败记录。

## 开发构建

使用 CI 的 Rust 工具链及仓库锁文件。开源分支的构建前置步骤会校验 Boa 源码归档的 SHA-256，准备到本地 `.build/`。这只影响构建。

```sh
python3 scripts/build/prepare-rust-dependencies.py
cargo build --locked --all-features --lib --bin loongsuite-pilot --bin loongsuite-pilot-sdk-hook
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
```

保持可执行文件、动态库、Agent 声明和运行资产来自同一提交。商业版使用其自身依赖准备与打包步骤。可选宿主插件有各自的语言运行契约，按对应工作流构建和验证。

## 隔离调试

先记录源版本、平台、Agent 版本、配置和触发步骤。为 HOME、USERPROFILE、Pilot 数据目录及 Agent 数据建临时目录，使用临时配置与独立的端口，避免连接个人正在运行的实例。启动命令先查 `loongsuite-pilot --help` 和 `src/cli/args.rs`。原始日志、用户 ID、消息正文、环境凭据不进入公开 issue、提交或 CI 产物。

沿同一个合成会话核对原始输入、输出 JSONL、`logs/input-state.json` 和去重状态。若涉及输出，在本地接收器或授权测试 Logstore 确认抵达情况。若涉及运行时安装，检查实际执行入口和加载库路径，避免旧 PATH、旧服务或残留 Hook 干扰。
