## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│              NON-INNER INSTALL FLOW (NEW)                            │
└─────────────────────────────────────────────────────────────────────┘

  bash installer.sh install \
    --collect-log true --collect-trace true \
    --sls-project X --sls-logstore Y --sls-endpoint Z \
    --cms-license-key A --cms-endpoint B --cms-workspace C \
    --service-name-prefix D
                │
                ▼
  ┌──────────────────────────────┐
  │ 1. check_deps (node ≥ 18)   │
  │ 2. download_and_extract      │
  │ 3. ★ probe_agents()          │──▶ $NODE_BIN $INSTALL_SRC/dist/cli-probe.js
  │    (调用 Node 探测代码)       │       │
  │ 4. ★ select_agents()         │◀──────┘ JSON: [{id, name, detected}]
  │    (交互式菜单)               │
  │ 5. deploy_package            │
  │ 6. write_config()            │──▶ config.json (含全部新字段 + agents 选择)
  │ 7. start service             │
  └──────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│              INNER INSTALL FLOW (UNCHANGED)                          │
└─────────────────────────────────────────────────────────────────────┘

  curl ... | bash -s -- install --sls-* ...
                │
                ▼
  (现有流程不变，不调用 probe，不交互选择)
```

---

## 1. CLI Probe 入口 (`src/cli-probe.ts`)

新增独立 TypeScript 入口，构建为 `dist/cli-probe.js`。

**职责**：
- 读取 `agents.d/*.json`（通过 `AgentDefLoader`）
- 对每个 agent 执行 `detectAgent(def.detection)`
- 输出 JSON 到 stdout

**接口**：
```
$ node dist/cli-probe.js [--json]
[
  {"id": "claude-code", "displayName": "Claude Code", "detected": true, "reason": "~/.claude"},
  {"id": "codex", "displayName": "Codex", "detected": false, "reason": ""},
  {"id": "cursor-hook", "displayName": "Cursor", "detected": true, "reason": "~/.cursor"},
  {"id": "qoder-cli", "displayName": "Qoder CLI", "detected": false, "reason": ""},
  {"id": "qoder-work", "displayName": "QoderWork", "detected": false, "reason": ""}
]
```

**设计决策**：
- 复用已有的 `AgentDefLoader` 和 `detectAgent` 逻辑，避免 bash 中重复实现
- 进程退出码 0 表示成功（即使没有探测到任何 agent）
- 不依赖 config.json（安装时 config 尚未写入）
- `--json` 标志可选，默认即 JSON 输出

---

## 2. 安装脚本改动 (`deploy/loongsuite-pilot-installer.sh`)

### 2.1 新增参数解析

```bash
COLLECT_LOG=""
COLLECT_TRACE=""
CMS_LICENSE_KEY=""
CMS_ENDPOINT=""
CMS_WORKSPACE=""
SERVICE_NAME_PREFIX=""
SELECTED_AGENTS=""  # 非交互模式: --agents claude-code,cursor-hook
```

新增 case 分支：
```bash
--collect-log)        COLLECT_LOG="$2"; shift 2 ;;
--collect-trace)      COLLECT_TRACE="$2"; shift 2 ;;
--cms-license-key)    CMS_LICENSE_KEY="$2"; shift 2 ;;
--cms-endpoint)       CMS_ENDPOINT="$2"; shift 2 ;;
--cms-workspace)      CMS_WORKSPACE="$2"; shift 2 ;;
--service-name-prefix) SERVICE_NAME_PREFIX="$2"; shift 2 ;;
--agents)             SELECTED_AGENTS="$2"; shift 2 ;;
```

### 2.2 Agent 探测函数

```bash
probe_agents() {
    msg "==> 探测 AI Agent..." "==> Probing AI Agents..."
    PROBE_RESULT=$("$NODE_BIN" "$INSTALL_SRC/dist/cli-probe.js" --json 2>/dev/null) || {
        msg "⚠️  Agent 探测失败，将跳过选择" "⚠️  Agent probe failed, skipping selection"
        PROBE_RESULT="[]"
    }
}
```

### 2.3 交互式选择函数

```bash
select_agents() {
    # 如果有 --agents 参数，直接使用
    if [ -n "$SELECTED_AGENTS" ]; then return; fi

    # 解析 PROBE_RESULT，展示菜单
    # 默认选中已探测到的 agent
    # 用户可切换，回车确认
    # 最终设置 SELECTED_AGENTS="claude-code,cursor-hook"
}
```

交互式菜单 UX：
```
==> 探测 AI Agent...

    [1] ✅ Claude Code    (已检测到: ~/.claude)
    [2] ❌ Codex          (未检测到)
    [3] ✅ Cursor         (已检测到: ~/.cursor)
    [4] ❌ Qoder CLI      (未检测到)
    [5] ❌ QoderWork      (未检测到)

    已检测到的 Agent 默认启用 (✅)
    输入编号切换选择 (空格分隔)，直接回车确认: 
```

### 2.4 write_config 扩展

在现有 `write_config()` 的 Node.js 内联脚本中新增：

```javascript
const collectLog = '${COLLECT_LOG}';
const collectTrace = '${COLLECT_TRACE}';
const cmsLicenseKey = '${CMS_LICENSE_KEY}';
const cmsEndpoint = '${CMS_ENDPOINT}';
const cmsWorkspace = '${CMS_WORKSPACE}';
const serviceNamePrefix = '${SERVICE_NAME_PREFIX}';
const selectedAgents = '${SELECTED_AGENTS}';

if (collectLog) config.collectLog = collectLog === 'true';
if (collectTrace) config.collectTrace = collectTrace === 'true';

if (cmsLicenseKey || cmsEndpoint || cmsWorkspace) {
  config.cms = config.cms || {};
  if (cmsLicenseKey) config.cms.licenseKey = cmsLicenseKey;
  if (cmsEndpoint) config.cms.endpoint = cmsEndpoint;
  if (cmsWorkspace) config.cms.workspace = cmsWorkspace;
}

if (serviceNamePrefix) config.serviceNamePrefix = serviceNamePrefix;

if (selectedAgents) {
  config.agents = config.agents || {};
  const selected = selectedAgents.split(',').map(s => s.trim());
  // 读取所有已知 agent ID（从探测结果）
  const allAgents = JSON.parse('${PROBE_RESULT}' || '[]');
  for (const agent of allAgents) {
    config.agents[agent.id] = config.agents[agent.id] || {};
    config.agents[agent.id].enabled = selected.includes(agent.id);
  }
}
```

---

## 3. Config 结构扩展

### 3.1 config.json 新增字段

```jsonc
{
  // 现有字段 ...
  
  "collectLog": true,         // 全局 log 采集开关
  "collectTrace": true,       // 全局 trace 采集开关
  "serviceNamePrefix": "xxx", // 服务名前缀

  "cms": {                    // CMS 后端（预留）
    "licenseKey": "xxx",
    "endpoint": "xxx",
    "workspace": "xxx"
  },

  "agents": {                 // 安装时锁定的 agent 启用状态
    "claude-code": { "enabled": true },
    "cursor-hook": { "enabled": true },
    "codex": { "enabled": false },
    "qoder-cli": { "enabled": false },
    "qoder-work": { "enabled": false }
  }
}
```

### 3.2 TypeScript 类型扩展

`ConfigFile` interface 新增：
```typescript
collectLog?: boolean;
collectTrace?: boolean;
serviceNamePrefix?: string;

cms?: {
  licenseKey?: string;
  endpoint?: string;
  workspace?: string;
};

agents?: Record<string, {
  enabled?: boolean;
  captureMessageContent?: boolean | string;
}>;
```

`AnalyticsConfig` 新增：
```typescript
collectLog: boolean;
collectTrace: boolean;
serviceNamePrefix: string;

cms: {
  enabled: boolean;
  licenseKey: string;
  endpoint: string;
  workspace: string;
};
```

---

## 4. 运行时 Agent 启用门控

### 非 inner 构建 (`__INTERNAL_BUILD__ = false`)

在 `DeploymentManager` 或 `AgentDiscoveryService` 中增加门控：

```typescript
function isAgentEnabled(agentId: string, config: AnalyticsConfig): boolean {
  // 如果 config.agents 未定义 → 向后兼容，走 auto-detect
  if (!config.agents || Object.keys(config.agents).length === 0) {
    return true; // fallback to auto-detect
  }
  // 如果定义了 → 严格按 enabled 字段
  return config.agents[agentId]?.enabled !== false;
}
```

### Inner 构建 (`__INTERNAL_BUILD__ = true`)

忽略 `config.agents.enabled`，始终走 auto-detect（现有行为不变）。

---

## 5. 构建系统改动 (`build.mjs`)

新增 `cli-probe` 入口：

```javascript
// 现有: entryPoints: ['src/index.ts']
// 新增: entryPoints: ['src/index.ts', 'src/cli-probe.ts']
```

产出 `dist/cli-probe.js`，打包进安装 tarball。

---

## 6. 向后兼容矩阵

| 场景 | 行为 |
|------|------|
| 老 config 无 `agents` 字段 + 非 inner | auto-detect（现有行为） |
| 新 config 有 `agents` 字段 + 非 inner | 按 enabled 启用 |
| Inner 构建（任何 config） | 始终 auto-detect |
| 新 config 有 `cms` 字段 | 仅持久化，不影响运行时（flusher 后续实现） |
| 新 config 有 `collectLog`/`collectTrace` | 仅持久化，flusher 后续读取 |

---

## Baseline Documentation Sync

实现完成后需更新：
- `docs/modules/core.md`: ConfigLoader 新字段、AgentDiscovery 分叉逻辑
- `docs/modules/types.md`: 新增类型定义
