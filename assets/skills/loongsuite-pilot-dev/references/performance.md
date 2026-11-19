# 性能测试与报表

## 口径

当前 Qoder 和 Codex 方法各运行空闲、低负载、高负载三种场景，每档三轮。每轮预热 64 个会话，计量窗口 30 秒，CPU 与 RSS 每 100 ms 采样。空闲和低负载的采集轮询为 10 秒，高负载为 100 ms。部分历史发行版使用 30 秒轮询，方法与展示说明见 `scripts/performance/README.md` 和对应 `tests/performance_native/pilot-history-method-*.json`。

CPU 平均值按计量窗口的累积 CPU 时间差计算，峰值取相邻资源样本的区间值。RSS 单独保留平均和峰值。原始输入与 JSONL 的速率按窗口内实际字节计算。高负载 15 秒内未排空时，只有已交付数据通过完整性校验且能确认有积压，才能记录资源结果并标记超出承载能力。低负载未交付、重复、token 错误等按测试失败处理。

## 修改和扩展

1. `scripts/performance/prepare_public.py` 解析固定 SHA 和正式发布资产。`pilot_history.py` 驱动 Qoder，`codex_history.py` 驱动 Codex，底层 fixture 分别见 `native_qoder_fixture.py`、`legacy_qoder_fixture.py`、`codex_rollout_fixture.py`。
2. 新增测试对象先准备可确定复现、能通过生产入口采集的 fixture。固定每轮 request、response、tool call、tool result 的字段、唯一 ID、token 及字节预期。先跑 smoke 再测三档。JS 和 Rust 若都支持该对象，优先对两者使用同一真实输入契约。
3. 新方法的 ID 和参数入 `tests/performance_native/`。将方法接入 `prepare_public.py`、`.github/workflows/sdk-performance.yml` 的 `benchmark_method`、执行分派及 `publish_history.py` 的验证注册。方法实质变化时使用新的 ID，保留历史选择与说明。接着更新 `pilot-history.html` 的 `SUBJECT_METHODS`、选择器及测试。
4. 发布数据留在 `sdk-performance-results` 分支的 `history.json`，只维护 release、main、dev 节点。dev 节点绑定以 `.github/workflows/sdk-performance.yml` 的当前配置为准。本地试跑用于诊断，正式报表以 GitHub CI 实测为准。历史不兼容需要源码和实际 smoke 证据。
5. `scripts/performance/site-home.html` 是 GitHub Pages 主页。`publish_history.py` 渲染 `performance/index.html`，`performance-site.yml` 发布。主页链接 `./performance/`。更改页面时检查两个 URL、数据加载、三档六图、横轴节点、平均/峰值、百分比、跨待测试节点连线和窄屏。

```sh
python3 -m unittest discover -s scripts/performance -p 'test_*.py'
```

本地只诊断时，使用[迁移手册的本地 smoke](agent-migration.md#linux-下复跑性能-smoke)。官方仓库对绑定的 dev 分支手动触发可能更新公开报表。需要发布且有权限时，将 `PILOT_PERF_DEV_REF` 设为流水线配置的 dev 节点分支。

```sh
gh workflow run sdk-performance.yml --ref "$PILOT_PERF_DEV_REF" \
  -f mode=dev -f benchmark_method=github-full-pilot-codex-rollout-v2
```

查看 `scripts/performance/README.md` 获取 Linux/Docker 复现命令、参数和发布权限。比较性能时保留配置、fixture、方法和 SHA，若有显著差异，先检查排空状态、轮询和运行环境。

## SDK 热点短筛

归一化前的字符串和字节可以借用到当前解析结束。回调、持久化和跨任务数据按所有权约定复制。用已验收提交保留基线包，候选复用同一 fixture、轮询、采样和质量验证器。测试设计需命中具体热点，例如 Qoder segment 兜底在响应中检查已知 cache-read token，并核对 outbox 汇总值。短筛同时记录平均和峰值 CPU/RSS、输入和交付速率、实测回合数及排空状态。字段缺失、重复、续采或 ACK/RETRY 变化都要在接受候选前解决。

### 迁移后 CPU 回退怎么查

- **先做可归因的对照。** 线上平均值和峰值出现大幅变化时，先核对方法、有效负载、排空以及 runner。不同 runner 的历史值可用来发现异常。再拿正式发行版、迁移基线和候选在同一机器、同一输入与采样口径下重测，分别比较平均值、峰值和吞吐。
- **先采样线程，再查调用栈。** 在预热结束后的活动窗口，分别看采集、交付和宿主线程。分别采样热点和跑最终计时。归一化前后重点检查完整回合、文件记录和活动批次是否被反复克隆，是否只为了取长度而先序列化一次，或者无增补时仍把活动转成 JSON 再转回类型。
- **把所有权交给最后一个消费者。** Codex 的增量步骤可用借用切片构造事件。只有实际补入待处理的子 Agent 调用时才复制回合。SDK 接收独占批次时直接移动活动对象，按堆内存预估控制采集暂存，由 outbox 的最终编码检查单条及队列字节限额。保留原入口对借用批次的限额、事务提交和 ACK/RETRY。
- **复用刚解析的行时核对完整范围和源版本。** 保留有界的短区间，只有待恢复范围完全落在本轮扫描中且当前源版本一致才使用。跨轮回合、超限、隔离坏行、轮转或改写走已有的授权读盘和恢复路径。用同尺寸的源改写、跨轮增量及取消回合检查不会交付旧记录或推进错误游标。
- **优先复用 SDK 已编码的 JSONL 活动。** 宿主只需输出 JSONL 时，可先借用判定工作区、Git 和审计所需的字段。已有信息足够且无需补字段时，复用原始负载并执行标准 JSONL 投影。需要 Git 补齐、上游 Trace、审计默认值或其他输出时，保留类型化处理。用带未知字段和工具内容的样本对账两条路径。
- **对固定结构直接生成规范事件。** 原生记录的字段和类型已经确定时，可以直接构造 `AgentActivityEntry`，复用消息规范化、token 类型转换等公共逻辑。固定输入要逐条对账事件 ID、Trace、字段缺省、内容和用量，并覆盖恢复、多模态、父子会话及失败分支。
- **保留事务和诊断契约。** 按批更新持久队列计数时把计数、事件和续采位置放在同一事务，测旧队列迁移、部分 ACK 失败回滚及同批重试。暂时停用辅助输入可以定位固定内存与扫描成本，最终结果需要启用正式交付的采集和诊断链路。
