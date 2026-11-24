# Local Interception

English | [简体中文](zh-CN/interceptor.md)

Pilot evaluates supported agent hooks on the local machine. Qoder Desktop/CLI and Qwen Work use a separate interception hook alongside the collection hook; OpenClaw uses its plugin adapter. Supported phases are `UserPromptSubmit`, `PreToolUse`, and `PostToolUse`. PostToolUse can replace a result returned to the model, but cannot undo a tool's completed side effects.

## Enable interception

Set the startup configuration in `config.json` and restart the collector:

```json
{ "interceptor": { "mode": "all" } }
```

The environment variable `LOONGSUITE_PILOT_INTERCEPTOR_MODE` takes precedence. Installers accept `--interceptor-mode all` on macOS/Linux or `-InterceptorMode all` on Windows. `all` enables the Worker, HTTP listener, interception hooks, and configured local file rules. Without executable rules, requests are allowed, including requests containing credentials. `none`, an omitted mode, or any other value disables interception; cached files cannot enable it. Collection hooks remain independent.

When interception is enabled, installers and runtime configuration loading ensure masking covers `cloudAccessKey`, `apiKey`, `privateKey`, and `databaseUrl`. Mask mode `all` stays unchanged; other modes become `custom`, merging these types with existing custom types without duplicates and retaining the replacement format. This protection also applies to environment overrides and hand-edited configuration, independently of rule matches.

**Migration:** builtin credential interception has been removed. Configure local file rules to block or log matching content. The former interceptor `custom` mode, `--interceptor-types`, and `LOONGSUITE_PILOT_INTERCEPTOR_TYPES` are no longer supported. An existing `custom` configuration disables interception after upgrading. Explicitly select `all` before restarting to enable configured rules. Masking still supports its own `custom` mode, with credential types automatically included when interception is enabled.

## Local file rules

Write the following document to `<dataDir>/configs/managed/interceptor.json`. The directory name `managed` is a local format convention; the engine reads files without requiring a remote configuration service. Write any script bodies first, then atomically replace the rule document.

```json
{
  "interceptor": {
    "rules": [
      {
        "kind": "pattern",
        "id": "command-preview",
        "version": "1",
        "agents": ["qoder", "qodercli"],
        "events": ["UserPromptSubmit", "PreToolUse", "PostToolUse"],
        "action": "log",
        "match": "substring",
        "pattern": "RULE_PROBE",
        "title": "Command rule preview",
        "message": "This operation matches a local rule"
      },
      {
        "kind": "script",
        "id": "command-policy-sh",
        "version": "1",
        "agents": ["qoder", "qodercli"],
        "events": ["PreToolUse"],
        "shell": "sh"
      }
    ]
  }
}
```

Rule IDs must be unique within the document. IDs and versions accept ASCII letters, digits, dots, underscores, and hyphens only. `agents` and `events` must be nonempty arrays.

| Field | Values |
|-------|--------|
| `agents` | `qoder`, `qodercli`, `openclaw`, `qwen-work-cn` |
| `events` | `UserPromptSubmit`, `PreToolUse`, `PostToolUse` |
| `action` | Defaults to `block`: stop at the first blocking hit. `log`: record the hit, allow execution, and continue checking without notifying the host. |
| `kind` | `pattern` or `script`. `http` is a format placeholder: warn and skip without making a request. |
| `match` | `substring` or `regex` for a pattern rule. |
| `shell` | `sh` or `powershell` for a script rule; only the local platform's shell runs. |

Rules match one text assembled in order from user input, tool name, tool input, and tool output. Objects contribute string, number, and boolean leaves. Raw protocol data, session metadata, and rule titles/messages are excluded. The retired `fields` key is accepted and ignored.

Substring matching is literal. Patterns use JavaScript RegExp syntax, rejecting lookahead and lookbehind; matching runs in a dedicated Worker. Its default 200ms budget includes queueing. Timeout ends the task and terminates the thread before a replacement can be created. A failed termination logs a warning and disables further regex execution until the collector restarts. Pattern hits use `[PATTERN_BLOCKED]` as their reason.

### Scripts and cache namespaces

The default script path is `configs/managed/scripts/<id>@<version>.sh` or `.ps1`. For the example above, create `configs/managed/scripts/command-policy-sh@1.sh`:

```sh
#!/bin/sh
cat >/dev/null
printf '%s\n' '{"matched":false}'
```

The script receives one JSON object on stdin: `{"prompt":"<combined text>"}`. Stdout must contain exactly one JSON line, either `{"matched":false}` or `{"matched":true,"reason":"..."}`, and exit successfully. A timeout, nonzero exit, or invalid output skips the rule and preserves earlier log hits. All local file rules share a 3.5 second budget; exhaustion stops checking and fails open. Log scripts actually run with the same costs and side effects.

Unix uses `sh <file>` under a Node guardian that owns the process group. A private lease or deadline reclaims background descendants. Windows maintains at most two warm PowerShell executors with process-scoped `ExecutionPolicy Bypass`. Each executor is created atomically inside a kill-on-close Windows Job Object and retired with its native descendants after one request, including success, timeout, stop and crashes. A private lease and an independent guardian deadline also cover interceptor Worker termination; replacement waits for tree cleanup. Startup and cleanup count toward the request budget. Non-ASCII input is escaped as `\uXXXX`; scripts can read the original text with `ConvertFrom-Json`. The native Job capability requires Windows 10 / Server 2016 or later. If CLM/WDAC blocks its initialization, the rule fails open with `Windows Job Object unavailable` before any script starts; it never falls back to an unowned executor. Scripts receive a restricted environment such as PATH, HOME, and TEMP. They run as the collector user and are not an operating-system sandbox; processes delegated to services or WMI are outside native child-process ownership.

PowerShell 5.1 script files containing non-ASCII source text must use UTF-8 with a BOM. Escaping the stdin request preserves its JSON content; it does not change how PowerShell decodes the script file itself.

The Windows launcher removes inherited `PSModulePath` so PowerShell 5.1 reconstructs its own module search paths. Bootstrap commands explicitly import builtin module manifests from `$PSHOME` to avoid scanning unrelated modules during startup. This also supports a collector launched through Node from PowerShell 7; see [Microsoft's module-path guidance](https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_psmodulepath#starting-windows-powershell-from-powershell-7).

The local document also accepts optional `interceptor.scriptCache`, a 64-character lowercase hexadecimal namespace selecting `configs/managed/scripts/<scriptCache>/`. Without it, scripts live in the root scripts directory. A configuration provider must place all required scripts before publishing a document. The engine validates the namespace's format and file paths, without interpreting its origin.

Files are checked every three seconds. Invalid documents or scripts not yet ready preserve the previous executable generation. In-flight requests retain their original generation and executor; executors are retired after their last request, including when rules are cleared or become pattern-only. Loading validates real paths and regular files; execution rechecks the file to reject symlinks.

## Decisions and telemetry

File rules run in array order. `matches` preserves all known log and block hits. Top-level metadata identifies the final enforcing rule, or the first log hit when allowed. A complete check without hits has `matched=false`; an error without a known result omits it. A known log hit followed by an error can retain both `matched=true` and `failOpen=true`.

Rule hits no longer emit separate `guardrail.evaluation` events. Linked tool events carry the final request decision in `gen_ai.guardrail.*`; denied Qoder user prompts still emit `llm.request`. Individual log/block matches remain in the HTTP response and local access log `matches` array. UserPromptSubmit log does not synthesize a rejected prompt.

Allowed prompt verdicts are linked to the first native `llm.request` of the turn, including `action=log` for log hits. Later tool continuation requests do not reuse that prompt verdict. Correlation happens before content privacy processing and identity rewriting; private correlation metadata is removed before output.

Collected events omit rule `reason`, `message`, `matched`, `enforcement`, `title`, `severity`, and `match`. They retain `rule_id` and `rule_version`. The collected `gen_ai.guardrail.action` is `block` for enforced blocks, `log` for log hits, or `allow` for other known verdicts. `triggered=true` still means a check verdict exists, not that a rule matched. HTTP responses continue to use `allow` / `block`; host diagnostics and local access logs retain rule text.

Rule hits use the ID and version configured in the local rule document.

See [Output Event Schema](output-event-schema.md) for the `gen_ai.guardrail.*` fields.

Qoder hooks identifying `parent_business_info.product=app` emit blocked prompts as `qoder-app`. Workspace filtering uses the corresponding native agent/session identity before output, preserving sticky exclusions without sharing App and CLI privacy state.

The interception `agent` is a protocol and rule route (`qoder` / `qodercli`), while `gen_ai.agent.type` identifies the collected product. Native collection uses the current prompt's `businessIdentity.product` or its owning Hook context to retain `qoder-app` / `qoder-cli`. A Qoder route without product metadata is not treated as proof of IDE identity when linking an App request. Explicit App and CLI identities remain isolated. If a blocked prompt has no product metadata and never reaches a native transcript or Stop Hook, its synthetic event retains the existing `qoder-cli` fallback; that fallback does not prove the product was CLI.

## Runtime and failure handling

An interceptor Worker inside the collector process owns loopback HTTP, rules, runtime heartbeats, and verdict checkpoints. The main collector thread handles collection and output. Main-thread stalls do not occupy the Worker's event loop, though they delay message delivery and recovery. All threads still share process and machine resources.

Hook clients perform a 500ms health check followed by a 4 second decision request. Missing runtime, connection failures, timeouts, or invalid responses fail open. The normal and log-only paths exit successfully without host output. The listener prefers `127.0.0.1:18791`, falling back to an available port recorded in `interceptor/runtime.json`.

Tool verdicts use session ID, tool call ID, and phase, retaining the original timestamp. The Worker keeps at most 10,000 records for 30 minutes and checkpoints changes asynchronously every 15 seconds. The main-thread mirror waits at most two seconds for accepted verdicts before linking events. Message batches allow one outstanding ACK; event output has bounded item and byte queues. Overflow and stop timeouts are explicitly counted. An ACK means bounded acceptance or a counted drop, not backend persistence.

Prompt verdicts share the same retention, capacity, checkpoint and IPC lifecycle. The cache stores the agent, session, a SHA-256 prompt digest and request identity, without prompt text. Native `requestSetId` and Hook `request_set_id` values are carried only as private SHA-256 digests and removed before output; this does not change `gen_ai.request.id`. Comparable request identities take precedence, and two explicit, different IDs never fall back to another identified request.

New Qoder Hook observations explicitly record missing request/product metadata. Only an observation marked as missing its request ID can be linked to a native explicit ID through a unique candidate with the same session, compatible product and prompt digest within five seconds of the native prompt timestamp. Old UUID-shaped IDs are not assumed anonymous. Pending, failed and blocked attempts participate in ambiguity checks. The first successful anonymous association binds the verdict to that native request, allowing retries without lending it to a different request. The mirror returns this private binding over IPC to the runtime checkpoint writer; it survives checkpoint restore. Ambiguous prompts remain unannotated, and internal provenance/binding fields are never emitted as guardrail fields.

During normal shutdown, the collector confirms that all Worker writers have exited and drains accepted output before taking exclusive checkpoint ownership. If the mirror has prompt bindings, it asynchronously reads the latest disk checkpoint, merges the mirror and atomically saves it, retaining records only the old Worker had persisted. This also covers bindings created after a Worker crash and before restart. No takeover occurs while a Worker may still write. Read, validation or write failures reject shutdown instead of silently discarding ownership.

Worker failure clears stale runtime and retries with backoff from one to 30 seconds, recovering from checkpoints and the main-thread mirror. Shutdown closes HTTP, drains accepted output for up to five seconds, and reclaims script resources. Access logs use a bounded asynchronous masking and write queue at `interceptor/logs/access.log`.

`loongsuite-pilot status` reports the interceptor runtime; `restart` reloads the startup switch. Interception has no separate system service and stops with the collector.

## Downgrade

Rules accept only `action: block/log`, with `block` as the default. The removed `enforcement` key is rejected. Invalid documents preserve the previous executable rule generation.
