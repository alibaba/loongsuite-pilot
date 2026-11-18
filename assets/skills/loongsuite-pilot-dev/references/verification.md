# 测试与发布验收

## 测试选型

- 单元测试靠近实现，覆盖最小解析、配置默认值、边界和错误恢复。格式变化用固定脱敏 fixture 检查旧输入与新输出。
- 集成测试置于 `tests/*.rs`。通过真实 CLI 或实际输入源进入，复用已有 harness。例子包括 `qoder_native_wakeup.rs`、`qoder_native_transcript_input.rs`、`interceptor_native.rs`、`sdk_dynamic.rs`、`installer_native.rs` 和 `installer_dashboard_history.rs`。
- 异步测试等待可观察的状态变化并设上限。测试独立的数据目录、进程和端口。结束时停止子进程并释放锁。不要依赖当前用户已有 Agent、已装 Pilot、账号或开发机网络。
- 恢复类改动覆盖短读、失败重试、并发关闭、重启回放、偏移、重复 ID 及异常时的反压。输出类改动核对字段和事件数，同时检查内容采集与屏蔽设置。
- 安装、升级和回滚要用构建出的安装资产。模拟和实机结果分别记录。Windows 脚本看 Windows PowerShell 5.1 及工作流支持的其他宿主契约；macOS 菜单栏需要真实桌面环境。平台特有行为以对应原生验收为准。

## 命令与门禁

构建同版本 CLI 和动态库后，按改动选择测试。下面的命令在隔离环境内运行。完整门禁见 `.github/workflows/ci.yml`，SDK 打包和宿主检查见 `.github/workflows/sdk.yml`。

```sh
cargo test --locked --all-features --test qoder_native_wakeup --test qoder_native_transcript_input
cargo test --locked --all-features --test sdk_dynamic --test interceptor_native
cargo test --locked --all-features --test installer_native --test installer_dashboard_history
cargo test --workspace --locked --all-features
```

## 安装态和嵌入验收

1. 干净安装、重装已有配置、升级、故障回滚及卸载。检查版本指针、进程、Hook 和数据目录。验证缺失参数直接报错，省略 Agent 白名单能发现后来安装的 Agent，本地观测默认关闭且可单独开启。
2. 真实 Qoder 触发模型和工具事件。核对四类事件、稳定 ID、字段完整性、消息开关、token 来源和 checkpoint 恢复。用隔离 JSONL 或本地接收器按验证会话和事件 ID 对账，记录计数和质量指标。
3. 对照完整 Pilot 和 C 宿主使用的动态库及 Hook 可执行文件 SHA-256，并用同一份真实输入验证两端输出。按字段语义处理独立运行的时间、环境和 ID，检查父调用、子 Agent 和 Trace 关联。测试 ABI 版本、回调数据、ACK/RETRY、启停、销毁和 fail-open。打包按平台检查头文件、库、实际需要的二进制和说明文件；记录架构、签名和真实机覆盖范围。
4. 推送前检查变更清单和 `git diff --check`，仅提交供回归使用的脱敏样本、代码和通用文档。阶段性能力盘点和实机结果留在本地。

## 与正式 Node.js 发布版验证升级回滚

1. 记录发布资产的版本和 SHA-256，使用原发布安装器把 Node.js 版装入隔离目录。保留用户及第三方 Hook，使用真实 Agent 读写同一会话。
2. 使用候选安装包升级，检查实际进程位置、版本指针和服务心跳。用同一会话再触发事件，重启后继续验证稳定 ID、无重放缺失和旧 checkpoint 接续。
3. 为重装和升级分别注入候选 collector 启动故障，保留完整安装入口和候选合法性。确认故障确实触发，安装器返回失败，版本指针恢复，Node.js 进程由原服务管理器拉起并更新心跳。在 Windows 读取实际 Task Scheduler 启动结果与 collector PID。
4. 正常升级后从安装入口手动回滚，确认正式 Node.js 能续采同一会话，旧 Hook 恢复且用户条目保留。测试用故障注入和 CI 验收包只用于隔离验证。
