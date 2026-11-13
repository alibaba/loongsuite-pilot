---
name: agentloop-collector-setup
description: |
  安装采集器（loongsuite-pilot）。用户要安装、配置或重新获取 loongsuite-pilot 时使用。
  Triggers: "安装 loongsuite-pilot", "安装 pilot", "安装采集器", "loongsuite-pilot", "配置 loongsuite-pilot".
---

# 安装 loongsuite-pilot

判断用户要安装之后，先在对话里请用户选一个用户标识，不要先执行脚本，也不要自己挑。安装会生成一个 zip。

请用户选择用什么表示用户标识（user.id）。该值用于之后的追踪和审计的个人标识，请让用户根据自己的情况进行选择。问的时候不要出现 `--user-id-source`，也不要说存量安装。选项按下面的说明展示：

- 主机名：这台电脑的主机名
- Qoder 用户名：用户名可能会更换，企业版一般不能更换
- Qoder 邮箱：Qoder 登录邮箱
- 不设置：使用用户 ID 进行标识。这是旧选项，CLI 场景提取不到，IDE 场景可以提取到

用户选定后再决定参数。主机名传 `--user-id-source hostname`，Qoder 用户名传 `--user-id-source username`，Qoder 邮箱传 `--user-id-source email`。选了不设置就不要传 `--user-id-source`。

本技能与 [agentloop-audit-query](../agentloop-audit-query/SKILL.md) 相邻安装，安装与授权共用 Query Skill 的脚本。得到回复后，在当前项目目录调用该脚本，`<agentloop-audit-query目录>` 为 Query Skill 的安装路径。后续重试沿用同一入口，只改参数。用户标识一旦选过，后续命令都带上同一个 `--user-id-source`。

## 环境

先检测当前环境，只执行对应的一条命令。

### Linux 和 macOS

找不到 `python3` 时用 `python`。

```bash
python3 "<agentloop-audit-query目录>/scripts/run.py" install [--user-id-source <hostname|username|email>]
```

### Windows

参数名与 Linux 和 macOS 相同。

```powershell
powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "<agentloop-audit-query目录>/scripts/run.ps1" install [--user-id-source <hostname|username|email>]
```

不要自己做登录、查询、写配置或安装 Pilot。把脚本输出告诉用户，不要贴出 license key、API key 或 AccessKey。查日志用 `audit` 子命令，见查询技能。

成功时，stdout 有一行 `enterprise_zip=<路径>`。先确认这个文件存在，再展示给用户。Linux 和 macOS 用 `ls -l`，Windows 用 `Get-Item`，记下真实大小和修改时间。文件不存在就直说，不要给打不开的链接。

先只展示可点击的文件链接。一句话说明 zip 已生成，带上大小和修改时间，并说明这个 zip 可以本地解压后安装试用，也可以到管理市场下发。然后用文件名做 Markdown 链接，URI 是 `file://` 加绝对路径：

```markdown
[loongsuite-pilot-installer.zip](file:///Users/xxx/.loongsuite-pilot/audit/loongsuite-pilot-installer.zip)
```

这个链接能展示成可点击文件时，不要再附纯文本路径。只有链接展示不出来时，再补一段代码块里的绝对路径，方便复制：

```
/Users/xxx/.loongsuite-pilot/audit/loongsuite-pilot-installer.zip
```

路径必须是绝对路径。`~` 展开成真实家目录。空格写成 `%20`。Windows 路径先把反斜杠换成正斜杠，再写成 `file:///C:/...`。点击后在访达或资源管理器里打开该文件，不会在对话里预览 zip。不要说已经放进产出面板。不要打开 zip，也不要贴出里面的配置。

## 报错

登录没完成，或用户说明是国际站、要用 AccessKey 时，先读 [鉴权说明](../agentloop-audit-query/references/auth.md)。不要在这里重写鉴权步骤。授权完成后再执行原来的安装命令，只保留 `--user-id-source`、`--agent-space`、`--region`。没选用户标识时不要补 `--user-id-source`。

脚本提示缺少地域时，请用户填写 regionId，再带上 `--agent-space` 和 `--region` 执行。不要自己补 `cn-hangzhou` 或其他默认地域。

### 退出码 7

这时才请用户选 AgentSpace。

输出里这几行分别是：

- `enterprise installed`：已经生成过 zip。没有这一行就是还没生成过。有这一行时，提醒用户之前已经生成过安装包，这次是重新生成。
- `previous <agentSpace> <regionId>`：上次的选择，可以推荐沿用。
- 其余每行是一个 `agentSpace regionId`。

获得数据之后列出选项，每一行一个选项，选项文字写 `agentSpace` 和 `regionId`，尽量不要漏行。这些行不一定包含账号下的全部空间。某个地域查询失败，或列举达到分页上限时，对应空间不会出现在输出里。

让用户选择时尽量选几个推荐的，用选择框的形式让用户可以点击选择。选择框里再留一项，让用户自己填写名称和 regionId。并说明这份列表不一定完整。

选定后沿用上面的入口重新执行，保留已经选过的 `--user-id-source`，并带上 `--agent-space` 和 `--region`。没选用户标识时不要补 `--user-id-source`。

### 其他失败

上面的退出码和 stderr 都对不上时，可以阅读脚本，看它实际调用了哪条命令，把这条命令单独拿出来执行，用来确认失败原因。要改参数时，只改你单独执行的那条命令。尽量不要改文件。单独执行的命令已经跑通之后，才可以把同样的改动写回文件。改文件要慎重，改过的文件会被后面的安装接着使用。
