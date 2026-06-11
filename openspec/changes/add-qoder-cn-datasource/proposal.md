## Why

QoderCN is a new standalone desktop IDE (国内版 Qoder) with its own CLI agent component (`qodercncli`). It shares the same data architecture as Qoder but stores data in separate directories. To achieve observability coverage for QoderCN users, we need dedicated input sources that read from QoderCN's paths.

Investigation confirms:
- SQLite schema (`chat_message` table in `local.db`) is **identical** to Qoder
- IDE data (`User/History/`, `ai_tracker/`) follows the same structure
- CLI hook mechanism (transcript JSONL + Stop event) is **identical** — just a different config path (`~/.qoder-cn/settings.json`)
- QoderWork CN (`~/.qoderworkcn/`) has already been partially deployed on a separate branch

## What Changes

Add QoderCN as a first-class data source with three collection channels:

1. **SQLite polling** — token usage from `~/Library/Application Support/QoderCN/SharedClientCache/cache/db/local.db`
2. **IDE snapshot** — file edit history and ai_tracker from QoderCN's data root
3. **Hook JSONL** — transcript forwarding via Stop hook in `~/.qoder-cn/settings.json`

All three reuse existing base classes with only path/identity changes.

## Capabilities

### New Capabilities
- `qoder-cn-datasource`: QoderCN IDE + CLI agent data collection (SQLite + IDE snapshot + hook)

### Modified Capabilities
- None (additive only — new inputs registered alongside existing ones)

## Impact

- **Low risk**: Pure additive change, no modifications to existing inputs or normalization logic
- **Detection**: `~/.qoder-cn` directory existence (created when QoderCN is launched)
- **Deploy**: Hook injection into `~/.qoder-cn/settings.json` (same nested format as Qoder)

## Affected Baseline Modules

- `src/types/client-type.ts` — new `ClientType.QoderCn` enum value
- `src/inputs/` — new `qoder-cn-sqlite/` and `qoder-cn/` input directories
- `src/core/orchestrator.ts` — register new inputs
- `agents.d/` — new `qoder-cn.json` agent definition
- `assets/hooks/` — new `qodercn-loongsuite-pilot-hook.sh`
- `assets/hooks/hook-processor.mjs` → `normalizeTranscriptRecord()` — add `'qoder-cn'` branch

## Baseline Documentation Updates

- `docs/modules/inputs.md` — add QoderCN to the list of supported data sources
- No changes to pipeline architecture or module boundaries
