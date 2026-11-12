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
2. 真实 Qoder 触发模型和工具事件。核对四类事件、稳定 ID、字段完整性、消息开关、token 来源和 checkpoint 恢复。用授权 SLS 测试环境按时间、版本、Agent 和验证 ID 检索，记录计数和质量指标。保留能复核的查询口径。
3. 用同一动态库测试完整 Pilot 与 C 宿主。测试 ABI 版本、回调数据、ACK/RETRY、启停、销毁和 fail-open。打包按平台检查头文件、库、实际需要的二进制和说明文件；记录架构、签名和真实机覆盖范围。
4. 推送前检查变更清单和 `git diff --check`，确保没有日志、凭据、测试临时产物或商业文件。开源验收通过后单向同步商业分支并重跑所需测试。
