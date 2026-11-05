# 查询执行与环境绑定

查询知识不依赖仪表盘制作能力。已有 SLS 查询工具、CLI 或 SDK 时复用它；安装本插件时优先使用下列入口与已保存的登录。不要为查询创建第二套鉴权或读取凭据文件。

## 插件入口

在插件根目录执行，始终显式传入已确认的 Unix 秒时间范围和承载 Logstore：

```bash
python3 scripts/run.py audit --project <project> --region <region> --logstore <logstore> --from <from> --to <to> --query '<已展开的检索或 SQL>' --line 100 --offset 0
```

找不到 `python3` 时用 `python`。Windows 的入口为 `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File scripts/run.ps1 audit`，参数相同；包含 SQL 双引号时应检查实际传参，未验证的平台不得宣称通过。

插件的 `--project`、`--logstore`、`--region` 会更新本地目标记录，其余项沿用 `~/.loongsuite-pilot/audit/config-record.json`。多源任务先记录原目标；结束时仅在本轮改变过默认表且用户未要求保留时，用 `audit --logstore <原表> --list` 恢复原表，不能固定改回 agent-event。`--list` 不取日志。独立 SLS 工具按请求绑定目标，无需模拟此本地状态行为。

Project、Region、可用表、组织表及身份映射属于客户环境配置，不写入公开 schema。目标不完整时请用户补缺项，不推测地域。命名 AgentSpace 时同时提供 `--agent-space` 和 `--region`。Region 使用地域 ID；SLS endpoint 为 `{region}.log.aliyuncs.com`，不要与 CMS OTLP 地址互换。

脚本有最近一小时的底层默认值，但 Skill 不依赖它。时间未确认时先询问；不得运行任何日志/统计探测。环境元数据检查不等于时间范围授权。

## 字符串、标识符与参数

- 带点字段和带连字符表名使用双引号，如 `"user.id"`、`"agent-event"`；标识符只能来自已确认映射。
- SQL 字符串以单引号包裹，其中的单引号加倍。搜索语法与 SQL 语法分别转义；不要把未经处理的输入拼成 WHERE。
- `${{key|default}}` 属于 SLS 仪表盘变量。CLI / SDK 不会替换它，交付前必须按类型展开，不能传残留模板。
- 时间、页大小、偏移和桶宽校验为整数及有效范围；维度、排序、表名使用白名单，不接受任意表达式作为参数。
- 展示标签查 [枚举](value-labels.md)；筛选和下钻保留原始值、来源与身份上下文。

## 响应完整性与分页

插件 stdout 是 GetLogsV2 JSON，单次 `--line` 上限 100。依据实际返回封装识别结果与查询完成标志，不能把查询未完成、网络失败、权限不足或截断解释为 0。

- 分析 SQL 用 `ORDER BY ... LIMIT offset,count` 控制结果与分页，接口 line/offset 不作为 SQL 分页依据。排名明确为 TopN；需要全部分组时使用稳定排序，逐页检查完成状态。工具包装另有返回上限时同时检查。
- 原始日志：沿用范围和筛选分页；单页 100 条只说明样本。时间序列采用时间、纳秒时间、稳定 ID 排序；跨表分别取页时须全局归并后截页。
- 大结果集按不重叠的时间片查询并记录覆盖；distinct、分位数和比例不可对分片结果直接相加或平均。只在指标可加时合并聚合结果。
- 执行未完成时保留相同参数重试或缩窗检查，返回“不完整”的边界；有副作用的安装、发布不属于查询重试。

## 报错

登录没完成，或用户说明是国际站、要用 AccessKey 时，先读 [共享鉴权说明](../../references/auth.md)。不要在这里重写鉴权步骤。授权完成后原样重新执行查询，保留原来的查询目标、时间范围、分页和 `--list` 等全部参数。

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

上面的退出码和 stderr 都对不上时，可以阅读脚本，看它实际调用了哪条命令，把这条命令单独拿出来执行，用来确认失败原因。要改参数时，只改你单独执行的那条命令。尽量不要改文件。单独执行的命令已经跑通之后，才可以把同样的改动写回文件。改文件要慎重，改过的文件会被后面的查询接着使用。
