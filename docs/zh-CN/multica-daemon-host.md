# 在 ECS 主机接入 Multica daemon

在 **运行 Multica daemon 的同一台主机、以启动 daemon 的同一个系统用户** 安装 Pilot。Linux 上如使用系统服务，确保该服务仍以该用户运行，且用户的目录可访问。这样 Pilot 能读取 `~/.multica/daemon.log` 或命名 profile 中的日志，也能访问该 daemon 的 loopback 健康检查端口。

使用包含 daemon 自动发现功能的 Pilot 发行包和对应版本的安装器。已有接入命令时，在安装参数中加 `--multica-collection-mode on` 即可。

```sh
bash ./installer.sh install \
  --multica-collection-mode on \
  --service-name-prefix "$MULTICA_ENV_NAME" \
  --collect-log true --collect-trace false \
  --sls-project "$SLS_PROJECT" --sls-endpoint "$SLS_ENDPOINT" \
  --sls-logstore agent-event --sls-api-key "$SLS_API_KEY"
loongsuite-pilot status
```

安装器将 Multica 模式保存到 Pilot 配置，系统服务重启后也会加载。已经安装并使用前台进程时，直接运行：

```sh
LOONGSUITE_PILOT_MULTICA_COLLECTION_MODE=on loongsuite-pilot run
```

客户只需提供安装参数。Pilot 会用 daemon 的 PID 和本地健康检查确认身份，然后开始读取日志。默认和命名 profile 均支持，日志轮转和上报重试通过现有的文件 checkpoint 处理。显式关闭 Multica 或 pipeline 会禁用自动发现。已经有显式 `input_multica` 配置时，沿用该配置。

## 验证

到安装参数对应的 Project 下查看 `multica-logs`。按 `instance` 筛选安装时选的应用名前缀。确认收到运行状态和带 `task_id`、`phase` 的日志。backend 和 daemon 使用相同的环境前缀时，可用任务 ID 关联快照和阶段。旧日志格式的阶段图使用[兼容查询](examples/multica-task-timeline.sql)。
