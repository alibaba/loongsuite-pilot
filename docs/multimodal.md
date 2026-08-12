# Multimodal Collection

English | [简体中文](zh-CN/multimodal.md)

LoongSuite Pilot can convert media in agent messages or tool results (images today: inline base64, or local paths read and encoded at write time) into object-storage `uri` parts, upload them asynchronously to OSS or SLS PutObject, and attach a short summary on normalized events. Use this when downstream analysis needs image content without embedding large base64 blobs in JSONL.

Multimodal conversion is separate from message content capture:

- `captureMessageContent: false` strips full message and tool content (including `gen_ai.input.multimodal_metadata`).
- `agents.<id>.multimodal.uploadMode` controls whether—and on which surfaces—media becomes `uri` parts.

Multimodal also requires global `config.multimodal` object-storage infrastructure; see [Configuration Guide](configuration.md#multimodal-object-storage). Event field shapes are in [Output Event Schema](output-event-schema.md#multimodal-message-parts).

## Current Scope

| Item | Status |
|------|--------|
| Media types | **Images only**. Audio and video are future work. |
| Implemented agents | **`codex`** and **`qoder` (IDE)**. Other agents ignore `uploadMode` until their extractors land. |
| Detection | Agent-specific: Codex uses inline base64 data-URLs in the transcript; Qoder IDE uses SQLite attachment paths and image paths in tool results / assistant markdown (read from disk, then `uri`). |

## How To Enable

Both must be ready:

1. Global `config.multimodal` (uploader, credentials, `storageBasePath`, etc.).
2. A non-`none` `uploadMode` on the target agent, and that agent must implement extraction.

Example (Codex + Qoder IDE):

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
    },
    "qoder": {
      "enabled": true,
      "captureMessageContent": true,
      "multimodal": { "uploadMode": "both" }
    }
  }
}
```

Restart after changing config:

```bash
loongsuite-pilot restart
```

## uploadMode

Configured per agent under `agents.<id>.multimodal.uploadMode`:

| Mode | Behavior |
|------|----------|
| `none` | Disable multimodal conversion (default). |
| `input` | Convert supported images in user / non-assistant messages only. |
| `tool` | Convert supported images in tool results only. |
| `output` | Convert supported images in assistant / model output only (requires an extractor path for that agent). |
| `both` | Enable all surfaces above (for paths that are wired). |

Unknown values fall back to `none`.

## What Each Agent Collects

The table below describes what multimodal collection actually captures per agent. Add new agents here as extractors land.

| Agent | Active | Collected data |
|-------|--------|----------------|
| `codex` | Yes | See [Codex](#codex) below. |
| `qoder` (IDE) | Yes | See [Qoder IDE](#qoder-ide) below. **Qoder CLI is not included.** |
| Others | No | Setting `uploadMode` has no effect today. |

### Codex

Codex converts matching `input_image` data-URLs to `uri` parts at write time; base64 is not written into JSONL. Upload is asynchronous; when the queue is full or upload fails, Pilot may still emit an optimistic `uri` (dangling) and log a warning.

| `uploadMode` | Codex surface | Typical user action |
|--------------|---------------|---------------------|
| `none` | No conversion | — |
| `input` | `input_image` on user messages | Paste/clipboard, Add file / Files mentioned (`response_item/message` with `role=user`) |
| `tool` | `input_image` in tool results | Absolute path in the prompt then `view_image`; generate-then-`view_image` (`function_call_output`) |
| `output` | None | Reserved for assistant-message images; no Codex extractor path yet |
| `both` | `input` + `tool` (and `output` when wired) | Covers paste/add-file and tool read/generate images |

Notes:

- An image path in the prompt or reply does not by itself yield multimodal media; Codex detection is driven by base64 `input_image` in the transcript.
- With `captureMessageContent: false`, multimodal summary fields are stripped with other message content.

### Qoder IDE

Qoder IDE (`qoder` / `qoder-idea`) converts on the `qoder-trace` path after IDE token enrichment: detect a local image path → `MultimodalProcessor.pathToUri` (read bytes → uri) → `uri` part on the event. Policy is `agents.qoder.multimodal`; **only the IDE branch runs conversion—Qoder CLI turns are skipped**. Failures are fail-open and do not interrupt text/token collection.

| `uploadMode` | Qoder IDE surface | Typical user action / event |
|--------------|-------------------|-----------------------------|
| `none` | No conversion | — |
| `input` | SQLite `chat_record.extra.attachedImagePaths` (and image context entries) | Paste / @ image; attached to matching `llm.request` / user `messages_delta` |
| `tool` | `tool.result` text: `Image file: <path>` or ImageGen `absolute path of the image is: <path>` | Read image, ImageGen; result rewritten as text + `uri` parts |
| `output` | `![...](path)` in `llm.response` `gen_ai.output.messages` (image extensions) | Assistant replies that embed read/generated images |
| `both` | All of the above | Attachments, tool read/generate, and output embeds |

Notes:

- Glob-discovered paths that were never visually read are not collected.
- The same path on tool and output surfaces is path-cached in-process to avoid re-reads; uploads remain content-addressed by sha256.

## Output Shape (Short)

- Message / tool-result `parts` use `type: "uri"` (with `mime_type`, etc.) instead of inline base64.
- Optional `gen_ai.input.multimodal_metadata`: a summary list of `uri` media on that event.

Full field docs: [Output Event Schema](output-event-schema.md#multimodal-message-parts).

## Related Docs

- [Configuration Guide · Multimodal Object Storage](configuration.md#multimodal-object-storage) — global OSS / SLS infra.
- [Agent Configuration](agents.md) — `agents.<id>.multimodal.uploadMode` entry point.
- [Output Event Schema](output-event-schema.md) — `uri` parts and metadata fields.
- [Data Masking](masking.md) — text secret masking (independent of multimodal media upload).
