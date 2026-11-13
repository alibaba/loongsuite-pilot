# 登录、账户与查询目标切换

Setup 提供安装、查询、预览和发布共用的专用 CLI 与多 Profile 环境，默认 Profile 为 `loongsuite-pilot`。用户只需说明要登录、切账户或切换查询目标，由 Agent 组织参数；只有明确安装 Pilot 时才询问 `user.id` 并生成安装包。仅准备环境不查询日志，也不询问日志时间。

## 执行入口

在当前项目目录执行，`<agentloop-collector-setup目录>` 替换为 Setup Skill 的安装路径；后续重试沿用同一入口，只执行当前平台对应的一条命令。

Linux 和 macOS 使用 Python，找不到 `python3` 时用 `python`：

```bash
python3 "<agentloop-collector-setup目录>/scripts/run.py" auth
```

Windows 使用本机原生 PowerShell，参数相同：

```powershell
powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "<agentloop-collector-setup目录>/scripts/run.ps1" auth
```

下文以 `auth`、`audit` 表示同一入口后的子命令。Setup 自身提供 `auth` 与 `install`；`audit` 与查询目标绑定需要相邻的 Query Skill，`report`、`publish` 需要 Builder。

## 专用 CLI 与 Profile

- Qoder 插件使用插件根的 `aliyun/`。独立安装默认使用 Setup 根的 `aliyun/`；Setup 尚未配置且相邻 Query 的 `aliyun/config.json` 已存在时，脚本沿用该目录，不要求手动迁移。
- 这些目录与终端默认 `~/.aliyun/` 分开，每个命名 Profile 独立保存凭证。Agent 不读取、复制或输出凭证文件；账户选择通过下述安全元数据完成。

## 查看可选账户

用户要切账户但未给出 Profile 名称时，先执行 `auth --list`。它只返回本地安全元数据，不访问云端、不下载 CLI，也不修改选中状态。JSON 结构示例：

```json
{
  "selected_profile": "<当前Profile>",
  "profiles": [
    {
      "name": "<Profile名称>",
      "mode": "OAuth",
      "site_type": "CN",
      "configured": true,
      "selected": true
    }
  ]
}
```

向用户展示名称、登录方式和站点，标明当前项，询问选用哪一项或为新账户指定名称。`configured` 只代表本地已配置，不代表凭证仍有效或云端授权已验证；`selected` 表示当前选择。不要打开 `aliyun/config.json` 获取更多内容。

## 自然切换账户

1. 用户已经给出 Profile 名称时，直接执行 `auth --profile "<名称>"`；未给出时，先按上节列出可选名称，再让用户选择或命名新账户，不擅自改名。
2. 已配置的 Profile 按脚本识别的登录方式使用；新名称默认走 OAuth。浏览器打开后，让用户选择对应云账号完成登录。
3. 登录失败或未完成时，保留原 Profile 与原目标，不宣称已切换。必要时用 `auth --list` 确认当前选择。
4. 成功切换到不同 Profile 后，脚本清除旧的 AgentSpace、Project、Region 与 Logstore 目标，再确认新账户下的查询目标：AgentLoop 使用 AgentSpace 与地域，直接 SLS 使用 Project、Region 与 Logstore。需要选择空间时，执行 `audit --list-spaces` 获取候选。
5. 按下一节完成绑定，再继续用户已经提出的查询或发布任务。只有切账户需求时，简短回报当前账户与已确认目标即可，不主动查数。

## 切换查询目标

保持当前 Profile，按用户目标使用同一 `audit --list` 入口。Agent 根据用户说明与已确认上下文补齐参数，只询问必要缺项，不要求用户手写完整命令。

AgentLoop 场景主要使用空间名称与地域，由脚本解析对应 Project，默认日志库为 `agent-event`；需要其他日志库时显式传入 `--logstore`：

```bash
python3 "<agentloop-collector-setup目录>/scripts/run.py" audit --agent-space "<名称>" --region "<region>" --list
```

直接使用 SLS Project 时，确认 Project、Region 与 Logstore：

```bash
python3 "<agentloop-collector-setup目录>/scripts/run.py" audit --project "<project>" --region "<region>" --logstore "<logstore>" --list
```

Windows 使用同一共享入口的 `run.ps1`，参数不变。绑定成功返回当前目标上下文 JSON，不查询日志，也不要求日志时间或生成采集器安装包。

- 直接绑定 SLS 时，Project 或 Region 任一变化，本次命令都必须显式给出完整的 `--project`、`--region`、`--logstore`；缺项时不修改原目标。只有同 Project 且 Region 未变时，才可沿用其他已确认字段，例如仅用 `--logstore` 切换日志库。
- 显式指定 `--project` 会清除旧 AgentSpace 关联，避免直接 Project 目标保留空间标签。
- `--agent-space` 与 `--project` 不能同时传入；AgentSpace 与 `--logstore` 可以组合，先解析空间，再选择日志库。参数不完整或冲突时先补齐、纠正，再绑定，不宣称已切换。

用户尚未给出空间名称时，执行 `audit --list-spaces`；已知地域可加 `--region "<region>"` 缩小范围。返回空间元数据 JSON：

```json
{
  "spaces": [
    {"agentSpace": "<空间名称>", "regionId": "<region>"}
  ]
}
```

列空间不更改当前 Profile 或目标，也不查询日志。某个地域查询失败或达到分页上限时，列表可能不完整；允许用户直接提供名称和地域。选定后按上述入口完成绑定，简短回报 AgentSpace（适用时）、Project、Region 与 Logstore，再继续原任务。

`audit --list` 不是通用空间枚举接口：已有目标时返回当前上下文 JSON；未绑定时可能提示候选，退出码 7 才按每行 `agentSpace regionId` 处理。

## 站点与登录方式

未指定时使用国内站 OAuth，不额外加 `--auth-mode` 或 `--oauth-site-type`。用户已说明要求时直接采用，不重复询问。

- 国际站：在 `auth` 上加 `--auth-mode OAuth --oauth-site-type INTL`；`INTL` 对应 alibabacloud.com。
- AccessKey：Agent 不执行配置命令，也不让用户把 AccessKey Id 或 Secret 发到对话里。请用户在本机终端执行脚本 stderr 给出的完整 `configure --mode AK` 命令，保留其中的 `--config-path` 与 Profile。用户确认配置后，再执行 `auth --profile "<名称>" --auth-mode AK`，不加 `--oauth-site-type`；仍提示配置时重复终端引导，不打开凭证文件。

登录报错且站点、方式尚未明确时，再询问 CN／INTL 与 OAuth／AccessKey，按选择重试。授权参数只传给 `auth`。

## 继续原任务

认证与目标绑定完成后，重新执行原来的 `install`、`audit`、`report` 或 `publish`。查询目标使用本次已确认的绑定，保留原任务的用户标识、查询、时间范围、分页和其他业务参数，不盲目复用切换前的目标。没有查询或报表任务时，到环境确认结束，不额外运行日志或统计探测。
