# 数据源选择

先按 [核心面板目录](catalog.md) 选计数对象，再读 [schema](schema.md) 对应 Source。表是否存在、是否有数据、索引字段是否齐全，由本轮目标环境确认；不在公共资料记录某个空间的行数或表清单。

| 逻辑来源 | 实际表 | 使用范围 |
|---|---|---|
| `agent_events` | `agent-event` + `agent-event-webtracking` | 应用行为、模型响应 Token、工具、显式 Skill、缓存与拦截事实；字段兼容按 schema，两表 UNION ALL |
| `runtime_events` | `ebpf-event` | eBPF 运行时观测；先确认公开字段与目标索引，不能当成应用表自动加入每一条查询 |
| `intent_events` | `audit-event` | 限定意图事件名，包含普通与风险意图；不是整张审计表 |
| `security_findings` | `audit-event`，可选历史 `security-event` | 安全检测发现；排除同域中的意图事件，不能冒充已确认风险 |
| `incident_events` | `incident-event` | 高保真风险、用户风险和证据回溯 |
| `entity_facts` | 已确认的安全发现及 Skill 上下文来源 | 实体清单、画像与共现；实体数组和稳定标识须有字段契约，风险附着来自 incident |
| `dept_roster` | 客户组织表，例如 `department` | 可选扩展：在册人数、组织归属、覆盖率与未使用人群 |

应用侧默认合并两条写入链路；确认只有一张可用时裁剪不存在表并披露来源覆盖，不能引用不存在表再用 COALESCE 兜底。混合 runtime/application 时分别保留 source_scope，未确认独立观测含义时不能把两者简单相加称作全量。

审计与风险的用户/Agent 列是 `"user"`、`agent_type`；应用表是 `"user.id"`、`"gen_ai.agent.type"`。应用源适配、意图、风险字段详见 schema；安全发现/实体及拦截的补充契约分别在主题配方中。

部门表是客户扩展，不要求所有环境有；有真实表时先验证用户映射、单人多归属与快照边界，没有时只能给明确标注的假设 JOIN 示例。轨迹、分析结果和其他未披露契约不猜字段；说明限制并使用已有公开数据可支持的范围。
