# Add custom attributes per request

English | [简体中文](zh-CN/request-attributes.md)

Before sending each user turn, an application can write customer, user, or task identifiers for that request. Pilot matches the record against the native session and collected input, then adds the attributes to that turn's events and trace spans. The agent may be a CLI started for each task or a long-running SDK/RPC process; values come from each request without changing a shared process environment.

The shared per-turn path uses the [per-turn trace correlation](zh-CN/upstream-trace-correlation.md) files, but does not require an upstream trace or `upstreamLink.enabled`. Applications starting a separate Grok process for each task can also use the process-environment path below. Neither path injects values into the agent's network requests, copies attributes from an upstream span, or installs a missing agent plugin.

## CLI: one Grok process per task

When the application server starts a separate Grok process for each turn, it can set attributes on that child process without knowing the native session ID in advance. Pilot's Grok Hook copies inherited attributes onto events for the turn identified by that Hook's explicit `prompt_id`. For example:

```bash
LOONGSUITE_PILOT_SPAN_ATTRIBUTES='memory.user_id=customer-001,memory.request_id=request-001' \
  grok -p 'Describe the project'
```

In an existing `spawn` call, preserve the command, arguments, and environment and add the variable to that specific child's `env` object. Do not repeatedly mutate the server's shared `process.env` for concurrent tasks.

Pilot still needs to allow the corresponding span prefix:

```json
{
  "otlpTrace": {
    "spanAttributePassthroughPrefixes": ["memory."]
  }
}
```

This follows the existing Claude Code/Codex environment-variable path and is independent of `requestAttributes.enabled` and `upstreamLink.enabled`. The variable must reach the **agent and its Hook**; setting it only on the collector does not add attributes to business calls. Its format is `key=value,key=value`; values are strings, cannot contain commas, and are limited to 512 characters each. Grok also applies the 64-field, 8 KiB group, and 128-character key limits below, and these dynamic fields enter subsequent masking.

If the same Grok process accepts further turns, its environment does not change with each request. For multiple users in a long-running process, use the shared per-turn file path below. Grok support does not imply that Pi or DSH also reads this variable.

Recovered historical turns are not backfilled with values from the current process. Without an explicit `prompt_id`, the Hook omits these attributes and continues normal collection. Confirm that the actual business entry point provides this identifier for the current request.

## 1. Per-turn files: confirm that the caller can identify the turn

All of these conditions must hold:

- Pilot already collects the agent, and its first standard events provide the current user input before they are exported.
- Before sending the input, the caller obtains the **native `gen_ai.session.id` used by collected events**, for example from SDK/ACP session creation. Check an existing event to confirm the IDs agree.
- The caller and Pilot access the same data directory, and the caller can append correlation records there.

A business session ID does not replace the native session ID. Output identity overrides do not change the ID used for matching. If a directly launched CLI creates its native session ID internally, first check whether the framework supports creating a session before sending, providing a native session ID, or another reliable integration point. Starting one process per task alone does not establish this prerequisite. Supported agents also have a process-environment path described in [Trace output](trace-output.md#custom-span-attributes).

Matching uses collected input, not HTTP arrival time. Repeated input within one native session consumes records in file order. **Concurrent requests with identical input in the same session cannot be uniquely identified from text alone.** For this integration, serialize each native session as “write this turn's record → send its input → wait for the turn to finish.” Independent native sessions may write and run concurrently.

Once using this integration, **write a `turn` record before every turn, including `"attributes": {}` as a placeholder when no business attributes are needed**. Do not omit an intermediate turn and prewrite a record for a future turn with identical input: the intermediate turn could consume the future attributes. An empty object is consumed with its matching turn to preserve this position.

## 2. Enable request attributes and span passthrough

Merge into Pilot's existing `config.json`, preserving reporting destinations and other settings:

```json
{
  "requestAttributes": { "enabled": true },
  "otlpTrace": {
    "spanAttributePassthroughPrefixes": ["memory."]
  }
}
```

Restart Pilot to load the settings. In Kubernetes, persist them in the injection template or configuration source that generates this file.

`requestAttributes.enabled` defaults to false; the collector environment variable `LOONGSUITE_PILOT_REQUEST_ATTRIBUTES=true` also enables it. It adds matched attributes to output events. `spanAttributePassthroughPrefixes` selects ordinary fields copied onto spans: without a matching prefix, fields can appear in event output but do not reach spans through this mechanism. Trace reporting still requires an existing CMS/OTLP destination and `collectTrace`.

## 3. Write attributes before each turn

Use this location under Pilot's data directory:

```text
<dataDir>/acp-correlate/<native-session-id>.jsonl
```

Append one complete JSON object and a newline per turn, including empty-object placeholders for turns without attributes. For example:

```json
{"type":"turn","sessionId":"session-demo","contentPrefix":"Describe the project","attributes":{"memory.user_id":"customer-001","memory.request_id":"request-001","memory.attempt":1}}
```

Prefer `contentHash`: the first 16 hexadecimal characters of the original user text's UTF-8 SHA-256. `contentPrefix` is an optional fallback; avoid short or repeated prefixes. Supply at least one. Put business fields in the `attributes` object; `traceparent` is optional.

Adapt this Node.js example in the caller. `send` is the application's existing SDK/RPC function, not a new Pilot business API. The example assumes one serialized writer per native session. For multiple processes writing the same session file, use a platform-owned single writer or cross-process coordination.

```js
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

function writeRequestAttributes({ dataDir, sessionId, prompt, attributes }) {
  try {
    const dir = path.join(dataDir, 'acp-correlate');
    const name = path.basename(String(sessionId))
      .replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
    const record = {
      type: 'turn',
      sessionId,
      contentHash: createHash('sha256').update(prompt, 'utf8')
        .digest('hex').slice(0, 16),
      attributes,
    };
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${name}.jsonl`),
      JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch {
    // Continue the business request once; this turn may have no attributes.
    return false;
  }
}

async function sendTurn({ dataDir, sessionId, prompt, attributes = {}, send }) {
  const attributesWritten = writeRequestAttributes({
    dataDir, sessionId, prompt, attributes,
  });
  // Send the same prompt through the original SDK/RPC after the write completes.
  const result = await send(prompt);
  return { result, attributesWritten };
}
```

`send` must resolve after the business turn finishes. If the existing API only acknowledges receipt, wait for completion separately before sending the next turn. For identical prompts in one session, call `sendTurn` in this order, writing a record each time:

| Request order | Written `attributes` | Request attributes for that turn |
| --- | --- | --- |
| A | `{"memory.user_id":"U001","memory.request_id":"R001"}` | U001 / R001 |
| B | `{}` | No added request values; does not inherit A |
| C | `{"memory.user_id":"U003","memory.request_id":"R003"}` | U003 / R003 |

The no-inheritance behavior uses B's empty-object placeholder; it does not guarantee correct matching when arbitrary turns are omitted. Replay of the same native turn can recover its matched record. Preserve Pilot's consumption markers in the same directory. Do not overwrite history or add records after a request completes; exported data is not updated retroactively. `upstreamLink.ttlMs` controls expiry cleanup for the shared directory (24 hours by default), including when upstream trace linking is disabled.

The directory and consumption markers must be writable. A record or claim write failure degrades telemetry on a best-effort basis: business execution continues, but attributes may be lost. Correct same-input matching is not guaranteed unconditionally across permission failures and recovery. Monitor `attributesWritten`, restore write access, and recheck ownership after recovery; do not resend completed business requests to repair telemetry.

In request-attribute mode, each correlation file is limited to 32 MiB and each complete JSONL line to 64 KiB. If either the whole file or any complete line exceeds its budget, Pilot logs a warning and refuses **the entire new file read** while retaining existing cached matches; it does not skip just the oversized line or silently read only the first N lines. Bound record sizes and session lifetime, use a new file for a new native session, or allow normal TTL cleanup. Do not replace, truncate, or manually rotate an active append-only session file: doing so can invalidate consumption markers and turn ownership.

## 4. Upstream traces and field policies

To also attach to an upstream trace, enable `upstreamLink.enabled` and add the real upstream `traceparent` to the **same turn record**. With upstream linking disabled, attributes still work and existing trace/parent relationships remain unchanged. Adding business attributes also preserves valid native subagent parent-tool contexts.

Values can be strings, finite numbers, or booleans, not objects, arrays, or `null`. Keys are limited to 128 characters and string values to 512 characters; each group is limited to 64 attributes and 8 KiB of JSON encoded as UTF-8. Use a dedicated namespace such as `memory.*`. Reserved prefixes (including `gen_ai.`, `user.`, `agent.`, `git.`, `workspace.`, `event.`, `trace_`, and `cost_`) and sensitive names (such as token, secret, and password) cannot be set as ordinary business attributes. Invalid individual fields are dropped. A group exceeding its count or byte budget is rejected as a whole rather than truncated.

Explicit per-turn file attributes override producer fields with the same ordinary key, including defaults from Grok's environment variable. They are attached before shared masking, and span passthrough uses the resulting values. This mechanism does not change canonical `user.id` or session identity. To use `memory.user_id` for memory ownership, configure the memory system to read that Agent attribute, for example `$.agent_attributes.attributes["memory.user_id"]`, and confirm the mapping with a real trajectory sample.

## 5. Verify and troubleshoot

Use two native sessions with distinct `memory.user_id` values and send fresh requests through the actual business entry point:

1. Check native session, turn, user, and request identifiers in Pilot's standard events.
2. Check actual AGENT, LLM, TOOL, and other generated spans in local OTLP debug output or a receiver.
3. Read the same trace back from CMS/OTLP, checking native attribute types and complete parent relationships, then test memory ownership mapping.
4. Exercise identical input with A (values) → B (empty placeholder) → C (new values), independent concurrent sessions, and collector restart/replay. Also verify business execution continues during directory write failures, attributes degrade, and ownership is rechecked after recovery.

For missing attributes, check loaded configuration, shared data directory, native session ID, original input hash, write-before-send ordering, available user input in the first collected events, and allowed span prefixes. If a plugin is not loaded or standard events are absent, restore collection first; correlation records cannot repair a missing collection entry point.
