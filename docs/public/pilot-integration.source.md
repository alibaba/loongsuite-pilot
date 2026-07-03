# LoongSuite Pilot AI Coding Agent 接入指南（{{platformName}}）

本文介绍如何通过 LoongSuite Pilot 将开发者本机的 AI Coding Agent 数据接入目标平台（{{platformName}}）。接入后，您可以查看 AI Coding Agent 的会话、模型调用、工具调用、Token 用量、日志和 Trace 数据，用于团队使用分析、审计和可观测分析。

LoongSuite Pilot 是运行在开发者本机的轻量级采集服务。同一台机器、同一个操作系统用户下通常只需要安装一次。安装后，Pilot 会自动发现已安装并使用过的 AI Coding Agent，完成对应 Agent 的本地接入配置，将不同 Agent 的活动数据整理为统一事件，并按接入配置上报日志和 Trace 数据。

接入后，Pilot 会根据您在接入中心选择的配置执行以下上报：

- 开启 Trace 接入后，将 AI Coding Agent 的会话、轮次、步骤、LLM 调用和工具调用转换为 OpenTelemetry Trace，并上报到目标 Trace 服务。
- 开启日志接入后，将标准化后的 Agent 活动事件写入日志服务，用于审计、检索和后续分析。

## 接入后可以查看什么

接入 LoongSuite Pilot 后，可以分析以下数据：

- 团队正在使用哪些 AI Coding Agent。
- 会话、轮次、Agent 步骤、模型调用和工具调用。
- 错误事件、工具调用失败和 Agent 运行过程。
- 模型名称、调用耗时、输入 Token、输出 Token 和缓存 Token。Token 数据以源 Agent 实际提供的内容为准。
- 工具名称、工具参数、工具结果、工具耗时和错误信息。
- 通过日志检索和 Trace 链路分析 Agent 运行过程。
- Git 仓库、分支、工作目录和主机等上下文信息。
- 标准化后的 Agent 活动日志和 OpenTelemetry Trace。

Pilot 支持按 Agent 控制是否采集完整 Prompt、Completion、工具参数和工具结果，也支持在数据上报前对常见密钥进行脱敏。

## 前提条件

开始接入前，请确认满足以下条件：

- 已开通目标平台（{{platformName}}），并已创建目标工作空间。
- 目标 AI Coding Agent 已在本机安装，并至少使用过一次。
- Pilot 安装用户与日常使用 AI Coding Agent 的操作系统用户一致。
- 如需 Trace 上报，已在接入中心获取 Trace LicenseKey、Trace Endpoint 和工作空间信息。
- 如需日志上报，已在接入中心完成日志接入资源初始化，并获取日志服务 Project、Logstore 和 Endpoint。

### 环境要求

| 环境 | 要求 |
| --- | --- |
| macOS / Linux / WSL | Node.js 18 及以上版本，建议使用 Node.js 22；已安装 `npm`；已安装 `curl` 或 `wget`。 |
| Windows | Windows 10 及以上版本；PowerShell 5.1 及以上版本；Node.js 18 及以上版本，建议使用 Node.js 22；已安装 `npm`。 |

安装前可执行以下命令确认 Node.js 和 npm：

```bash
node -v
npm -v
```

macOS、Linux 或 WSL 中如未安装 Node.js，可以使用 nvm 安装 Node.js 22：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 22
nvm use 22
```

Windows 中如未安装 Node.js，建议先安装 nvm-windows 或官方 Node.js 安装包，再确认 `node -v` 和 `npm -v` 可正常执行。

## 支持范围

Pilot 支持 macOS、Linux、WSL 和 Windows。Pilot 会自动发现已安装并使用过的 AI Coding Agent，并按 Agent 类型区分采集结果。不同 Agent 在不同操作系统上的支持情况可能不同，最终支持范围以接入中心页面和当前安装包为准。

### macOS / Linux / WSL

| AI Coding Agent | Trace 上报 | 日志上报 | 对话和工具调用 |
| --- | --- | --- | --- |
| Claude Code | 支持 | 支持 | 支持 |
| Codex | 支持 | 支持 | 支持 |
| Cursor | 支持 | 支持 | 支持 |
| OpenCode | 支持 | 支持 | 支持 |
| Qoder | 支持 | 支持 | 支持 |
| Qoder CN | 支持 | 支持 | 支持 |
| Qoder CLI | 支持 | 支持 | 支持 |
| Qoder for JetBrains | 支持 | 支持 | 支持 |
| Qoder Work | 支持 | 支持 | 支持 |
| Qoder Work CN | 支持 | 支持 | 支持 |
| Qwen Code CLI | 支持 | 支持 | 支持 |
| Wukong | 支持 | 支持 | 支持 |

### Windows

| AI Coding Agent | Trace 上报 | 日志上报 | 对话和工具调用 |
| --- | --- | --- | --- |
| Claude Code | 支持 | 支持 | 支持 |
| Codex | 支持 | 支持 | 支持 |
| Cursor | 支持 | 支持 | 支持 |
| OpenCode | 支持 | 支持 | 支持 |
| Qoder CLI | 支持 | 支持 | 支持 |
| Qoder IDE User 版本 | 支持 | 支持 | 支持 |
| Qoder Work User 版本 | 支持 | 支持 | 支持 |

Token 用量采集依赖源 Agent 是否在本地数据或接入事件中暴露 Token 字段。如果源 Agent 未暴露相关字段，Pilot 不会凭空推算 Token 用量。

### 最低版本

| AI Coding Agent | 最低版本 |
| --- | --- |
| [Qoder](https://qoder.com/en/ide) | 1.3.0 及以上 |
| [Qoder CLI](https://qoder.com/cli) | 1.0.13 及以上 |
| [Qoder CN](https://qoder.com.cn/) | 1.9.3 及以上 |
| [Qoder Work](https://qoder.com/en/qoderwork) | 0.6.2 及以上 |
| [Qoder Work CN](https://qoder.com.cn/qoderwork) | 0.6.2 及以上 |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) | 2.1.119 及以上 |
| [Codex CLI](https://help.openai.com/en/articles/11096431) | 0.129.0 及以上 |
| [Codex](https://openai.com/codex/) | 26.519.81530（3178）及以上 |
| [Cursor](https://docs.cursor.com/) | 1.3.0 及以上 |
| [OpenCode](https://opencode.ai/) | 1.17.9 及以上 |
| [Wukong](https://wukong.dingtalk.com/) | 0.9.56-26060901 及以上 |
| [Qwen Code CLI](https://qwen.ai/qwencode) | 0.14.4 及以上 |

## 步骤一：获取接入命令

建议直接从控制台复制自动生成的安装命令，不建议手动拼接接入参数。

1. 登录目标平台控制台（{{platformName}}），选择目标工作空间。
2. 在左侧导航栏进入接入中心。
<!-- platform:agentloop -->
3. 在 AI Coding Agent 接入区域选择 LoongSuite Pilot，或选择对应的 AI Coding Agent 接入卡片。
<!-- /platform -->
<!-- platform:cms -->
3. 在 AI 应用可观测区域选择 LoongSuite Pilot，或选择对应的 AI Coding Agent 接入卡片。
<!-- /platform -->
4. 在参数配置区域完成配置：
   - 选择连接方式，例如公网方式或阿里云内网方式。
   - 设置服务名前缀。Pilot 会按 `${prefix}-${agentType}` 生成最终服务名，例如 `ai-coding-agent-codex`、`ai-coding-agent-cursor`。
   - 如需 Trace 上报，开启 Trace 接入并获取 LicenseKey、Endpoint 和工作空间信息。
   - 如需日志上报，开启日志接入并完成日志资源初始化。
5. 复制页面下方生成的安装命令。

如果接入中心生成的命令仍显示占位提示，请完成对应资源初始化或参数获取后，再重新复制命令。

<!-- platform:agentloop -->
![AgentLoop 接入命令示意](https://alidocs.oss-cn-zhangjiakou.aliyuncs.com/res/2M9qP5jAr0em4O01/img/f4c0b4f3-9334-470e-a2f0-5e723c953457.png)
<!-- /platform -->
<!-- platform:cms -->
![云监控 2.0 接入命令示意](https://help-static-aliyun-doc.aliyuncs.com/assets/img/zh-CN/7695110871/p1075780.png)
<!-- /platform -->

## 步骤二：安装 LoongSuite Pilot

请在日常使用 AI Coding Agent 的同一个操作系统用户下执行安装命令。以下命令为参数示例，实际接入时请优先使用控制台生成的命令。

### macOS / Linux / WSL

```bash
curl -fsSL https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh -o /tmp/loongsuite-pilot-installer.sh && bash /tmp/loongsuite-pilot-installer.sh install \
  --collect-log "true" \
  --collect-trace "true" \
  --sls-project "<日志服务 Project>" \
  --sls-logstore "<日志服务 Logstore>" \
  --sls-endpoint "<日志服务 Endpoint>" \
  --cms-license-key "<Trace LicenseKey>" \
  --cms-endpoint "<Trace Endpoint>" \
  --cms-workspace "<Trace 工作空间>" \
  --service-name-prefix "<服务名前缀>"
```

### Windows PowerShell

```powershell
$installer = "$env:TEMP\loongsuite-pilot-installer.ps1"
Invoke-WebRequest `
  -Uri 'https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.ps1' `
  -OutFile $installer

powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer install `
  -CollectLog 'true' `
  -CollectTrace 'true' `
  -SlsProject "<日志服务 Project>" `
  -SlsLogstore "<日志服务 Logstore>" `
  -SlsEndpoint "<日志服务 Endpoint>" `
  -CmsLicenseKey "<Trace LicenseKey>" `
  -CmsEndpoint "<Trace Endpoint>" `
  -CmsWorkspace "<Trace 工作空间>" `
  -ServiceNamePrefix "<服务名前缀>"
```

安装流程中如果要求输入用户 ID，该项为选填项，用于标识本地 Pilot 采集数据所属用户，便于在 Trace 和审计日志中按用户检索。例如填写 `zhangsan` 后，上报数据会带上 `user.id=zhangsan`。

### 常用安装参数

| macOS / Linux 参数 | Windows 参数 | 说明 |
| --- | --- | --- |
| `--collect-log` | `-CollectLog` | 是否开启日志上报。设置为 `true` 时，需要同时提供日志服务 Project、Logstore 和 Endpoint。 |
| `--collect-trace` | `-CollectTrace` | 是否开启 Trace 上报。设置为 `true` 时，需要同时提供 LicenseKey、Trace Endpoint 和工作空间信息。 |
| `--sls-project` | `-SlsProject` | 日志服务 Project。 |
| `--sls-logstore` | `-SlsLogstore` | 日志服务 Logstore，通常由接入中心初始化生成。 |
| `--sls-endpoint` | `-SlsEndpoint` | 日志服务 Endpoint。公网和内网 Endpoint 不同，请以接入中心生成值为准。 |
| `--cms-license-key` | `-CmsLicenseKey` | Trace 写入鉴权使用的 LicenseKey。 |
| `--cms-endpoint` | `-CmsEndpoint` | OTLP Trace Endpoint，请使用接入中心生成的完整地址。 |
| `--cms-workspace` | `-CmsWorkspace` | Trace 工作空间标识。 |
| `--service-name-prefix` | `-ServiceNamePrefix` | 服务名前缀。Pilot 会按 `${prefix}-${agentType}` 生成最终服务名。 |
| `--userId` | `-UserId` | 可选。写入上报事件的用户标识。 |
| `--mask-mode` | `-MaskMode` | 可选。数据脱敏模式，支持 `none`、`all`、`custom`。 |
| `--mask-types` | `-MaskTypes` | 可选。`custom` 模式下指定脱敏类型，例如 `apiKey,databaseUrl`。 |

安装器会自动完成以下操作：

1. 检查 Node.js、npm、curl 或 wget 等运行依赖。
2. 下载并解压 LoongSuite Pilot 安装包。
3. 安装 Pilot 运行时依赖。
4. 自动发现当前用户下已安装并使用过的 AI Coding Agent。
5. 让您确认或选择需要采集的 Agent。
6. 写入采集配置，并完成对应 Agent 的本地接入配置。
7. 安装 `loongsuite-pilot` 服务管理命令。
8. 配置并启动本地采集服务。

Windows 安装完成后，如果当前 PowerShell 窗口中暂时找不到 `loongsuite-pilot` 命令，请重新打开一个 PowerShell 窗口后再执行。

## 步骤三：验证安装

安装完成后，先检查本地服务状态：

```bash
loongsuite-pilot status
loongsuite-pilot info
```

然后使用任一已接入的 AI Coding Agent 完成一次新的对话、代码生成或工具调用，并等待 1 到 2 分钟。

### 查看本地采集输出

macOS / Linux / WSL：

```bash
ls -lt "$HOME/.loongsuite-pilot/logs/output"
tail -f "$HOME/.loongsuite-pilot/logs/output/"*.jsonl
```

Windows PowerShell：

```powershell
Get-ChildItem "$env:USERPROFILE\.loongsuite-pilot\logs\output"

Get-ChildItem "$env:USERPROFILE\.loongsuite-pilot\logs\output\*.jsonl" |
  Sort-Object LastWriteTime |
  Select-Object -Last 1 |
  Get-Content -Wait
```

如果本地输出目录中可以看到新增 JSONL 事件，说明本机采集链路已经生效。

### 查看控制台数据

<!-- platform:agentloop -->
- 如开启日志上报，可在 AgentLoop 的 AI Agent 洞察中查看 Agent 活动事件、会话记录和工具调用审计数据。
- 如开启 Trace 上报，可在 AgentLoop 中查看对应服务的 Trace 链路；也可根据接入配置在后端 Trace 平台中检索。
- 触发一次新的 AI Coding Agent 活动后，回到 AgentLoop 控制台查看对应接入任务的数据状态。数据到达时间可能受本地批量发送和后端处理延迟影响。
<!-- /platform -->
<!-- platform:cms -->
- 如开启日志上报，可在日志服务目标 Project 的 Logstore 中检索 Agent 活动事件。
- 如开启 Trace 上报，可在云监控 2.0 的 AI 应用可观测中查看对应服务的调用链路。
- 在云监控 2.0 的应用可观测 > AI 应用可观测中，查找安装时配置的服务名前缀；进入应用后可在调用链分析中查看会话、Turn、Step、LLM 调用、工具调用、Token 消耗和耗时分布。
<!-- /platform -->

服务名通常由安装时配置的服务名前缀和 Agent 类型组成。例如服务名前缀为 `ai-coding-agent` 时，可以查找 `ai-coding-agent-codex`、`ai-coding-agent-cursor`、`ai-coding-agent-qoder` 等服务。

### 验证 Agent 采集

如果预期 Agent 没有数据，请按以下步骤检查：

1. 确认目标 Agent 已安装，并至少使用过一次。
2. 确认准入控制文件中没有将该 Agent 设置为 `off`。macOS / Linux / WSL 默认路径为 `~/.loongsuite-pilot/agent-control.json`，Windows 默认路径为 `%USERPROFILE%\.loongsuite-pilot\agent-control.json`。
3. 确认配置文件中没有将该 Agent 设置为 `"enabled": false`。macOS / Linux / WSL 默认路径为 `~/.loongsuite-pilot/config.json`，Windows 默认路径为 `%USERPROFILE%\.loongsuite-pilot\config.json`。
4. 修改配置后，执行 `loongsuite-pilot restart`。
5. 触发一次新的 Agent 活动，再查看本地输出或控制台数据。

## 管理 LoongSuite Pilot

安装完成后，可以使用 `loongsuite-pilot` 命令管理本地服务：

```bash
loongsuite-pilot start
loongsuite-pilot stop
loongsuite-pilot restart
loongsuite-pilot status
loongsuite-pilot info
```

如需开启本地状态页面，可以执行：

```bash
loongsuite-pilot monitor start
```

然后访问：

```text
http://127.0.0.1:8765/
```

## 可选：调整 Agent 采集

安装完成后，通常不需要手动修改 Agent 采集配置。如需关闭某个 Agent，或减少 Prompt、Completion、工具参数和工具结果等内容采集，可以通过本地配置文件中的 `agents` 配置调整。配置文件默认路径如下：

| 系统 | 配置文件路径 |
| --- | --- |
| macOS / Linux / WSL | `~/.loongsuite-pilot/config.json` |
| Windows | `%USERPROFILE%\.loongsuite-pilot\config.json` |

示例：

```json
{
  "agents": {
    "claude-code": {
      "enabled": true,
      "captureMessageContent": false
    },
    "cursor": {
      "enabled": true,
      "captureMessageContent": false
    },
    "qoder": {
      "enabled": false
    }
  }
}
```

| 配置项 | 说明 |
| --- | --- |
| `enabled: true` | 开启该 Agent 的采集。Pilot 仍会检测本机是否存在对应数据源。 |
| `enabled: false` | 关闭该 Agent 的采集。 |
| `captureMessageContent: false` | 尽量避免采集完整 Prompt、Completion、工具参数和工具结果。具体效果取决于对应 Agent 暴露的数据和集成方式。 |

修改配置后，需要重启 Pilot：

```bash
loongsuite-pilot restart
```

## 可选：配置数据脱敏

Pilot 可以在事件发送到输出后端前，对常见密钥进行脱敏。默认情况下无需修改该配置；敏感环境建议同时关闭完整消息内容采集，并开启脱敏。

开启全部脱敏规则：

```json
{
  "mask": {
    "mode": "all"
  }
}
```

仅开启指定脱敏规则：

```json
{
  "mask": {
    "mode": "custom",
    "types": [
      "apiKey",
      "databaseUrl"
    ]
  }
}
```

| 模式 | 说明 |
| --- | --- |
| `none` | 不进行脱敏。未配置 `mask.mode` 时默认使用该模式。 |
| `all` | 开启所有内置敏感数据规则。 |
| `custom` | 只开启 `mask.types` 中列出的脱敏类型。 |

| 脱敏类型 | 覆盖内容 | 替换标记 |
| --- | --- | --- |
| `cloudAccessKey` | 阿里云、AWS、腾讯云风格的 AccessKey ID。 | `[ACCESSKEY_MASKED]` |
| `apiKey` | OpenAI-compatible 和常见平台风格 API Key。 | `[APIKEY_MASKED]` |
| `privateKey` | PEM 或 OpenSSH 私钥块。 | `[PRIVATEKEY_MASKED]` |
| `databaseUrl` | 包含密码的数据库 URL。 | `[DATABASEURL_MASKED]` |

Pilot 重点扫描可能包含用户或工具内容的字段，例如 LLM 输入输出消息、工具调用参数、工具调用结果和已知 Agent 内容字段。模型名、Token 数、耗时、Git 分支和 Workspace 路径等稳定元数据不作为密钥内容字段扫描。

修改配置后，需要重启 Pilot：

```bash
loongsuite-pilot restart
```

## 升级和卸载

LoongSuite Pilot 会自动检查并在后台完成升级，无需手动执行升级命令；升级后会继续使用当前采集配置。

### 卸载并保留本地数据

macOS / Linux / WSL：

```bash
curl -fsSL https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh -o /tmp/loongsuite-pilot-installer.sh && bash /tmp/loongsuite-pilot-installer.sh uninstall
```

Windows PowerShell：

```powershell
$installer = "$env:TEMP\loongsuite-pilot-installer.ps1"
Invoke-WebRequest `
  -Uri 'https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.ps1' `
  -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer uninstall
```

### 卸载并删除本地数据

macOS / Linux / WSL：

```bash
curl -fsSL https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh -o /tmp/loongsuite-pilot-installer.sh && bash /tmp/loongsuite-pilot-installer.sh uninstall --purge
```

Windows PowerShell：

```powershell
$installer = "$env:TEMP\loongsuite-pilot-installer.ps1"
Invoke-WebRequest `
  -Uri 'https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.ps1' `
  -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer uninstall -Purge
```

## 常见问题

### 可以只开启 Trace 或只开启日志吗？

可以。只开启 Trace 时，将 `--collect-trace` 或 `-CollectTrace` 设置为 `true`，并填写 Trace 相关参数。只开启日志时，将 `--collect-log` 或 `-CollectLog` 设置为 `true`，并填写日志服务相关参数。

### 安装后控制台看不到数据怎么办？

先按“查看本地采集输出”确认本地 JSONL 输出目录中是否有新增事件。

如果本地没有新数据，请优先检查本机采集链路：

1. 确认 `loongsuite-pilot status` 显示采集服务正在运行。
2. 确认使用 AI Coding Agent 的操作系统用户与安装 Pilot 的用户一致。
3. 确认目标 Agent 已安装，并在 Pilot 安装后完成过一次新的真实对话、代码生成或工具调用。
4. 确认目标 Agent 没有在 `agent-control.json` 或 `config.json` 中被关闭。
5. 修改配置后，执行 `loongsuite-pilot restart`，再触发一次新的 Agent 活动。

如果本地已有新数据，但控制台暂时没有数据，请检查上报配置和平台侧延迟：

1. 确认安装命令来自当前接入任务，且 LicenseKey、Endpoint、Project、Logstore 等参数已生成。
2. 如果开启日志上报，确认日志服务 Project、Logstore 和 Endpoint 与接入中心生成值一致。
3. 如果开启 Trace 上报，确认 LicenseKey、Trace Endpoint 和工作空间信息均填写正确。
4. 等待 1 到 2 分钟后刷新控制台。短时任务可能需要等待本地批量发送和后端索引完成。

### 本地没有发现预期 Agent 怎么办？

请确认目标 Agent 已安装并至少使用过一次，且没有在 `agent-control.json` 或 `config.json` 中被关闭。修改配置后，执行 `loongsuite-pilot restart`，再触发一次新的 Agent 活动。

### 接入会影响 AI Coding Agent 的正常使用吗？

正常情况下影响较小。Pilot 以本地采集服务运行，采集结果会批量写入本地 JSONL、日志服务和目标 Trace 服务。上报失败不会阻断 AI Coding Agent 的正常使用。

### 如何减少敏感内容采集？

建议同时使用两类配置：

1. 在 `agents` 中设置 `captureMessageContent: false`，尽量避免采集完整 Prompt、Completion、工具参数和工具结果。
2. 在 `mask` 中设置 `mode: "all"` 或按需设置 `custom`，在输出前脱敏常见密钥。

修改配置后，执行 `loongsuite-pilot restart`。
