## Technical Design

### Overall Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Docker Container (Ubuntu 22.04 + Node 22 + systemd)                     │
│                                                                         │
│  run-l1.mjs                                                             │
│  └─ expandFeaturesScenario()                                            │
│      ├─ Phase 1: agentDynamicDiscovery()                                │
│      ├─ Phase 2: autoUpgrade()        ──┐                               │
│      ├─ Phase 3: autoRollback()         ├─ uses MockServer              │
│      ├─ Phase 4: dualSend()           ──┘                               │
│      └─ Phase 5: maskingValidation()                                    │
│                                                                         │
│  lib/mock-server.mjs                                                    │
│  ├─ createManifestServer(port, manifest, tarGzPath)                     │
│  └─ createWebtrackingServer(port) → { received[], close() }            │
│                                                                         │
│  lib/expand-features.mjs                                                │
│  ├─ buildAgentDiscoveryScript(env)                                      │
│  ├─ buildAutoUpgradeScript(env)                                         │
│  ├─ buildAutoRollbackScript(env)                                        │
│  ├─ buildDualSendScript(env)                                            │
│  └─ buildMaskingValidationScript(env)                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Execution Model

与现有 install-smoke 不同，expand-features 使用**混合模式**：
- Phase 脚本仍通过 `runLocalScript()` 执行 shell（和 install-smoke 一致）
- 但 mock server 需要在 Node.js 主进程中运行（因为需要收集 HTTP 请求数据）
- 因此 Phase 2/3/4 的流程是：Node 主进程启动 mock server → shell 脚本操作 pilot → Node 关停 server 并 assert

```
Node process (run-l1.mjs)
  │
  ├── startMockServer()          ← http.createServer in-process
  ├── runLocalScript(phase_sh)   ← child bash: modify config, restart pilot, wait
  ├── assertions on mock data    ← Node checks received requests
  └── stopMockServer()
```

### Phase 1: Agent Dynamic Discovery

```bash
# 前置: pilot 已安装 (expand-features scenario 自行 install)
loongsuite-pilot stop

# 卸载 codex
npm uninstall -g @openai/codex
rm -f "$HOME/.local/bin/codex"

# 启动 pilot (discovery interval = 30s from docker-compose env)
loongsuite-pilot start

# 等 5s → 验证 codex NOT detected
sleep 5
grep -c '"deploy:codex".*agent detected' "$LOG" && exit 1 || true

# 重装 codex
npm install -g @openai/codex

# 等 discovery interval (≤35s)
sleep 35

# 验证 codex detected
grep '"deploy:codex".*agent detected' "$LOG" || exit 1
```

### Phase 2: Auto Upgrade (Mock Manifest)

**Mock Server** serves:
- `GET /manifest.json` → `{ version: "99.0.0", git_commit: "fake", package_url: "http://localhost:PORT/pkg.tar.gz" }`
- `GET /pkg.tar.gz` → 当前已安装版本的 tar.gz 包（复用 /opt/project/loongsuite-pilot.tar.gz）

**Shell Script**:
```bash
# 修改 config.json 注入 autoUpdate
node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('$HOME/.loongsuite-pilot/config.json'));
cfg.autoUpdate = {
  enabled: true,
  manifestUrl: 'http://127.0.0.1:$MOCK_PORT/manifest.json',
  checkIntervalMs: 10000
};
fs.writeFileSync('$HOME/.loongsuite-pilot/config.json', JSON.stringify(cfg, null, 2));
"

# Restart pilot (updater is a separate daemon, restart both)
loongsuite-pilot restart

# Wait for updater first check (60s initial + up to 10s interval)
sleep 75

# Assert new version deployed
CURRENT=$(cat "$HOME/.loongsuite-pilot/current")
[ "$CURRENT" = "99.0.0-fake" ] || exit 1
```

### Phase 3: Auto Rollback

**Strategy**: Use `installer.sh upgrade` command which has built-in rollback logic.

```bash
# 记录当前版本
OLD_CURRENT=$(cat "$HOME/.loongsuite-pilot/current")

# Mock server serves a broken package (tar.gz with dist/index.js = "process.exit(1)")
# installer.sh upgrade → deploys → tries start → fails → calls rollback

bash /opt/project/deploy/installer.sh upgrade \
  --package-url "http://127.0.0.1:$MOCK_PORT/broken-pkg.tar.gz"

# installer 退出非 0（升级失败已回退）是预期行为
# 验证 current 恢复
NEW_CURRENT=$(cat "$HOME/.loongsuite-pilot/current")
[ "$NEW_CURRENT" = "$OLD_CURRENT" ] || exit 1

# 验证 service 仍在 running
loongsuite-pilot status || exit 1
```

**Broken Package**: 运行时在 Node 进程中动态生成一个最小 tar.gz：
- `package.json` (version: "99.9.9")
- `VERSION` (version=99.9.9, git_commit=broken)
- `dist/index.js` → `process.exit(1)` (立即崩溃)
- `scripts/collector-daemon.js` → 正常 shim (供 bootstrap 用)

### Phase 4: Dual Send (Mock Webtracking Servers)

**两个 Mock Webtracking Server**:
- Server A (port X): 收集原始 POST body → `receivedA[]`
- Server B (port Y): 收集原始 POST body → `receivedB[]`

**Config Injection**:
```json
{
  "flushers": {
    "sls": {
      "enabled": true,
      "endpoints": [
        { "name": "e2e-raw", "endpoint": "http://127.0.0.1:PORT_A", "project": "e2e", "logstore": "raw", "kind": "agentActivity", "mode": "webtracking", "redact": false },
        { "name": "e2e-redacted", "endpoint": "http://127.0.0.1:PORT_B", "project": "e2e", "logstore": "redacted", "kind": "agentActivity", "mode": "webtracking", "redact": true }
      ]
    }
  }
}
```

**Shell**: restart pilot → trigger agent probe → wait flush (10s)

**Node Assertions**:
- `receivedA.length > 0` — raw endpoint received data
- `receivedB.length > 0` — redacted endpoint received data
- Parse body: endpoint B 的 entries 中 code-generation 相关字段应为空或已 redact

### Phase 5: Masking Validation

**Config Injection**:
```json
{
  "mask": { "mode": "all", "types": ["cloudAccessKey", "apiKey", "privateKey", "databaseUrl"] }
}
```

**Approach**: 在 agent probe 的 output 中注入包含已知 pattern 的文本，然后检查 JSONL 文件。

由于 mask 作用于 `AgentActivityEntry` 写入 JSONL 之前（在 `InputManager` → entry-builder → mask → flusher 链路中），我们只需：
1. 确保 probe 产出包含敏感 pattern 的 entry
2. 读 JSONL 验证 pattern 已被替换

**注入方式**: 利用 codex probe 的 `codex exec "包含 sk-fake1234567890abcdefghijkl 的文本"` — 这段文本会出现在 entry 的 message content 字段中。

**Shell Validation Script**:
```bash
# 读 JSONL, grep 确认原始 pattern 不存在
for f in "$HOME/.loongsuite-pilot/logs/output"/*.jsonl; do
  if grep -q "sk-fake1234567890abcdefghijkl" "$f"; then
    echo "FAIL: raw API key found in $f"
    exit 1
  fi
  if grep -q "LTAI1234567890abcdef" "$f"; then
    echo "FAIL: raw access key found in $f"
    exit 1
  fi
done

# 验证 mask 标记存在（证明 entry 确实经过了 masker）
grep -l "APIKEY_MASKED\|ACCESSKEY_MASKED" "$HOME/.loongsuite-pilot/logs/output"/*.jsonl || {
  echo "FAIL: no masked markers found (masking may not be active)"
  exit 1
}
```

### Mock Server Design (`lib/mock-server.mjs`)

```javascript
export function createMockServer(handlers) → { port, server, close() }
// handlers = Map<path, (req, res) => void>

export function createWebtrackingCollector(port) → { received[], port, close() }
// received = [{ body: string, headers, timestamp }]

export function createManifestServer(port, { manifest, packagePath }) → { close() }
// GET /manifest.json → manifest JSON
// GET /pkg.tar.gz → stream packagePath file
```

### Environment Variables (新增)

| Variable | Default | Description |
|----------|---------|-------------|
| `E2E_EXPAND_SKIP_PHASES` | `` | 逗号分隔，跳过指定 phase (e.g. "3,5") |
| `E2E_EXPAND_MOCK_PORT_BASE` | `19100` | Mock server 起始端口 |

### Error Handling

- 每个 phase 独立：某 phase 失败不影响后续 phase 执行（除非 `E2E_EXPAND_FAIL_FAST=1`）
- Mock server 启动失败 → 该 phase skip + warning
- 超时等待使用固定上限（120s），超时即 FAIL

### Dependency on install-smoke

`expand-features` scenario 自行执行 pilot 安装（调用 `localBuildInstallScript`），不要求先跑 install-smoke。这样可独立运行，也方便调试。
