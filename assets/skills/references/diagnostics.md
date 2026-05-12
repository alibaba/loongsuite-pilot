# 诊断排查指南

本文档随 `loongsuite-pilot` 安装包一起分发，安装完成后自动写入
`~/.loongsuite-pilot/skills/references/diagnostics.md`，随 pilot 升级自动更新。

---

## 系统化排查顺序

数据未出现时，**按以下顺序逐步排查，勿跳步**——后一步的结论依赖前一步：

```
第 1 步 → 服务是否在运行？
第 2 步 → 原始日志是否已生成？
第 3 步 → 输出数据是否已产出？
第 4 步 → 上报是否成功？
第 5 步 → Hook 配置是否正确？
```

---

## 第 1 步：检查服务状态

```bash
~/.local/bin/loongsuite-pilot status
```

预期输出包含：`✅ loongsuite-pilot is running (PID ...)`，updater 显示 running。

若服务未运行，先启动，再查日志定位错误原因：

```bash
~/.local/bin/loongsuite-pilot start
tail -100 ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log
```

---

## 第 2 步：检查原始日志采集

若服务运行正常但数据仍未出现，查看各 agent 的原始 JSONL 日志：

| Agent | 日志路径 |
|-------|---------|
| Cursor | `~/.loongsuite-pilot/logs/cursor-hook/history/cursor-YYYY-MM-DD.jsonl` |
| Cursor 错误 | `~/.loongsuite-pilot/logs/cursor-hook/errors/cursor-error-YYYY-MM-DD.jsonl` |
| Qoder CLI/IDE | `~/.loongsuite-pilot/logs/*/qoder-cli-YYYY-MM-DD.jsonl` |

将 `YYYY-MM-DD` 替换为当天日期。文件为空或不存在说明 Hook 未触发，直接跳至第 5 步。

---

## 第 3 步：检查输出数据

查看 pilot 处理后的输出 JSONL（按 agent 分子目录存储）：

```bash
ls -la ~/.loongsuite-pilot/logs/output/
tail -5 ~/.loongsuite-pilot/logs/output/<agentType>/*.jsonl
```

若输出文件存在且有内容，说明处理流程正常；若为空，检查第 2 步的原始日志。

---

## 第 4 步：检查上报失败记录

```bash
ls ~/.loongsuite-pilot/sls-failed-logs/
```

目录非空表示数据上报失败——检查网络连通性或 SLS 配置（`config.json` 中的
`endpoint`、`project`、`logstore` 等字段）。

---

## 第 5 步：验证 Hook 配置

各工具的 Hook 配置入口：

| 工具 | 配置文件 | 检查项 |
|------|---------|--------|
| Cursor | `~/.cursor/settings.json` | Hook 入口脚本路径有效 |
| Qoder CLI | `~/.qoder/settings.json` | Hook 配置项存在 |
| Qoder Work | `~/.qoderwork/settings.json` | Hook 配置项存在 |
| Codex | `~/.codex/hooks.json` | JSON 文件存在且格式有效 |
| Claude Code | Shell rc 文件 | 含 `source ~/.loongsuite-pilot/...` 行 |

验证 Cursor Hook 脚本是否存在：

```bash
ls -la ~/.loongsuite-pilot/hooks/cursor-loongsuite-pilot-hook.sh
```

重启对应 AI 编程工具使 Hook 生效——安装后不重启，Hook 不会触发。

---

## 其他诊断文件

| 文件 | 用途 |
|------|------|
| `~/.loongsuite-pilot/logs/input-state.json` | 采集进度状态（断点续传依据） |
| `~/.loongsuite-pilot/logs/snapshot-store.json` | IDE 快照存储状态 |
| `~/.loongsuite-pilot/logs/loongsuite-pilot-updater.log` | 自动更新日志 |

---

## 常见问题速查

| 现象 | 解决方法 |
|------|---------|
| 工号以 0 开头，数据异常 | 编辑 `config.json`，确保 `userId` 为 6 位含前导 0，然后 `loongsuite-pilot restart` |
| Codex 出现重复 Hook 信息 | 清理 `~/.codex/config.toml` 中的 hook 配置，仅保留 `~/.codex/hooks.json`，重启 Codex |
| Linux 7U 执行 `node -v` 报 glibc 错误 | 执行 patchelf 补丁（见 SKILL.md 第 3 节） |
| 安装后 Hook 未生效 | 重启对应 AI 编程工具（Cursor / Qoder 等） |
| Claude Code Hook 不工作 | 在 Shell 中执行 `source ~/.bashrc`（或 `~/.zshrc`） |
| Linux 服务无法启动 | 确认当前用户有 `sudo` 权限 |
