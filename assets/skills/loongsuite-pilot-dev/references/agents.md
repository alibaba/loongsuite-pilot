# Agent 接入与二进制 Hook

## 新增或改造 Agent

1. 在 `agents.d/` 找相近定义，沿 `src/deployment/agent_def_loader.rs`、`src/deployment/deployment_manager.rs` 和 `src/core/orchestrator.rs` 确认发现、部署、启停及输入注册的实际入口。保持历史 Agent ID、配置与用户自有 Hook 兼容。
2. 先验证不同平台和 Agent 版本真实产生的最小脱敏样本。明确 transcript、SQLite、Hook 各自的权威字段，约定回合、步骤和 tool call ID 的生成/关联规则。以 `src/inputs/base/`、`src/inputs/rest_support.rs` 和同类 adapter 为起点。
3. 复用标准事件构造，覆盖 request、response、tool call、tool result、可用 token、结束原因及内容采集开关。区分源没有提供用量、合法的零值和实际缺失。未经实测的来源不写成已支持。
4. SDK 按 profile 和已授权来源实例化采集器。确认增量、轮转、截断、半行和进程重启。checkpoint 随可恢复的交付边界推进，重放保留事件 ID。将旧进度导入新命名空间时只初始化空状态，导出给旧版前确认 outbox 已排空。参考 `tests/qoder_533_recovery_pipeline.rs` 和 `tests/codex_checkpoint_backpressure_history.rs`。
5. 用真实 Agent 加安装包验证发现、部署、首轮、续轮、重启恢复、输出、卸载清理及升级后的旧配置行为。文档入口是 `docs/zh-CN/agent-onboarding.md`。

## 按 Qoder 将 Hook 改为原生入口

- 参考 `src/deployment/hook_strategy.rs` 的 `qoder_exec_args` 和 `qoder_exec_definition`。让 Agent 用命令和独立参数调用安装后的 `loongsuite-pilot-sdk-hook`，检查空格、Unicode 路径和 Windows 参数处理。部署需要幂等，替换 Pilot 管理的旧条目并保留用户自己的 Hook。
- 完整 Pilot 的 Qoder Stop、SubagentStart 和 SubagentStop 使用共享二进制的 `sdk-hook --channel observe` 模式。`src/hook_process/qoder_wakeup.rs` 写入唤醒通知，`src/inputs/qoder-trace/transcript_source.rs` 和 `transcript_scanner.rs` 负责读取原生会话和轮询兜底。token 关联查同目录 `token_enricher.rs` 与各 reader。普通 Qoder CLI 的原生 usage 开关由宿主在启动进程时传入 `QODER_EXPOSE_TOKEN_USAGE=true`，详见 `docs/zh-CN/sdk.md`。处理完整字段和磁盘增量的工作留在 collector。
- 同步拦截是另一条链路，完整版 Qoder 由 `sdk-hook --channel local --agent qoder-auto` 进入 SDK 本地裁决。Qoder IDE 和 CLI 可以共用设置，原生 Hook 按实际进程识别并使用对应输出契约。检查端点不可达时快速放行。Agent 侧只收到一次有效响应。SDK 裁决协议查 `include/pilot_sdk.h` 和 `src/sdk/hooks.rs`。验收用无敏感内容的关键词做允许和拒绝对照，检查真实 Qoder CLI 的目标工具是否执行。同步阻断使用退出码 2 和 stderr，验证直接命令和兼容包装器都能将退出码传给 Qoder。
- 先确认宿主确实支持二进制 Hook。逐项检查新旧路径、安装包资产、Hook 配置和真实事件字段。证明该路径不启动 Node/JS 后，才删除它专用的脚本和打包条目。其他宿主加载的插件有独立契约，按宿主逐一迁移。

## 完整 Pilot 的 Codex 采集

- 完整版原生注册 Codex rollout 和中止回合补采，沿用现有监听和 `CODEX_HOME` 配置。
- 保留 Codex 已注册的 Hook 命令与信任记录。Unix 和 PowerShell 启动脚本调用完整版入口，由原生处理器写唤醒和 span 上下文。
- 从曾由 SDK 采集的版本迁移时，完整版用原事件 ID 补交上一实例的未确认批次，再按监听器命名空间接管进度。验证同一会话的续采、请求响应关联、真实 token 和工作区字段。

## 接入 SDK Hook

- 按 Agent 的部署、采集和裁决需求判断是否需要进入共享 SDK，再新增对应入口。SDK 支持的 Agent 在 `src/sdk/agent_hooks.rs` 注册 ID、兼容别名和裁决事件，在 `src/sdk/policy.rs` 校验 profile 与来源，沿 `src/sdk/runtime.rs` 查采集入口。复用 `sdk-hook` 的传输和限时，分别按策略处理端点不可达、已受理超时和过载，实现时沿轻量函数检查链接依赖，两种壳复用一个 Hook 二进制，部署策略按各自入口配置。将完整 Pilot 已有的 Hook 命令作为兼容入口时，按正式 Node.js 回滚目标核对恢复的配置。
- 观察点使用 `sdk-hook --channel observe` 唤醒采集。使用 `--channel local` 验证本地同步裁决。裁决事件要依据 Agent 当前版本的 Hook 输出契约更新 `src/sdk/hook_protocol.rs`，新增 Agent 以该 Agent 实测支持的事件为准。
- 唤醒只能引用该实例策略中的授权源。使用 SDK 的源命名空间和采集器现有进度机制。运行时策略应能独立启停已编入的适配器。验收加上端口缺失快速放行、观察不走裁决、重启不重复、部署与清理保留用户 Hook，并记录该 Agent 加入后的库与 Hook 二进制增量。

## 复用 Qoder 迁移路径

- 将宿主能力、部署产物和事件内容分开验收。完整版由外壳提供 Agent、输出和隐私配置，嵌入模式由调用方提供 Agent 策略和输出回调。两端使用同一份 SDK、同一个 Hook 二进制和同一份采集实现。
- 以原始 transcript 或 SQLite 为主要数据源时，Hook 只发有界唤醒或裁决。Qoder 的观察和本地裁决分别使用 `observe` 和 `local`。未授权的路径、事件和 Agent 不能开启强制裁决。
- 新的裁决适配器保留 SDK 硬截止和 Agent 的原生阻断契约。容量取当前 SDK 实例与 Hook 客户端协议的配置。宿主按 `remaining_ms` 控制等待。使用 `hook-client.jsonl` 与 `hook-verdict.jsonl` 按 ID 对齐接收、排队、回调及回复。
- 并发回归用 SDK 已接收的请求和回调区间证明重叠。使用受控回调延迟核对每条结果，覆盖在线过载、端点不可达、同 ID 重试只裁决一次和真实 Agent 的实际工具行为。
- 成对交付同一提交的动态库和 Hook。利用隔离目录覆盖受管配置安装、更新、查询及清理，保留用户和第三方 Hook。通过持久 ACK、无重复续采及正式 Node.js 版本升级回滚验收后，再更新 README 对该 Agent 的支持状态。

## 宿主插件和恢复

- Hermes 等由 Agent 宿主加载的插件继续使用其宿主要求的语言。完整版的 Rust 采集器负责已部署源的进度、字段归一化与输出。加入宿主资源时同时核对打包白名单、部署依赖及升级回滚事务的资源角色和上限。
- 复用原始日志与 checkpoint 契约时，按可持久化区分进程、用户、会话和轮次。验证会话轮转、PID 复用、分段与半行、输出背压及重启重放。源文件的回收只能使用已落盘的 offset 和文件身份。没有可靠的终止证据时继续等待显式生命周期标记。

## 性能

Hook 短小且有界。读取按源偏移增量推进，稳定文件标识和偏移可避免重复扫描。按需解析负载，使用 `&str`、`&[u8]` 借用同一条记录，跨任务、持久化或需要独立生命周期时才持有所有权。批次序列化一次，保留可重放字节。索引缓存要写清失效和重建条件，覆盖增长、轮转和重启，避免用省 CPU 换取错误匹配或无限增内存。优化前后用同一负载、轮询和验证器对照。
