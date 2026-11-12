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
gh workflow run sdk-performance.yml --ref "$PILOT_PERF_DEV_REF" \
  -f mode=dev -f benchmark_method=github-full-pilot-codex-rollout-v2
```

运行手动触发命令前，将 `PILOT_PERF_DEV_REF` 设为流水线配置的 dev 节点分支。查看 `scripts/performance/README.md` 获取 Linux/Docker 复现命令、参数和发布权限。比较性能时保留配置、fixture、方法和 SHA，若有显著差异，先检查排空状态、轮询和运行环境。
