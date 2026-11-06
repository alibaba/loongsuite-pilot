# 查询执行与环境绑定

查询知识不依赖仪表盘制作能力。已有 SLS 查询工具、CLI 或 SDK 时复用它；安装本插件时优先使用下列入口与已保存的登录。不要为查询创建第二套鉴权或读取凭据文件。

## 插件入口

在当前项目目录调用插件脚本，始终显式传入已确认的 Unix 秒时间范围和承载 Logstore。`<插件目录>` 替换为插件安装路径：

```bash
python3 "<插件目录>/scripts/run.py" audit --project <project> --region <region> --logstore <logstore> --from <from> --to <to> --query '<已展开的检索或 SQL>' --line 100 --offset 0
```

找不到 `python3` 时用 `python`。Windows 的入口为 `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "<插件目录>/scripts/run.ps1" audit`，参数相同；包含 SQL 双引号时应检查实际传参，未验证的平台不得宣称通过。

插件的 `--project`、`--logstore`、`--region` 会更新本地目标记录，其余项沿用 `~/.loongsuite-pilot/audit/config-record.json`。多源任务先记录原目标；结束时仅在本轮改变过默认表且用户未要求保留时，用 `audit --logstore <原表> --list` 恢复原表，不能固定改回 agent-event。`--list` 不取日志。独立 SLS 工具按请求绑定目标，无需模拟此本地状态行为。

Project、Region、可用表、组织及账单映射取本次目标的配置。目标不完整时请用户补缺项，不推测地域。命名 AgentSpace 时同时提供 `--agent-space` 和 `--region`。Region 使用地域 ID；SLS endpoint 为 `{region}.log.aliyuncs.com`，不要与 CMS OTLP 地址互换。

脚本有最近一小时的底层默认值，但 Skill 不依赖它。时间未确认时先询问；不得运行任何日志/统计探测。环境元数据检查不等于时间范围授权。

SQL 写法与分页见 [SQL 写作技巧](sql-writing.md)。stdout 为 GetLogsV2 JSON；检查 meta.progress，完成后再交付结果。

## 报错

登录没完成，或用户说明是国际站、要用 AccessKey 时，按 [鉴权说明](../../references/auth.md) 完成登录。授权完成后原样重新执行查询，保留原来的查询目标、时间范围、分页和 `--list` 等全部参数。

### 退出码 1

看 stderr：

- `Query target is incomplete. Missing ... project, logstore, and region are required.`：这次传入的和记录里已有的合在一起后，project、logstore、region 仍缺 `Missing` 后面列出的项。请用户补上缺的项，不要改用 AgentSpace 推导。
- `Pass --region. Choosing an AgentSpace requires its region. Do not use a default region.`：请用户填写 regionId，不要自己补默认地域。
- `No AgentSpace found`：账号下没有空间。
- `AgentSpace is missing slsProject or regionId`：选中的空间没有查询要用的字段。
- `Missing --query. Search example: * . Stats example: * | SELECT count(*)`：没有查询语句。
- `--from must not be later than --to`、`--line must be greater than 0`、`--line must not exceed 100`、`--offset must not be less than 0`，或参数名后接 `is not a number`：按提示改正参数。

### 退出码 7

stdout 每行是 `agentSpace regionId`。这些行不一定包含账号下的全部空间。某个地域查询失败，或列举达到分页上限时，对应空间不会出现。把这些行发给用户选。用户的空间不在列表里时，请用户给出名称和 regionId。选定后沿用上面的入口重新执行，原样保留查询语句、时间范围、分页和 `--list` 等已有参数，只增加 `--agent-space` 和 `--region`。

### 其他失败

其他失败时，根据 stderr 核对 CLI 参数、权限与网络；必要时查看脚本的实际调用，并单独重试同一请求定位原因。向用户说明错误和未完成的查询。
