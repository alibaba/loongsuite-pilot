# Codex 无 owner 历史文件重复扫描：问题、复现与修复

## 问题与证据

2026-11-04 的一份匿名 macOS 现场诊断包显示，collector 在没有新增消费、没有标准事件产出的窗口中仍有持续 CPU 开销。自监控中 211 个窗口的读取量完全相同：每 10 分钟读取 18,710,880,480 字节，调用文件读取 API 186,480 次。

现场 checkpoint 与文件元数据给出了准确解释：

| 项目 | 数值 |
|---|---:|
| 实际存在的 transcript 文件 | 1,588 |
| `ownerSessionMetaOffset=null` 的文件 | 1,559 |
| 其中非空文件 | 1,554 |
| 无 owner 文件总大小 | 155,924,004 字节 |
| 这些文件的消费进度 | 全部 `scanOffset=size` |
| 这些文件的 active turn、pending/fork 恢复状态 | 全部为空 |

每个非空文件均小于 1 MiB。旧代码每轮扫描这些文件两遍，因此：

```text
155,924,004 × 2 = 311,848,008 字节/轮
      1,554 × 2 =       3,108 次读取/轮

每 10 秒轮询一次，10 分钟共 60 轮：
311,848,008 × 60 = 18,710,880,480 字节
      3,108 × 60 =        186,480 次读取
```

这与自监控逐字节、逐次调用一致。原生调用栈中也出现文件读取回调后的 JSON 解析和 UTF-8 解码。无需使用用户对话正文即可闭环。读取字节是文件 API 返回量的累加，包含缓存命中和重复读取，不等于物理磁盘吞吐。

45.12 MB 的 fork 积压属于另一组 owner 已知的文件。额外 1,671 条 `ENOENT` checkpoint 是已不存在文件的状态，不是同一存活文件重复注册；不能将两者当成本次固定读取量的来源。

## 根因与 main 已有保护

旧版本基准 `dae15826c69496ff010c8be3c4a9ea9b7ca6cbda` 的调用链：

1. `collect()` 先调用 `indexDiscoveredTranscriptOwners()`。owner offset 为 null 时，`findOwnerSessionMetaOffset()` 从文件头扫描到 EOF，尝试寻找 `session_meta`。
2. 随后进入文件处理。`rolloutCaughtUp()` 要求 owner offset 非 null，导致已经消费到 EOF 的无 owner 文件仍不能快速退出。
3. 文件处理再次寻找 owner，形成第二遍扫描。没有记录“这个文件版本已确认没有 owner”，下一轮重复执行。

`null` 同时承担“尚未查找”和“已查找但不存在”两种含义，是重复工作的原因。消费水位实际上已经推进到 EOF；这不是恢复队列重试，也不是新增输入量过大。

**本次分支基于的 main 是 `f72c9810`。main 已通过 `findOwnerOffset()` 的 2,048 项 LRU 缓存空结果，覆盖上述 1,559 文件的稳定轮询场景。不能把 main 说成仍然复现原现场问题。**

main 尚有两个边界：

- 历史无 owner 文件超过 2,048 个时，顺序遍历会循环淘汰缓存；稳定文件仍然每轮被扫描两遍。
- 缓存只在内存中，重启时已确认无 owner 的历史文件仍会被重新探测。

本分支先以 2,056 个文件复现 main 的容量边界。回归测试在未修改 main 上失败，每轮读取 1,015,664 字节；采用本次修复后，同一用例的正常轮询与重启探测均为零内容读取。

## 解决方案与安全边界

在每个文件的 `InputState.extra.codexOwnerAbsentVersion` 中保存完整的无 owner 探测结果。标记包含现有 `sourceVersion()` 生成的 `dev/ino/size/mtime/ctime` 文件版本；不保存对话、session ID 或额外正文。

- 只有探测范围是整个文件、确实到达 EOF、没有未完成尾行、没有超大记录隔离，并且读取前后版本一致时，才写入标记。
- 不变文件直接复用该结果，不依赖共享 LRU 是否保留了这个文件；每个文件最多保存一个版本字符串。
- 追加、截断、inode 替换和时间戳变化会使结果失效；找到有效 owner 后删除旧标记。同尺寸改写即使恢复 mtime，也会通过 ctime 变化重新探测。
- prefix、未完成或被隔离的扫描不生成持久化无 owner 证据，仍沿用现有内存探测策略。
- 标记独立于 `codexTranscript`，不会伪造首次 baseline checkpoint，也不会被调用方稍后保存的旧 checkpoint 对象覆盖。
- 仅跳过重复 owner 探测，不修改事件、消费水位、active turn、pending/deferred recovery、fork 判定或输出协议。旧状态没有该字段时仍按正常流程探测。

这不保证零 CPU：文件发现、stat 和状态遍历仍然存在。若文件内容改写后所有参与版本判断的元数据都无法区分，缓存仍有元数据判别本身的边界，与现有 LRU 相同。

## 可重复的性能验证

`tests/performance/codex-owner-probe.perf.mjs` 使用真实 `CodexTranscriptInput`、`StateStore` 和原始读取计数器，在临时目录合成无 owner 的有效 JSONL。脚本校验物理换行、JSON 可解析性、逐文件长度和总字节数；不读取真实 Codex 目录，也不访问远端。

在本分支安装依赖后，创建只读比较用 worktree：

```bash
git worktree add --detach /tmp/pilot-owner-old dae15826c69496ff010c8be3c4a9ea9b7ca6cbda
git worktree add --detach /tmp/pilot-owner-main f72c9810
```

在本分支工作目录下，分别对三个版本运行。`--source-root` 只改变被编译的源码，依赖由本分支提供：

```bash
# main 的 LRU 容量边界：默认 2,056 个 4 KiB 文件、3 轮 collect
node tests/performance/codex-owner-probe.perf.mjs \
  --source-root /tmp/pilot-owner-old --output /tmp/owner-old-large.json
node tests/performance/codex-owner-probe.perf.mjs \
  --source-root /tmp/pilot-owner-main --output /tmp/owner-main-large.json
node tests/performance/codex-owner-probe.perf.mjs \
  --source-root "$PWD" --output /tmp/owner-fixed-large.json

# 原现场的非空文件数量和总字节；内容为合成数据
node tests/performance/codex-owner-probe.perf.mjs \
  --source-root /tmp/pilot-owner-old \
  --files 1554 --total-bytes 155924004 --output /tmp/owner-old-field.json
node tests/performance/codex-owner-probe.perf.mjs \
  --source-root /tmp/pilot-owner-main \
  --files 1554 --total-bytes 155924004 --output /tmp/owner-main-field.json
node tests/performance/codex-owner-probe.perf.mjs \
  --source-root "$PWD" \
  --files 1554 --total-bytes 155924004 --output /tmp/owner-fixed-field.json
```

2026-11-04 在同一台 macOS、Node v22.22.2 上顺序执行六组。下表 CPU/墙钟耗时为三轮 collect 的中位数，不设置时间阈值：

| 场景 | 版本 | 每轮读取字节 / 次数 | CPU ms | 墙钟 ms |
|---|---|---:|---:|---:|
| 现场规模 | 旧版 | 311,848,008 / 3,108 | 375.718 | 364.837 |
| 现场规模 | main | 0 / 0 | 57.686 | 59.152 |
| 现场规模 | 本分支 | 0 / 0 | 45.292 | 38.407 |
| 2,056 文件 | 旧版 | 16,842,752 / 4,112 | 255.451 | 235.389 |
| 2,056 文件 | main | 16,842,752 / 4,112 | 352.118 | 347.130 |
| 2,056 文件 | 本分支 | 0 / 0 | 81.611 | 81.656 |

重启 startup 阶段，现场规模的旧版/main 读取 155,924,004 字节、1,554 次；2,056 文件的旧版/main 读取 8,421,376 字节、2,056 次。本分支两组均为 0。所有阶段新增消费与事件产出均为 0，避免将历史 baseline 误记成新业务数据。

基准按轮数调用真实 collect，不等待实际 10 秒；collect 计时不含状态文件 save，重启状态 load 也在计时之前。CPU 和墙钟时间受宿主负载影响，不可直接换算为线上 CPU 百分比或承诺线上下降幅度。可稳定比较的是内容读取字节、调用次数和事件计数。

## 功能验证与已知基线失败

```bash
npm run typecheck
npx vitest run tests/unit/inputs/codex-transcript \
  tests/unit/inputs/base-input.test.ts tests/unit/checkpoints \
  tests/unit/inputs/input-runtime-metrics.test.ts
npm test
npm run build
```

- 定向回归：10 个文件、423 项通过，包含 109 项 source recovery 测试。新增覆盖超 LRU 容量、重启状态加载、追加/截断/替换/同尺寸改写、prefix/未完成探测、损坏标记，以及读取中版本变化。
- 类型检查与生产 Node v22.22.2 构建通过。
- Node v22.22.2 完整测试：456 个文件通过、6 个跳过、8 个失败；6,565 项通过、70 项跳过、86 项失败。
- 86 项失败全部位于 Hermes 测试，Python 子进程被 `SIGKILL` 终止。对未修改的 main 重跑同一批测试，得到完全相同的 86 个失败测试名，差集为空。本分支没有改动 Hermes 或 Python；不能将本次完整测试报告写成全绿。

发布时还需核对最终安装制品是否实际包含空结果缓存修复；版本号本身不是源码覆盖证明。线上验收应关注无新增输入时的 `raw_read_bytes/raw_read_calls` 是否下降，同时确认追加新的正常 turn 后仍能产出事件。
