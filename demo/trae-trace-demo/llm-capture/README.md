# llm-capture —— 观测 TRAE 的 LLM 调用（system prompt / reasoning 取证）

本目录回答一个问题：**TRAE 每轮发给 LLM 的到底是什么？** Hook 只能拿用户 prompt
与最终回答（已实测），system prompt 与 reasoning 必须从 LLM 调用链路上取。

## 前置结论（vscdb-inspect 已验证）

`state.vscdb`（globalStorage）**没有加密字段、没有 system prompt**——120 个键全明文，
内容是 UI 状态 / 模型列表 / session 索引。因此：

- ❌ OSCrypt 解密路线（TRAE 给的方案）**不适用于此库**：它针对的是凭据库的
  `v10` 密文，这里一个都没有；
- ❌ 解密 Safe Storage 主密钥属于凭据提取，**不在本项目范围**，即使解了也拿不到
  prompt（大概率在服务端）；
- ✅ 可行路线按优先级：**A 自定义模型代理 → B mitmproxy → C（最后）二进制插桩**。

## 文件清单

| 文件 | 作用 |
|---|---|
| `vscdb-inspect.mjs` | state.vscdb 安全结构探查（只读副本、不解密、疑似凭据只报键名） |
| `sanitize.mjs` | 共享脱敏模块：敏感键名/值形态识别、凭据头丢弃、messages 摘要 |
| `llm-proxy.mjs` | 路线 A：OpenAI-compatible 捕获代理（明文本地代理，透传 + 捕获） |
| `mitm-trae-capture.py` | 路线 B：mitmproxy 插件（TLS 终止点捕获，需信任根证书） |
| `out/` | 所有捕获产物，已 gitignore，不入库 |

## 路线 A：自定义模型代理（首选）

适用：TRAE / IDE 允许配置「自定义模型」base_url。客户端把 base_url 指向本代理，
代理透传到真实上游并捕获。

```bash
node llm-capture/llm-proxy.mjs \
  --port 9100 \
  --upstream https://dashscope.aliyuncs.com/compatible-mode/v1 \
  --out llm-capture/out/capture.jsonl
# 客户端 base_url = http://127.0.0.1:9100
```

单请求临时换上游：加请求头 `X-Upstream-Target: https://host/path-prefix`。

捕获格式（每行一条 JSONL）：
- `kind: request` —— method / path / 脱敏后请求体 / `messages_summary`（role + 字符数 + 首部指纹）/ model / stream；
- `kind: response` —— 状态码、耗时；非 SSE 存脱敏后完整响应；SSE 存 delta 统计序列（delta_chars / reasoning_chars / tool_calls / finish_reason / usage）与总字符数。

## 路线 B：mitmproxy

适用：无法改 base_url（请求直发云端）。前提是机器信任 mitmproxy 根证书且 TRAE
未做证书钉扎——**若钉扎，此路不通**，别绕，直接评估路线 C 的性价比。

```bash
pip install mitmproxy
mitmdump -s llm-capture/mitm-trae-capture.py   # 监听 127.0.0.1:8080
# macOS：系统设置 → 代理 → 安全网页浏览(HTTPS) 指向 127.0.0.1:8080
# 首次需访问 http://mitm.it 安装并信任根证书
```

只捕获 LLM/Agent 类流量（URL 含 chat/completion/agent/create_agent_task 等），
输出 `out/mitm-capture.jsonl`，格式与路线 A 一致。

## 安全约定（两条路线共用，不可协商）

1. **凭据头不落盘**：Authorization / Cookie / x-api-key 等整体丢弃（只记存在性），
   但照常转发给上游——丢弃会 401，转发不落盘不冲突；
2. **递归脱敏**：键名命中 token/secret/password/auth… 或值形态像凭据
   （JWT / sk- / ghp_ / AKIA…）即替换为 `[REDACTED:原因:长度]`，保留长度、绝不保留前后缀；
3. **不做的事**：不解密 state.vscdb / database.db、不读 keychain、不提取任何密钥；
4. **产物不入库**：`out/` 已在 `.gitignore`，捕获文件含用户 prompt，即使脱敏也不进仓库。

## 与 trace demo 的衔接

capture.jsonl 的 `messages_summary`（字符数序列）可与 trace 里 LLM span 的
输入/输出字符数对拍；`sse_total_reasoning_chars > 0` 即证明模型有 reasoning
输出——这正是 hook 层拿不到的部分。

## 边界诚实声明

若 TRAE 的 prompt 是**云端拼装再云端调模型**（日志里 `svr__02_preprocess_build_llm_prompt`
的暗示），则本地任何代理/插桩都看不到最终 prompt——只能看到客户端上行部分。
先跑路线 A/B 确认请求形态，再下结论。
