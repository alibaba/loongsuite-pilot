# Add custom attributes per request

English | [简体中文](zh-CN/request-attributes.md)

Before sending each user turn, an application can write customer, user, or task identifiers for that request. Pilot matches the record against the native session and collected input, then adds the attributes to that turn's events and trace spans. The agent may be a CLI started for each task or a long-running SDK/RPC process; values come from each request without changing a shared process environment.

The shared per-turn path uses the [per-turn trace correlation](zh-CN/upstream-trace-correlation.md) files, but does not require an upstream trace or `upstreamLink.enabled`. Applications starting a separate Grok process for each task can also use the process-environment path below. Neither path injects values into the agent's network requests, copies attributes from an upstream span, or installs a missing agent plugin.

## Quick start: a server starts Grok for each request

Use these steps when an HTTP application starts a separate Grok process for each business request. Long-running SDK/RPC processes use the per-turn file integration below.

### 1. Upgrade a specified package and verify the deployed Hook

Use a **Pilot package or image known to contain this feature**. Source code on a feature branch does not mean the public `latest` package includes it. A candidate handoff should identify the source commit, package/image location, checksum, and supported Agent versions. See [installation](installation.md) for specified-package options.

Upgrade both the Collector and deployed Hook/Plugin assets. Replacing Collector `dist` alone or restarting the service is insufficient. Installation updates Pilot assets; also verify the command Grok actually loads points to the new Hook. Restarting the Collector does not change an existing business process's environment. Subsequent requests must launch new Agent processes with their request values.

**Multitenant and system deployment has an additional prerequisite:** default open-source Grok deployment registers `$GROK_HOME/hooks/loongsuite-pilot.json` for the current home, not all future tenant directories. Platforms using dynamic `GROK_HOME`, shared managed configuration, or customized installers must preserve and verify their existing Hook registration before upgrading its referenced Collector/Hook assets. Do not replace that deployment with a normal single-user installation and assume compatibility. Persist container changes in the image or injection template and verify a newly created tenant directory.

### 2. Allow `memory.` span fields in Pilot

Merge into the existing `config.json`, retaining OTLP/CMS destinations and **appending** `memory.` to existing prefixes:

```json
{
  "otlpTrace": {
    "spanAttributePassthroughPrefixes": ["memory."]
  }
}
```

Restart the Collector to load configuration. This child-process path needs neither `requestAttributes.enabled` nor `upstreamLink.enabled`, and requires no correlation file. Trace reporting should already work.

### 3. Pass the current user to each child process

Use the application's authenticated, stable identity, consistent across clients, such as `tenant-001:user-007`. Generate a separate request ID each time. Validate or encode identifiers to avoid commas. Preserve the existing command, arguments, working directory, and environment:

```js
import { spawn } from 'node:child_process';

// Values come from the current authenticated business request.
const attributes = `memory.user_id=${tenantUserId},memory.request_id=${requestId}`;
const child = spawn(grokCommand, grokArgs, {
  ...existingSpawnOptions,
  env: {
    ...(existingSpawnOptions.env ?? process.env),
    LOONGSUITE_PILOT_SPAN_ATTRIBUTES: attributes,
  },
});
```

Create a separate environment object for every request without mutating shared `process.env`. Concurrent A/B requests pass their own values to their respective Agents and Hooks. Setting this variable only on the Collector does not annotate business requests; it must reach the Agent before the turn starts.

### 4. Check traces, then configure memory ownership

Send simultaneous requests from two users through the actual application. Check each Trace's AGENT span for the correct `memory.user_id` and `memory.request_id`. Multitenant platforms must repeat this in a **new tenant directory** to verify shared Hook registration remains effective.

For memory ownership, map userId to `$.agent_attributes.attributes["memory.user_id"]`. Read an actual trajectory first to confirm that field exists, then test mapping, extraction, and recall. The default userId mapping does not automatically use it. **Trace attributes, trajectory attributes, and successful memory extraction/recall are separate acceptance checks.**

## OpenClaw: per-turn values on a persistent Gateway

Verified with **OpenClaw 2026.6.5 `agent` RPC**: changing values, empty attributes, concurrent independent sessions, and identical-input concurrent submissions to one session associate separately in the same Gateway process. `LOONGSUITE_PILOT_SPAN_ATTRIBUTES` on that process is a startup default; it cannot switch business users per RPC.

1. Update and activate Pilot's OpenClaw plugin, restarting the Gateway once to load it. Enable `requestAttributes.enabled` and `memory.` span passthrough below, and restart the Collector. The caller must write to the same data directory used by the Collector. A remote RPC client cannot replace this with arbitrary request parameters; a business adapter beside the Gateway can publish records.
2. Use the real native `sessionId`. `sessionKey` routes sessions but does not replace the correlation-file session ID. This version accepts a caller-specified session ID in `agent`; verify collected IDs for new and resumed sessions.
3. For this verified RPC, native `runId` equals caller `idempotencyKey`, which the modern Pilot plugin uses as `gen_ai.turn.id`. Use a unique key for each new logical request and publish its exact record **before** sending:

```js
import { randomUUID } from 'node:crypto';

const runId = randomUUID();
writeRequestAttributes({ dataDir, sessionId, turnId: runId,
  attributes: { 'memory.user_id': tenantUserId, 'memory.request_id': requestId } });
await gateway.request('agent', {
  sessionId, sessionKey, message: prompt, idempotencyKey: runId,
});
```

`writeRequestAttributes` is the caller-side example below; `gateway.request` is the application's existing OpenClaw client. Adding an `attributes` object directly to this RPC is unsupported and rejected by this version. Exact records handle identical input, reverse publication order, and concurrent submission without arrival-order guessing. The Gateway may still serialize execution within a session.

This does not establish the same ID semantics for `chat.send`, HTTP compatibility endpoints, or older OpenClaw versions. Legacy Pilot adapters can generate different turn IDs. Confirm actual versions/events. When exact native IDs are unavailable before sending, use a known native session with serialized text matching.

## Codex: CLI children and a persistent app-server

Two entry points have been verified with **Codex 0.166.0**:

- A separate CLI child per request: give each child its own `LOONGSUITE_PILOT_SPAN_ATTRIBUTES`, as with Grok. No correlation file or linking switches are needed.
- A persistent app-server: `thread/start` returns the native thread ID, which is Pilot's session ID. Before each new `turn/start`, publish a `contentHash` record using original user text. Enable `requestAttributes.enabled`, and write `attributes: {}` for unannotated turns.

```js
const { thread } = await codex.request('thread/start', existingThreadOptions);
// For each new turn, write first; wait for turn/completed before the next one.
writeRequestAttributes({ dataDir, sessionId: thread.id, prompt,
  attributes: { 'memory.user_id': tenantUserId, 'memory.request_id': requestId } });
await codex.request('turn/start', {
  threadId: thread.id, input: [{ type: 'text', text: prompt }],
});
```

Use a Pilot version containing the native user-provenance correlation fix. An app-server's first turn also writes environment context. Pilot derives the original user hash from native `content_item_metadata.provenance` or `user_message`, preserving full messages. Do not add environment context to the caller's hash or strip arbitrary XML to guess input.

Different threads can run concurrently. **Calling `turn/start` during an active turn on the same thread can add input to that turn and return the same ID**, rather than create a second independent request. Steering cannot carry two independently attributed turn identities; do not prequeue a second FIFO record for it. Use separate threads or wait for completion. Native turn IDs are returned after `turn/start`, so arbitrary business request IDs cannot predeclare an exact match.

## User ownership and concurrency

For memory extraction, derive `memory.user_id` from the application's authenticated identity. Use the same stable value across clients, qualified by tenant where needed, such as `tenant-001:user-007`. `memory.request_id` changes per request and is for diagnosis. Agent instance IDs, the container's root user, working directories, and native session IDs do not establish business-user identity.

The chain is: request identity → child environment or per-turn record → Hook/Plugin events → Pilot native session/turn association → masking and span passthrough → AGENT span attribute → trajectory `agent_attributes.attributes` → memory `userId` mapping.

| Calling pattern | Attribute source | Concurrency boundary |
| --- | --- | --- |
| Separate Grok child per request | Each child's own `env` | Concurrent children are supported when Hooks supply the current `prompt_id`; do not mutate shared server environment |
| Different native sessions | Separate session files | Sessions can run concurrently |
| One session, input text/hash only | Text FIFO records | Serialize turns to completion; identical input arriving out of order is ambiguous |
| One session, exact native turn ID known before sending | Records with `turnId` | Pilot handles identical input and out-of-order arrival; the framework must separately permit concurrent turns |

`turnId` must equal the collected **`gen_ai.turn.id`**, not an arbitrary business request ID. Some CLIs generate it only after execution starts. Adding a JSON field alone does not make those entry points support advance exact association. Use independent sessions, a verified child-process path, or an integration that exposes the native lifecycle.

Adapter turn IDs can also differ from host API IDs. Confirm actual events:

| Framework | Collected `gen_ai.turn.id` | Caller consideration |
| --- | --- | --- |
| Grok | `promptId` from Hook/updates | Available in current Hooks; CLI callers should not assume it is known before launch and can use child env |
| Codex | `<native-session-id>:<host-turn-id>` | A host turn ID alone is insufficient; match the complete collected value |
| DSH | `<native-session-id>:<host-turn-number>` | Confirm actual SDK/plugin loading and sequence semantics; do not infer it from business request counters |
| Pi | UUID generated by Pilot's extension for the turn | External callers usually cannot know it in advance; use a confirmed session with serialized text matching or add lifecycle integration |

This table describes matching protocol, not a claim that each framework exposes a caller-assigned turn-ID API.

Also distinguish whether a **session ID** is available in advance. Pi 1.5.0 has been verified to create a session with `--session-id <UUID>`: generate a UUID, write that session's text association record, then launch Pi with the same UUID. Give concurrent users separate UUIDs. DSH 0.2.1-rc.5 CLI `--session-id` resumes an existing session; it does not inject a new session ID. Verified subsequent-turn association does not establish first-turn support. Production callers need SDK session creation before sending or a lifecycle integration; an unannotated business “warmup” request is not a substitute. Recheck native flags and lifecycle behavior for other versions.

## CLI: one Grok process per task

When the application server starts a separate Grok process for each turn, it can set attributes on that child process without knowing the native session ID in advance. Pilot's Grok Hook copies inherited attributes onto events for the turn identified by that Hook's explicit `prompt_id`. For example:

```bash
LOONGSUITE_PILOT_SPAN_ATTRIBUTES='memory.user_id=customer-001,memory.request_id=request-001' \
  grok -p 'Describe the project'
```

In an existing `spawn` call, preserve the command, arguments, and environment and add the variable to that specific child's `env` object. Do not repeatedly mutate the server's shared `process.env` for concurrent tasks.

```js
// Run once for each HTTP request, preserving the existing args, cwd, and env.
const childEnv = {
  ...existingEnv,
  LOONGSUITE_PILOT_SPAN_ATTRIBUTES:
    `memory.user_id=${tenantUserId},memory.request_id=${requestId}`,
};
const child = spawn('grok', args, { cwd, env: childEnv });
```

Validate identifiers before using this comma-separated format. Concurrent A/B children inherit their own values; the collector does not infer ownership from process start order.

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

- Pilot already collects the agent, and its first standard events provide current input, or the caller can supply an exact native turn ID.
- Before sending the input, the caller obtains the **native `gen_ai.session.id` used by collected events**, for example from SDK/ACP session creation. Check an existing event to confirm the IDs agree.
- The caller and Pilot access the same data directory, and the caller can append correlation records there.

A business session ID does not replace the native session ID. Output identity overrides do not change the ID used for matching. If a directly launched CLI creates its native session ID internally, first check whether the framework supports creating a session before sending, providing a native session ID, or another reliable integration point. Starting one process per task alone does not establish this prerequisite. Supported agents also have a process-environment path described in [Trace output](trace-output.md#custom-span-attributes).

Without `turnId`, matching uses collected input, not HTTP arrival time. Repeated input within one native session consumes records in file order. **Concurrent requests with identical input in the same session cannot be uniquely identified from text alone.** In text mode, serialize each native session as “write this turn's record → send its input → wait for the turn to finish.” Independent native sessions may write and run concurrently.

In text FIFO mode, **write a `turn` record before every turn, including `"attributes": {}` as a placeholder when no business attributes are needed**. Do not omit an intermediate turn and prewrite a record for a future turn with identical input: the intermediate turn could consume the future attributes. An empty object preserves this position. Sessions containing only exact records may omit records for turns without attributes. If a session mixes text FIFO records, write an exact `attributes: {}` record for each unannotated turn to prevent fallback consumption of an identical-input FIFO record. Prefer one association mode per session.

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

For text mode, prefer `contentHash`: the first 16 hexadecimal characters of the original user text's UTF-8 SHA-256. `contentPrefix` is an optional fallback; avoid short or repeated prefixes. Supply at least one. Put business fields in the `attributes` object; `traceparent` is optional.

If the exact native turn ID is known before sending, prefer exact mode; input text is optional:

```json
{"type":"turn","sessionId":"session-demo","turnId":"native-turn-002","attributes":{"memory.user_id":"tenant-001:user-007","memory.request_id":"request-002"}}
```

Exact records match only that native turn in that session. They do not enter text FIFO or get consumed by other identical-input requests. Identical publications may be retried. Conflicting contexts visible at the first resolution cause that turn's file association to be refused with a warning. Publish all records before collection first resolves the turn; its result is then frozen in cache. Later conflicting appends do not trigger a new decision, and events or spans are not updated retroactively. A single writer or cross-process coordination must still ensure complete lines.

Adapt this Node.js example in the caller. `send` is the application's existing SDK/RPC function, not a new Pilot business API. The example assumes one serialized writer per native session. For multiple processes writing the same session file, use a platform-owned single writer or cross-process coordination.

```js
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

function writeRequestAttributes({ dataDir, sessionId, turnId, prompt, attributes }) {
  try {
    const dir = path.join(dataDir, 'acp-correlate');
    const name = path.basename(String(sessionId))
      .replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
    const record = {
      type: 'turn',
      sessionId,
      ...(turnId ? { turnId } : {
        contentHash: createHash('sha256').update(prompt, 'utf8')
          .digest('hex').slice(0, 16),
      }),
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

The no-inheritance behavior assumes B's empty-object placeholder and no same-key producer default; it does not guarantee correct matching when arbitrary turns are omitted. `attributes: {}` occupies a position without clearing fields already supplied by a Hook/Plugin or global configuration. Do not set dynamic `memory.user_id` defaults on a long-running multi-user process. Replay of the same native turn can recover its matched record. Preserve Pilot's consumption markers in the same directory. Do not overwrite history or add records after a request completes; exported data is not updated retroactively. `upstreamLink.ttlMs` controls expiry cleanup for the shared directory (24 hours by default), including when upstream trace linking is disabled.

The directory and consumption markers must be writable. A record or claim write failure degrades telemetry on a best-effort basis: business execution continues, but attributes may be lost. Correct same-input matching is not guaranteed unconditionally across permission failures and recovery. Monitor `attributesWritten`, restore write access, and recheck ownership after recovery; do not resend completed business requests to repair telemetry.

In request-attribute mode, each correlation file is limited to 32 MiB and each complete JSONL line to 64 KiB. If either the whole file or any complete line exceeds its budget, Pilot logs a warning and refuses **the entire new file read** while retaining existing cached matches; it does not skip just the oversized line or silently read only the first N lines. Bound record sizes and session lifetime, use a new file for a new native session, or allow normal TTL cleanup. Do not replace, truncate, or manually rotate an active append-only session file: doing so can invalidate consumption markers and turn ownership.

## 4. Upstream traces and field policies

To also attach to an upstream trace, enable `upstreamLink.enabled` and add the real upstream `traceparent` to the **same turn record**. With upstream linking disabled, attributes still work and existing trace/parent relationships remain unchanged. Adding business attributes also preserves valid native subagent parent-tool contexts.

Values can be strings, finite numbers, or booleans, not objects, arrays, or `null`. Keys are limited to 128 characters and string values to 512 characters; each group is limited to 64 attributes and 8 KiB of JSON encoded as UTF-8. Use a dedicated namespace such as `memory.*`. Reserved prefixes (including `gen_ai.`, `user.`, `agent.`, `git.`, `workspace.`, `event.`, `trace_`, and `cost_`) and sensitive names (such as token, secret, and password) cannot be set as ordinary business attributes. Invalid individual fields are dropped. A group exceeding its count or byte budget is rejected as a whole rather than truncated.

Explicit per-turn file attributes override producer fields with the same ordinary key, including defaults from Grok's environment variable. They are attached before shared masking, and span passthrough uses the resulting values. This mechanism does not change canonical `user.id` or session identity. To use `memory.user_id` for memory ownership, configure the memory system to read that Agent attribute, for example `$.agent_attributes.attributes["memory.user_id"]`, and confirm the mapping with a real trajectory sample.

Default memory ownership reads `user.id`, then `enduser.id`; it does not automatically read `memory.user_id`. Dotted keys require the bracket path above. A custom mapping uses only its configured path, without the default fallback. Check both the AGENT span and trajectory `agent_attributes.attributes`, then test the mapping with a real sample.

Cross-client memory also requires checking `agentId`/`appId` mapping and recall filters: default Agent name and first service name can differ across frameworks. Equal user IDs alone do not prove shared recall. A mapping test proves value extraction only; memory extraction, storage, and cross-client recall require separate acceptance. Isolate business sessions by user to avoid mixing conversation context. This feature assigns telemetry fields; it does not isolate the Agent's conversation state.

## 5. Verify and troubleshoot

Use two native sessions with distinct `memory.user_id` values and send fresh requests through the actual business entry point:

1. Check native session, turn, user, and request identifiers in Pilot's standard events.
2. Check actual AGENT, LLM, TOOL, and other generated spans in local OTLP debug output or a receiver.
3. Read the same trace back from CMS/OTLP, checking native attribute types and complete parent relationships, then test memory ownership mapping.
4. Exercise identical input with A (values) → B (empty placeholder) → C (new values), independent concurrent sessions, and collector restart/replay. Where exact native turn IDs are available, also test identical input arriving out of order and conflicting contexts. Verify business execution continues during directory write failures, attributes degrade, and ownership is rechecked after recovery.

For missing attributes, check loaded configuration, shared data directory, native session ID, original input hash, write-before-send ordering, available user input in the first collected events, and allowed span prefixes. If a plugin is not loaded or standard events are absent, restore collection first; correlation records cannot repair a missing collection entry point.
