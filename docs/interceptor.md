# Local Interception

English | [简体中文](zh-CN/interceptor.md)

Pilot evaluates supported agent hooks on the local machine. Qoder Desktop/CLI and Qwen Work use a separate interception hook alongside the collection hook; OpenClaw uses its plugin adapter. Supported phases are `UserPromptSubmit`, `PreToolUse`, and `PostToolUse`. PostToolUse can replace a result returned to the model, but cannot undo a tool's completed side effects.

## Enable interception

Set the startup configuration in `config.json` and restart the collector:

```json
{ "interceptor": { "mode": "all" } }
```

The environment variable `LOONGSUITE_PILOT_INTERCEPTOR_MODE` takes precedence. Installers accept `--interceptor-mode all` on macOS/Linux or `-InterceptorMode all` on Windows. `all` enables every builtin credential rule and adds those types to the masking configuration. `none`, an omitted mode, or any other value disables the Worker, HTTP listener, local rules, and interception hook deployment; cached files cannot enable them. Collection hooks remain independent.

**Migration:** the former interceptor `custom` mode, `--interceptor-types`, and `LOONGSUITE_PILOT_INTERCEPTOR_TYPES` are no longer supported. An existing `custom` configuration disables interception after upgrading. Explicitly select `all` before restarting to continue interception, with all builtin credential types enabled. Masking still supports its own `custom` mode.

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
        "enforcement": "audit",
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
| `enforcement` | Defaults to `enforce`: block at the first hit. `audit`: record the hit, allow that rule, continue checking, and do not notify the host. |
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

The script receives one JSON object on stdin: `{"prompt":"<combined text>"}`. Stdout must contain exactly one JSON line, either `{"matched":false}` or `{"matched":true,"reason":"..."}`, and exit successfully. A timeout, nonzero exit, or invalid output skips the rule and preserves earlier audit hits. All local file rules share a 3.5 second budget; exhaustion stops checking and fails open. Audit scripts actually run with the same costs and side effects.

Unix uses `sh <file>` under a Node guardian that owns the process group. A private lease or deadline reclaims background descendants. Windows maintains at most two warm PowerShell executors with process-scoped `ExecutionPolicy Bypass`. Each executor is created atomically inside a kill-on-close Windows Job Object and retired with its native descendants after one request, including success, timeout, stop and crashes. A private lease and an independent guardian deadline also cover interceptor Worker termination; replacement waits for tree cleanup. Startup and cleanup count toward the request budget. Non-ASCII input is escaped as `\uXXXX`; scripts can read the original text with `ConvertFrom-Json`. The native Job capability requires Windows 10 / Server 2016 or later. If CLM/WDAC blocks its initialization, the rule fails open with `Windows Job Object unavailable` before any script starts; it never falls back to an unowned executor. Scripts receive a restricted environment such as PATH, HOME, and TEMP. They run as the collector user and are not an operating-system sandbox; processes delegated to services or WMI are outside native child-process ownership.

PowerShell 5.1 script files containing non-ASCII source text must use UTF-8 with a BOM. Escaping the stdin request preserves its JSON content; it does not change how PowerShell decodes the script file itself.

The Windows launcher removes inherited `PSModulePath` so PowerShell 5.1 reconstructs its own module search paths. Bootstrap commands explicitly import builtin module manifests from `$PSHOME` to avoid scanning unrelated modules during startup. This also supports a collector launched through Node from PowerShell 7; see [Microsoft's module-path guidance](https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_psmodulepath#starting-windows-powershell-from-powershell-7).

The local document also accepts optional `interceptor.scriptCache`, a 64-character lowercase hexadecimal namespace selecting `configs/managed/scripts/<scriptCache>/`. Without it, scripts live in the root scripts directory. A configuration provider must place all required scripts before publishing a document. The engine validates the namespace's format and file paths, without interpreting its origin.

Files are checked every three seconds. Invalid documents or scripts not yet ready preserve the previous executable generation. In-flight requests retain their original generation and executor; executors are retired after their last request, including when rules are cleared or become pattern-only. Loading validates real paths and regular files; execution rechecks the file to reject symlinks.

## Decisions and telemetry

Builtin sensitive-type rules run first and stop on a block. After they allow, file rules run in array order. `matches` preserves all known audit and enforce hits. Top-level metadata identifies the final enforcing rule, or the first audit hit when allowed. A complete check without hits has `matched=false`; an error without a known result omits it. A known audit hit followed by an error can retain both `matched=true` and `failOpen=true`.

Each file-rule hit emits `event.name=guardrail.evaluation`, including session/tool identifiers when available, phase, rule metadata, and that rule's action. It does not copy prompt or tool bodies; reasons and reminders are masked. Linked tool events describe the final request decision. For audit followed by enforce, evaluation actions are allow/block and the final tool action is block. UserPromptSubmit audit does not synthesize a rejected prompt; enforce still records the blocked prompt as `llm.request`.

Scripts may echo business content in `reason`. Setting an agent's `captureMessageContent=false` removes `gen_ai.guardrail.reason` from emitted observations, linked tool events, rejected-prompt events and OTLP span attributes/events, while preserving action and rule identity. Host blocking responses keep their diagnostic reason.

JSONL and SLS can retain evaluation events. OTLP filters them before turn grouping and conversion, so they cannot generate extra execution spans or prematurely end a turn. See [Output Event Schema](output-event-schema.md) for the `gen_ai.guardrail.*` fields.

Qoder hooks identifying `parent_business_info.product=app` emit observations and blocked prompts as `qoder-app`. Workspace filtering uses the corresponding native agent/session identity before output, preserving sticky exclusions without sharing App and CLI privacy state.

## Runtime and failure handling

An interceptor Worker inside the collector process owns loopback HTTP, rules, runtime heartbeats, and verdict checkpoints. The main collector thread handles collection and output. Main-thread stalls do not occupy the Worker's event loop, though they delay message delivery and recovery. All threads still share process and machine resources.

Hook clients perform a 500ms health check followed by a 4 second decision request. Missing runtime, connection failures, timeouts, or invalid responses fail open. The normal and audit-allow paths exit successfully without host output. The listener prefers `127.0.0.1:18791`, falling back to an available port recorded in `interceptor/runtime.json`.

Tool verdicts use session ID, tool call ID, and phase, retaining the original timestamp. The Worker keeps at most 10,000 records for 30 minutes and checkpoints changes asynchronously every 15 seconds. The main-thread mirror waits at most two seconds for accepted verdicts before linking events. Message batches allow one outstanding ACK; event output has bounded item and byte queues. Overflow and stop timeouts are explicitly counted. An ACK means bounded acceptance or a counted drop, not backend persistence.

Worker failure clears stale runtime and retries with backoff from one to 30 seconds, recovering from checkpoints and the main-thread mirror. Shutdown closes HTTP, drains accepted output for up to five seconds, and reclaims script resources. Access logs use a bounded asynchronous masking and write queue at `interceptor/logs/access.log`.

`loongsuite-pilot status` reports the interceptor runtime; `restart` reloads the startup switch. Interception has no separate system service and stops with the collector.

## Downgrade

Older clients may reject `enforcement` or `scriptCache`. Stop Pilot before returning to an older format. Disable audit rules or explicitly change them to default enforce and remove unsupported fields; merely stripping an audit key would turn it into an enforcing rule. For clients without namespace support, move script bodies to the root scripts directory and remove `scriptCache`, or clear the local rule and script files before starting the older client.
