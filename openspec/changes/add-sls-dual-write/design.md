## Context

The SLS flusher today resolves a single SLS destination via `buildSlsConfig` in [`src/core/config-loader.ts`](file:///Users/lukechen/dev/loongsuite-pilot/src/core/config-loader.ts), producing a `SlsFlusherConfig` with a single shared `endpoint` URL/`mode`/AK pair plus an `endpoints[]` array of length 1. The flusher already iterates `endpoints[]`, so the structural fan-out path exists; it is the resolution layer and the per-endpoint shape that block multi-destination usage.

Two installers (`loongsuite-pilot-installer.sh`, `loongsuite-pilot-installer-inner.sh`) live at `deploy/`. After diffing, they only differ in cosmetic places (an arch-mismatch warning and a status-check refactor) and are uploaded side-by-side to the same OSS prefix by [`deploy/upload.sh`](file:///Users/lukechen/dev/loongsuite-pilot/deploy/upload.sh). Today the `-inner` suffix carries no behavioral signal.

External teams are now adopting loongsuite-pilot. They want to ship telemetry to their own SLS project for team-level analytics while internal teams still want the built-in `loongsuite_pilot_for_ai_coding` to receive a copy for ecosystem-wide observability. A single destination cannot serve both readers.

## Goals / Non-Goals

**Goals:**
- Support three deployment modes selected at install time:
  1. No `--sls-*` args → built-in destination only.
  2. `--sls-*` args → user destination only (current default).
  3. `--sls-*` args + `--default-sls-override=false` → dual-write (user + built-in).
- Make `SlsEndpoint` a self-contained destination so two endpoints can have different SLS regions and access methods.
- Keep the built-in destination (`INTERNAL_SLS_DESTINATION`) **invisible in `config.json`** — it is appended in memory only.
- Keep the existing `sls.destinationOverride` field name; extend its `false` semantics rather than introducing a new field.

**Non-Goals:**
- No N-way fan-out beyond two destinations. The runtime structure already supports more, but the config schema only exposes one user destination plus the optional internal mirror.
- No changes to redaction policy or `captureMessageContent` semantics. Both endpoints start with `redact: false` (matching today's default).
- No rename of the two installer scripts. The cosmetic divergence is left as-is; both scripts gain the new flag identically.
- No HTTP/JSONL flusher changes.

## Decisions

### D1. Reuse `destinationOverride`, extend `false` semantics

The existing field already reads naturally under both values. The change in meaning is:

| `sls.*` user fields | `destinationOverride` | Today | After |
|---|---|---|---|
| absent | (irrelevant) | INTERNAL only | INTERNAL only (unchanged) |
| present | `true` (or absent → defaulted true) | USER only | USER only (unchanged) |
| present | `false` | INTERNAL only (sls.* ignored) | USER + INTERNAL (dual-write) |

**Default when omitted**: `true` (when the `sls` block has user destination fields). This matches the installer's existing behavior of always writing `destinationOverride: true` together with `--sls-*` flags.

**Alternatives considered:**
- *Add a new `defaultSLSOverride` field*: rejected — two fields with overlapping meanings invites confusion.
- *Append the internal destination silently whenever `destinationOverride` is absent*: rejected — explicit user opt-in via `false` keeps behavior predictable for hand-edited configs.

### D2. Per-endpoint encapsulation in `SlsEndpoint`

`SlsEndpoint` becomes self-describing:

```ts
interface SlsEndpoint {
  name: string;            // unique identifier; used for failed-log filename
  endpoint: string;        // base URL, e.g. "https://cn-shanghai.log.aliyuncs.com"
  project: string;
  logstore: string;
  kind: 'agentActivity' | 'mcp' | 'trace';
  mode: 'webtracking' | 'ak';
  accessKeyId?: string;    // required iff mode === 'ak'
  accessKeySecret?: string;
  redact?: boolean;
}
```

The flusher reads `mode`/`endpoint`/credentials off each `SlsEndpoint`. `SlsFlusherConfig` keeps top-level fields as **defaults** during config build (so env vars and legacy single-destination configs still work), but at runtime the per-endpoint values are authoritative.

**Alternatives considered:**
- *Keep mode/credentials at top level, scope only URL per endpoint*: rejected — inner teams may legitimately use AK for their own SLS and webtracking for the internal mirror. Without per-endpoint mode, that combination is impossible.

### D3. Internal destination is never persisted in `config.json`

`INTERNAL_SLS_DESTINATION` lives in `src/internal/sls-destination.ts`. `buildSlsConfig` decides at runtime whether to append it. Reasons:
- The internal destination is an implementation detail of the packaged runtime; surfacing it in user config invites accidental edits.
- Release packaging already plans to obfuscate `src/internal/sls-destination.ts`. Keeping it out of disk state preserves that flexibility.

Internal endpoint name: `internal-sls` (constant exported from `src/internal/sls-destination.ts`). This feeds both runtime identification and the failed-log filename.

### D4. Installer flag: `--default-sls-override=true|false`

Spelling matches the JSON key 1:1 — no aliasing. Default `true`. The flag is only persisted in `config.json` when at least one `--sls-*` arg is also supplied. Standalone use (e.g. `--default-sls-override=false` without `--sls-project`) is a no-op and emits a friendly warning.

**Alternatives considered:**
- *Negated boolean `--no-default-sls-override`*: rejected — double-negative.
- *Intent-named alias `--dual-write`*: rejected — risks two ways to spell the same thing.

### D5. Failed-log filename keyed by `endpoint.name`

Today `persistFailedLogs` writes to `<failedLogDir>/<endpoint.kind>.jsonl`. With dual-write, both endpoints carry `kind: 'agentActivity'` and would collide. Keying by `endpoint.name` produces stable per-destination files (`user-sls.jsonl`, `internal-sls.jsonl`). The `kind` value remains in the JSON line payload for forensic use.

### D6. AK client lifecycle when modes differ across endpoints

The current `SlsFlusher` constructor builds a single `ALY` client when `config.mode === 'ak'`. With per-endpoint mode, we lazily build (and cache by `endpoint.name`) one `ALY` client per AK endpoint on first use. Webtracking endpoints stay clientless. Caching avoids reconstructing the client on every batch; the cache is invalidated only on flusher shutdown.

### D7. Resolution algorithm in `buildSlsConfig`

```
1. Read user-provided fields (env > config.sls.* > undefined).
2. hasUserDestination = (user project && user logstore present)
3. If !hasUserDestination → endpoints = [INTERNAL]
4. Else:
     userEndpoint = SlsEndpoint built from user fields,
                    name='user-sls'   // distinct from 'internal-sls'
     destinationOverride = (config.sls.destinationOverride !== false)   // default true
     If destinationOverride → endpoints = [userEndpoint]
     Else                   → endpoints = [userEndpoint, INTERNAL]
5. Each appended INTERNAL endpoint is fully populated from INTERNAL_SLS_DESTINATION;
   its name is 'internal-sls'.
6. Dedup pass: collapse entries that target the same
   (normalized endpoint URL, project, logstore) tuple, keeping the FIRST entry
   so that user-leg name/credentials/redact win when there is a collision.
```

Env var precedence (`SLS_ACCESS_KEY_ID`, `SLS_ENDPOINT`, etc.) is preserved for the user destination only; the internal leg is always pinned to its constants.

### D8. Dedup user destination against the internal destination

If a user-provided destination happens to equal the internal destination (same endpoint URL, project, logstore) — for example a hand-edited `config.json` that pasted the internal values verbatim — the resolver SHALL collapse them so only **one** copy is sent. This keeps the legacy single-write Case C bit-for-bit identical to today's behavior even when the user fields coincide with the internal constants, and it makes accidental double-write impossible in dual-write mode.

The dedup compares **normalized** `endpoint` URL (strip trailing slash, lowercase host, prepend `https://` if missing), `project`, and `logstore`. Mode and credentials are not part of the dedup key — if two entries differ only in mode or AK creds, the first wins.

**Alternatives considered:**
- *Reject the config with an error*: rejected — too aggressive for the most common case where the values match by coincidence.
- *Merge fields from both entries*: rejected — ambiguous when modes differ; first-wins is predictable.

## Risks / Trade-offs

- **[Risk] Case C — hand-edited config without `destinationOverride` and user fields equal to internal constants** — today the strict `=== true` check ignores user fields and falls back to internal-only (a single write to the internal logstore). After the change, default-true would treat the user fields as authoritative; if they coincide with the internal constants, the resolver's D8 dedup pass collapses them back to a single entry — bit-for-bit identical to today. → **Mitigation**: D8 dedup pass plus a unit test that pastes the internal constants into the user fields and asserts `endpoints.length === 1`.
- **[Risk] Case C — hand-edited config without `destinationOverride` and user fields differ from internal constants** — today such a config silently falls back to internal-only; after the change the user destination starts receiving data as the config visually implies. → **Mitigation**: this is a *fix*, not a regression; no data loss (the internal leg simply stops receiving and the user leg starts). Called out in release notes.
- **[Risk] Hand-edited configs with `destinationOverride: false`** — today such a config falls back to internal-only; after the change it would attempt dual-write if `sls.*` fields are present. → **Mitigation**: behavior is *additive* (the user destination starts receiving logs, internal still receives), so no data is lost. The user assumed not to have this combination today (no installer writes it).
- **[Risk] Failed-log filename changes from `agentActivity.jsonl` to `user-sls.jsonl`** — on upgrade, the user leg's failed-log file gains a new name. The old file becomes orphaned (no module reads or writes it). → **Mitigation**: accepted as-is. Failed-log files are operator-facing artifacts only; no other module depends on them. Log retention (`slsFailedDays` default 7) will age out the orphan. The benefit is two clearly distinct filenames in dual-write mode (`user-sls.jsonl` vs `internal-sls.jsonl`).
- **[Risk] Two endpoints, two regions, AK creds wrong on one leg** — webtracking leg succeeds, AK leg keeps failing. → **Mitigation**: failed-log persistence is per-endpoint (`endpoint.name`), so operators can diagnose without losing the other leg's data. The flusher's `Promise.allSettled`-like loop already isolates endpoint failures.
- **[Trade-off] More complex `SlsEndpoint` shape** — code paths that consume `SlsEndpoint` (currently only `SlsFlusher`) need to read mode/URL off the endpoint. Acceptable: the consumer surface is small.
- **[Risk] `ALY` client construction cost** — per-endpoint clients double resource use in dual-write mode. → **Mitigation**: only one AK client at most in practice (internal leg is webtracking); cache by name.
- **[Trade-off] Two installer scripts maintained in parallel** — they remain near-identical with the new flag. We accept this since the scripts are otherwise diverging cosmetically already and unifying them is out of scope.

## Migration Plan

1. **Code rolls out behind existing config**: deployments without `destinationOverride: false` keep current behavior bit-for-bit. No data path changes for them.
2. **Installer change is additive**: omitting `--default-sls-override` defaults to today's behavior.
3. **No data migration needed**: `~/.loongsuite-pilot/config.json` stays valid as-is.
4. **Rollback**: re-install the previous package via the installer's normal upgrade/rollback path. The new `destinationOverride: false` value is forward-compatible (older code reads it as "no override" → internal-only, which is at worst a temporary loss of dual-write while rolled back).

## Open Questions

- Should the failed-log retention policy (`slsFailedDays`) gain a per-destination view in the dashboard, or is the current single counter fine? *(Deferred — not blocking; can be added later.)*
- Should `--default-sls-override=false` without `--sls-*` be a hard error rather than a warning? *(Decided: warning, no-op — gentler for accidental flag combinations.)*
