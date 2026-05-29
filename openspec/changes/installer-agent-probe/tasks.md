## Tasks

### Task 1: Add `src/cli-probe.ts` entry point

**File**: `src/cli-probe.ts` (new)

Create a standalone CLI entry that:
- Instantiates `AgentDefLoader` with `builtinDir` pointing to `../agents.d` relative to the script
- Loads all agent definitions
- Runs `detectAgent(def.detection)` for each definition
- Outputs JSON to stdout: `[{id, displayName, detected, reason}]`
- `reason`: the path or command that matched (for display in the menu)
- Exits 0 on success regardless of detection results
- Does NOT depend on config.json

Reference files:
- `src/deployment/agent-def-loader.ts` (AgentDefLoader)
- `src/deployment/detect-utils.ts` (detectAgent)

---

### Task 2: Add cli-probe to build system

**File**: `build.mjs`

- Add `src/cli-probe.ts` as a second entry point
- Ensure `dist/cli-probe.js` is produced and included in the package tarball
- Verify the probe script is callable: `node dist/cli-probe.js`

---

### Task 3: Extend ConfigFile and AnalyticsConfig types

**Files**:
- `src/types/index.ts`
- `src/core/config-loader.ts`

Add to `ConfigFile` interface:
```typescript
collectLog?: boolean;
collectTrace?: boolean;
serviceNamePrefix?: string;
cms?: { licenseKey?: string; endpoint?: string; workspace?: string };
agents?: Record<string, { enabled?: boolean; captureMessageContent?: boolean | string }>;
```

Add to `AnalyticsConfig`:
```typescript
collectLog: boolean;
collectTrace: boolean;
serviceNamePrefix: string;
cms: { enabled: boolean; licenseKey: string; endpoint: string; workspace: string };
```

Update `loadConfig()` to parse and populate these new fields with sensible defaults:
- `collectLog`: default `true`
- `collectTrace`: default `true`
- `serviceNamePrefix`: default `''`
- `cms.enabled`: default `false` (true only if licenseKey is present)

---

### Task 4: Implement agent-enabled gate in deployment/discovery

**Files**:
- `src/core/agent-discovery-service.ts` OR `src/deployment/deployment-manager.ts`
- `src/core/orchestrator.ts` (if wiring changes needed)

Implement the gate logic:
- If `__INTERNAL_BUILD__` is true → skip gate, auto-detect as before
- If `config.agents` is undefined or empty → skip gate, auto-detect (backward compat)
- Otherwise → only start/deploy agents where `config.agents[id].enabled === true`

Ensure `AgentDiscoveryService.processEntry()` checks this gate before starting an agent.

---

### Task 5: Add new parameters to non-inner installer script

**File**: `deploy/installer.sh`

Add parameter parsing for:
- `--collect-log` (value: true/false)
- `--collect-trace` (value: true/false)
- `--cms-license-key`
- `--cms-endpoint`
- `--cms-workspace`
- `--service-name-prefix`
- `--agents` (comma-separated agent IDs for non-interactive mode)

Add variables at the top alongside existing ones.

---

### Task 6: Add probe_agents() function to non-inner installer

**File**: `deploy/installer.sh`

Implement `probe_agents()`:
- Call `$NODE_BIN "$INSTALL_SRC/dist/cli-probe.js" --json`
- Capture output into `PROBE_RESULT`
- Handle failure gracefully (fallback to empty list)

Insert call in `cmd_install()` after `download_and_extract` and before `deploy_package`.

---

### Task 7: Add select_agents() interactive menu to non-inner installer

**File**: `deploy/installer.sh`

Implement `select_agents()`:
- If `--agents` was provided, use it directly and skip interaction
- Parse `PROBE_RESULT` JSON (via `$NODE_BIN -e "..."`)
- Display numbered list with detected/not-detected status
- Default: all detected agents are selected
- User can toggle by entering numbers (space-separated)
- Confirm with Enter
- Set `SELECTED_AGENTS` as comma-separated string

Handle non-tty stdin: if stdin is not a terminal, auto-select all detected agents.

---

### Task 8: Extend write_config() with new parameters

**File**: `deploy/installer.sh`

Extend the inline Node.js script in `write_config()` to persist:
- `config.collectLog` (from `--collect-log`)
- `config.collectTrace` (from `--collect-trace`)
- `config.cms` object (from `--cms-*` params)
- `config.serviceNamePrefix` (from `--service-name-prefix`)
- `config.agents` map with `enabled` field (from `SELECTED_AGENTS` + `PROBE_RESULT`)

---

### Task 9: Unit tests for cli-probe and config-loader changes

**Files**:
- `tests/unit/cli-probe.test.ts` (new)
- `tests/unit/core/config-loader.test.ts` (extend)

Tests for cli-probe:
- Mocked agents.d directory with test JSON files
- Verify JSON output format
- Verify detected/not-detected agents

Tests for config-loader:
- Config with `collectLog`, `collectTrace`, `cms`, `serviceNamePrefix`
- Config with `agents` field → verify gate behavior
- Config without `agents` field → verify backward compat

---

### Task 10: Verify implementation conforms to baseline constraints

Manual verification:
- Config priority (env > file > defaults) is maintained for new fields
- `__INTERNAL_BUILD__` flag correctly gates agent selection behavior
- Inner installer script is NOT modified
- Data pipeline (Input → Normalization → Flusher) is not affected

---

### Task 11: Update baseline documentation

**Files**:
- `docs/modules/core.md`: Add ConfigLoader new fields, describe AgentDiscovery behavior split
- `docs/modules/types.md`: Document new type fields

> Requires human confirmation before proceeding.
