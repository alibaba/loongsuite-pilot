## Why

Today, an SLS-configured installation can only write to **one** SLS destination: either the user-provided one (when `--sls-*` flags are passed) **or** the built-in `loongsuite_pilot_for_ai_coding` logstore. Internal teams that adopt loongsuite-pilot need a way to ship telemetry to **both** their own SLS project (for team analytics) **and** the built-in destination (for ecosystem-wide observability) at the same time. Forcing them to choose loses one of the two views.

## What Changes

- Extend the existing `sls.destinationOverride` boolean in `config.json` with a new semantics for `false`: instead of being treated as "no override" (which today silently falls back to internal-only), `destinationOverride: false` together with user-provided `sls.*` fields enables **dual-write** to both the user destination and the built-in destination.
- Move per-destination concerns (`endpoint` URL, `mode`, AK credentials, `redact`) **into each `SlsEndpoint`** so two destinations can live in different SLS regions and use different access methods (one webtracking, one AK).
- Add a new installer flag `--default-sls-override=true|false` (default `true`) on `loongsuite-pilot-installer.sh` and `loongsuite-pilot-installer-inner.sh`. The flag is only written into `config.json` when at least one `--sls-*` flag is also supplied.
- The built-in destination (`INTERNAL_SLS_DESTINATION`) is **never** materialized in `config.json`. It is appended in memory by `buildSlsConfig` only when (a) user `sls.*` fields are present **and** (b) `destinationOverride === false`.
- Switch failed-log persistence to key files by `endpoint.name` instead of `endpoint.kind`, so two endpoints serving the same `kind: 'agentActivity'` no longer collide on the same `.jsonl` file.

## Capabilities

### New Capabilities
- `sls-dual-write`: Resolution rules that turn `config.json` SLS settings into the runtime `endpoints[]` array, plus the per-`SlsEndpoint` self-contained shape (URL, mode, credentials, redaction).
- `sls-installer-flags`: Installer flag surface for `--default-sls-override` and how it is materialized into `config.json`.

### Modified Capabilities
<!-- None — `openspec/specs/` is currently empty. -->

## Impact

- **Code**:
  - `src/types/index.ts` — `SlsEndpoint` gains `endpoint`, `mode`, `accessKeyId`, `accessKeySecret` fields (already has `redact`, `kind`, `name`). `SlsFlusherConfig` keeps top-level fields for back-compat-free defaulting during config build but the flusher reads them off each endpoint.
  - `src/core/config-loader.ts` — `buildSlsConfig` resolution rules updated to encode the three-case matrix.
  - `src/internal/sls-destination.ts` — adds an `endpoint.name` constant for the internal leg (e.g., `internal-default`).
  - `src/flushers/sls-flusher.ts` — webtracking URL builder uses `endpoint.endpoint`; AK client is constructed per endpoint at send time (or cached by name); `persistFailedLogs` keys by `endpoint.name`.
  - `deploy/loongsuite-pilot-installer.sh` and `deploy/loongsuite-pilot-installer-inner.sh` — new `--default-sls-override` arg parsing and `write_config` branch.
- **Affected Baseline Modules**:
  - `specs/baseline/modules/flushers.md` — SLS multi-endpoint dispatch and per-endpoint mode.
  - `specs/baseline/modules/core.md` — `config-loader` resolution rules for SLS.
  - `specs/baseline/modules/types.md` — `SlsEndpoint` shape.
- **APIs / Schemas**: `config.json` `sls.destinationOverride: false` gains a new meaning. The change is **additive for the installer-written shape** (today the installer only ever writes `true`), but technically reinterprets a value a hand-edited file might have had. Documented in design.md.
- **Dependencies**: none added.
