# 深度分析与验证

主 Agent 不得把「可查的假设」写成「待验证」后结束。能用 SLS 或本仓库代码证伪/证实的假设，必须查完再写进 Issue。

## 写作基本原则

> 所有产出面向一个**没参与分析的开发者**。读者不知道你做了什么中间步骤、跑了多少查询。
> 最终 Issue 必须做到：**看完能理解问题 → 能复现验证 → 能拿着建议直接修**。

### 必须遵守

1. **禁止缩写和黑话**：不要用 `pidmm`、`cmdmm`、`SNR`、`UNR` 等自造缩写。始终使用完整中文或全称
2. **数字必须有上下文**：不写 `stale 806 > pidmm 495`；写「"心跳过期"模式影响 806 个 Agent，"PID 不一致"影响 495 个 Agent」
3. **验证必须可复现**：每条验证包含完整的查询命令、返回结果摘要、结论
4. **解释必须成段落**：用自然语言的因果逻辑讲清楚，不要堆列代码符号
5. **建议必须可执行**：修复建议要指到具体文件、函数、改法，让开发者拿到就能动手

## 深度标准（合格 vs 不合格）

| 不合格 | 合格 |
|--------|------|
| 「待验证：与 XX 告警共现」 | 已查出共现 Agent 数、占比，附带完整查询命令和结果 |
| 「可能是环境问题」 | 指出具体的代码分支/条件判断，用告警消息分布或 status 字段数据佐证 |
| 只引用 alarm-code-map 表中的文件名 | 实际读了代码，用自然语言描述触发条件和调用链逻辑 |
| 多条并列假设无主次 | 有明确的**主因**，次要因素排在后面，已排除的假设标注排除理由 |
| 建议「对照大盘」 | 建议具体到修改哪个文件的哪个函数、修改思路、预期效果 |
| 用缩写堆砌 `stale 806 > pidmm 495 > restart 287` | 用表格或段落逐一解释每个模式的含义和影响范围 |

**可以留在待确认项的**：必须登录用户机器才能看的本地文件内容、无法从 SLS 字段推断的进程现场。
凡是 logstore 里有的字段，不算待确认项。

## 子 Agent 用法

对每个有告警 Agent 的 `alarm_type`（或至少 Top 影响面类型），主 Agent **必须**用 `Task` 工具启动子 Agent 做深挖（可并行）。

- `subagent_type`: 优先 `generalPurpose`（要跑 `query_sls.py` + 读代码）；只读代码扫入口时可用 `explore`
- `readonly`: 分析阶段用 `false`（需写 `data/runs/<day>/analysis/<alarm_type>.json` 验证结果）；不要改业务 `src/`
- 同一轮多个类型 → **并行**多个 Task，每个类型一个子 Agent

### 子 Agent Prompt 模板

把下面整段作为 Task `prompt`（替换尖括号）：

```text
你是 LoongSuite Pilot 异常深挖子 Agent。只分析一种告警，目标是给出可证据支撑的主因。

## 写作要求（最重要）

你的输出将被直接写入面向开发者的 Issue。读者没有参与过你的分析过程。因此：

1. **禁止使用缩写和黑话**：不要用 pidmm、cmdmm、SNR、UNR 等缩写，始终使用完整中文或英文全称
2. **数字必须有完整上下文**：不要写「stale 806 > pidmm 495」，要写「"心跳过期"模式影响 806 个 Agent」
3. **每条验证必须可复现**：包含验证目的、完整查询命令、返回结果、结论
4. **用自然语言段落解释**，不要用列表堆砌代码符号
5. **修复建议要具体到文件、函数、改法**

## 范围

- alarm_type: <ALARM_TYPE>
- 仓库根: <REPO_ROOT>
- 快照: .agents/skills/alarm-triage/data/runs/<DAY>/exceptions.json
- 代码入口表: .agents/skills/alarm-triage/references/alarm-code-map.md
- 窗口: -604800s（或与快照一致）

## 必做步骤

1. 读快照中该类型的 candidate + 相关 samples/users。
2. 在 src/ 定位所有发射点，沿调用链读触发条件（弄清“什么状态会报这个告警”）。
2b. **必须继续往下追**：顺着该触发条件找到**真正把系统推到该状态的业务/采集代码**（如 src/inputs、src/file-collection、src/flushers、src/updater），典型隐患：一次性读取超大文件、缺少增量读取/断点偏移、全量重扫、循环内同步 I/O、无背压/无重试、无上限缓存、offset 未重置、句柄泄露等。**停在分支判断/阈值层不算深挖完成；根因必须落在被监控代码上，禁止以调阈值/加抑制/降采样等降噪手段作为主结论**（除非能用代码+数据证明告警判定逻辑本身确有缺陷）。
3. 用脚本做验证查询（可多条），结果写入:
   .agents/skills/alarm-triage/data/runs/<DAY>/analysis/<ALARM_TYPE>.json
   使用:
   python3 .agents/skills/alarm-triage/scripts/query_sls.py \
     --logstore alarm|status --window -604800s --pretty \
     --query '...' --out <path>
4. 对每个假设：证实 / 证伪 / 无法远程验证（仅后者可进待确认项）。
5. 产出 Markdown 结论（返回给父 Agent），**严格使用以下结构**:

---

## 告警消息分类

用表格列出窗口内所有告警消息的模板分类（将数字/IP/路径替换为占位符后归并）：

| 消息模板 | 影响 Agent 数 | 含义说明 |
|----------|-------------:|----------|
| `updater heartbeat is stale` | 806 | Updater 进程的心跳文件超过阈值时间未更新 |
| `updater heartbeat pid N does not match running pid N` | 495 | 心跳文件中记录的 PID 与当前实际运行的 Updater 进程 PID 不一致 |
| ... | ... | ... |

## 代码分析

用**自然语言段落**描述告警的触发逻辑：

- 哪个模块/函数触发了这个告警
- 触发条件是什么（用业务语言描述，例如「当心跳文件的最后修改时间距现在超过 3 分钟时」）
- 从条件成立到告警发出经过了哪些步骤
- 如果有多个代码路径能触发同一告警，逐一说明

引用代码位置用 `文件路径:函数名` 格式。

## 验证过程

**每条验证**严格按以下结构书写：

### 验证 N：<一句话描述验证目的>

**目的**：我们想确认 XXX 是否成立。

**方法**：通过查询 SLS 的 alarm/status 日志，统计 YYY。

**查询命令**：

```bash
python3 .agents/skills/exception-issue/scripts/query_sls.py --logstore alarm --pretty --query "
<完整的 SQL 查询>
"
```

**结果**：

（表格或关键数字）

**结论**：XXX 假设成立/不成立，因为 ZZZ。

## 根因

用 1-3 段自然语言描述，每段写清因果链：

1. **主要原因**：什么条件 → 触发什么逻辑 → 导致什么结果。引用验证中的具体数据。
2. **次要原因**（如有）
3. **已排除的假设**：曾考虑但已排除的假设及排除理由

## 优先级建议

建议 P0–P3，包含 Impact / Severity / Difficulty 三维度评级和一句话理由。
（最终由主 Agent 按 references/priority.md 裁定）

## 修复建议

每条建议需包含：
- **要改什么**：涉及的文件和函数
- **怎么改**：具体的修改思路
- **预期效果**：修复后预计消除多少告警
- **风险与注意**：可能的副作用

## 待确认项

仅限无法远程验证的项（需要登录用户机器才能看的信息）。可以为空。

---

## 常用验证查询提示

- 消息模板分布、版本分布、与另一 alarm_type 的 Agent 共现率
- status 侧 init_type / updater_pid_alive / current_version_valid / node_bin_valid
- 按 input_name / endpoint_name / ver 下钻
常量 AK 等见 scripts/query_sls.py 文件头；status 查询常需 `__topic__: pilot_status`。
```

### 父 Agent 汇总

收到子 Agent 结果后：

1. **检查可读性**：所有缩写替换为全称，数字都有上下文解释
2. **检查可复现性**：验证过程包含完整的查询命令，读者能直接运行复现
3. **检查可操作性**：修复建议具体到文件、函数、改法
4. 若仍有「可查未查」或不符合写作要求的表述 → **补查/重写**，不得落盘
5. 按 [issue-format.md](issue-format.md) 的正文模板组装最终 Issue
6. 按 [priority.md](priority.md) 裁定最终 priority 写入 frontmatter
7. 验证原始 JSON 留在 `data/runs/<day>/analysis/`，Issue 里放完整的验证过程描述

## 验证查询 cookbook

以下可直接改 `ALARM` / 文案后执行。`--logstore alarm` 时 query 以分析 SQL 为主。

### 1) 某类型 message 模板 Top

```bash
python3 .agents/skills/alarm-triage/scripts/query_sls.py --logstore alarm --pretty --query "
alarm_type: UPDATER_FAILURE_ALARM | SELECT
  regexp_replace(alarm_message, '\\d+', 'N') AS msg_pattern,
  approx_distinct(concat(COALESCE(ip,''), '|', COALESCE(cast(user_id as varchar), ''))) AS agent_count
GROUP BY msg_pattern ORDER BY agent_count DESC LIMIT 20
"
```

### 2) 两类型 Agent 共现

```bash
python3 .agents/skills/alarm-triage/scripts/query_sls.py --logstore alarm --pretty --query "
* | SELECT
  approx_distinct(ak) AS agents_a,
  approx_distinct(CASE WHEN has_b > 0 THEN ak END) AS agents_both,
  round(approx_distinct(CASE WHEN has_b > 0 THEN ak END)*100.0/approx_distinct(ak), 2) AS both_pct
FROM (
  SELECT concat(COALESCE(ip,''), '|', COALESCE(cast(user_id as varchar), '')) AS ak,
    max(CASE WHEN alarm_type='UPDATER_NOT_RUNNING_ALARM' THEN 1 ELSE 0 END) AS has_a,
    max(CASE WHEN alarm_type='SERVICE_NOT_RUNNING_ALARM' THEN 1 ELSE 0 END) AS has_b
  GROUP BY ak
) WHERE has_a = 1
"
```

（按需改两种 `alarm_type`；先限定 has_a 的类型。）

### 3) 版本分布

```bash
python3 .agents/skills/alarm-triage/scripts/query_sls.py --logstore alarm --pretty --query "
alarm_type: PROCESS_RESOURCE_ALARM | SELECT ver,
  approx_distinct(concat(COALESCE(ip,''), '|', COALESCE(cast(user_id as varchar), ''))) AS agent_count
GROUP BY ver ORDER BY agent_count DESC LIMIT 20
"
```

### 4) status：init_type / 守护存活（需 topic）

```bash
python3 .agents/skills/alarm-triage/scripts/query_sls.py --logstore status --pretty --query "
__topic__: pilot_status and project: * | SELECT init_type,
  count(*) AS agents
FROM (
  SELECT concat(COALESCE(ip,''), '|', COALESCE(hostname,''), '|', COALESCE(user_id,'')) AS sk,
    max_by(init_type, __time__) AS init_type
  FROM log GROUP BY sk
) GROUP BY init_type ORDER BY agents DESC
"
```

查询失败时：修正 SQL 再跑，不要改用「待验证」糊弄过去。
