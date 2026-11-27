# 给一次 Agent 调用加自定义 Span 属性

比如，A 和 B 共用一个 Agent 会话：A 发起的回合写 `memory.user_id=user-a`，B 发起的回合写 `memory.user_id=user-b`。会话 ID 不变，属性跟着每轮调用走。

Pilot 只需要把属性和**本次原生调用**对上。通过校验的按次属性会直接进入 Span，**不用再配 `otlpTrace.spanAttributePassthroughPrefixes`**。这个过程不会改 prompt，也不依赖 `TRACEPARENT`。

## 准备 Pilot

安装支持按次属性的 Pilot 版本，部署对应 Agent 的 Hook 或插件，并按 [Trace 输出](./trace-output.md) 配好上报。使用自定义 Pilot 数据目录时，调用方、Hook 和采集器使用同一个本地目录。应用从自己的业务上下文获取用户 ID 或请求 ID，不直接采用用户可随意填写的身份。

| 你怎么调用 Agent | 你需要做什么 |
| --- | --- |
| 每次新起 Claude Code / Qwen Code CLI | 启动时给本次子进程设置两项 env，可以继续同一个会话 |
| Qoder SDK / OpenClaw，发送前已知原生 ID | 用本次 UUID 或 session/run ID 登记，再发送请求 |
| Codex / Copilot / DeepSeek Harness / Hermes，调用中才知道原生 ID | 先登记属性，从本次受理回执或生命周期回调拿到原生 ID 后绑定 |

仅在桌面里手工发消息、调用方拿不到原生回合 ID 的，不适用这套按次绑定。其他框架和具体版本见 [各框架接入示例](./invocation-attributes-native.md)。

## 每轮启动一个 CLI 进程

启动器为**每次**进程创建新的调用 ID 和 env。示例用 Claude Code；Qwen Code CLI 可将最后一行换为 `qwen "请回复 OK"`。

```bash
LOONGSUITE_PILOT_INVOCATION_ID="$(uuidgen)" \
LOONGSUITE_PILOT_SPAN_ATTRIBUTES='memory.user_id=user-a,memory.request_id=req-42' \
  claude -p "请回复 OK"
```

需要续聊时照常传 `--resume`。即使下一轮没有业务属性，也要传新的调用 ID，属性变量留空。不要改常驻服务的全局 env。

## 长驻宿主接入

先在采集器配置里启用实际使用的 Input。下面是 Qoder SDK 的配置；已有 Trace 输出设置不需要改。

```json
{
  "invocationAttributes": {
    "sources": {
      "qoder-trace": { "selector": "message" }
    }
  }
}
```

用 Pilot 自带的 Node 和安装目录中的登记工具。若部署时自定义了数据目录，运行登记工具时把 `LOONGSUITE_PILOT_DATA_DIR` 指向同一个目录。下面的 UUID 由调用方为本次用户消息预先生成：

```bash
"$PILOT_NODE" "$PILOT_INSTALL_DIR/dist/invocation-attributes.js" register <<'JSON'
{
  "agent": "qoder-cli",
  "invocationId": "req-42",
  "selector": {
    "kind": "message",
    "messageId": "2dbdb620-69d9-44d5-832b-6c4e329f7444"
  },
  "attributes": { "memory.user_id": "user-a", "memory.attempt": 1 }
}
JSON
```

接着把**同一个 UUID** 设为 Qoder SDK 用户消息的 `uuid` 并发出。不用把 `attributes` 塞进 Agent 请求。如果是先调用再拿到原生 ID 的入口，改用 `put` 保存属性、`bind` 关联该次回合；对应 Input、选择器和示例见 [各框架接入示例](./invocation-attributes-native.md)。

## 验证结果

在同一个会话发两次相同的消息，分别带 `user-a` 和 `user-b`。打开两条 Trace，核对各自 Span 的 `memory.user_id`；不登记属性的回合不应继承上一轮的值。不要把逐轮变化的键同时设置成全局属性。

可以直接新增业务键，无需逐键配置。保留键、敏感键、字段类型和大小限制仍然生效。旧版平铺事件字段的前缀配置保持兼容，不是上述按次接入的必选项。
