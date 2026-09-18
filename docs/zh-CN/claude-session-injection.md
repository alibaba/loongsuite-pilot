# Claude Agent SDK 会话目录 Hook 注入

Pilot 已安装后，在客户配置写入完成、Claude Code 子进程启动之前执行：

```bash
loongsuite-pilot inject --agents=claude-code \
  --config-dir=/sessions/session-a/claude --json
```

目录优先级为 `--config-dir`、本次命令进程的 `CLAUDE_CONFIG_DIR`、`~/.claude`。SDK 启动时仍需传入相同的 `CLAUDE_CONFIG_DIR`，并允许加载用户级 command Hook。请为每次 SDK 调用构造独立的环境变量，不要并发修改父进程的全局环境。

命令读取安装版本的 Agent 定义，合并全部 Claude Code Hook，并设置 `env.LOONGSUITE_PILOT_DATA_DIR` 为 Pilot 实际数据目录。其他环境变量、客户配置及第三方 Hook 会保留。原有手工配置中直接调用 Pilot `.sh` 入口的条目会被接管；包裹在客户自定义脚本里的 Hook 需先由客户清理，避免重复采集。

成功返回 `0`，JSON 的 `status` 为 `updated` 或 `unchanged`，同时返回 `settingsPath`。失败返回非零，JSON 包含 `status: failed` 和 `error`。客户自行决定失败后继续还是阻断业务启动。成功仅表示本地配置已准备，不代表 SDK 已执行 Hook 或后端已收到数据。

相同配置重复执行不会重写文件。同一个真实目录内，注入与 Pilot 后台的 Claude Hook 安装、卸载和环境变量合并共用跨进程锁；竞争时等待上限 10 秒，权限不足、只读文件系统等错误立即返回。不同目录可以并行。客户自己的配置写入必须先完成，注入后不要再用模板覆盖。目录锁适用于同一主机或 PID 命名空间内的本地文件系统，不用于跨 Pod 共享配置目录；每个 Pod 应使用独立目录。

首版支持 Linux 和 macOS，依赖已经部署的 Hook 脚本与 Node 运行环境。无效 JSON、非普通 settings 文件、缺失脚本或禁用采集时会报错。命令不发现 Claude 可执行文件、不重启服务、不修改全局部署记录，也不会使临时目录自动进入 watchdog 或卸载管理范围。Pilot 升级后，对新会话再次执行命令即可使用当前 Hook 定义；持久目录及退出后的清理由客户管理。

验收时运行真实 SDK 会话，核对 `<Pilot 数据目录>/logs/claude-code/` 与目标后端中的 session ID。仅配置目录不同不代表观测数据的租户隔离；共享 Pilot 数据目录时应确保 session ID 不冲突。
