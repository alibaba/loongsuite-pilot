# 容器快速接入

容器里多数 Agent 只在进程启动时读一次配置。Hook 如果写晚了，这一轮采集就是空的，补救往往要重建容器。这篇说明什么时候注入、怎么调用，以及失败时怎么看原因。

主机上的 Pilot 行为不变。这里只覆盖镜像和 Kubernetes。

## 先选路径

1. 能改业务镜像：用场景一。配置已经在镜像里，或在容器启动前就位，用 1-1。要在 `CMD` 里自己渲染配置，用 1-2。
2. 不能改镜像，集群有 webhook：用场景二。默认 2-1。要覆盖 Hermes、DSH，或在 `command` 里自己渲染配置，用 2-2。
3. 没有 webhook：用场景三。

样例里的 `claude-code` 换成自己的 Agent id。多个 id 用逗号分隔。不写 id 时探测全部已安装的 Agent。

`LOONGSUITE_PILOT_AGENTS=none` 才会跳过探测。不设置、空字符串、字面量 `null` 都是全量探测。读到字面量 `null` 时会打一行警告，避免把平台的默认值当成关闭。

## 场景一：镜像集成

**1-1 默认。** 构建期注入加上入口注入，和现有 Dockerfile 写法相同：

```dockerfile
FROM node:22-bookworm-slim
ARG PILOT_INSTALLER_URL=https://example.internal/loongsuite-pilot/installer.sh
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
# 先装 agent：构建期注入靠磁盘探测
RUN npm install -g @anthropic-ai/claude-code
RUN useradd --create-home --shell /bin/bash agent
USER agent
ENV HOME=/home/agent PATH=/home/agent/.local/bin:$PATH
# 构建期注入：deploy --require 构建门禁
RUN curl -fsSL "$PILOT_INSTALLER_URL" | bash -s -- install --mode container --agents claude-code
# 入口在启动 CMD 之前全量探测并注入
ENTRYPOINT ["/home/agent/.loongsuite-pilot/entrypoint.sh"]
CMD ["claude", "-p", "hello"]
```

```sh
docker run --rm --init --stop-timeout 30 \
  -e LOONGSUITE_PILOT_CMS_LICENSE_KEY="$CMS_LICENSE_KEY" \
  -e LOONGSUITE_PILOT_CMS_WORKSPACE="$CMS_WORKSPACE" \
  my-agent:instrumented
# 日志中应出现一行：[entrypoint] hook install: claude-code=ok
```

**1-2 渲染后再注入。** `|| true` 保证注入失败时应用仍会启动。`LOONGSUITE_PILOT_AGENTS=none` 省掉入口那一次全量探测。命令行上的 `--agents` 优先，不受这个环境变量影响。

```dockerfile
ENV LOONGSUITE_PILOT_AGENTS=none
CMD ["sh", "-c", "/app/render-settings.sh && { loongsuite-pilot hook install --agents claude-code || true; } && exec claude -p \"$TASK\""]
```

## 场景二：Kubernetes webhook

**2-1 只打 label。** 行为与现在相同：

```yaml
template:
  metadata:
    labels:
      loongsuitePilotAutoEnable: "on"
      agentLoopSpaceName: "my-space-001"
      agentLoopAgents: "claude-code"      # 可选：eager 注入跳过全量探测
  spec:
    containers:
    - name: agent
      image: my-agent:latest
      command: ["claude", "-p", "$(TASK)"]
      env:
      - { name: TASK, value: "review this PR" }
```

这条路径的 eager 注入只覆盖 `hook` 和 `plugin-inject`。Hermes（`directory-plugin`）和 DSH（`dsh-yaml-patch`）仍等 daemon。需要覆盖它们时用 2-2。

**2-2 渲染后再注入。** 在 2-1 的基础上改 `command`。不需要渲染时去掉第一行。

```yaml
      image: my-agent:latest              # 需要有 bash：start.sh 是 bash 脚本
      command: ["/bin/sh", "-c"]
      args:
      - |
        /app/render-settings.sh
        exec /mnt/pilot/start.sh --agents=claude-code -- claude -p "$TASK"
```

不需要再设 `PILOT_ENABLE_DAEMON` 和 `LOONGSUITE_PILOT_DATA_DIR`。daemon 仍由 preload 拉起，数据目录沿用 webhook 注入的值。打了 `agentLoopAgents` label 时可以省略 `--agents=claude-code`。省略并且没有 label 时会全量探测，容器不会进入 recorded 范围，之后新装的 Agent 仍由 daemon 部署。

## 场景三：手工 init container

**3-1 默认。** `start.sh` 在业务命令之前注入。`--agent=` 仍然可用，新的写法是 `--agents=`。

```yaml
spec:
  volumes:
  - { name: pilot-shared, emptyDir: {} }
  initContainers:
  - name: pilot-init
    image: <ACR>/loongsuite-pilot-init:<version>
    volumeMounts: [{ name: pilot-shared, mountPath: /mnt/pilot }]
  containers:
  - name: agent
    image: my-agent:latest
    command: ["/mnt/pilot/start.sh"]
    args: ["--agents=claude-code", "--", "claude", "-p", "review this PR"]
    env:
    - { name: PILOT_ENABLE_DAEMON, value: "true" }
    - { name: LOONGSUITE_PILOT_DATA_DIR, value: /mnt/pilot }
    lifecycle:
      preStop: { exec: { command: ["/mnt/pilot/prestop.sh"] } }
    volumeMounts: [{ name: pilot-shared, mountPath: /mnt/pilot }]
```

**3-2 渲染后再注入。**

```yaml
    command: ["/bin/sh", "-c"]
    args:
    - |
      /app/render-settings.sh
      exec /mnt/pilot/start.sh --agents=claude-code -- claude -p "review this PR"
```

## 多个身份目录

同一个 Agent 的每个身份目录单独执行一次，并且放在该身份的进程启动之前。以 Grok 为例，`--home` 只写这一次指定的目录，不会改其他身份的注册文件：

```sh
/mnt/pilot/bin/loongsuite-pilot hook install \
  --agents grok-build \
  --home "grok-build=/workspace/.grok/u/$HASH" \
  --json
```

退出码为 0 后再启动这个身份的进程。命令会创建 `hooks/` 并写入 `hooks/loongsuite-pilot.json`。这是 Grok 读取的 hook 注册文件，不是采集到的数据。同一身份再执行一次只核对该文件。点名 `grok-build` 之后，这个容器只维护已经注入过的 Agent。

## 约束

- 用 Agent 自己的 uid 执行。`HOME` 和该 Agent 的 home 变量与 Agent 一致。否则原因码是 `uid-mismatch` 或 `not-detected`。
- 在配置写完之后、Agent 读取配置之前执行。写晚了，`hook status` 报 `overwritten`。
- `start.sh` 需要 bash。`entrypoint.sh` 和 `bin/loongsuite-pilot` 只需要 POSIX sh。
- 不要用 `postStart`。它和入口并发，返回非零还会导致容器被杀。

## 排障

镜像里：

```sh
docker exec <容器> loongsuite-pilot hook status --json
```

Kubernetes 里：

```sh
kubectl exec <pod> -c <容器> -- /mnt/pilot/bin/loongsuite-pilot hook status --json
```

退出码：全部为 `ok`、`up-to-date` 或 `skipped` 时是 0，否则是 1。用法错误是 2。入口和 `start.sh` 失败不阻断业务进程。自己在命令里调用时，需要 `|| true` 才能保持同样的行为。

| 原因码 | 含义 |
| --- | --- |
| `not-detected` | 点名的 Agent 没探测到。设置它的 home 变量，或把命令放到 `PATH`。 |
| `uid-mismatch` | 以 root 执行，但 home 属于其他 uid。改用 Agent 用户执行。 |
| `invalid-settings` | 配置文件不是合法 JSON。提示里有文件和错误位置。 |
| `overwritten` | 注入之后配置又被改写。改为渲染完成后再执行 `hook install`。 |
| `disabled` | `config.agents` 关闭了这个 Agent。 |
| `unknown-id` | 没有这个 Agent id。 |
| `settings-dir-missing` | 配置目录不存在，而且创建失败。 |
| `deploy-failed` | 写入失败。按提示重试。 |
| `lock-timeout` | 等部署状态锁超时。重试。 |
| `activation-pending` | 插件还在激活。等 Agent 启动完成后再试。 |
| `activation-failed` | 插件激活失败。看 Agent 日志。 |
| `runtime-unprepared` | 数据目录没准备好。检查 `--pilot-dir` 和目录权限。 |
