# 磁盘占用排查与回收策略（2026-11-10）

本次修改基于 main `7cc3d7f3`，分支 `codex/fix-disk-retention`。线上只读查询使用 `sls_admin_zt`，数据源为用户指定的上海地域 `loongsuite-cn-shanghai-admin / loongsuite_status`。未修改线上配置或清理用户文件。

## 线上证据与行为分析

固定窗口为北京时间 2026-11-10 14:30–15:30。只选择扫描时间也落在窗口内、状态为 `ok` 的扫描；每实例取最后一次扫描，同一用户再取占用最大的实例。GB 使用十进制，超标条件为原始值严格大于 4,000,000,000 字节。

| 指标 | 结果 |
| --- | ---: |
| 超过 4 GB 的实例 | 294 |
| 上述实例中可识别用户数 | 276 |
| 超过 10 GB 的实例 | 57 |
| logs 占比超过 90% 的超标实例 | 291 |
| 最大数据目录占用 | 51.84 GB |

重查附件的 10 月 29 日窗口，按下文 SQL 得到 183 个超标实例、172 个可识别用户，与附件的 172 个实例、163 个用户不完全一致。缺少附件原查询及其结果集，不能断言原因，也不把本次重查当作对原快照的精确复现。

两个窗口中有 126 个相同 instance_id 都超过 4 GB，其中 57 个上升至少 1 GB、7 个下降至少 1 GB，变化中位数为 +0.886 GB。这里有“两个窗口均超标”的筛选，不能代表全部原始高占用用户；没有匹配到的实例可能离线、换实例标识或已经低于阈值，不能直接认作修复成功。

在当前高占用实例中，以 input 行的 `raw_in_records > 0` 限定确有采集活动，OpenCode 有 56 个活动实例、解析量合计约 28.60 GB；Pi 有 72 个活动实例、解析量合计约 26.13 GB。它们值得优先检查，但输入量、重复读取量均不等于磁盘留存量，不能据此把某位用户的 logs 占用归因到某个 Agent。当前线上只有 logs 合计，修复增加的分项扫描上线后才能逐一确认。

主查询（API 查询窗口同时设为上述固定窗口）：

```sql
* |
WITH scans AS (
  SELECT instance_id,
    max_by(user_id, "metric_json.disk_dir_sampled_at") AS uid,
    max_by(version, "metric_json.disk_dir_sampled_at") AS version,
    max_by("metric_json.disk_data_bytes", "metric_json.disk_dir_sampled_at") AS bytes,
    max_by("metric_json.disk_logs_bytes", "metric_json.disk_dir_sampled_at") AS logs
  FROM log
  WHERE "metric_json.disk_dir_status" = 'ok'
    AND "metric_json.disk_data_bytes" > 0
    AND "metric_json.disk_dir_sampled_at" >= '2026-11-10T06:30:00.000Z'
    AND "metric_json.disk_dir_sampled_at" < '2026-11-10T07:30:00.000Z'
  GROUP BY instance_id
)
SELECT count(*) AS instances,
  count_if(bytes > 4000000000) AS over4,
  count_if(bytes > 10000000000) AS over10,
  count_if(bytes > 4000000000 AND logs * 1.0 / bytes > 0.9) AS logs_dominated,
  max(bytes) / 1e9 AS max_gb
FROM scans
```

不要用全文检索 `pilot_status` 代替上述字段条件：本 Logstore 中实际可查询的是已展开的指标列，本次全文查询没有返回扫描。

## 本地复现和根因

同一夹具包含两个 10 天前停止写入、各 1.3 GB 的 `*-all.jsonl`，单文件均小于 3 GiB 应急阈值，总量超过 2 GiB：

| 实现 | 清理前字节 | 清理后字节 | 删除数 |
| --- | ---: | ---: | ---: |
| main 原代码 | 2,600,000,000 | 2,600,000,000 | 0 |
| 修复代码 | 2,600,000,000 | 0 | 2 |

原代码每轮把未分段的 `-all.jsonl` 标为“今天”，导致历史文件不能进入年龄或总量回收候选。修复使用文件 mtime，并在删除失败后重新统计，避免把未删除文件从容量计算中扣除。

另一个独立根因是原始输入平铺在 `logs/<agent>/`，清理器只认固定目录或下一层 `history/errors/debug`，既不知道这些文件已消费多少，也不知道是否仍在追加。因此不能仅把这些目录加进普通日志白名单。

## 修复后的策略

- 原始 Hook/插件文件按约 100 MiB 分段。使用有序序号和随机标识的新文件名、原子 `.active` 指针及跨进程锁；不重命名输入 inode。单条大记录完整保留。
- 覆盖 Claude Code、OpenCode、OpenClaw、MiMo Code、Pi、Kiro CLI、Qwen Code CLI、Grok Build，以及 DSH、Hermes 的原始事件写入器。
- Hook 输入保存每个文件的 offset 和 `dev/ino/birthtime`，发现同名替换时从头读取。分段从零开始读；历史 daily 文件延续原有冷启动跳过历史的语义。离线积压分多轮排空，普通读取预算为每轮合计 8 MiB，允许完整读完跨预算的一条记录。
- 嵌套的 Cursor、千问办公 history 同样按消费检查点回收；千问办公主 Trace 输入也登记文件身份和偏移。通用 history 年龄清理已关闭，即使来源尚未发现、没有检查点或检查点未落盘，也不能按日期删除原始输入。其他已登记的原始输入目录同样不进入通用诊断日志清理。
- Qoder、Qoder CN、Qoder Work 主 Trace 输入登记每个 daily 文件的消费偏移和身份，跨天保留回收依据；升级时迁移现有 `lastFile/lastOffset`，即使当天没有文件也能回收已消费的旧文件。无消费依据的旧文件继续保留；同名替换从头读取，含超长隔离记录的文件不自动回收。
- Kiro 冷启动在初始文件快照中确定最后一个可消费 turn，并将文件边界、身份和 turn ID 存入检查点，不保存正文。多轮排空或重启后继续使用同一边界，抑制所有更早的旧 turn；初始边界之后新追加的事件正常采集。
- 原始来源每目录以 2 GiB 为回收目标。只有检查点已落盘、offset 等于当前文件大小、身份一致且已关闭的文件才可删除；年龄超过 `hookHistoryDays` 时也遵循相同条件。未消费或活跃文件不能为达到目标而强删。
- 历史 daily 文件在文件日期和最近修改日期都早于两个完整本地日时视作关闭，给时区差异和晚到写入留窗口。历史偏移未知时先按输入既有迁移规则建立状态。
- DSH 在 turn/start 边界分段，并携带最近的 request/header，保证新段独立恢复；活跃 turn 不拆段。DSH/Hermes 已关闭段通过持久化的 session offset、inode、birthtime 回收。Hermes 取消按年龄盲删原始日志；确认对应进程退出后，已消费的最后一段即使仍被 active 指针引用也可回收，进程存活或探测返回 EPERM 时保留。
- Codex 待上报 journal 默认上限为 512 MiB，写入整批前检查容量。超限保留既有 journal、拒绝新批次，沿用既有持久化失败语义冻结共享检查点并暂停本 collector 各输入，通过现有告警链路报错；不会伪造导出成功。这是为保留重放能力而采取的背压，不能解读为仅暂停 Codex。重启时顺便回收已有持久化 ACK 的残留 payload。超过七天的积压记诊断警告，不按年龄丢弃。
- 可用环境变量 `LOONGSUITE_CODEX_PENDING_MAX_BYTES` 调整 journal 字节上限（正安全整数）。已有积压超过上限时不会被强制缩减。先恢复导出端，再重启让已有 journal 恢复上报；若大 turn 尚未结束且容量不足以持久化其后续事件，需要评估磁盘后提高上限再重启。
- Cursor 可选 raw trace 是诊断副本，按 10 MiB 分段、总量约 100 MiB 回收旧段，不影响正式 history 输入。
- 复用已有的有界磁盘遍历，新增 `metric_json.disk_logs_by_family` JSON 字符串；固定目录族避免泄露动态文件名和项目名，分项之和等于 logs 总量。采样状态、时间戳与总量共用一次扫描，未完成扫描不发布半成品。
- 清理诊断记录 `deleted`、`deletedBytes`、`errors`，文件占用/权限错误保留源文件，不把失败计为回收成功。

## 验证与上线验收边界

主要端到端用例在 `tests/integration/raw-source-retention.test.ts`，覆盖旧式 all 文件、并发写入、分段顺序、重启续采、未消费尾部、未落盘检查点、持锁、同名 inode 替换、Windows 风格 EPERM、DSH/Hermes 闭合段和跨轮读取预算。插件、输入、journal、指标、部署与 OTLP 另有对应回归测试。

未做生产部署、真实 Windows 文件占用测试或真实 Agent 安装态验收；EPERM 用故障注入验证。构建成功不代替最终安装产物验收。

2 GiB 是已消费闭合段的回收目标，不是允许丢数据的硬限额。未消费源、DSH 尚未闭合的旧 session 和超长单个 turn 会保留；旧 DSH 文件要在采用新写入器并产生可证明关闭的段后才能回收。多种目录相加也可能仍大于 4 GB。不能宣称全部高占用用户已解决。

灰度上线后，继续按相同 instance_id 和原用户集合核对分项占用、总量、raw backlog、采集和导出连续性、容量告警及清理错误。对剩余高占用用户，用 `disk_logs_by_family` 确认路径，再决定积压恢复或额外治理；离线和无有效扫描的实例单列，不计作回收成功。
