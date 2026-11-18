# Rust Pilot 的 Agent 能力与验收状态

本文供维护者核对迁移范围。Node.js 对照使用正式 [v1.18.0](https://github.com/alibaba/loongsuite-pilot/releases/tag/v1.18.0)。性能以有公开记录的正式版本和 Rust 提交为准。

## Qoder IDE 与 CLI

- **采集与续采**由 SDK 的 Qoder profile 执行。输入使用 transcript、IDE SQLite、分段数据和可用的 token 来源，经 SDK 归一化和 checkpoint 交付。完整版外壳提供用户、隐私、工作区、安装资源及 JSONL、SLS、Trace 等出站配置。云壳通过活动批次接收同一标准事件，ACK/RETRY 维持数据交付语义。CLI token 取决于源和对应的 usage 开关。
- **拦截**使用同一个原生 `loongsuite-pilot-sdk-hook`。完整版通过 SDK `local` 通道执行本地策略，云壳通过 `cloud` 进入 `on_hook`。独立的 `observe` 通道负责唤醒。云壳策略提供 HCD 和 Agent 列表，由 SDK 安装或清理本实例的受管 Hook。
- **Node.js 差别**集中在生产入口和状态交接。Rust 用原生二进制处理 Hook，保留安装态升级和回滚所需的旧进度兼容。Node.js 的 Agent 插件、扩展和适配范围按其发行版单独维护。完整版的 ACP、多模态和出口由外壳编排。
- **可用性**以 README 的 Qoder IDE 与 CLI 为声明范围。云壳集成验收覆盖真实 Qoder CLI、原生阻断结果、源授权、重启续采和自动部署清理。Qoder CN、Qoder Work、JetBrains 等变体需各自验收。

## Codex

- **采集与续采**运行在完整版外壳。原生 Codex Hook 写唤醒和 trace 上下文，外壳的 rollout 采集器读取普通与中断回合、token、调用关系和 checkpoint。历史 SDK 批次重放保留原事件 ID，由外壳接管进度。入口在 [Codex transcript](../../src/inputs/codex-transcript/) 和 [编排](../../src/core/orchestrator.rs)。
- **部署与拦截**使用完整版的受管 Hook 和 Agent 信任记录。现有 Rust 的 Codex 接入用于采集和开发验证，拦截和云壳 SDK 交付范围均为 Qoder。
- **Node.js 差别及可用性**已有独立 rollout 和性能验证。安装态跨 Codex 版本、工具关联、token、trace、配置所有权和正式 Node.js 回滚需要维护者给出逐平台验收结果，之后再更新 README 的支持声明。

## 其他 Agent

- **现有实现**依 Agent 分布在完整版外壳及 Agent 宿主插件。日志或 transcript 适配器位于 [inputs](../../src/inputs/)，配置部署位于 [deployment](../../src/deployment/)，按宿主运行的扩展位于 [assets/plugins](../../assets/plugins/)。
- **Node.js 差别及可用性**以 [Node.js 的 Agent 列表](https://github.com/alibaba/loongsuite-pilot/blob/v1.18.0/docs/zh-CN/agents.md) 和 [Rust 支持状态](../../README.zh-CN.md#rust-版本的-agent-支持状态) 核对。已有 Rust 实现的能力随实际部署、采集样本和发行包验证确认。千问办公与 OpenClaw 的 Node.js 拦截等功能待对应 Rust 维护者适配与验收。
- Node.js main 新增的 Multica 观测与 Pod 来源识别、千问办公协作会话、多身份部署和 Claude SDK preload 按各自入口核对。Codex 的系统 Hook 使用 Rust 部署入口。千问办公协作采集在完整版读取授权的会话状态，定向测试覆盖权限、终态与重启去重，真实客户端验收仍待完成。Multica 在完整版使用 Rust 采集入口，按来源维护 checkpoint 和待投递批次。Linux 多身份启动、Agent 配置所有权及 Claude SDK preload 使用完整版入口，其中 preload 已经过宿主模拟。真实 Multica 服务和 Pod 环境由维护者按部署目标验收。
- Hermes 使用宿主 Python 插件生成事件，Rust 输入与 Trace journal 按用户、会话和轮次处理轮转。Linux 同一 PID 命名空间的退出恢复要求确认进程身份、持久游标和源分段完整。旧插件继续通过显式结束记录闭合。相关边界和字段见 [Trace 输出](trace-output.md)。
- OpenCode 与 Pi 的历史回放在完整版按 4 MiB/分钟默认速率限流，每周期至多处理 256 条或约 50 ms 进程 CPU；增量偏移仍按完整 JSONL 记录推进。性能需按 Agent 的原生输入、实际输出量和字段质量确认。目前公开的持续性能报表覆盖 Qoder 与 Codex。

## 已有高负载性能记录

下列为完整版 Pilot 的三轮中位数。平均 CPU 按测量窗口统计，峰值指标按采样区间统计。运行链接可查看对应版本与口径。跨 runner 的数值用于观察，代码归因需要同机对照。

- Qoder Rust 已合入并发裁决的 `5f56677f` 平均／峰值 CPU 35.61%／139.12%，平均／峰值 RSS 46.25／54.17 MiB，缺失和重复均为 0。同一源码树的候选跑在另一种处理器上。[合入后的 Qoder CI](https://github.com/alibaba/loongsuite-pilot/actions/runs/44274371069)
- Qoder Rust 并发裁决候选 `0a2b2775` 平均／峰值 CPU 21.76%／111.16%，平均／峰值 RSS 45.63／49.62 MiB，数据质量无缺失、无重复。[并发修复的 Qoder CI](https://github.com/alibaba/loongsuite-pilot/actions/runs/44271151629)
- Qoder Rust `91ce4a6d` 平均／峰值 CPU 17.35%／87.89%，平均／峰值 RSS 45.08／51.80 MiB。[Rust Qoder CI](https://github.com/alibaba/loongsuite-pilot/actions/runs/44256124710)
- Qoder Node.js `v1.17.1` 平均／峰值 CPU 124.41%／201.41%，平均／峰值 RSS 138.33／169.67 MiB。[Node.js Qoder CI](https://github.com/alibaba/loongsuite-pilot/actions/runs/43891800054)
- Codex Rust `c4543bc6` 平均／峰值 CPU 69.86%／217.31%，平均／峰值 RSS 65.09／78.78 MiB。[Rust Codex CI](https://github.com/alibaba/loongsuite-pilot/actions/runs/44029353647)
- Codex Node.js `v1.17.1` 平均／峰值 CPU 93.33%／180.91%，平均／峰值 RSS 133.12／135.49 MiB。[Node.js Codex CI](https://github.com/alibaba/loongsuite-pilot/actions/runs/43891830163)

改造时从 [Agent 接入与二进制 Hook](../../assets/skills/loongsuite-pilot-dev/references/agents.md) 开始。用各 Agent 原生记录对照标准事件、恢复边界和真实行为，再判断是否需要迁入 SDK。
