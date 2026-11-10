# Multimodal Collection

English | [简体中文](zh-CN/multimodal.md)

> **Experimental.** Multimodal config and event fields may change.

LoongSuite Pilot can convert media in agent messages or tool results (inline image base64, local image paths, or local video paths, read and encoded at write time) into object-storage `uri` parts, upload them asynchronously to OSS or SLS PutObject, and attach a short summary on normalized events. Use this when downstream analysis needs the media without embedding large base64 blobs in JSONL.

`agents.<id>.multimodal.uploadMode` controls whether—and on which surfaces—media
becomes `uri` parts. Legacy `captureMessageContent` settings do not disable
message or multimodal content reporting.

Multimodal also needs an explicit `config.multimodal.storage` block; a matching `config.sls` API Key can supply its auth. See [Configuration Guide](configuration.md#multimodal-object-storage). Event field shapes are in [Output Event Schema](output-event-schema.md#multimodal-message-parts).

## Current Scope

| Item | Status |
|------|--------|
| Media types | **Images**, plus local `.mp4`, `.mov`, `.m4v`, `.3gp`, `.3g2`, `.webm`, `.mkv`, and `.avi`. Codex still handles inline images only. Audio is future work. |
| Implemented agents | **`codex`**, **`qoder` (IDE and CLI)**, and **`qwen-work-cn`**. Other agents ignore `uploadMode` until their extractors land. |

### Detection

Where each agent finds images. Surfaces collected after it is enabled are in [What Each Agent Collects](#what-each-agent-collects).

| Agent | Source | Form |
|-------|--------|------|
| Codex | transcript | Inline base64 data-URL |
| Qoder IDE | SQLite attachments; transcript | Local path |
| Qoder CLI | transcript | Local path (paste / `@` / Read / ImageGen), read from disk, then `uri` |
| Qwen Work CN | transcript | Local path (paste tag, `Read`, `qwenwork_media_read`, generate and present tools) |

## How To Enable

Both must be ready:

1. Global object storage: set `multimodal.storage` explicitly; its auth can reuse a matching SLS API Key under the conditions in [Configuration](configuration.md#multimodal-object-storage).
2. A non-`none` `uploadMode` on the target agent, and that agent must implement extraction.

Example (Codex + Qoder IDE):

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
      "multimodal": { "uploadMode": "all" }
    },
    "qoder": {
      "enabled": true,
      "multimodal": {
        "uploadMode": "all",
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
| `input` | Convert supported images in user / non-assistant messages and in tool results. |
| `output` | Convert supported images in assistant / model output (output requires an extractor path for that agent). |
| `all` | Enable all wired surfaces. |

Unknown values fall back to `none`.

## allowedRootPaths

`pathToUri` only reads files inside allowed roots. Configured under `agents.<id>.multimodal.allowedRootPaths` and **merged with that agent's defaults** (not a replace). Defaults live on the agent Input (`QoderTraceInput`, `CodexTranscriptInput`, `QwenWorkCNTraceInput`); the Input merges user paths with those defaults and canonicalizes them once (`~` expand, `realpath`). `multimodal` only enforces the resulting list.

Extractors still join relative `@` / Read paths with `agent.qoder.cwd`, but cwd is **not** added to the allowlist. Workspace paths and directories such as `~/Documents` need an explicit `allowedRootPaths` entry.

| Agent | Defaults |
|-------|----------|
| `qoder` | `~/.qoder/tmp` (CLI paste / clipboard), `~/.qoder/vibe_images` (ImageGen), and the desktop IDE paste cache `…/Qoder/SharedClientCache/cache/images` (`~/Library/Application Support/Qoder` / `%APPDATA%/Qoder` / `~/.config/Qoder`; Linux remote hashed profiles use `<appRoot>/<hash>/SharedClientCache/cache/images`). |
| `codex` | `~/.codex` (reserved; Codex today uses inline base64, not disk paths). |
| `qwen-work-cn` | `~/.qwenworkcn/workspace` (clipboard paste `uploads/`) and `~/.qwenworkcn/tmp`. |

UNC/device paths and symlinks are skipped. An image suffix is accepted only when the bytes are an image header. Video suffixes `.mp4`, `.mov`, `.m4v`, `.3gp`, and `.3g2` need `ftyp` at offset 4, and the major brand must not be `M4A `, `M4B `, or `M4P `. `.webm` and `.mkv` need an EBML header. `.avi` needs `RIFF` with `AVI ` at offset 8. A suffix and header from different families are skipped. Local paths are treated as filesystem paths. A URL query after the extension (for example `a.png?x=1` in markdown) is not stripped; `pathToUri` will not fall back to the path with the query removed.

## What Each Agent Collects

The table below describes what multimodal collection actually captures per agent. Add new agents here as extractors land.

| Agent | Active | Collected data |
|-------|--------|----------------|
| `codex` | Yes | See [Codex](#codex) below. |
| `qoder` | Yes | See [Qoder IDE](#qoder-ide) and [Qoder CLI](#qoder-cli) below. |
| `qwen-work-cn` | Yes | See [Qwen Work CN](#qwen-work-cn) below. |
| Others | No | Setting `uploadMode` has no effect today. |

### Codex

Codex converts matching `input_image` data-URLs to `uri` parts at write time; base64 is not written into JSONL. Upload is asynchronous and may produce optimistic `uri`s (see [Dangling URIs](#dangling-uris-and-consumer-contract) below).

| `uploadMode` | Codex surface | Typical user action |
|--------------|---------------|---------------------|
| `none` | No conversion | — |
| `input` | `input_image` on user messages and in tool results | Paste/clipboard, Add file / Files mentioned; path in the prompt then `view_image`; generate-then-`view_image` (`function_call_output`) |
| `output` | No conversion today | No assistant-message extractor yet; tool-result images follow `input`. |
| `all` | User messages and tool results | Covers paste/add-file and tool read/generate images |

Notes:

- An image path in the prompt or reply does not by itself yield multimodal media; Codex detection is driven by base64 `input_image` in the transcript. Local paths often remain in companion `input_text` (`Files mentioned` / `<image path="...">`); Pilot uploads from the companion data-URL only and does not re-read the file from disk.

### Qoder IDE

Qoder IDE (`qoder`) converts on the `qoder-trace` path after IDE token enrichment: detect a local image path → `MultimodalProcessor.pathToUri` (read bytes → uri) → `uri` part on the event. Policy is `agents.qoder.multimodal`. JetBrains sessions (`qoder-idea`) share this input but are skipped. Failures are fail-open and do not interrupt text/token collection.

| `uploadMode` | Qoder IDE surface | Typical user action / event |
|--------------|-------------------|-----------------------------|
| `none` | No conversion | — |
| `input` | Read from SQLite; `tool.result` text: `Image file: <path>` or ImageGen `absolute path of the image is: <path>` | Paste / @ image; cite a video file; Read image, ImageGen |
| `output` | `![...](path)` in `llm.response` `gen_ai.output.messages` (image extensions); `tool.call` image `file_path` | Assistant replies that embed read/generated images; Read image by path |
| `all` | All of the above | Attachments, tool read/generate, and output embeds |

Notes:

- Glob-discovered paths that were never visually read are not collected.
- The same path on tool and output surfaces is path-cached in-process to avoid re-reads; uploads remain content-addressed by sha256.

### Qoder CLI

Qoder CLI (`qoder-cli`, still configured via `agents.qoder.multimodal`) converts on the same `qoder-trace` path after CLI token enrichment. It does not query SQLite. Assistant finals usually have no embedded image; `output` converts `tool.call` image paths. Tool-result images follow `input`. Fail-open.

| `uploadMode` | Qoder CLI surface | Typical user action / event |
|--------------|-------------------|-----------------------------|
| `none` | No conversion | — |
| `input` | Union of `agent.qoder.attachments[].filename`, `[Image: source: <path>]`, `@path` (relative paths join `agent.qoder.cwd`), and `文件：<image or video path>` (CLI 1.1.61 paste citation), then unique-resolve; `tool.result` text: `Read image: <path>`, `Image file: <path>`, ImageGen `absolute path of the image is: <path>` | Paste image, `@` / `--attachment`; path in the prompt then Read; ImageGen then Read to preview |
| `output` | `tool.call` image `file_path` | Path in the prompt then Read; find then Read |
| `all` | User attachments, tool-result images, and tool-call image paths | Paste/`@` plus tool read/generate |

Notes:

- Glob-only listings that were never `Read` / `ImageGen` are not collected.
- Remote OSS URLs are not used as the source; local `pathToUri` is.
- CLI (1.1.29) writes `type: "attachment"` / `image_file.filename` (absolute local path) into the transcript. The hook only copies matching `image_file` objects onto `agent.qoder.attachments`. `QoderTraceInput` unions those filenames with `[Image: source:]` / `@`, unique-resolves, then drops the carrier before emit.

### Qwen Work CN

Qwen Work CN (`qwen-work-cn`) converts on the `qwen-work-cn-trace` path after turn enrichment. Policy is `agents.qwen-work-cn.multimodal`. The hook is unchanged. Pasted images and local image or video paths on tools become `uri` parts. Failures are fail-open.

| `uploadMode` | Qwen Work CN surface | Typical user action / event |
|--------------|----------------------|-----------------------------|
| `none` | No conversion | — |
| `input` | Paste tag in the user message; `qwenwork_media_read` result `data.files[].source` where `kind` is `image` or `video`; `qwenwork_media_task` `files` when `status` is `completed`; `qwenwork_file_present_files` result `artifacts[].filePath` | Paste, select, or drag; the model finds images or reads video; generation completes and is presented |
| `output` | `Read` `file_path`; `qwenwork_media_read` call `files`; `qwenwork_file_present_files` call `files[].file_path` | A path in the message then Read; the model finds images or reads video; present an already generated file |
| `all` | All of the above | Paste, read, and generate |

Notes:

- A `pending` `qwenwork_image_generate` or `qwenwork_video_generate` result, a `qwenwork_media_task` call that only has `output_name`, `mcp_workspace_bash` command text, and a bare filename with no read are not collected.
- A `qwenwork_media_read` result item with no `kind`, or a `kind` other than `image` / `video`, is not collected.
- `uri` and `originalUri` on a present result repeat `filePath`. Only `filePath` is taken.
- OSS URLs are not a collection source.
- Selected, dragged, Read, found, and generated files live in the session directory. Reading them requires that directory in `allowedRootPaths`.

## Output Shape (Short)

- Message / tool-result `parts` use `type: "uri"` (with `mime_type`, etc.) instead of inline base64.
- Optional summaries of `uri` media, split by where the parts already sit: `gen_ai.input.multimodal_metadata` (input and tool output), `gen_ai.output.multimodal_metadata` (output and tool calls). `gen_ai.input.multimodal_metadata_delta` summarizes only this event's `messages_delta` and `tool.call.result`, not cumulative `messages`.

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
