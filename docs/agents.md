# Agent Configuration

English | [简体中文](zh-CN/agents.md)

Use this guide to choose which AI coding agents Pilot should collect from and whether sensitive message content should be captured.

## Supported Agent IDs

These IDs identify the supported integrations. Most can be used in installer
options, `agent-control.json`, and `config.json`; shared integrations and output
type differences are called out in the notes.

| Agent | ID | Notes |
|-------|----|-------|
| Claude Code | `claude-code` | Hook integration. |
| Codex | `codex` | Hook integration. |
| Cursor | `cursor` | Hook integration. |
| Cursor CLI | `cursor-cli` | Detected and emitted as `cursor-cli`, but reuses Cursor's installed Hook/input pipeline rather than deploying an independent Hook. Use `cursor-cli` for an output-specific content policy. |
| DeepSeek Harness | `dsh` | User-level YAML patch plugin plus local per-session JSONL polling. Captures native LLM, reasoning, tool, token, and TTFT data. |
| Grok Build | `grok-build` | Four fail-open hooks plus local session-log fusion; captures LLM, token, tool, cancellation, and failure lifecycle data. |
| Hermes Agent | `hermes-agent` | Native directory plugin and local session-file collection. Output records use `gen_ai.agent.type=hermes`. |
| Kiro CLI | `kiro-cli` | Hook integration with delayed local SQLite/session collection. Token usage is not exposed by the source. |
| MiMo Code | `mimo-code` | Plugin injection; captures LLM, tool, and token lifecycle events. |
| OpenClaw | `openclaw` | Plugin injection for OpenClaw 2026.3.8 or later. Automatic legacy/modern adaptation; model-call timing is inferred before 2026.5.12. |
| OpenCode | `opencode` | Plugin injection. |
| Pi Coding Agent | `pi-coding-agent` | Pi Extension injection; captures LLM and tool lifecycle events. |
| Qoder | `qoder` | Hook integration. |
| Qoder CN | `qoder-cn` | Hook integration. |
| Qoder for JetBrains | `qoder-jetbrains` | Detection-only deploy ID. Agent gating uses `qoder` in `agent-control.json`; content policy uses `qoder-idea` in `config.json`. |
| Qoder CLI | `qoder` | Shares the Qoder agent definition and uses hook/session sources. |
| Qoder Work | `qoder-work` | Hook and local data sources. |
| Qoder Work CN | `qoder-work-cn` | Hook and local data sources. |
| Qwen Code CLI | `qwen-code-cli` | Hook integration; parses qwen-code transcript JSONL on Stop. |
| Qwen Work CN | `qwen-work-cn` | Hook and local data sources. |
| Wukong | `wukong` | Runtime auto-discovery and CLI API polling via local `wukong-cli`; it is not an `agents.d` installer selection. |
| WorkBuddy | `workbuddy` | Structural Hook/file wakeups with a 30-second local transcript polling fallback. Verified on WorkBuddy Desktop 5.2.6 for macOS and 5.3.5.0 for Windows 11. |

The Windows verification used an installed Pilot package, resolved Node from the
installer-pinned `node-bin` with Node absent from `PATH`, and passed strict JSONL
validation against a real WorkBuddy transcript.

Codex collection is transcript-backed. Pilot uses the lightweight
`SessionStart` and `UserPromptSubmit` hooks to discover the effective
`CODEX_HOME`, including task-scoped homes created by orchestrators, and tails
recent rollout files from that session root. `Stop` is retained as a
best-effort wakeup and is not required for directory discovery.

## Grok Build Collection And Lifecycle

Pilot detects Grok Build from `~/.grok` and installs four fail-open hooks in
`~/.grok/hooks/loongsuite-pilot.json`: `stop`, `stop_failure`,
`user_prompt_submit`, and `session_end`. Subagent hooks are intentionally not
installed or collected.

Each completed turn is reconstructed from three Grok-owned JSONL sources:

- Session `chat_history.jsonl` provides messages, model metadata, tool
  arguments, tool results, and the system instruction.
- Session `updates.jsonl` provides the real prompt ID, turn terminal state,
  cancellation or failure, and tool status.
- `~/.grok/logs/unified.jsonl` provides model timing and token usage plus tool
  execution timing and success.

Collection starts with the turn observed after installation and does not replay
older session history. Because Grok persists cancellation asynchronously, a
cancelled turn can be emitted on the next `user_prompt_submit` or
`session_end`. Setting `agents["grok-build"].captureMessageContent` to `false`
removes user, assistant, and system content as well as tool arguments, tool
results, and raw error details.

The installed assets include POSIX and PowerShell launchers. The Grok-specific
watchdog check repairs missing or changed Pilot Hook assets and configuration;
uninstall removes only the Pilot-owned Grok Hook entries and preserves third-
party hooks.

## DeepSeek Harness Collection And Lifecycle

Pilot resolves one exact Harness home for both detection and deployment. It
keeps a previously deployed patch path for repair and cleanup, then checks an
explicit local-definition `patchPath`, the Pilot service's `DSH_HOME`, and — on
Linux — the `DSH_HOME` of a unique same-user running DSH process. Standard
`~/.dsh` and `dsh` command detection remain the fallback. Pilot does not scan
temporary directories or assume a fixed non-default home; multiple distinct
running homes found during initial discovery are reported as ambiguous instead
of selecting one silently.

When `dsh` is enabled, Pilot appends one marked, Pilot-owned block to the
resolved `<DSH_HOME>/cordis.patch.yml`. That block loads the packaged plugin
from `$PILOT_DATA/plugins/dsh/plugin.mjs`; bytes outside the marked block are
preserved. Start a new DSH process after first enabling or reinstalling the
integration so the host loads the current patch.

The plugin writes append-only native events to
`$PILOT_DATA/logs/dsh/dsh-<session-id>.jsonl`. On POSIX systems, the directory
is mode `0700` and files are mode `0600`. These source files contain the native
message and tool data needed for normalization, so treat them as sensitive;
credential-shaped keys are filtered before writing. `captureMessageContent`
controls normalized output and does not remove content from these source logs.
Pilot derives LLM TTFT from the native request boundary to the first reasoning,
text, or tool-call stream delta and reports it in nanoseconds as
`gen_ai.response.time_to_first_token`.

The normal `agent-control.json` and `config.json` gates use the ID `dsh`.
Disabling collection removes an enable marker first, so an already-loaded
plugin stops writing, then removes only Pilot's marked YAML block. The runtime
watchdog repairs the block while DSH remains enabled. Uninstall performs the
same owned-block cleanup before removing plugin assets and preserves unrelated
YAML content. If the source lacks a request boundary or an output delta, Pilot
omits TTFT instead of fabricating zero.

## OpenClaw Compatibility And Lifecycle

Pilot supports OpenClaw releases `>=2026.3.8`. Before writing host configuration,
Pilot reads the selected installation's `package.json` using in-process filesystem
operations. No version argument is needed, and version discovery starts no CLI,
shell, or package-manager subprocess. It supports executable symlinks (npm/pnpm),
npm and pnpm global wrappers, enterprise bundle layouts, `OPENCLAW_CLI_PATH`, and
source containers whose working directory is the OpenClaw package root. Runtime
version labels (`OPENCLAW_SERVICE_VERSION`, `OPENCLAW_BUNDLED_VERSION`, and
`OPENCLAW_VERSION`) alone never authorize installation or schema capabilities.
Unknown/unsupported versions leave configuration untouched and remain retryable.
Shared installations must be visible through these paths or runtime metadata.
Conflicting PATH and source-package installations are rejected. If the Gateway
starts from a different absolute path, its container launcher must expose that
same entry as `OPENCLAW_CLI_PATH` (an installation path, not a version override).
Pilot cannot infer an otherwise invisible Gateway executable from its own PATH.

| Host version | Adapter | `hooks.allowConversationAccess` |
| --- | --- | --- |
| 2026.3.8–2026.4.23 | Legacy | Omitted; stale Pilot-owned key removed |
| 2026.4.24–2026.5.11 | Legacy | Enabled |
| 2026.5.12+ | Modern | Enabled |

Pilot checks metadata again during deployment/repair so upgrades and downgrades
select the appropriate configuration. The plugin independently selects its
adapter from `api.runtime.version`. When that field is missing/empty/`unknown`
(including the official 2026.3.8 npm bundle), it follows the executing Node
entry's real path to the nearest OpenClaw `package.json`, with bounded depth
and reads. This runtime fallback never searches PATH/cwd, executes a CLI, or
uses a user-supplied version; explicit unsupported versions remain rejected.
Config paths honor `OPENCLAW_CONFIG_PATH`
and `OPENCLAW_STATE_DIR`. For hosts supporting conversation access, the entry is:

```json
{
  "plugins": {
    "entries": {
      "loongsuite-pilot-openclaw": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

The legacy adapter uses `llm_input`, assistant `before_message_write`, tool hooks,
and `llm_output` to preserve observed output, tool IDs and per-call token usage.
Run aggregate usage is diagnostic-only, never added to model usage. LLM start
times are inferred from the input or last persisted tool-result boundary and
marked `agent.openclaw.timing.inferred=true` with `agent.openclaw.timing.source`.
These intervals include orchestration overhead and are not precise provider
latency. TTFT, transport metrics, and retries absent from persistence are omitted.
Failed legacy runs close at `agent_end` even when `llm_output` never arrives.
Sub-millisecond inferred intervals are quantized to the converter's 1ms resolution
and marked `agent.openclaw.timing.quantized_ms=1`; the same logical clock keeps
subsequent tool/parent boundaries ordered. Observation time is retained separately.
Completed run state is evicted before active state. Capacity eviction, session end,
ambiguous failure and orphan expiry (30 minutes of inactivity, checked on new
input) seal collection with `legacy_cleanup`, `gen_ai.turn.end=true`, and
`agent.openclaw.collection.incomplete=true`, never a guessed native success/error.
Structural deduplication has a 64Ki-character/1024-node budget. Oversized messages
use bounded native response ID/timestamp identity when available; otherwise they
are still collected without deduplication, never using truncated content hashes.
If a fallback reuses the native run ID after that attempt is closed, it starts
a separate turn/trace and retains the original ID in `agent.openclaw.run_id`.
Missing messages or tokens are not fabricated; for overlapping runs on the same
session, ambiguous session-only persistence is omitted and the aggregate carries
`agent.openclaw.correlation.ambiguous=true` until all colliding runs end.

Known 2026.3.8 limits: persistence-hook correlation requires a native
`sessionKey` (for example, a Gateway session or `agent --local --agent main`).
A new standalone `--session-id` without an agent/session-store binding lacks
that key; Pilot retains run-level events but does not guess per-call ownership.
Also, 3.8 disables the streaming `include_usage` request option for non-OpenAI-native
Chat Completions endpoints. DashScope on that path can produce native zero-token
records; Pilot cannot reconstruct actual usage from them. This is provider-dependent:
real Gateway calls to DeepSeek have returned positive native usage, verified against
each collected model call, including cache tokens.

Native sender extraction is not supported on 2026.3.8: its legacy hooks do not supply
the modern sender identity. Pilot retains configured/environment identity; it does
not infer a sender from message content or session names. `AGENTTEAMS_WORKER_NAME`
remains supported; set it before starting the Gateway and restart the Gateway after
changing it. Worker identity is independent of sender identity.

Pilot creates a private backup
before migrating a legacy plugin-array configuration. Upgrade also replaces
the previous Pilot single-file load path with the package directory. Uninstall
removes both forms plus Pilot's entry; unrelated plugins and their settings are
preserved.

The injected plugin writes append-only source events below
`~/.loongsuite-pilot/logs/openclaw/`. The directory is mode `0700` and files are
mode `0600` on POSIX systems. Provider errors or cancelled calls can legitimately
have no output message or token usage; Pilot reports the native finish reason
and available timing without inventing content or zero token counts. Content-off
also removes error messages because provider/tool errors can contain user content.

The [real-provider Gateway acceptance harness](../scripts/e2e/openclaw-compat.md)
runs only in a disposable Linux container and uses the actual Pilot installer and
collector. It checks native token parity, trace topology, worker identity, restart
deduplication, content-off, watchdog repair, reinstall and uninstall. The exact
OpenClaw version is a test assertion, not an input to Pilot version detection.
Local acceptance does not replace independent SLS/ARMS readback or customer EDR testing.

## Choose Agents During Installation

Use `--agents` to skip the interactive selection step:

```bash
bash /tmp/loongsuite-pilot-installer.sh install --agents "claude-code,codex,cursor,dsh"
```

The installer still checks whether each selected agent exists on the machine before deploying collection capabilities.

## Enable Or Disable Agents After Installation

Use `~/.loongsuite-pilot/agent-control.json` for simple admission control:

```json
{
  "version": 3,
  "tools": {
    "claude-code": "on",
    "cursor": "auto",
    "dsh": "on",
    "qoder": "off"
  }
}
```

| Mode | Meaning |
|------|---------|
| `on` | Force-enable the agent when its data source exists. |
| `off` | Disable the agent. |
| `auto` | Use default auto-detection behavior. |

Restart Pilot after changing this file:

```bash
loongsuite-pilot restart
```

## Configure Content Capture Per Agent

Use `config.json` when you need to control message content capture:

```json
{
  "agents": {
    "claude-code": { "enabled": true, "captureMessageContent": false },
    "codex": { "enabled": true, "captureMessageContent": false },
    "dsh": { "enabled": true, "captureMessageContent": false },
    "openclaw": { "enabled": true, "captureMessageContent": false },
    "cursor": { "enabled": true, "captureMessageContent": true }
  }
}
```

| Setting | Description |
|---------|-------------|
| `enabled` | Set to `false` to disable the agent from config. |
| `captureMessageContent` | Set to `false` to avoid collecting full prompts, completions, tool arguments, and tool results where the integration supports that policy. |
| `multimodal.uploadMode` | **Experimental.** Multimodal upload policy. `none` (default) disables; `input` / `tool` / `output` / `both` select conversion surfaces. See [Multimodal Collection](multimodal.md). |
| `multimodal.allowedRootPaths` | Extra local roots merged with agent defaults for `pathToUri`. `~` is expanded. Workspace images need the project directory listed here. See [Multimodal Collection](multimodal.md#allowedrootpaths). |

For sensitive environments, pair `captureMessageContent: false` with [Data Masking](masking.md). To collect multimodal data, see [Multimodal Collection](multimodal.md) (images only; `codex` and Qoder IDE/CLI).

## Verify Agent Collection

```bash
loongsuite-pilot status
ls ~/.loongsuite-pilot/logs/output
tail -f ~/.loongsuite-pilot/logs/output/*.jsonl
```

If an expected agent is not collecting:

- Confirm the agent is installed and has been used at least once.
- Confirm the agent ID is not set to `off` in `agent-control.json`.
- Confirm `config.json` does not set the agent to `"enabled": false`.
- Restart Pilot after configuration changes.
