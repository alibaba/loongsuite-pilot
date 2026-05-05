# Contract: Cursor Hook Output Record

## Purpose

定义 `cursor-hook-processor.mjs` 写入 JSONL 的输出契约和运行时响应契约。

## Output File Contract

- Directory: `~/.loongsuite-pilot/logs/cursor-hook/history/`
- Filename: `cursor-YYYY-MM-DD.jsonl`
- Write mode: append-only (one JSON object per line)

## JSONL Record Schema

```json
{
  "uuid": "1f8a4a6e-b3f8-4ac5-9f2a-6e2a0f0aa111",
  "logTime": "2026-04-27T06:32:10Z",
  "reported": false,
  "clientType": "CursorHook",
  "hookEvent": "postToolUse",
  "data": {
    "cursor_version": "1.0.0",
    "time_unix_nano": "1745735530000000000",
    "event.name": "tool.result",
    "session.id": "sess-1",
    "request.model": "gpt-test",
    "tool.name": "Shell"
  }
}
```

## Field Rules

| Field | Rule |
|---|---|
| `uuid` | Must be a random UUID generated at write time |
| `logTime` | Must be UTC ISO-8601 string without milliseconds |
| `reported` | Always `false` on initial write |
| `clientType` | Always `CursorHook` |
| `hookEvent` | Normalized event name (`unknown` if missing/invalid) |
| `data` | Merge of retained raw fields + mapped standard fields |

## Data Merge Contract

1. Remove consumed source fields listed in mapping spec.
2. Keep non-mapped raw fields.
3. Apply mapped standard fields.
4. On key conflict, mapped value wins.
5. Drop `undefined` and empty object/array values.

## Runtime Response Contract

- Success response body: `{}` (stdout)
- Failure-path response body: `{}` (stdout) as well
- Exit code: `0` in all supported and failure-path cases

## Fail-Open Guarantee

The processor must not block caller workflows under:

- invalid JSON input
- missing processor runtime dependencies
- append/write failures
- runtime mapping exceptions

All above scenarios still return `{}` and keep non-blocking behavior.
