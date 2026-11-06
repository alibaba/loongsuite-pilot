# Hermes Agent fixture provenance

`real-tool-turn-hooks.jsonl` is a sanitized subset of a real Hermes Agent
0.9.0 callback capture produced on 2026-07-10 at:

```text
<temporary-directory>/probe-events.jsonl
```

The original interaction made one `terminal` call for
`wc -l /etc/hosts /etc/shells`. Provider credentials and the provider endpoint
were not present in this fixture. Long prompt wording was shortened and all
correlation IDs were replaced with deterministic fixture values without
changing callback ordering, message roles, tool payloads, or usage fields.

## Rust 上游关联重放

`upstream-replay.json` 由 `scripts/testing/generate-hermes-upstream-fixtures.py`
调用当前 Hermes 插件生成，包含正常输入、仅历史输入、延迟历史输入和带前轮历史的
延迟输入，每种都连续重复两轮相同提示词。使用 Python >=3.8 在开发环境重新生成并审阅
差异；插件运行位置来自临时目录，身份固定为 fixture-user，不读取真实安装配置。

`tests/upstream_context.rs` 校验插件和原始 hook fixture 的 SHA-256 后，把这些真实插件输出
送入 Rust 的 HermesLogInput、InputManager、TraceLinker 和转换器，分别验证单批和逐条
采集。生成器不进入安装包；Cargo 回归不要求安装 Python。
