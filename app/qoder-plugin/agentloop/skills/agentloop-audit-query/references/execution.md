# 查询执行与环境绑定

查询知识不依赖仪表盘制作能力。已有 SLS 查询工具、CLI 或 SDK 时复用它；使用这些 Skill 时优先使用下列 Setup 共享入口与当前选中的 Profile。不要为查询创建第二套鉴权或读取凭据文件。

## Skill 脚本入口

在当前项目目录调用 Setup 的共享入口。实际取日志时，始终显式传入已确认的 Unix 秒时间范围和承载 Logstore。`<agentloop-collector-setup目录>` 替换为 Setup Skill 的安装路径：

```bash
python3 "<agentloop-collector-setup目录>/scripts/run.py" audit --project <project> --region <region> --logstore <logstore> --from <from> --to <to> --query '<已展开的检索或 SQL>' --line 100 --offset 0
```

找不到 `python3` 时用 `python`。Windows 的入口为 `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "<agentloop-collector-setup目录>/scripts/run.ps1" audit`，参数相同；包含 SQL 双引号时应检查实际传参，未验证的平台不得宣称通过。

脚本在参数完整、无冲突时更新本地目标记录。AgentLoop 目标用 `--agent-space` 与 `--region` 解析，可另加 `--logstore`；直接 SLS 目标用 `--project`、`--region`、`--logstore`。两种目标不混传 `--agent-space` 与 `--project`，显式 Project 绑定会清除旧 AgentSpace 关联。

直接 SLS 目标的 Project 或 Region 任一变化，本次都须显式提供完整三项，缺项不修改记录。只有同 Project 且 Region 未变时，才可沿用其他已确认字段。该范围内的多源任务先记录原日志库；结束时仅在本轮改变过默认表且用户未要求保留时，用 `audit --logstore <原表> --list` 恢复，不能固定改回 agent-event。跨 Project 或 Region 恢复时同样提供完整原目标。`--list` 不取日志。独立 SLS 工具按请求绑定目标，无需模拟此本地状态行为。

Project、Region、可用表、组织及账单映射取本次目标的配置。目标不完整时请用户补缺项，不推测地域。命名 AgentSpace 时同时提供 `--agent-space` 和 `--region`。Region 使用地域 ID；SLS endpoint 为 `{region}.log.aliyuncs.com`，不要与 CMS OTLP 地址互换。

脚本有最近一小时的底层默认值，但 Skill 不依赖它。时间未确认时先询问；不得运行任何日志/统计探测。环境元数据检查不等于时间范围授权。

SQL 写法与分页见 [SQL 写作技巧](sql-writing.md)。日志库查询的 stdout 为 GetLogsV2 JSON；检查 meta.progress，完成后再交付结果。

## Dataset 查询

用户给出 AgentSpace 和 Dataset 时使用这条分支。它不读取审计目录、schema 或枚举标签，也不改当前日志库目标。字段以该 Dataset 的 schema 为准。

```bash
python3 "<agentloop-collector-setup目录>/scripts/run.py" audit --agent-space <agent-space> --region <region> --dataset <dataset> --from <from> --to <to> --query '<SELECT 或 * | SELECT>' --line 100 --offset 0
```

脚本调用 `aliyun agentloop execute-query --type SQL`，并把 `--dataset` 传成 `--dataset-name`。`--line` 对应 `--length`，上限仍是 100。stdout 是 execute-query JSON，用 `columns` 与 `rows` 按位置对齐，不是 GetLogsV2 的 `data`。检查 `meta.progress`。

身份需要 RAM 动作 `agentloop:ExecuteQuery`，资源为 `acs:agentloop:<region>:<account>:agentspace/<agent-space>/dataset/<dataset>`。OAuth 登录范围是该账号可调用的全部 API。按最小权限创建的 RAM 用户要单独授予这个动作；它不区分只读 SQL 和写入语句。

账户与查询目标切换按 Setup 的[账户与查询目标切换](../../agentloop-collector-setup/references/auth.md)完成。`audit --list-spaces` 返回 `{spaces:[{agentSpace,regionId}]}`，只列空间，不更改 Profile 或目标，可用 `--region` 缩小范围；选定后按上述 AgentSpace 或直接 Project 参数执行 `audit --list` 绑定，成功返回当前上下文 JSON。元数据操作不要求日志时间、不取日志；实际查询才执行上述时间确认流程。

## 报错

登录没完成，或用户说明是国际站、要用 AccessKey 时，按 [鉴权说明](../../agentloop-collector-setup/references/auth.md) 完成登录。授权与目标确认后重新执行查询，使用当前已确认目标，保留原来的查询语句、时间范围、分页和 `--list` 等业务参数。

### 退出码 1

看 stderr：

- `Query target changed or incomplete. Missing explicit --region, --logstore. Pass --project, --region, and --logstore together.`：这是缺少本次显式参数的示例；`Missing explicit` 按实际输入动态列出缺项，顺序为 project、region、logstore。直接 SLS 目标的 Project 或 Region 改变，或目标不完整时，本次须补齐完整三项，不能沿用旧字段；失败不修改原目标。
- `Cannot combine --agent-space with --project. Choose one query target.`：按用户目标选择 AgentSpace 或直接 SLS Project 方式，不能同时传两者；冲突不修改原目标。
- `Pass --region. Choosing an AgentSpace requires its region. Do not use a default region.`：请用户填写 regionId，不要自己补默认地域。
- `No AgentSpace found`：账号下没有空间。
- `AgentSpace is missing slsProject or regionId`：选中的空间没有查询要用的字段。
- `Missing --query. Search example: * . Stats example: * | SELECT count(*)`：没有查询语句。
- `Cannot combine --dataset with --project or --logstore.`：Dataset 查询只使用 AgentSpace、地域和 Dataset，不要同时传 Project 或 Logstore。
- `Cannot combine --dataset with --list or --list-spaces.`：`--dataset` 只执行查询，不列举空间，也不改绑定。
- `Dataset query target is incomplete. Missing explicit --region, --dataset. Pass --agent-space, --region, and --dataset together.`：这是缺项示例。`--dataset` 存在时必须同时给出 `--agent-space`、`--region` 和 `--dataset`，失败不修改原日志库目标。
- `query returned no columns/rows`：execute-query 没有返回可按位置对齐的 `columns` 与 `rows`。
- `--from must not be later than --to`、`--line must be greater than 0`、`--line must not exceed 100`、`--offset must not be less than 0`，或参数名后接 `is not a number`：按提示改正参数。

### 退出码 7

stdout 每行是 `agentSpace regionId`。这些行不一定包含账号下的全部空间。某个地域查询失败，或列举达到分页上限时，对应空间不会出现。把这些行发给用户选。用户的空间不在列表里时，请用户给出名称和 regionId。选定后沿用上面的入口重新执行，原样保留查询语句、时间范围、分页和 `--list` 等已有参数，只增加 `--agent-space` 和 `--region`。

### 其他失败

其他失败时，根据 stderr 核对 CLI 参数、权限与网络；必要时查看脚本的实际调用，并单独重试同一请求定位原因。向用户说明错误和未完成的查询。
