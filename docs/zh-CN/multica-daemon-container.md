# 在 Multica daemon 容器接入 Pilot

Pilot 与 Multica daemon 在同一个容器、以同一个用户运行时，能自动发现默认或命名 profile 的 `daemon.log`。部署时为 Pilot 提供 SLS 接入参数和 `--multica-collection-mode on` 即可。阶段日志发送到所选 Project 的 `multica-logs`。backend 采集器和 daemon Pilot 使用同一个 `--service-name-prefix`，大盘就能将阶段日志与任务快照关联起来。

## Dockerfile 修改前后

以下示例基于 [Multica v0.6.0 的官方 Dockerfile](https://github.com/multica-ai/multica/blob/v0.6.0/Dockerfile)。保留原有 daemon 参数。在接入镜像中增加 Pilot 安装器和启动脚本。用子进程启动 Pilot，最后通过 `exec` 让 Multica daemon 接收容器的停止信号。

修改前：

```dockerfile
FROM ghcr.io/multica-ai/multica-backend:v0.6.0
ENTRYPOINT ["/app/multica", "daemon", "start", "--foreground", "--no-auto-update", "--no-auto-reload"]
```

修改后：

```dockerfile
FROM ghcr.io/multica-ai/multica-backend:v0.6.0
RUN apk add --no-cache bash curl npm
COPY installer.sh /usr/local/share/loongsuite-pilot/installer.sh
COPY start-multica-daemon.sh /usr/local/bin/start-multica-daemon
RUN chmod +x /usr/local/bin/start-multica-daemon
ENTRYPOINT ["/usr/local/bin/start-multica-daemon"]
CMD ["daemon", "start", "--foreground", "--no-auto-update", "--no-auto-reload"]
```

`installer.sh` 和安装包须来自包含本功能的同一次发布。验证未发布的版本时，把源码构建的 `loongsuite-pilot.tar.gz` 放进镜像，并在运行时设置 `PILOT_PACKAGE_URL=file:///path/to/loongsuite-pilot.tar.gz`。在镜像构建阶段仅复制安装器及必要的候选包，运行时通过环境变量或 Secret 注入 SLS 参数。示例启动脚本如下。

```sh
#!/bin/sh
set -eu
: "${SLS_ENDPOINT:?set SLS_ENDPOINT}"
: "${SLS_PROJECT:?set SLS_PROJECT}"
: "${SLS_API_KEY:?set SLS_API_KEY}"
: "${MULTICA_ENV_NAME:?set MULTICA_ENV_NAME}"

export PATH="$HOME/.local/bin:$PATH"
installer=/usr/local/share/loongsuite-pilot/installer.sh
if ! command -v loongsuite-pilot >/dev/null 2>&1; then
  LOONGSUITE_PILOT_PACKAGE_URL="${PILOT_PACKAGE_URL:-}" bash "$installer" install \
    --no-start --collect-log true --collect-trace false \
    --multica-collection-mode on --service-name-prefix "$MULTICA_ENV_NAME" \
    --sls-endpoint "$SLS_ENDPOINT" --sls-project "$SLS_PROJECT" \
    --sls-logstore agent-event --sls-api-key "$SLS_API_KEY"
fi
loongsuite-pilot run &
exec /app/multica "$@"
```

重新构建镜像并使用新镜像部署 daemon。Pilot 启动时 daemon 可能尚未就绪，之后会定期重新发现本地 daemon。常规接入只需要能访问本机 loopback 和读取本用户的日志文件，在 Kubernetes 中无需授予 Pilot 读 Pod 日志的权限。应用运行时的 Pilot 状态目录可挂载持久卷，以保留日志进度。

## 验证

在对应 Project 的 `multica-logs` 查找环境名和 `record_type=server_log`，确认有 `phase`、`phase_elapsed_ms`、`total_elapsed_ms` 及 `task_id`。Multica v0.6.0 的旧格式日志可用[任务阶段兼容查询](examples/multica-task-timeline.sql)绘图。已部署的大盘查询由维护者发布。
