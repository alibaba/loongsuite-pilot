# Agent 接入与二进制 Hook

## 新增或改造 Agent

1. 在 `agents.d/` 找相近定义，沿 `src/deployment/agent_def_loader.rs`、`src/deployment/deployment_manager.rs` 和 `src/core/orchestrator.rs` 确认发现、部署、启停及输入注册的实际入口。保持历史 Agent ID、配置与用户自有 Hook 兼容。
2. 先验证不同平台和 Agent 版本真实产生的最小脱敏样本。明确 transcript、SQLite、Hook 各自的权威字段，约定回合、步骤和 tool call ID 的生成/关联规则。以 `src/inputs/base/`、`src/inputs/rest_support.rs` 和同类 adapter 为起点。
3. 复用标准事件构造，覆盖 request、response、tool call、tool result、可用 token、结束原因及内容采集开关。区分源没有提供用量、合法的零值和实际缺失。未经实测的来源不写成已支持。
4. 确认增量、轮转、截断、未写完的一行和进程重启的处理。checkpoint 只推进到可恢复的交付边界。重放保留原始事件 ID，交付失败/队列满时保留待处理进度。参考 `tests/qoder_533_recovery_pipeline.rs` 和 `tests/codex_checkpoint_backpressure_history.rs`。
5. 用真实 Agent 加安装包验证发现、部署、首轮、续轮、重启恢复、输出、卸载清理及升级后的旧配置行为。文档入口是 `docs/zh-CN/agent-onboarding.md`。

## 按 Qoder 将 Hook 改为原生入口

- 参考 `src/deployment/hook_strategy.rs` 的 `qoder_exec_args` 和 `qoder_exec_definition`。让宿主用命令和独立参数调用安装后的 Pilot 二进制，检查空格、Unicode 路径和 Windows 参数处理。部署需要幂等，替换 Pilot 管理的旧条目并保留用户自己的 Hook。
- Qoder Stop 调用 `hook-process qoder --wakeup-only`。`src/hook_process/qoder_wakeup.rs` 写入唤醒通知，`src/inputs/qoder-trace/transcript_source.rs` 和 `transcript_scanner.rs` 负责读取原生会话和轮询兜底。token 关联查同目录 `token_enricher.rs` 与各 reader。普通 Qoder CLI 的原生 usage 开关由宿主在启动进程时传入 `QODER_EXPOSE_TOKEN_USAGE=true`，详见 `docs/zh-CN/sdk.md`。处理完整字段和磁盘增量的工作留在 collector。
- 同步拦截是另一条链路，Qoder 由 `interceptor hook --agent qoder-auto` 进入原生判定。检查端点不可用、无效裁决、超时和关闭期间快速放行，Agent 侧只有一次有效响应。云壳裁决协议查 `include/pilot_sdk.h` 和 `src/sdk/hooks.rs`。验收使用无敏感内容的关键词和 Agent 正常运行的对照场景。
- 先确认宿主确实支持二进制 Hook。逐项检查新旧路径、安装包资产、Hook 配置和真实事件字段。证明该路径不启动 Node/JS 后，才删除它专用的脚本和打包条目。其他宿主加载的插件有独立契约，按宿主逐一迁移。

## 性能

Hook 短小且有界。读取按源偏移增量推进，稳定文件标识和偏移可避免重复扫描。按需解析负载，使用 `&str`、`&[u8]` 借用同一条记录，跨任务、持久化或需要独立生命周期时才持有所有权。批次序列化一次，保留可重放字节。索引缓存要写清失效和重建条件，覆盖增长、轮转和重启，避免用省 CPU 换取错误匹配或无限增内存。优化前后用同一负载、轮询和验证器对照。
