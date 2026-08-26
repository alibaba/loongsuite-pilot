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
| Implemented agents | **`codex`** and **`qoder` (IDE and CLI)**. Other agents ignore `uploadMode` until their extractors land. |
| Detection | Agent-specific: Codex uses inline base64 data-URLs in the transcript; Qoder IDE uses SQLite attachment paths and image paths in tool results / assistant markdown; Qoder CLI uses local paths in the transcript (paste / `@` / Read / ImageGen), read from disk, then `uri`. |

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
      "multimodal": {
        "uploadMode": "both",
        "allowedRootPaths": ["~/workspace/loongsuite-pilot"]
      }
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

## allowedRootPaths

`pathToUri` only reads files inside allowed roots. Configured under `agents.<id>.multimodal.allowedRootPaths` and **merged with that agent's defaults** (not a replace). Defaults live on the agent Input (`QoderTraceInput`, `CodexTranscriptInput`); the Input merges user paths with those defaults and canonicalizes them once (`~` expand, `realpath`). `multimodal` only enforces the resulting list.

Extractors still join relative `@` / Read paths with `agent.qoder.cwd`, but cwd is **not** added to the allowlist. Workspace paths and directories such as `~/Documents` need an explicit `allowedRootPaths` entry.

| Agent | Defaults |
|-------|----------|
| `qoder` | `~/.qoder/tmp` (CLI paste / clipboard), `~/.qoder/vibe_images` (ImageGen), and the desktop IDE paste cache `…/Qoder/SharedClientCache/cache/images` (`~/Library/Application Support/Qoder` / `%APPDATA%/Qoder` / `~/.config/Qoder`; Linux remote hashed profiles use `<appRoot>/<hash>/SharedClientCache/cache/images`). |
| `codex` | `~/.codex` (reserved; Codex today uses inline base64, not disk paths). |

UNC/device paths, symlinks, and non-image magic bytes are skipped. Local paths are treated as filesystem paths. A URL query after the image extension (for example `a.png?x=1` in markdown) is not stripped; `pathToUri` will not fall back to `a.png`.

## What Each Agent Collects

The table below describes what multimodal collection actually captures per agent. Add new agents here as extractors land.

| Agent | Active | Collected data |
|-------|--------|----------------|
| `codex` | Yes | See [Codex](#codex) below. |
| `qoder` | Yes | See [Qoder IDE](#qoder-ide) and [Qoder CLI](#qoder-cli) below. |
| Others | No | Setting `uploadMode` has no effect today. |

### Codex

Codex converts matching `input_image` data-URLs to `uri` parts at write time; base64 is not written into JSONL. Upload is asynchronous and may produce optimistic `uri`s (see [Dangling URIs](#dangling-uris-and-consumer-contract) below).

| `uploadMode` | Codex surface | Typical user action |
|--------------|---------------|---------------------|
| `none` | No conversion | — |
| `input` | `input_image` on user messages | Paste/clipboard, Add file / Files mentioned (`response_item/message` with `role=user`) |
| `tool` | `input_image` in tool results | Absolute path in the prompt then `view_image`; generate-then-`view_image` (`function_call_output`) |
| `output` | None | Reserved for assistant-message images; no Codex extractor path yet |
| `both` | `input` + `tool` (and `output` when wired) | Covers paste/add-file and tool read/generate images |

Notes:

- An image path in the prompt or reply does not by itself yield multimodal media; Codex detection is driven by base64 `input_image` in the transcript. Local paths often remain in companion `input_text` (`Files mentioned` / `<image path="...">`); Pilot uploads from the companion data-URL only and does not re-read the file from disk.
- With `captureMessageContent: false`, multimodal summary fields are stripped with other message content.

### Qoder IDE

Qoder IDE (`qoder`) converts on the `qoder-trace` path after IDE token enrichment: detect a local image path → `MultimodalProcessor.pathToUri` (read bytes → uri) → `uri` part on the event. Policy is `agents.qoder.multimodal`. JetBrains sessions (`qoder-idea`) share this input but are skipped. Failures are fail-open and do not interrupt text/token collection.

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

### Qoder CLI

Qoder CLI (`qoder-cli`, still configured via `agents.qoder.multimodal`) converts on the same `qoder-trace` path after CLI token enrichment. It does not query SQLite. Assistant finals usually have no embedded image, so **there is no output surface** (`uploadMode=output` is a no-op for CLI; `both` = input + tool). Fail-open.

| `uploadMode` | Qoder CLI surface | Typical user action / event |
|--------------|-------------------|-----------------------------|
| `none` | No conversion | — |
| `input` | Union of `agent.qoder.attachments[].filename`, `[Image: source: <path>]`, and `@path` (relative paths join `agent.qoder.cwd`), then unique-resolve | Paste image, `@` / `--attachment` |
| `tool` | `tool.result` text: `Read image: <path>`, `Image file: <path>`, ImageGen `absolute path of the image is: <path>` | Path in the prompt then Read; ImageGen then Read to preview |
| `output` | None | CLI does not embed images in the final assistant text |
| `both` | `input` + `tool` | Paste/`@` plus tool read/generate |

Notes:

- Glob-only listings that were never `Read` / `ImageGen` are not collected.
- Remote OSS URLs are not used as the source; local `pathToUri` is.
- CLI (1.1.29) writes `type: "attachment"` / `image_file.filename` (absolute local path) into the transcript. The hook only copies matching `image_file` objects onto `agent.qoder.attachments`. `QoderTraceInput` unions those filenames with `[Image: source:]` / `@` and unique-resolves.

## Output Shape (Short)

- Message / tool-result `parts` use `type: "uri"` (with `mime_type`, etc.) instead of inline base64.
- Optional `gen_ai.input.multimodal_metadata`: a summary list of `uri` media on that event.

Full field docs: [Output Event Schema](output-event-schema.md#multimodal-message-parts).

## Dangling URIs And Consumer Contract

Pilot emits optimistic storage `uri`s at write time; upload continues asynchronously. In the cases below the object may never land in storage (dangling), and Pilot logs a warning:

| Case | Behavior |
|------|----------|
| Upload queue full | Still returns a `uri`, but skips enqueue. |
| Upload failed | PUT / retries fail; no further retry of that blob. |
| Shutdown timeout | `MultimodalProcessor.shutdown()` waits at most about **1.5s** for in-flight uploads (`MULTIMODAL_SHUTDOWN_TIMEOUT_MS`). |

The shutdown timeout does **not** mark those uploads as failed: they remain unsettled Promises and the PUT may still be in flight. After the wait, shutdown stops waiting, the uploader is marked `closed` (so a late completion will not write the in-process `successKeys` cache), and the process typically `exit`s soon after—which may interrupt unfinished requests. Whether the object eventually lands is **best-effort**: it may succeed or be permanently missing. Event fields alone cannot distinguish those outcomes; operators can tell from logs.

This is an intentional trade-off: images are supplementary to the text pipeline and must not block process exit. Blobs live only in memory—there is no “persist remaining and retry next start” spill like some SLS senders. On stop, events that already carry a `uri` are usually flushed first, then checkpoints / transcript offsets advance, so unfinished uploads in that window are **not replayed** on restart.

## Related Docs

- [Configuration Guide · Multimodal Object Storage](configuration.md#multimodal-object-storage) — global OSS / SLS infra.
- [Agent Configuration](agents.md) — `agents.<id>.multimodal.uploadMode` entry point.
- [Output Event Schema](output-event-schema.md) — `uri` parts and metadata fields.
- [Data Masking](masking.md) — text secret masking (independent of multimodal media upload).
