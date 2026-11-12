---
name: loongsuite-pilot-dev
description: Develop, debug, test, and review the Rust LoongSuite Pilot runtime and CloudShell SDK. Use for Agent discovery and adapters, native Hook migration, transcript recovery, event quality, installer defaults, SDK ABI, or performance benchmarks and GitHub Pages reporting in this repository.
---

# LoongSuite Pilot Rust 开发

从仓库根目录操作。先读根目录及目标子目录的 `AGENTS.md`，确认当前分支、工作区和目标发行版。2.0.0 发布前在开源 `alibaba/loongsuite-pilot:dev/v2.0.0` 开发。先验收开源改动，再单向同步到商业版 `dev/v2.0.0`。商业代码、内置配置、运行日志和用户数据留在商业环境。

## 按改动查阅

- 编译、隔离调试和了解 SDK 边界，读 [架构与调试](references/runtime.md)。
- 新增或改造 Agent，替换 JS Hook，读 [Agent 接入与二进制 Hook](references/agents.md)。
- 分析 CPU 或内存，修改压测及报表，读 [性能测试与报表](references/performance.md)。
- 写测试、验收安装包或发布 SDK，读 [测试与发布验收](references/verification.md)。

## 开发顺序

1. 找到现有的同类入口，沿 Agent 定义、部署、采集、归一化、持久化、输出走一遍。定位哪些地方会影响完整 Pilot 与嵌入 SDK。
2. 固定输入样本和输出契约后改最小范围。涉及 Hook、checkpoint、安装或 ABI 的改动，先把正常路径、失败路径和恢复路径写成可执行验收项。
3. 跑相关 Rust 测试及对应宿主契约。打包改动用实际 host 和动态库同版本组合验证。Qoder 数据质量是主要验收项，Codex 需要可用于开发验证。其他 Agent 按实际改动验证。
4. 记录测试命令、提交 SHA、Agent 版本、结果和仍需实机验证的平台。临时压测产物和中间日志放工作区外，结束后清理自己创建的目录和 worktree。
