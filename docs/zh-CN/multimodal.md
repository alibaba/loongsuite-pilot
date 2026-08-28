# 多模态采集

[English](../multimodal.md) | 简体中文

LoongSuite Pilot 可以把 Agent 消息/工具结果中的内联媒体（当前为图片 base64）在写时转为对象存储 `uri`，异步上传到 OSS 或 SLS PutObject，并在规范化事件中附带摘要字段。适用于需要保留图像内容供下游分析，又不希望把巨大 base64 写进 JSONL 的场景。

多模态与消息内容采集是两层不同控制：

- `captureMessageContent: false` 会剥离完整消息与工具内容（含 `gen_ai.input.multimodal_metadata`）。
- `agents.<id>.multimodal.uploadMode` 决定是否、以及在哪些表面上把媒体 blob 转为 `uri`。

开启多模态还需要全局 `config.multimodal` 对象存储基础设施，见 [配置总览](configuration.md#多模态对象存储)。事件字段形态见 [输出事件 Schema](output-event-schema.md#多模态消息-parts)。

## 当前能力范围

| 项 | 现状 |
|----|------|
| 媒体类型 | **仅图像**。音频、视频等后续再支持。 |
| 已实现 Agent | **仅 `codex`**。其他 Agent 即使配置了 `uploadMode` 也不会转换或上传。 |
| 判定依据（Codex） | transcript 中的 `input_image` **base64 data-URL**。文本里出现的文件路径本身不会产生多模态数据。 |

## 如何开启

两处同时就绪：

1. 全局 `config.multimodal`（uploader、凭证、`storageBasePath` 等）。
2. 目标 Agent 的 `uploadMode` 不为 `none`，且该 Agent 已实现提取。

示例（Codex）：

```json
{
  "multimodal": {
    "uploader": "oss",
    "storageBasePath": "oss://your-bucket/pilot-mm",
    "oss": {
      "endpoint": "https://oss-cn-hangzhou.aliyuncs.com",
      "accessKeyId": "your-access-key-id",
      "accessKeySecret": "your-access-key-secret"
    }
  },
  "agents": {
    "codex": {
      "enabled": true,
      "captureMessageContent": true,
      "multimodal": { "uploadMode": "both" }
    }
  }
}
```

修改配置后重启：

```bash
loongsuite-pilot restart
```

## uploadMode

按 Agent 配置在 `agents.<id>.multimodal.uploadMode`：

| 模式 | 行为 |
|------|------|
| `none` | 关闭多模态转换（默认）。 |
| `input` | 仅转换用户/非助手消息中的支持图片。 |
| `tool` | 仅转换工具结果中的支持图片。 |
| `output` | 仅转换助手/模型输出中的支持图片（需该 Agent 有对应提取路径）。 |
| `both` | 同时开启上述全部表面（对已接线的路径生效）。 |

未知取值会回落到 `none`。

## 各 Agent 采集内容

下表说明开启多模态后，各 Agent 实际会采集什么。后续接入新 Agent 时在此补充。

| Agent | 是否生效 | 采集内容 |
|-------|----------|----------|
| `codex` | 是 | 见下方 [Codex](#codex)。 |
| 其他 | 否 | 配置 `uploadMode` 目前无效，等待对应 extractor 落地。 |

### Codex

Codex 在写时把匹配的 `input_image` data-URL 转为 `uri` part，不再把 base64 写入 JSONL。上传异步进行，可能产生乐观 `uri`（见下方 [悬空 URI](#悬空-uri与消费方约定)）。

| `uploadMode` | Codex 采集表面 | 典型用户操作 |
|--------------|----------------|--------------|
| `none` | 不转换 | — |
| `input` | 用户消息中的 `input_image` | 粘贴剪贴板、Add file / Files mentioned 等（`response_item/message` + `role=user`） |
| `tool` | 工具结果中的 `input_image` | 提示里只贴绝对路径后由 `view_image` 读入；生成图像后再 `view_image` 等（`function_call_output`） |
| `output` | 无 | 预留给助手消息中的图片；Codex 当前无提取落点 |
| `both` | `input` + `tool`（以及未来的 `output`） | 同时覆盖粘贴/加文件与工具读图/生成图 |

注意：

- Prompt 或回复文本中出现图像路径，不等于会采到多模态图片；必须以 transcript 里的 base64 `input_image` 为准。本地路径常出现在伴随的 `input_text`（`Files mentioned` / `<image path="...">`）中并会保留；Pilot 只从 companion data-URL 上传，避免按路径二次读文件。
- `captureMessageContent: false` 时，多模态摘要字段会与其他消息内容一并剥离。

## 输出形态（简述）

- 消息 / 工具结果的 `parts` 中出现 `type: "uri"`（含 `mime_type` 等），而不是内联 base64。
- 可选字段 `gen_ai.input.multimodal_metadata`：本条事件中 `uri` 媒体的摘要列表。

完整字段说明见 [输出事件 Schema](output-event-schema.md#多模态消息-parts)。

## 悬空 URI 与消费方约定

Pilot 采用写时乐观 `uri`：事件可先带上 storage `uri`，上传在后台异步完成。下列情况对象可能永远不会出现在存储中（dangling），并打 warn 日志：

| 场景 | 说明 |
|------|------|
| 上传队列满 | 仍返回 `uri`，但跳过入队。 |
| 上传失败 | PUT / 重试失败后不再补传。 |
| 进程关停超时 | `MultimodalProcessor.shutdown()` 对 in-flight 上传最多再等约 **1.5s**（`MULTIMODAL_SHUTDOWN_TIMEOUT_MS`）。 |

关停超时**不等于**把上传判失败：底层仍是未 settle 的 Promise，PUT 可能还在进行。超时后关停路径不再继续等待，uploader 会标记 `closed`（完成时也不再写入进程内 `successKeys`）；随后进程很快 `exit`，尚未完成的请求可能被打断。因此对象是否最终落盘**不保证**——可能已上传成功，也可能永久缺失。事件字段本身无法区分这两种结果；运维侧可结合日志判断。

这是有意取舍：图片是文本链路的补充信息，不阻塞进程退出；blob 只在内存中，没有像部分 SLS sender 那样「drain 不完落盘下次再发」的兜底。关停顺序上，带 `uri` 的事件通常已先 flush，随后 checkpoint / transcript offset 会推进，下次启动不会重读同一行，因此该窗口内未完成的上传**不会被重放补传**。

## 相关文档

- [配置总览 · 多模态对象存储](configuration.md#多模态对象存储) — 全局 OSS / SLS 基础设施。
- [Agent 配置](agents.md) — `agents.<id>.multimodal.uploadMode` 入口。
- [输出事件 Schema](output-event-schema.md) — `uri` part 与 metadata 字段。
- [数据脱敏](masking.md) — 文本密钥脱敏（与多模态媒体上传独立）。
