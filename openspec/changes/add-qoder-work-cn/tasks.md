## Tasks

All tasks completed.

### Task 1: Add ClientType.QoderWorkCN [x]
- File: `src/types/client-type.ts`
- Add `QoderWorkCN = 'qoder-work-cn'` in IDE tools section (after QoderWork)

### Task 2: Create agent descriptor
- File: `agents.d/qoder-work-cn.json`
- Model after `agents.d/qoder-work.json` with CN-specific paths
- detection.paths: `["~/.qoderworkcn"]`
- hook.settingsPath: `"~/.qoderworkcn/settings.json"`
- hook.hookCommand: `"$PILOT_DATA/hooks/qoderworkcn-loongsuite-pilot-hook.sh"`
- hook.replaceHookCommands: `["$PILOT_DATA/hooks/qoder-loongsuite-pilot-hook.sh qoder-work-cn"]`

### Task 3: Parameterize QoderWorkInput (Hook JSONL)
- File: `src/inputs/qoder-work/qoder-work-input.ts`
- Add `agentType` and `detectionPath` to constructor options with defaults
- Make `id` dynamic: `${this.agentType}-hook`
- Replace hardcoded `ClientType.QoderWork` with `this.agentType` in transformRecord
- Make `checkAvailability()` and `getWatchPaths()` use detectionPath parameter
- Ensure existing callers unchanged (backward-compatible defaults)

### Task 4: Parameterize QoderWorkLogInput (SDK Log)
- File: `src/inputs/qoder-work-log/qoder-work-log-input.ts`
- Add `agentType` to constructor options with default `ClientType.QoderWork`
- Make `id` dynamic: `${this.agentType}-log`
- Replace hardcoded `ClientType.QoderWork` with `this.agentType` in handleEvent/finalizeTurn
- Parameterize `resolveQoderWorkRoot()` to support CN variant path (`QoderWork CN` dir name)
- Make `getWatchPaths()` and `checkAvailability()` configurable or add factory

### Task 5: Parameterize QoderWorkSqliteInput (SQLite)
- File: `src/inputs/qoder-work-sqlite/qoder-work-sqlite-input.ts`
- Add `agentType` to constructor options with default `ClientType.QoderWork`
- Make `id` dynamic: `${this.agentType}-sqlite`
- Replace hardcoded `ClientType.QoderWork` with `this.agentType` in transformRow
- Parameterize `resolveQoderWorkRoot()` (same change as Task 4, share the helper)

### Task 6: Create hook script
- File: `assets/hooks/qoderworkcn-loongsuite-pilot-hook.sh`
- Copy from `qoderwork-loongsuite-pilot-hook.sh`
- Change default AGENT_ID to `qoder-work-cn`
- Ensure it delegates to same `hook-processor.mjs`

### Task 7: Register CN inputs in orchestrator/config-loader
- Files: `src/core/orchestrator.ts`, `src/core/config-loader.ts`
- When `~/.qoderworkcn` detected, instantiate three CN inputs:
  - QoderWorkInput with agentType=QoderWorkCN, logDir for CN
  - QoderWorkLogInput with agentType=QoderWorkCN, dataRoot for CN
  - QoderWorkSqliteInput with agentType=QoderWorkCN, dataRoot for CN
- Register hook definition for CN (settingsPath: `~/.qoderworkcn/settings.json`)

### Task 8: Update agent-system-map
- File: `src/normalization/agent-system-map.ts`
- Add `qoder-work-cn` entry with same model/provider mappings as `qoder-work`

### Task 9: Unit tests
- Add/update tests for parameterized input classes with CN variant
- Test files:
  - `tests/unit/inputs/qoder-work-input.test.ts` — verify CN agentType flows through
  - `tests/unit/inputs/qoder-work-log-input.test.ts` — verify CN variant ID and path resolution
  - `tests/unit/inputs/qoder-work-sqlite-input.test.ts` — verify CN variant ID and agentType in entries
  - `tests/unit/normalization/agent-system-map.test.ts` — verify CN mapping exists

### Task 10: Verify implementation conforms to baseline constraints
- Run `npm test` to verify all existing tests still pass
- Verify QoderWork (international) inputs still work with default parameters
- Check that no baseline architecture constraint is violated

### Task 11: Update baseline documentation
- `docs/modules/inputs.md`: Note parameterized QoderWork input support for CN variant
- `docs/modules/hooks.md`: Add `qoder-work-cn/history/` to runtime layout
- Requires human confirmation before merging
