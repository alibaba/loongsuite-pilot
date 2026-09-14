# 多模态采集

[English](../multimodal.md) | 简体中文

> **实验性。** 多模态配置与事件字段可能调整。

LoongSuite Pilot 可以把 Agent 消息/工具结果中的媒体（当前为图像：内联 base64 或本地路径读入后编码）在写时转为对象存储 `uri`，异步上传到 OSS 或 SLS PutObject，并在规范化事件中附带摘要字段。适用于需要保留图像内容供下游分析，又不希望把巨大 base64 写进 JSONL 的场景。

多模态与消息内容采集是两层不同控制：

- `captureMessageContent: false` 会剥离完整消息与工具内容（含 `gen_ai.input.multimodal_metadata`）。
- `agents.<id>.multimodal.uploadMode` 决定是否、以及在哪些表面上把多模态转为 `uri`。

开启多模态还需要全局 `config.multimodal` 对象存储基础设施，见 [配置总览](configuration.md#多模态对象存储)。事件字段形态见 [输出事件 Schema](output-event-schema.md#多模态消息-parts)。

## 当前能力范围

| 项 | 现状 |
|----|------|
| 媒体类型 | **仅图像**。音频、视频等后续再支持。 |
| 已实现 Agent | **`codex`**、**`qoder`（IDE 与 CLI）**。其他 Agent 即使配置了 `uploadMode` 也不会转换或上传。 |
| 判定依据 | 因 Agent 而异：Codex 依赖 transcript 内联 base64；Qoder IDE 依赖 SQLite 附件路径与 transcript/工具结果中的图像路径；Qoder CLI 依赖 transcript 中的本地路径（粘贴/`@`/Read/ImageGen），读盘后转 `uri`。 |

## 如何开启

两处同时就绪：

1. 全局 `config.multimodal.storage`（`type` / `target` / `auth`）。
2. 目标 Agent 的 `uploadMode` 不为 `none`，且该 Agent 已实现提取。

示例（Codex + Qoder IDE）：

```json
{
  "multimodal": {
    "storage": {
      "type": "oss",
      "target": {
        "endpoint": "https://oss-cn-hangzhou.aliyuncs.com",
        "storageBasePath": "oss://your-bucket/pilot-mm"
      },
      "auth": {
        "mode": "ak",
        "accessKeyId": "your-access-key-id",
        "accessKeySecret": "your-access-key-secret"
      }
    }
  },
  "agents": {
    "codex": {
      "enabled": true,
      "captureMessageContent": true,
      "multimodal": { "uploadMode": "both" }
    },
    "qoder": {
      "enabled": true,
      "captureMessageContent": true,
      "multimodal": {
        "uploadMode": "both",
        "allowedRootPaths": ["~/workspace/loongsuite-pilot"]
      }
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

## allowedRootPaths

`pathToUri` 只读取允许根内的文件。配置在 `agents.<id>.multimodal.allowedRootPaths`，与 **该 Agent 自己的默认根合并**（不是替换）。默认根写在各 Agent Input 上（`QoderTraceInput`、`CodexTranscriptInput`）；由 Input 自己合并用户配置并做一次规范化（`~` 展开、`realpath`），`multimodal` 只校验合并后的列表。

提取器仍会用 `agent.qoder.cwd` 拼相对 `@` / Read 路径，但 **不会** 自动把 cwd 加进允许根。工作区或 `~/Documents` 等目录需要写进 `allowedRootPaths`。

| Agent | 默认根 |
|-------|--------|
| `qoder` | `~/.qoder/tmp`（CLI 粘贴）、`~/.qoder/vibe_images`（ImageGen），以及桌面 IDE 粘贴缓存 `…/Qoder/SharedClientCache/cache/images`（`~/Library/Application Support/Qoder` / `%APPDATA%/Qoder` / `~/.config/Qoder`；远端 Linux hashed profile 是 `<appRoot>/<hash>/SharedClientCache/cache/images`）。 |
| `codex` | `~/.codex`（预留；Codex 目前走内联 base64，不读盘）。 |

UNC/设备路径、符号链接、非图片 magic 都会跳过。本地路径一律按文件系统路径处理；图片后缀后的 URL query（例如 markdown 里的 `a.png?x=1`）不会剥掉，`pathToUri` 不会回退到 `a.png`。

## 各 Agent 采集内容

下表说明开启多模态后，各 Agent 实际会采集什么。后续接入新 Agent 时在此补充。

| Agent | 是否生效 | 采集内容 |
|-------|----------|----------|
| `codex` | 是 | 见下方 [Codex](#codex)。 |
| `qoder` | 是 | 见下方 [Qoder IDE](#qoder-ide) 与 [Qoder CLI](#qoder-cli)。 |
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

### Qoder IDE

Qoder IDE（`qoder`）在 `qoder-trace` 采集路径上，于 IDE token 富化之后做写时转换：检测到图像本地路径后走 `MultimodalProcessor.pathToUri`（读盘 bytes → uri）→ 事件中的 `uri` part。配置键为 `agents.qoder.multimodal`。同管道的 JetBrains 会话（`qoder-idea`）会跳过。失败 fail-open，不影响原有文本/token 采集。

| `uploadMode` | Qoder IDE 采集表面 | 典型用户操作 / 事件 |
|--------------|--------------------|---------------------|
| `none` | 不转换 | — |
| `input` | SQLite `chat_record.extra.attachedImagePaths`（及 context 中的 image） | 粘贴 / @ 图像；挂到对应 `llm.request` / 用户 `messages_delta` |
| `tool` | `tool.result` 文本中的 `Image file: <path>` 或 ImageGen `absolute path of the image is: <path>` | Read 读图、ImageGen 生成图；结果改写为 text + `uri` parts |
| `output` | `llm.response` 的 `gen_ai.output.messages` 文本中的 `![...](path)`（图像扩展名） | 助手回复中嵌入已读/生成图 |
| `both` | 以上全部 | 覆盖附件、工具读图/生成与输出展示 |

注意：

- 仅 Glob 发现、未实际视觉读取的路径不会采集。
- 同一路径在 tool 与 output 同时出现时，进程内路径缓存避免重复读盘；对象上传仍按内容 sha256 去重。

### Qoder CLI

Qoder CLI（`qoder-cli`，配置键仍为 `agents.qoder.multimodal`）走同一条 `qoder-trace` 采集路径，在 CLI token 富化之后做写时转换。不查 SQLite；助手最终回复通常不含嵌入图，因此 **没有 output 表面**（`uploadMode=output` 对 CLI 无效果，`both` = input + tool）。失败 fail-open。

| `uploadMode` | Qoder CLI 采集表面 | 典型用户操作 / 事件 |
|--------------|--------------------|---------------------|
| `none` | 不转换 | — |
| `input` | 合并 `agent.qoder.attachments[].filename`、`[Image: source: <path>]`、`@path`（相对路径拼 `agent.qoder.cwd`），再按解析后路径去重 | 粘贴图像、`@` / `--attachment` |
| `tool` | `tool.result` 中的 `Read image: <path>`、`Image file: <path>`、ImageGen `absolute path of the image is: <path>` | 文本里给路径后由 Read 读图；ImageGen 生成后再 Read 预览 |
| `output` | 无 | CLI 终端不把图嵌进最终助手文本 |
| `both` | `input` + `tool` | 覆盖粘贴/`@` 与工具读图/生成 |

注意：

- 仅 Glob 列出、未实际 `Read`/`ImageGen` 的路径不会采集。
- OSS 预签名/匿名 URL 不作为采集源；以本地路径 `pathToUri` 为准。
- CLI（1.1.29）会在 transcript 写入 `type: "attachment"` / `image_file.filename`（本地绝对路径）。Hook 只把本轮 `image_file` 原样拷到 `agent.qoder.attachments`；Input 把它和 `[Image: source:]` / `@` 一起提取、解析后去重，出站前丢掉这个载体字段。

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
