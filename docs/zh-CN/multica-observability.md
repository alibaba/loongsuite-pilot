# Multica 无侵入采集

`input_multica` 读取 Multica 已有的业务 API、Prometheus、daemon health 和日志，输出到 SLS。采集器不修改 Multica 二进制，不注入模型 SDK，也不把业务快照转换为 LLM 调用。

## 配置

标准 Pilot：将输入配置放入 `<dataDir>/configs/local/multica.json`，在主配置中启用 `pipeline.enabled`。没有 `input_multica` 配置时不会扫描本机或创建采集源。

```json
{
  "configName": "multica",
  "inputs": [{
    "Type": "input_multica",
    "CollectionMode": "on",
    "DetectionFailureThreshold": 3,
    "ApiBase": "https://multica.example.com",
    "TokenFile": "/credentials/multica-token",
    "WorkspaceIds": ["WORKSPACE_UUID"],
    "MetricsUrls": ["http://multica-backend:9090/metrics"],
    "LogFiles": ["/logs/backend.log", "/logs/daemon.log"],
    "IntervalSeconds": 30,
    "Instance": "multica-server"
  }],
  "flushers": [{
    "Type": "flusher_sls",
    "Endpoint": "YOUR_REGION.log.aliyuncs.com",
    "Project": "YOUR_AGENTSPACE_SLS_PROJECT",
    "Logstore": "multica-logs"
  }]
}
```

`ApiBase` 可省略，`DaemonHealthUrls` 和 `StatFiles` 可按需添加。启用采集至少需要一个可识别的 metrics、daemon health 或公开 API 入口；仅配置日志或文件路径不能确认 Multica 正在运行。

SLS logstore 须开启 webtracking；该传输方式无需配置云 AK。Endpoint 接受地域域名或 HTTP(S) 地址，裸域名默认 HTTPS；不要填写完整 `/track` 路径或已包含 project 前缀的域名。

目标以用户下发的本 pipeline `flushers[0]` 为准：`Endpoint`、`Project` 必填，`Logstore` 省略时仅对 Multica 默认使用 `multica-logs`，也可显式指定其他 logstore。填写当前 AgentSpace 对应的 SLS project，不固定为示例项目；不会读取或猜测其他 SLS/CMS 目标，也不会将 CMS LicenseKey 当作 SLS 凭证。主进程监控输入 JSON 变更并重建采集器；独立 CLI 修改配置后需要重启。

## 开关与连续检测

采集默认 **off**。环境变量对标准 Pilot 和独立采集器均有效：

```sh
export LOONGSUITE_PILOT_MULTICA_COLLECTION_MODE=on   # 开启检测与采集
export LOONGSUITE_PILOT_MULTICA_COLLECTION_MODE=off  # 关闭
```

模式优先级为 **环境变量 > 输入 CollectionMode > 主配置 pipeline.multica.mode > off**，仅接受 `on/off`。`pipeline.multica.enabled=false` 或 `LOONGSUITE_PILOT_PIPELINE_MULTICA_ENABLED=false` 仍优先禁止采集；`enabled=true` 不会自动将 mode 设为 on。修改服务环境变量后重启进程；输入 JSON 由 PipelineManager 监控并重建实例。

开启后每轮检查已配置的目标：有效的 `multica_*` 指标、具有 Multica 结构特征的 daemon `/health`，或具有专用 capability/setup 字段的公开 `/api/config`。普通 HTTP 200、`go_*` 指标、文件名和已安装 CLI 都不算运行证据。旧版 API 缺少可辨识字段时，需要提供 metrics 或 daemon health。

首次未识别时不采业务数据。识别成功后，连续未命中前两次继续采集以保留故障证据，默认第三次锁定停采；成功检测清零计数。`DetectionFailureThreshold` 可设为 1–30。超时、非成功 HTTP 响应和缺少特征均计为未命中，任一候选成功即可。每轮完成后等待 `IntervalSeconds`，默认 30 秒。

锁定后停止采集定时器、探测、采集和待发批次回放，不自动恢复。需要关闭再开启输入配置，或重启采集器。已经在执行的单轮工作会先结束。独立 sidecar 保持空闲存活，避免 Kubernetes 自动重启绕过停止状态。

探测不读取或发送业务 Token，不上传探测响应正文；单请求最多 1 秒，每轮最多 5 秒，响应最多 256 KiB，配置更小时使用较小值。激活日志给出 mode/enabled/reason/consecutiveMisses/stopped；`--once` 输出对应状态及成功/失败源数量。失败计数不跨进程持久化。

## 数据来源与权限

- **任务与业务状态**：`/api/issues`、`/api/issue-statuses`、`/api/agents`、`/api/runtimes`、`/api/agent-task-snapshot`、`/api/agents/{id}/tasks?include_usage=true`，提供状态、关联 ID、时间、重试、错误分类和已有用量。
- **自动化与汇总**：`/api/autopilots`、`/{id}/runs`、`/api/autopilots/usage`、`/api/dashboard/*`、`/api/agent-activity-30d`、`/api/agent-run-counts`，提供触发结果、配额及按天/Agent 的用量、耗时和失败汇总。
- **指标与本机健康**：已有 `/metrics` 的 `multica_*`、`go_*`、`process_*`；daemon `/health` 的活跃任务、资源等待和终态回传积压。需显式启用 Multica 的 metrics listener，并保证配置地址可达；远端不能直接访问 daemon 的 loopback 地址。
- **日志与文件**：`LogFiles` 读取已知事件及白名单诊断字段，保留脱敏后的 `log_message`、`error_message`、`error_code`、`error_stack`、`stderr`、`exit_code`；诊断文本默认最多 4 KiB，堆栈最多 8 KiB，截断通过 `log_content_truncated` 标明；`StatFiles` 只读取大小、修改时间等元数据，不读取文件正文。不展开 glob，不递归扫描。

业务 API 均使用 GET，须显式配置工作区 UUID。凭证通过 `TokenFile` 或 `TokenEnv` 提供，默认环境变量是 `MULTICA_TOKEN`；每次请求重新读取，便于轮换。账号需要相应工作区的读取权限，403 作为采集缺口记录。Metrics/health 不携带业务 Token；源 URL 不接受内嵌凭证、查询参数、fragment 或重定向。

输出使用字段白名单和凭证脱敏，不上传原始日志整行、任务 prompt/result、评论正文或任意配置环境变量。`CollectEntityNames` 默认关闭；开启后增加有限长度的名称/标题，并额外读取 `/api/projects`、`/api/workspaces/{id}`。名称和诊断文本仍可能包含用户信息，应通过 SLS 权限控制访问。

## 交付、限制与数据含义

记录采用 `schema_version=multica.v1`，以 instance/workspace/entity 和 task/issue/agent/runtime ID 关联。SLS 字段按字符串发送，数值分析需配置 long/double 索引；`observed_at` 表示采集时间，来源时间另存。

每源先原子保存过滤后的批次到 `<stateDir>/<configName>.<destinationHash>.multica-pending/`，收到 SLS ACK 后再推进 checkpoint 并删除批次。checkpoint 与待发批次均按 Endpoint、Project、Logstore 隔离，切换目标从新状态开始，不将旧批次重放到新目标；改回原目标可继续其待发批次。旧版不含目标标识的状态文件保留在磁盘，但不会自动采用，升级后日志可能重新采集。重试沿用 event_id，分包部分成功时可能重复，查询需按 event_id 去重。StateDir 应持久化，不能由两个进程共用同一 configName/stateDir。

默认超时 10 秒，每页 100 条、最多 10 页，单响应最多 4 MiB，每轮日志最多 1 MiB，单行最多 16 KiB。达到分页上限标记 `truncated=true`，响应超限记录 `response_too_large`；各源独立处理错误。轮询串行执行，不重叠。超长日志行会丢弃并计数，轮转时不保证补采已移走文件的未读尾部。

快照行数不等于任务数：按实体取最近成功且未截断的 snapshot_id，同一任务的活动快照和历史记录按 task_id 去重。缺失字段不补零；原生汇总可能延迟，历史任务只覆盖配置允许的分页范围。

Prometheus counter 要处理相邻采样差分与进程重启；histogram bucket 是累计值。`multica_llm_request_total` 是用量上报计数，不能当作模型网络请求数。全局指标不能反推出工作区归属；费用是来源上报值，不代表账单。

本采集器不抓取 trace；外部 CLI 内部未暴露的 Token 刷新或限流过程不可见。文件大小和请求耗时的相关性不能证明具体调用栈原因，可使用下述 pprof 火焰图进一步定位。

## 可选 pprof 火焰图

默认不采 pprof。要采集已有 Go pprof 端点，在 `input_multica` 中显式增加：

```json
{
  "PprofBaseUrl": "http://127.0.0.1:6060",
  "PprofTypes": ["cpu", "allocs"],
  "PprofIntervalSeconds": 900,
  "PprofCpuSeconds": 30,
  "PprofAllocsSeconds": 10,
  "PprofSourceVersion": "DEPLOYED_MULTICA_VERSION",
  "PprofPodName": "BACKEND_POD_NAME"
}
```

`PprofBaseUrl` 只接受 origin；采集器请求 `/debug/pprof/profile?seconds=30` 和 `/debug/pprof/allocs?seconds=10`，不向该端点发送业务 Token。此能力同样受默认 off、Multica 特征检测和连续失败停采控制；单独设置 pprof 地址不足以激活采集。端点必须已由 Multica 暴露，采集器不会修改服务配置。

每种 profile 默认 15 分钟一次，间隔可设 300–86400 秒；CPU 采样 1–60 秒，allocs 采样 1–30 秒。采样在常规业务采集后串行执行，采样当轮会增加约 40 秒耗时；不与另一采样轮重叠。失败后按 60/120/240/300 秒退避。端点有超时、压缩与解压后大小限制，默认各 16 MiB，可用 `PprofMaxBytes` 调低。只保留栈帧及权重，不上传 profile 的任意标签和注释；原始二进制不落盘。

输出为 `pprof_profile_chunk`：每段最多 1800 ASCII 字节，按 `profile_id`、`profile_part_index` 拼接得到 Flamebearer JSON，可用于 SLS 火焰图。`profile_sha256` 校验完整性；查询应仅采用段数完整的 profile，并按 `profile_end_ms` 选择最新一次。`profile_total/profile_unit` 对 CPU 是采样次数，对 allocs 是采样窗口内估算分配字节；不代表存活内存或泄漏。`profile_metadata_source` 标明时间来自原生 pprof 或采集器时钟，版本和 Pod 由上述显式配置提供。

成功送达 SLS 后持久化下次采样时间；发送失败复用已有批次，不重复抓取。同样需要持久化 StateDir。pprof 没有样本时如实报告零权重，不生成虚假栈；旧版端点不支持增量 allocs、没有采样时长时报告 `pprof_missing_interval`。启用后需要为 `profile_*`、`source_version`、`pod_name` 配置 SLS 字段索引。

## 独立运行与验证

```sh
npx esbuild src/pipeline/input/multica/cli.ts --bundle --platform=node --target=node22 --format=cjs --outfile=dist/multica-collector.cjs
node dist/multica-collector.cjs --config /config/multica.json --state-dir /state
# 单轮检查；任一采集源失败返回非零，未识别环境在 JSON 状态中显示
node dist/multica-collector.cjs --config /config/multica.json --state-dir /state --once
npm run typecheck
npx vitest run tests/unit/pipeline/multica tests/unit/pipeline/pipeline-manager.test.ts tests/unit/core/config-loader.test.ts
```

可选 Kubernetes 日志桥接脚本为 `scripts/multica-log-bridge.mjs`。采集器使用 `--activation-state-file /logs/.multica-activation.json`；桥接器须显式配置 `NAMESPACE` 和 `POD_LABEL_SELECTOR`，`MULTICA_LOG_CONTAINERS` 默认 `backend,daemon`。它需要只读的 `pods get/list`、`pods/log get` 权限，并与采集器共享日志卷：

```sh
export NAMESPACE=YOUR_NAMESPACE
export POD_LABEL_SELECTOR=app.kubernetes.io/name=multica
export MULTICA_ACTIVATION_STATE_FILE=/logs/.multica-activation.json
node scripts/multica-log-bridge.mjs
```

桥接器仅在启用状态未过期时拉取日志；缺失、关闭或过期时空闲。启用状态每 10 秒续约、有效期 30 秒，停采时立即关闭，在途请求可以结束。
