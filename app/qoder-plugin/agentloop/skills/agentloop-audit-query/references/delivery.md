# SQL 与接入包交付

同一查询可用于查询框、CLI 或 SDK；图表 JSON 不是查询 API 的输入。按用户需要选择交付物，不默认附上完整报表或创建服务。

## 查询契约

一次交付至少明确：

| 项 | 内容 |
|---|---|
| 查询口径 | 计数对象、分母、来源范围 |
| 环境 | Project、Region、承载 Logstore；跨表权限、索引字段和外表映射 |
| 参数 | from/to 为 Unix 秒整数、时区、左闭右开；筛选值及类型、空值/全部语义、桶宽、TopN 或分页 |
| 完整查询 | `检索 | WITH ... SELECT ...`，展开所有 CTE 和模板，保留需要的跨表时间条件 |
| 输出 | 列名、业务含义、数值单位、NULL 含义、去重/归并键；接口字符串数值由调用方按约定转换 |
| 完整性 | SQL LIMIT / 原文分页协议、完成状态、上限、稳定排序、样本与全量边界 |
| 验证 | 本轮目标实测 / 参考环境实测 / 离线验证 / 未执行；实际时间、参数与失败限制 |

模板可保留具名参数供调用方展开，但同时给一份已展开可粘贴的示例。分享用的示例使用合成身份与非敏感值。表名/排序使用白名单，整数校验后展开，字符串按 SQL 规则转义。SQL 内时间与接口 from/to 必须来自同一次参数绑定；SDK 函数开放 start/end 参数时不能仍在 SQL 中保留示例固定时间。SLS 仪表盘 `${{ }}` 不能直接当作 SDK 绑定变量。

## CLI

插件环境使用 [execution](execution.md) 的 `scripts/run.py audit`，显式传目标、范围和最终 query。已有 SLS CLI 时可使用其 GetLogsV2 入口，按当前 CLI 帮助确认参数/响应；不要求用户安装本插件才能消费 SQL。调用前后的 shell 转义不得改变 SQL 内的双引号，复杂 SQL 优先使用参数数组或请求文件。

GetLogsV2 结构包括 query、from、to；纯检索用 line/offset 分页，分析 SQL 用 `ORDER BY ... LIMIT offset,count`，不要用接口 line 或 offset 声称分析结果已取全。完成状态为 meta.progress；执行成功但 Incomplete 的结果不能标为准确全量。

## Python SDK 调用骨架

客户端由客户现有鉴权初始化，下面只消费已配置的 client；不创建第二套凭据管理。SDK 已存在时才运行，不自动添加依赖。

```python
from aliyun.log import GetLogsRequest


def query_complete(client, project, logstore, start, end, query_template):
    if not isinstance(start, int) or not isinstance(end, int) or start >= end:
        raise ValueError("Expected an ordered Unix-second interval")
    if "{{from}}" not in query_template or "{{to}}" not in query_template:
        raise ValueError("Expected both numeric time placeholders")
    query = query_template.replace("{{from}}", str(start)).replace("{{to}}", str(end))
    request = GetLogsRequest(project, logstore, start, end, "",
                             query=query, line=100, offset=0, reverse=False)
    for _ in range(3):
        response = client.get_logs(request)
        if response.is_completed():
            return [dict(row.contents) for row in response.get_logs()]
    raise RuntimeError("Query remains incomplete; do not report an exact result")
```

此骨架消费含 `{{from}}` / `{{to}}` 整数时间标记的模板，用同一 start/end 展开 SQL 与接口时间；其他筛选先按类型安全展开。这里只返回完整的一页/一个 SQL 结果集；需要下一页时按查询类型构造下一条请求。服务封装应加超时、受控退避、查询预算与错误分类，权限失败不换账号自动重试。distinct、比例和分位数不能在分页/分时后随意相加。

SDK `is_completed()` 与 CLI meta.progress 是不同响应封装。参考 [SLS Python 查询示例](https://help.aliyun.com/en/sls/developer-reference/use-getlogs-to-query-logs-46) 和 [分页查询](https://help.aliyun.com/en/sls/paged-query)，按客户实际 SDK/API 版本验证，不从工具包装后的 success 标记推断分析已完成。

## 验证记录

需要保存验证记录时，与 SQL 或报表放在当前项目的 `output/audit/reports/`，或用户指定的交付目录；记录查询范围、参数摘要、窄窗与完整范围的完成状态及检查结果。

单条聚合验证类型与分母；分页验证稳定排序、跨页边界和返回总量；同比验证历史范围与窗口重叠；外表 JOIN 验证身份映射、重复归属、零用量分母与覆盖；实体验证数组类型、稳定 ID、事实/风险分离和证据链。参考环境有数据不代表已验证所有字段组合或产品 UI 对账。
