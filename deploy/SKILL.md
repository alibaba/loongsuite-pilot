---
name: loongsuite-pilot-install
description: >-
  安装、卸载、初始化配置 LoongSuite Pilot（面向研发团队的 AI Coding 数据采集工具，
  支持 Cursor / Qoder / Claude Code / Codex）。当用户提到 loongsuite-pilot 安装、
  pilot 部署、Node.js 前置条件、nvm 配置、Linux 7U glibc 补丁、SSH 远程安装、
  config.json 配置、captureMessageContent 隐私模式、工号配置时，务必使用本
  Skill——即使用户只问“怎么装”也应触发。安装完成后可在
  ~/.loongsuite-pilot/skills/references/ 目录下找到诊断排查与观测面板的详细参考文档。
---

# LoongSuite Pilot — 安装 / 配置 / 卸载

LoongSuite Pilot 是面向研发团队的 AI Coding 数据采集与效能评估工具，支持
Cursor、Qoder IDE/CLI、Claude Code、Codex 的数据自动采集与上报。

> 诊断排查请查阅 `~/.loongsuite-pilot/skills/references/diagnostics.md`；
> 观测面板与运维手册请查阅 `~/.loongsuite-pilot/skills/references/monitoring.md`。
> 以上两个文件在 pilot 安装完成后自动写入本地，可直接打开阅读。

## 重要说明

> **所有命令必须在完整权限环境下执行**（Shell 工具调用时设置 `required_permissions: ["all"]`）。
> 沙箱环境下 `nvm`、`sudo` 及 PID 读取会受限，导致安装或诊断结果不可信。

---

## 1. 前置条件

- Node.js >= 18（推荐通过 nvm 安装 v22）
- 支持 **Mac** / **Linux 8U 开发机** / **Linux ECS**（Linux 需 `sudo` 权限）
- **Linux 7U 开发机**：需额外执行 glibc 兼容补丁（见第 3 节）

检查当前 Node 版本：

```bash
node -v    # 输出应 >= v18.0.0
```

---

## 2. 安装

执行以下两步完成标准安装（Mac / Linux 8U / ECS）：

```bash
# 步骤一：安装 nvm + Node.js（已有 node >= 18 可跳过）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 22

# 步骤二：安装 LoongSuite Pilot（将 <工号> 替换为 6 位员工号，含前导 0）
curl -fsSL https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite/loongsuite-pilot/loongsuite-pilot-installer-inner.sh \
  | bash -s -- install --user.id <工号>
```

安装成功后验证：

```bash
~/.local/bin/loongsuite-pilot status
~/.local/bin/loongsuite-pilot info
# diagnostics 与 monitoring 参考文档已自动写入 references/
ls -l references/
```

---

## 3. Linux 7U 补丁（glibc 兼容）

> **仅限 Linux 7U 开发机**。其他环境跳过本节，直接执行第 2 节。

用以下步骤替代第 2 节的"步骤一"，再执行第 2 节的"步骤二"：

```bash
# 安装 nvm + Node.js
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 22

# 打 glibc 补丁（补丁前 node -v 会报 glibc 版本错误）
curl -o- https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite/loongsuite-pilot/patchelf_node_for_7u.sh | bash

node -v    # 补丁成功后正常输出版本号，再执行步骤二
```

---

## 4. SSH 远程开发场景

通过 Cursor / Qoder SSH 连接远程开发机时：

1. Pilot **必须安装在远程开发机**（本地 Mac 端无需安装）
2. 远程机上按第 2 节或第 3 节的流程执行安装
3. Hook 随 Cursor/Qoder Remote Server 在远端自动生效

---

## 5. 初始配置（config.json）

安装完成后编辑配置文件 `~/.loongsuite-pilot/config.json`：

```json
{
  "enabled": true,
  "dataDir": "/Users/<用户名>/.loongsuite-pilot",
  "userId": "<6位工号>",
  "agents": {
    "cursor":      { "captureMessageContent": "true" },
    "qoder":       { "captureMessageContent": "true" },
    "qoder-cli":   { "captureMessageContent": "true" },
    "claude-code": { "captureMessageContent": "true" },
    "codex":       { "captureMessageContent": "true" }
  }
}
```

**关键字段说明**：

| 字段 | 说明 |
|------|------|
| `userId` | 6 位员工号，含前导 0（例如 `034567`）。填错会导致数据归属异常 |
| `captureMessageContent: "true"` | 完整采集请求 / 响应 / 工具执行内容 |
| `captureMessageContent: "false"` | 仅采集指标，不上报内容（隐私模式） |

配置修改后执行以下命令生效——不重启无效：

```bash
~/.local/bin/loongsuite-pilot restart
```

---

## 6. 卸载

```bash
# 保留日志与配置（~/.loongsuite-pilot/logs、config.json）
curl -fsSL https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite/loongsuite-pilot/loongsuite-pilot-installer-inner.sh \
  | bash -s -- uninstall

# 彻底清理（连同数据目录，不可恢复）
curl -fsSL https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite/loongsuite-pilot/loongsuite-pilot-installer-inner.sh \
  | bash -s -- uninstall --purge
```

卸载脚本会自动清理 `references/` 下的符号链接；本 `SKILL.md` 由用户手动维护，不受卸载影响。

---

## 7. 安装后的参考文档

pilot 安装成功后，以下两个文档自动写入本地，可直接打开阅读：

| 文件 | 内容 |
|------|------|
| `~/.loongsuite-pilot/skills/references/diagnostics.md` | 5 步系统化诊断排查 + 常见问题速查 |
| `~/.loongsuite-pilot/skills/references/monitoring.md` | 观测面板启停 + 全面健康检查 + 强制重启 + 版本回滚 |
