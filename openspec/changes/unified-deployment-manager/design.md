## Context

当前 loongsuite-pilot 的 agent 采集能力部署分散在两处：

1. **Orchestrator.installHooks()** — 硬编码每个 agent 的 hook 安装逻辑（Cursor、Qoder CLI、QoderWork）
2. **Orchestrator.registerAllInputs()** — 硬编码每个 agent 的 Input 注册逻辑

这意味着新增 agent 必须修改 Orchestrator 源码，且只支持 Hook 类部署。对于不提供 hook 机制的 agent（如 Aider、Python OTel 探针），目前无法自动部署采集能力。

设计文档中提出的统一部署架构要求：
- 安装脚本只负责安装 pilot 本身，所有 agent 的探测、部署、采集由 daemon 代码完成
- 通过声明式 JSON 配置文件驱动，新增 agent 无需改代码
- 两种部署模式：Hook 类（配置注入）和插件/探针类（独立包部署 + 挂载）

## Goals / Non-Goals

**Goals:**
- 引入 `DeploymentManager` 统一编排 agent 的探测（detect）、部署状态检查（isDeployed）、部署执行（deploy）
- 支持 Hook 类和插件/探针类两种部署策略，通过策略模式实现
- Agent 定义文件驱动：内置 `agents.d/*.json` + 用户自定义 `agents.d.local/*.json`
- 插件/探针部署后的 Shell 通知机制
- 简化 Orchestrator，将部署和 Input 注册逻辑从硬编码改为数据驱动

**Non-Goals:**
- 不改变现有 HookManager 的核心逻辑，仅将其作为 HookStrategy 的内部实现
- 不改变现有 Input 类的实现
- 不改变数据管道（InputManager → Flusher）的流转方式
- 不在本次实现 wrapper/rc-inject/env-inject 的全部挂载方式，先实现 wrapper 作为 MVP
- 不实现 OTel 探针的具体部署（本次仅搭建框架，具体探针的 agent 定义文件后续添加）

## Decisions

### D1: 策略模式分离部署逻辑

引入 `DeployStrategy` 接口，定义统一的部署合约：

```typescript
interface DeployStrategy {
  detect(def: AgentDefinition): Promise<boolean>;
  needsDeploy(def: AgentDefinition, record?: DeployedAgentRecord): Promise<boolean>;
  deploy(def: AgentDefinition): Promise<DeployResult>;
  undeploy(def: AgentDefinition): Promise<boolean>;
}
```

两个实现：
- `HookStrategy` — 包装现有 HookManager，从 AgentDefinition 的 `hook` 字段构造 HookDefinition
- `PluginProbeStrategy` — 负责包的获取（OSS 下载/tar 解压）+ 按 convention 执行插件自带的安装/卸载脚本 + 根据 mountType 写通知

**Why**: 两种模式的 detect/deploy 逻辑完全不同，策略模式使 DeploymentManager 不需要 if/else 分支。后续新增部署模式（如 MCP server 类）只需新增策略实现。

**Alternative considered**: 直接在 DeploymentManager 中 switch/case。更简单但违反开闭原则，随 agent 类型增多会变得难以维护。

### D2: Agent 定义文件格式

每个 agent 一个 JSON 文件，核心结构：

```jsonc
{
  "id": "cursor-hook",
  "displayName": "Cursor",
  "deployMode": "hook",           // "hook" | "plugin-probe"
  "detection": {
    "paths": ["~/.cursor"],       // 任一存在即认为 agent 已安装
    "commands": []                // 或命令存在性检查
  },
  "hook": {                       // deployMode=hook 时使用
    "settingsPath": "~/.cursor/hooks.json",
    "events": ["stop", "preToolUse", "postToolUse", ...],
    "hookCommand": "$PILOT_DIR/hooks/cursor-loongsuite-pilot-hook.sh",
    "format": "flat"              // "flat" | "nested"
  },
  "pluginProbe": {                // deployMode=plugin-probe 时使用
    "source": {
      "type": "tar",              // "oss" | "tar"
      "tarball": "$PILOT_DIR/plugins/otel-claude-hook.tar.gz",
      "destDir": "~/.cache/opentelemetry.instrumentation.claude/package",
      "remoteUrl": "https://..."  // 本地 tarball 不存在时的远程 fallback（可选）
    },
    "mountType": "wrapper"        // 仅用于决定通知内容："wrapper" | "rc-inject" | "env-inject"
  },
  "input": {                      // 采集输入配置
    "type": "hook-jsonl",         // Input 类型标识
    "logDir": "$PILOT_DATA/logs/cursor/history"
  }
}
```

plugin-probe 类的安装/卸载采用 convention-based 方式——PluginProbeStrategy 不声明安装命令，而是按约定查找并执行插件包中的脚本（见 D2.1）。

**Why**: JSON 格式易于机器读写，与现有配置（config.json）风格一致。`$PILOT_DIR` 和 `$PILOT_DATA` 作为变量模板，运行时替换。

**Alternative considered**: YAML 格式——可读性更好但引入额外依赖，且项目中无 YAML 使用先例。

### D2.1: Convention-based 插件生命周期

插件包（tarball）按约定提供脚本：
- `scripts/install.sh` — 安装（必须）
- `scripts/uninstall.sh` — 卸载（可选）

PluginProbeStrategy 按约定查找并执行，不需要在 agent 定义 JSON 中声明。

**环境变量 Contract**：PluginProbeStrategy 执行脚本时通过环境变量传递宿主信息：

| 变量 | 含义 | 示例 |
|------|------|------|
| `PILOT_DATA_DIR` | pilot 数据目录 | `~/.loongsuite-pilot` |
| `PILOT_LOG_DIR` | 该插件的日志目录 | `~/.loongsuite-pilot/logs/claude-code` |
| `PILOT_NODE_BIN` | node 绝对路径 | `/Users/x/.nvm/versions/node/v22/bin/node` |
| `PILOT_NPM_BIN` | npm 绝对路径 | 同目录下的 npm |

插件的 install.sh 按需读取这些变量，不需要的直接忽略。新增变量不 break 旧插件。

**生命周期**：

- **首次安装**：解压 tarball → 执行 `scripts/install.sh`
- **更新**（tarball hash 变化）：旧 destDir 下如果有 `scripts/uninstall.sh` 先执行 → 清空 destDir → 解压新 tarball → 执行 `scripts/install.sh`。如果没有 `scripts/uninstall.sh`，直接清空 + 解压 + install（靠 install.sh 幂等）
- **卸载**（pilot uninstall 时）：如果 destDir 下有 `scripts/uninstall.sh` 就执行

**过渡方案**：当前插件的 scripts/install.sh 不读 PILOT_LOG_DIR 环境变量。在插件作者改之前，pilot 侧在 `scripts/` 目录下提供 wrapper 脚本（如 `plugin-install-claude.sh`）。PluginProbeStrategy 优先查找 `$PILOT_DIR/scripts/plugin-install-{id}.sh`，不存在时 fallback 到插件自带的 `scripts/install.sh`。

**Why**: 宿主（pilot）定义 contract，插件实现 contract。宿主不理解插件的安装细节（npm install、hook 注册等），只负责解压 + 调用约定入口 + 传递环境变量。这与 Homebrew Formula、VS Code Extensions、Grafana Plugins 等成熟系统的设计一致。

**Alternative considered**: 在 agent 定义 JSON 中声明 install.command / install.args。缺点是宿主需要理解每个插件的安装参数，新增参数需改 JSON 和 PluginProbeStrategy。

### D3: DeploymentManager 编排流程

```
DeploymentManager.deployAll()
  ├─ loadDefinitions()          // 加载 agents.d/ + agents.d.local/
  ├─ for each definition:
  │   ├─ strategy.detect()      // agent 是否存在
  │   ├─ strategy.needsDeploy() // 是否需要部署（未部署 or 源文件哈希变化）
  │   ├─ strategy.deploy()      // 执行部署（首次安装或更新）
  │   └─ writeNotification()    // 插件类部署后写通知
  └─ return DeploymentResult[]
```

DeploymentManager 负责选择正确的策略（根据 `deployMode`），并追踪部署状态到 `~/.loongsuite-pilot/deployed-agents.json`。

**Why**: 将所有部署逻辑集中到一个编排器，Orchestrator 只需一行调用即可完成所有 agent 的部署。

### D3.1: 插件更新检测（哈希比对）

`deployed-agents.json` 中为每个已部署的 plugin-probe 类 agent 记录源文件的 SHA-256 哈希值：

```jsonc
{
  "claude-code": {
    "deployMode": "plugin-probe",
    "deployedAt": "2026-05-15T10:00:00Z",
    "sourceHash": "sha256:a3f2b8c..."   // tarball 或 OSS 包的哈希
  }
}
```

`needsDeploy()` 流程：
1. 计算当前源文件（tarball / OSS 包）的 SHA-256 哈希
2. 与 `deployed-agents.json` 中记录的 `sourceHash` 比对
3. 哈希不同 → 需要重新部署（pilot 更新带来了新版插件）
4. 哈希相同 → 跳过，无需重复安装

更新部署完成后同样写入通知文件，提醒用户新版插件已生效。

**Why**: 避免每次 daemon 启动都无条件重装（现有安装脚本的做法），同时确保 pilot 更新后携带的新版插件能被自动安装。哈希比对是最可靠的变化检测方式，不依赖版本号管理。

### D3.2: 运行时动态 agent 发现与部署

现有 `AgentDiscoveryService` 通过 fs.watch + 轮询监测 agent 数据目录，但仅触发 Input 的 start/stop。扩展其职责，连接到 DeploymentManager：

```
AgentDiscoveryService.refresh()
  ├─ 检测到新 agent 存在（detect() 从 false → true）
  ├─ 触发 DeploymentManager.deploySingle(agentDef)
  │   ├─ strategy.deploy()
  │   └─ writeNotification()
  └─ 注册对应 Input 并 start
```

具体实现：
- DeploymentManager 向 AgentDiscoveryService 注册所有 agent 定义的 detection.paths 作为 watchPaths
- AgentDiscoveryService 发现新 agent 时发射 `agent:discovered` 事件
- DeploymentManager 监听该事件，执行单个 agent 的部署流程
- 部署成功后通知 InputManager 注册并启动对应 Input

**Why**: 用户可能在 daemon 运行期间安装新 agent（如安装 Aider），系统应自动完成探测 → 部署 → 采集，无需重启 daemon。这是设计文档中描述的核心动态发现场景。

### D4: Input 注册数据驱动化

当前 Orchestrator.registerAllInputs() 为每个 agent 硬编码 Input 实例化和 DetectionEntry 构建。改为：

1. Agent 定义文件中的 `input` 字段声明 Input 类型和参数
2. 引入 `InputFactory`，根据 `input.type` 创建对应的 Input 实例
3. DeploymentManager 完成部署后，返回成功部署的 agent 定义列表
4. Orchestrator 根据返回结果调用 InputFactory 注册 Input

**Why**: 解耦 Input 注册与 Orchestrator 硬编码，新增 agent 只需添加定义文件和对应的 Input 类。

**分阶段实施**: 第一阶段保留现有硬编码注册逻辑作为 fallback，逐步迁移到数据驱动。完全迁移后删除硬编码逻辑。

### D5: Shell 通知机制

插件/探针类部署完成后：

1. DeploymentManager 写入通知文件 `~/.loongsuite-pilot/notifications`（追加模式）
2. pilot 安装时在 RC 文件（.bashrc/.zshrc）注入轻量检查逻辑（一个 `if` + `cat` + `rm`）
3. 用户打开新终端时自动显示通知并清除

通知内容根据挂载方式动态生成：
- wrapper → "请执行 `hash -r` 或打开新终端"
- rc-inject → "请执行 `source ~/.bashrc` 或打开新终端"
- env-inject → "请打开新终端"

**Why**: 插件/探针部署在 daemon 后台完成，当前 shell 不会自动感知新 wrapper/alias。通知机制是用户体验的关键。

## Risks / Trade-offs

### R1: Agent 定义文件与现有硬编码的过渡期
- **Risk**: 过渡期间两套逻辑共存可能导致重复部署或冲突
- **Mitigation**: 使用 `deployed-agents.json` 记录部署状态，deploy 前检查避免重复。第一阶段先将现有 agent 转为定义文件，确认等价后再删除硬编码。

### R2: OSS 下载失败
- **Risk**: 网络不可用时插件/探针无法部署
- **Mitigation**: deploy() 返回失败状态但不中断 daemon。AgentDiscoveryService 定期重试。支持本地 tar 包作为 fallback。

### R3: Wrapper 与用户 PATH 冲突
- **Risk**: wrapper 命令与用户已有命令冲突
- **Mitigation**: wrapper 安装前检查目标命令是否已存在于 wrapperDir 中。若已存在且非 pilot 创建的 wrapper，跳过并记录 warning。

### R4: RC 文件注入安全性
- **Risk**: 修改用户 shell RC 文件可能导致 shell 启动异常
- **Mitigation**: 注入内容用明确的标记注释包裹（`# loongsuite-pilot BEGIN` / `# loongsuite-pilot END`），便于识别和清理。注入逻辑仅为一个简单的 `if -f ... then cat ... rm ... fi`，不会影响 shell 启动。
