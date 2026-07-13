# Qoder for JetBrains 接入诊断排查指南

本文档随 `loongsuite-pilot` 安装包一起分发，安装完成后自动写入
`~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/qoder-jetbrains-diagnostics.md`，随 pilot 升级自动更新。

仅覆盖 **pilot 场景下 Qoder for JetBrains（IntelliJ IDEA / PyCharm / WebStorm / GoLand 等）的本地数据采集链路**，
不包含 Qoder for JetBrains 插件自身的功能问题。

**部署方式是 `detection-only`**：pilot 不会为 Qoder for JetBrains 单独写 hook 或起 Input，
它复用 **Qoder（Electron 版 / CLI）已经注入的共享 Hook**（`~/.qoder/settings.json` 的 Stop hook）和
**`qoder-trace`** 这一条 trace 聚合链路。若用户环境中只有 JetBrains 插件但没有共享 `~/.qoder/settings.json`
或 Stop hook，先按 `qoder-diagnostics.md` 的 Qoder CLI hook 链路完成共享 hook 注入。

---

## 采集链路概览（与 Qoder CLI/IDE 共享 Hook，独立 SQLite DB）

```
Qoder for JetBrains 插件（IntelliJ 系列）
  └─ 与 Qoder CLI/IDE 共享的 Stop hook (~/.qoder/settings.json)
       └─ qoder-loongsuite-pilot-hook.sh
            └─ qoder-hook-processor.mjs
                 └─ ~/.loongsuite-pilot/logs/qoder/history/qoder-YYYY-MM-DD.jsonl
                      └─ QoderTraceInput (id=qoder-trace)
                           ├─ 按 turn 分组，推断 variant（qoder-cli / qoder / qoder-idea）
                           ├─ IDE/JetBrains 类 turn → 按 session 匹配 SQLite token
                           │    └─ ~/.qoder/shared_client/cache/db/local.db（IntelliJ 专属 DB）
                           │         或 ~/Library/Application Support/Qoder/.../local.db（桌面版 DB，可能共存）
                           └─ relabel：若匹配到的 DB 是 shared_client（IntelliJ）路径，
                                agentType 从 qoder 改写为 qoder-idea
                                → 规范化输出到 ~/.loongsuite-pilot/logs/output/
```

关键事实：

- **没有专属 hook 脚本，没有专属 settings.json 路径**——检测和采集完全借用 Qoder CLI/IDE 的共享链路
- **有专属 SQLite DB**：`~/.qoder/shared_client/cache/db/local.db`（IntelliJ 插件写入，与桌面版的
  `SharedClientCache/cache/db/local.db` 是两个不同文件，可能同时存在）
- agentType 的最终判定发生在 `QoderTraceInput` 内部：若一个 turn 的 SQLite token 匹配到了
  `shared_client` 路径的 DB，该 turn 会被重新标记为 `qoder-idea`；否则保持 `qoder`

| 关键组件 | 路径 | 谁负责写 |
|---|---|---|
| Hook 注册 | `~/.qoder/settings.json` 的 `hooks.Stop`（与 Qoder CLI 共享，nested 格式） | pilot 检测到 Qoder CLI/IDE 或 JetBrains 插件目录后自动注入 |
| JetBrains 插件检测路径 | `~/Library/Application Support/JetBrains/<产品>*/plugins/qoder-jetbrains`（macOS）/ `~/.config/JetBrains/<产品>*/plugins/qoder-jetbrains`（Linux） | Qoder for JetBrains 插件安装时写入 |
| Hook History JSONL（共享） | `~/.loongsuite-pilot/logs/qoder/history/qoder-YYYY-MM-DD.jsonl` | qoder-hook-processor.mjs 增量 append |
| IntelliJ 专属 SQLite DB | `~/.qoder/shared_client/cache/db/local.db` | Qoder for JetBrains 插件写入 |
| Pilot 游标 | `~/.loongsuite-pilot/logs/input-state.json` 的 `qoder-trace` 条目 | QoderTraceInput 写入 |
| 规范化输出 | `~/.loongsuite-pilot/logs/output/` 中 `gen_ai.agent.type: "qoder-idea"` 的记录 | Flusher 写出 |

---

## 系统化排查顺序

Qoder for JetBrains 数据未出现，或数据被错误标记为 `qoder` 而不是 `qoder-idea` 时，
**按以下顺序逐步排查，勿跳步**：

```
第 1 步 → JetBrains 插件是否被检测到 + qoder-trace 是否启用
第 2 步 → 共享 Hook history 是否有该 IDE 产生的 turn
第 3 步 → IntelliJ 专属 SQLite DB 是否可访问 + 有 token 数据
第 4 步 → agentType relabel 是否生效（qoder → qoder-idea）
第 5 步 → pilot 是否成功消费 + 配置检查
```

---

## 第 1 步：插件检测 + qoder-trace 启用状态

### 1.1 插件目录检测

```bash
# macOS（按产品逐个检查，示例为 IntelliJ IDEA）
ls -la "$HOME/Library/Application Support/JetBrains/IntelliJIdea"*/plugins/qoder-jetbrains 2>/dev/null
# Linux
ls -la "$HOME/.config/JetBrains/IntelliJIdea"*/plugins/qoder-jetbrains 2>/dev/null
```

支持的产品前缀：`IntelliJIdea` / `IdeaIC` / `PyCharm` / `WebStorm` / `GoLand`。任意一个匹配到即视为检测成功。

若目录不存在 → 用户未安装 Qoder for JetBrains 插件，或安装到了非标准路径，让用户确认插件已启用。

> `detection-only` 部署模式下，即使检测成功，pilot **不会**为该 agent 写任何 hook 或专属配置——
> 检测结果只用于展示/统计，实际数据链路依赖第 2/3 步的共享 hook 和 SQLite DB。

### 1.2 确认 `qoder-trace` 是否启用（默认启用）

```bash
python3 - <<'PY'
import json
import pathlib
path = pathlib.Path.home() / '.loongsuite-pilot' / 'config.json'
try:
    cfg = json.loads(path.read_text())
except Exception:
    print('qoder-trace.enabled: true (default)')
    raise SystemExit(0)
listener = (cfg.get('listeners') or {}).get('qoder-trace') or {}
print('qoder-trace.enabled:', listener.get('enabled', 'true (default)'))
PY
```

- 若未配置或为 `true`（默认）→ trace 链路生效，继续第 2/3 步
- 若显式 `false` → `qoder-cli-hook` / `qoder-cli-session` / `qoder-sqlite` 会接管数据，但**不会**产生 `qoder-idea` 标记（relabel 逻辑只存在于 `QoderTraceInput` 内），此时 JetBrains 场景下的 token 数据会被计入 `qoder` 而非 `qoder-idea`——这是已知限制，不是 bug

---

## 第 2 步：共享 Hook history 中是否有该 IDE 产生的 turn

```bash
ls -la ~/.loongsuite-pilot/logs/qoder/history/
tail -20 ~/.loongsuite-pilot/logs/qoder/history/qoder-$(date -u +%Y-%m-%d).jsonl \
  | python3 -m json.tool
```

由于 hook 是共享的，history 文件里 Qoder 桌面版和 JetBrains 插件产生的 turn 会混在一起，
仅凭 `gen_ai.agent.type` 字段可能都是 `qoder`（relabel 发生在下游 QoderTraceInput，不是 hook 阶段）。
若整个 history 为空 → 参照 `qoder-diagnostics.md` 的 hook 注册排查（settings.json / Node runtime）。

---

## 第 3 步：IntelliJ 专属 SQLite DB 验证

### 3.1 DB 文件是否存在

```bash
DB="$HOME/.qoder/shared_client/cache/db/local.db"
ls -la "$DB"
```

不存在 → 用户从未在 JetBrains 插件里发生过对话，或插件版本过低未使用该 DB 结构。

### 3.2 是否有 token 数据

```bash
sqlite3 "$DB" "
  SELECT COUNT(*) AS eligible_rows
  FROM chat_message
  WHERE token_info IS NOT NULL AND token_info != '' AND json_valid(token_info);
"
```

预期 > 0。为 0 但用户确实用过插件 → 升级 Qoder for JetBrains 插件版本。

### 3.3 与桌面版 DB 的区分

同一台机器上可能同时存在两个 DB：

| DB 路径 | 归属 |
|---|---|
| `~/.qoder/shared_client/cache/db/local.db` | Qoder for JetBrains（IntelliJ 系列插件） |
| `~/Library/Application Support/Qoder/SharedClientCache/cache/db/local.db`（macOS）/ `${XDG_CONFIG_HOME:-~/.config}/Qoder/SharedClientCache/cache/db/local.db`（Linux） | Qoder 桌面版（Electron） |

`QoderTraceInput` 会读取**全部存在的 DB 路径**并按 `session_id` 匹配对应的 token 行，
两者可以共存，互不影响。

---

## 第 4 步：agentType relabel 是否生效

`QoderTraceInput` 的判定逻辑：

1. 按 `gen_ai.turn.id` 对 hook 记录分组
2. 对每个 turn，若所有 entry 的 `gen_ai.agent.type` 都是 `qoder`（未被 hook 阶段标记为 `qoder-idea`），
   且该 turn 的 `session.id` 匹配到的 SQLite token 来自 `shared_client` 路径的 DB，
   则整批 entry 的 `gen_ai.agent.type` 会被重写为 `qoder-idea`

```bash
# 检查规范化输出中是否出现 qoder-idea
ls -la ~/.loongsuite-pilot/logs/output/ | grep -E 'qoder(-idea)?'
grep -l '"qoder-idea"' ~/.loongsuite-pilot/logs/output/*.jsonl 2>/dev/null
```

若 output 中只有 `qoder`，从未出现 `qoder-idea`：

- 检查第 1.2 步 `qoder-trace` 是否被禁用（禁用后 relabel 逻辑不会执行）
- 检查第 3 步的 `shared_client` DB 路径是否真实存在且能匹配到对应 `session_id`
- Node < 22 环境下，hook 阶段的 `agent-event-normalizer.mjs` 无法直接推断 `qoder-idea`
  （见 `shared/qoder-db-utils.mjs` 中的 Node 版本限制说明），**这是设计上的已知 fallback**，
  最终由 `QoderTraceInput` 的 relabel 逻辑兜底，只要第 3 步 DB 数据正常，最终输出仍应为 `qoder-idea`

---

## 第 5 步：pilot 是否成功消费 + 配置检查

```bash
# 5.1 qoder-trace 游标
python3 -m json.tool ~/.loongsuite-pilot/logs/input-state.json | grep -A 3 '"qoder-trace"'

# 5.2 输出
ls -la ~/.loongsuite-pilot/logs/output/ | grep -E 'qoder(-idea)?'
```

若游标不前进：

- pilot 服务未运行 → `~/.local/bin/loongsuite-pilot status`
- `qoder-trace` 被禁用或 Qoder 桌面版/CLI 的共享 hook 从未注入 → 参照 `qoder-diagnostics.md` 排查共享链路
- Qoder for JetBrains 插件本身从未产生过完整对话（Stop hook 未触发）

### 5.1 agent-control / content policy 中的 ID 差异

`Qoder for JetBrains` 在不同配置文件中使用不同 ID，容易混淆：

| 配置文件 | 使用的 ID | 说明 |
|---|---|---|
| `agents.d/qoder-jetbrains.json` | `qoder-jetbrains` | 部署/检测专用 ID |
| `~/.loongsuite-pilot/agent-control.json` | `qoder` | 采集开关复用 Qoder 的开关（因为共享 hook） |
| `~/.loongsuite-pilot/config.json` 的 `agents` 段 | `qoder-idea` | 内容采集策略（`captureMessageContent` 等）单独配置 |

若用户想单独关闭 JetBrains 场景下的内容采集，但不影响 Qoder 桌面版，应修改 `config.json` 中
`agents["qoder-idea"]` 而不是 `agents["qoder"]`。

---

## 关键文件速查

| 文件 / 目录 | 作用 |
|---|---|
| `~/Library/Application Support/JetBrains/<产品>*/plugins/qoder-jetbrains`（macOS） | 插件检测路径 |
| `~/.config/JetBrains/<产品>*/plugins/qoder-jetbrains`（Linux） | 插件检测路径 |
| `~/.qoder/settings.json` | 共享 Stop hook 注册（与 Qoder CLI 共用） |
| `~/.qoder/shared_client/cache/db/local.db` | IntelliJ 专属 token usage DB |
| `~/.loongsuite-pilot/logs/qoder/history/qoder-YYYY-MM-DD.jsonl` | 共享 hook history |
| `~/.loongsuite-pilot/logs/input-state.json` | 含 `qoder-trace` 游标 |
| `~/.loongsuite-pilot/logs/output/` | 规范化输出，relabel 后的记录 `gen_ai.agent.type: "qoder-idea"` |
| `~/.loongsuite-pilot/agent-control.json` | 采集开关（用 `qoder` ID） |
| `~/.loongsuite-pilot/config.json` | 内容策略（用 `qoder-idea` ID） |

---

## 常见问题速查

| 现象 | 解决方法 |
|------|---------|
| 插件检测不到 | 确认插件安装路径匹配 `IntelliJIdea*` / `IdeaIC*` / `PyCharm*` / `WebStorm*` / `GoLand*` 模式，或产品未被列入检测范围 |
| 有共享 hook 数据但一直标记为 `qoder`，从未出现 `qoder-idea` | 检查 `~/.qoder/shared_client/cache/db/local.db` 是否存在及有无 token 数据；确认 `qoder-trace` 未被禁用 |
| 同时使用 Qoder 桌面版和 JetBrains 插件，数据混在一起 | 不会混。两者共享 hook 但各自的 SQLite DB 独立，`QoderTraceInput` 按 `session_id` 精确匹配对应 DB 后分别 relabel |
| 想单独关闭 JetBrains 场景的内容采集 | 修改 `config.json` 中 `agents["qoder-idea"]`，不要改 `agents["qoder"]`（会连带影响桌面版） |
| 想单独关闭 JetBrains 场景的采集开关 | `agent-control.json` 复用 `qoder` ID，无法单独关闭 JetBrains 而不影响桌面版/CLI（属设计限制） |
| IntelliJ 专属 DB 不存在 | 用户从未在插件里完成过一次完整对话，或插件版本过低未使用该 DB 结构，升级插件 |
