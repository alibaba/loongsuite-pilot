---
name: alarm-triage
description: >-
  从 LoongSuite Pilot exception_monitor 同源 SLS 拉取异常，对每个告警类型用子 Agent 深挖代码与数据、
  用 SLS 查证假设后写出可证据支撑的根因，输出 Issue 到 Code 平台并通过标签去重。
  在异常巡检、定期开 Issue、根因分析时使用。禁止只拉数、禁止留下能查却不查的「待验证」。
---

# Alarm Triage（告警分诊）

## Purpose

定期（或按需）从 exception_monitor 同源数据拉取异常，**深挖本仓库代码 + SLS 验证**，输出 Issue 到
[Code 平台](https://code.alibaba-inc.com/sls/loongsuite-pilot/issues)。

去重通过 Code 平台 Issue 标签实现：搜标签 `pilot-alarm` + `<alarm_type>`，已有未关闭则追加评论。

**硬性要求**：

1. 脚本只取数 / 出骨架；合格 Issue 必须有 `## 验证过程`、`## 根因`、`## 优先级`
2. 凡可用 SLS 或读代码证实/证伪的假设，**必须查完**；禁止写「待验证：是否与 XX 共现」这类可查项
3. 每个有量候选类型须启动 **子 Agent** 深挖（见 [references/deep-analysis.md](references/deep-analysis.md)），主 Agent 汇总后落盘
4. 按 [references/priority.md](references/priority.md) 给出 `P0–P3`（影响范围 × 严重度 × 修复难度）
5. **写作面向不了解分析过程的开发者**（见下方写作质量要求）

## 写作质量要求

Issue 的读者是**没有参与过分析的开发者**。写完后自查三个问题：

1. **能看懂吗？** — 没有缩写/黑话（`pidmm`、`cmdmm`、`SNR`），数字有上下文解释
2. **能复现吗？** — 每条验证包含完整查询命令和结果，读者能直接运行
3. **能动手改吗？** — 修复建议指到具体文件/函数/改法，拿到就能开工

详细格式模板见 [references/issue-format.md](references/issue-format.md)。

## Prerequisites

- `aliyun` CLI 已配置，默认 region `cn-shanghai`，可访问 `loongsuite-cn-shanghai-admin`
- 工作目录：本仓库根
- Code 平台 MCP 工具可用（`user-code` server：`list_issues`、`create_issue`、`create_issue_comment`、`manage_issue_label`）
- 告警→代码入口：[references/alarm-code-map.md](references/alarm-code-map.md)
- 深挖与验证规范：[references/deep-analysis.md](references/deep-analysis.md)
- 优先级规则：[references/priority.md](references/priority.md)
- 正文格式模板：[references/issue-format.md](references/issue-format.md)

## Workflow

每次执行按顺序：

1. **拉取异常快照**

   ```bash
   python3 .agents/skills/alarm-triage/scripts/fetch_exceptions.py
   ```

   产物：`.agents/skills/alarm-triage/data/runs/<YYYY-MM-DD>/exceptions.json`

2. **生成数据骨架草稿（可选）**

   ```bash
   python3 .agents/skills/alarm-triage/scripts/draft_from_snapshot.py
   ```

   草稿不可直接提交为 Issue。

3. **确认候选**

   - 粒度：每个 `alarm_type` 一条（`agent_count > 0`）
   - 标题：`[Pilot异常] <中文名> · 影响 Agent N · 用户 M`

4. **子 Agent 深挖 + 查询验证（必做）**

   对每个候选（高优先级可先做，但本轮应覆盖全部有量类型）：

   1. 用 `Task` **并行**启动子 Agent（`generalPurpose`），prompt 用
      [deep-analysis.md](references/deep-analysis.md) 模板，填入 `alarm_type` / 日期 / 仓库路径
   2. 子 Agent 必须：读发射点调用链 → 跑 `scripts/query_sls.py` 验证假设 → 写出主因与证据
   3. 验证结果 JSON 落到 `data/runs/<day>/analysis/<ALARM_TYPE>.json`
   4. 主 Agent 审查子结果：若仍有可查的「待验证」**或不符合写作要求**，补查/重写，不得提交

   深度合格线（详见 deep-analysis.md）：

   - 主因 1 条（可加次因），用自然语言段落解释因果链，有数据支撑
   - `## 验证过程` 每条包含：验证目的 → 完整查询命令 → 返回结果 → 结论
   - `## 优先级`：按 priority.md 给出 P0–P3 + 三维度评级与理由
   - 待确认项仅限必须上机才能看的项
   - **不得使用缩写/黑话**，所有数字必须有上下文解释

5. **去重检查（Code 平台）**

   在创建 Issue 之前，先检查平台上是否已有同类型的未关闭 Issue：

   ```
   CallMcpTool: user-code / list_issues
     repo: "sls/loongsuite-pilot"
     statuses: "new,assigned"
   ```

   遍历返回的 Issue 列表，检查标题是否包含对应的告警中文名（如 `updater 失败`、`服务未运行`）。
   也可以通过 `get_issue` 查看详情中的标签是否含 `<ALARM_TYPE>`。

   - **找到未关闭的同类 Issue** → 进入步骤 6a（追加评论）
   - **未找到** → 进入步骤 6b（新建 Issue）

6a. **追加评论（已有未关闭 Issue）**

   ```
   CallMcpTool: user-code / create_issue_comment
     repo: "sls/loongsuite-pilot"
     issueId: <existing_issue_id>
     content: "## <日期> 巡检更新\n\n- 本轮影响 Agent 数: N（上轮: M）\n- 趋势: ↑/↓/持平\n- 新增发现: ...\n- 根因/验证增量: ..."
   ```

   评论只写增量变化，不要整篇重贴。

6b. **新建 Issue（无未关闭 Issue）**

   ```
   CallMcpTool: user-code / create_issue
     repo: "sls/loongsuite-pilot"
     title: "[Pilot异常] <中文名> · 影响 Agent N · 用户 M"
     issueType: "BUG"
     description: "<按 issue-format.md 模板组装的完整 Markdown 正文>"
     descriptionFormat: "MARKDOWN"
   ```

   创建后立即打标签：

   ```
   CallMcpTool: user-code / manage_issue_label
     repo: "sls/loongsuite-pilot"
     issueId: <new_issue_id>
     action: "add"
     labelName: "pilot-alarm"

   CallMcpTool: user-code / manage_issue_label
     repo: "sls/loongsuite-pilot"
     issueId: <new_issue_id>
     action: "add"
     labelName: "<ALARM_TYPE>"        # 如 UPDATER_FAILURE_ALARM

   CallMcpTool: user-code / manage_issue_label
     repo: "sls/loongsuite-pilot"
     issueId: <new_issue_id>
     action: "add"
     labelName: "<P0|P1|P2|P3>"
   ```

7. **汇报**

   新建 / 评论 / 跳过；按 **P0→P3** 排序；每条：**优先级 + 主因一句话 + 关键证据数字 + Issue 链接**。

## Code 平台约定

| 项 | 规则 |
|----|------|
| 仓库 | `sls/loongsuite-pilot` |
| Issue 类型 | `BUG` |
| 描述格式 | `MARKDOWN` |
| 标签（必打） | `pilot-alarm` + `<ALARM_TYPE>` + `<P0\|P1\|P2\|P3>` |
| 去重维度 | 同 `alarm_type` + 未关闭（`new`/`assigned`） |
| 关闭后同类 | 可新建 |

## Scripts

| 脚本 | 作用 |
|------|------|
| `scripts/fetch_exceptions.py` | 从 SLS 拉取异常快照 |
| `scripts/draft_from_snapshot.py` | 生成数据骨架草稿 |
| `scripts/query_sls.py` | 深挖时 ad-hoc 验证查询 |

```bash
python3 .agents/skills/alarm-triage/scripts/query_sls.py --logstore alarm --pretty \
  --query 'alarm_type: UPDATER_FAILURE_ALARM | SELECT ver, approx_distinct(ip) AS c GROUP BY ver ORDER BY c DESC LIMIT 10'
```

## Guardrails

### 内容质量

- **禁止**无验证过程 / 根因 / 优先级的 Issue 提交
- **禁止**把可 SLS 验证的项写成「待验证」；查失败应修 SQL 重试
- 优先级须写清三维度理由，禁止只写 P0 不解释
- 根因须指向具体文件/符号或安装状态字段；禁止臆造模块

### 写作可读性

- **禁止缩写和黑话**：不用 `pidmm`、`cmdmm`、`SNR`、`UNR`，用完整中文或全称
- **数字必须有上下文**：不写 `stale 806 > pidmm 495`；写「"心跳过期"影响 806 个 Agent」
- **验证必须可复现**：每条验证包含完整查询命令，读者能直接运行
- **解释必须成段落**：用自然语言因果逻辑，不堆代码符号
- **建议必须可执行**：修复建议具体到文件、函数、改法

### 流程安全

- 子 Agent 不要改业务 `src/`（除非用户另派修复任务）
- 告警主指标用 Agent 去重，不用原始告警条数
- 拉取失败则停止开 Issue
- Issue 创建后必须打齐三个标签（`pilot-alarm` + alarm_type + priority）

## Alarm Type Labels

| alarm_type | 中文 |
|---|---|
| `SERVICE_NOT_RUNNING_ALARM` | 服务未运行 |
| `UPDATER_NOT_RUNNING_ALARM` | 守护掉线 |
| `UPDATER_FAILURE_ALARM` | updater 失败 |
| `DEGRADED_STARTUP_ALARM` | 降级启动 |
| `FLUSH_SEND_ALARM` | 发送失败 |
| `PROCESS_RESOURCE_ALARM` | 资源告警 |
| `INPUT_STOP_ALARM` | 输入停止 |
| `BROKEN_VERSION_POINTER_ALARM` | 版本指针损坏 |
| `INVALID_NODE_BIN_ALARM` | node 二进制无效 |
