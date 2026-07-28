# External 发布状态机

## 固定参数

- `workflow_version=1`
- `release_target=external`
- `validation_mode=true`
- 灰度档位：`EXTERNAL_0 → EXTERNAL_5 → EXTERNAL_15 → EXTERNAL_40 → EXTERNAL_60 → PROMOTE`
- 每档最短观察：30 分钟

`release_phase` 是工作流阶段，保存到 Issue metadata。Multica 原生 Issue 状态只用于 UI：

- 执行中：`in_progress`
- 已成功通知人工并等待：`in_review`
- 无法继续：`blocked`
- 流程结束：`done`

## 转换表

只有下表允许的组合才能产生下一动作。

| 当前阶段 | 新事件 | 条件 | 模拟动作 | 下一阶段 |
|---|---|---|---|---|
| `CANDIDATE_CHECK` | `START` | 无 Change 子 Issue | `CREATE_CHANGE_ISSUE` | `CHANGE_ANALYSIS` |
| `CHANGE_ANALYSIS` | `CHANGE_REPORT` | 缺字段或格式不合法 | `NOTIFY_CHANGE_ANALYSIS_BLOCKED` | `CHANGE_ANALYSIS_BLOCKED` |
| `CHANGE_ANALYSIS` | `CHANGE_REPORT` | `decision=RELEASE` 且字段完整 | `NOTIFY_RELEASE_RECOMMENDATION` | `AWAIT_HUMAN_RELEASE_DECISION` |
| `CHANGE_ANALYSIS` | `CHANGE_REPORT` | `decision=NO_RELEASE` 且字段完整 | `NOTIFY_NO_RELEASE` | `NO_RELEASE_HOLD` |
| `CHANGE_ANALYSIS` | `CHANGE_REPORT` | `decision=NEED_HUMAN_REVIEW` | `NOTIFY_HUMAN_REVIEW` | `CHANGE_ANALYSIS_BLOCKED` |
| `NO_RELEASE_HOLD` | `HOLD_EXPIRED` | 满 24 小时且无人工覆盖 | `CLOSE_NO_RELEASE` | `NO_RELEASE_CLOSED` |
| `NO_RELEASE_HOLD` | `HUMAN_APPROVAL` | 24 小时内明确 external + bump + 最新报告 | `CREATE_PLAN_ISSUE` | `APPROVED_TO_PLAN` |
| `AWAIT_HUMAN_RELEASE_DECISION` | `HUMAN_APPROVAL` | 明确 external + bump | `CREATE_PLAN_ISSUE` | `APPROVED_TO_PLAN` |
| `APPROVED_TO_PLAN` | `EXECUTION_REPORT` | `outcome=PLAN_READY` | `NOTIFY_PLAN_READY` | `AWAIT_EXTERNAL_START_CONFIRMATION` |
| `APPROVED_TO_PLAN` | `EXECUTION_REPORT` | plan 失败 | `NOTIFY_EXECUTION_FAILURE` | `AWAIT_HUMAN_PLAN_FAILURE_DECISION` |
| `AWAIT_HUMAN_PLAN_FAILURE_DECISION` | `HUMAN_APPROVAL` | 明确重试 plan 且绑定最新失败证据 | `DISPATCH_PLAN` | `APPROVED_TO_PLAN` |
| `AWAIT_HUMAN_PLAN_FAILURE_DECISION` | `HUMAN_PAUSE` | 明确要求暂停或先修复 | `MARK_PAUSED` | `PAUSED` |
| `AWAIT_EXTERNAL_START_CONFIRMATION` | `HUMAN_APPROVAL` | 明确 external + 版本 + `EXTERNAL_0` + 最新 plan | `DISPATCH_EXECUTION` | `ROLLING_OUT` |
| `ROLLING_OUT` | `EXECUTION_REPORT` | 当前 rollout 成功 | `CREATE_OBSERVATION_ISSUE` | `OBSERVING` |
| `ROLLING_OUT` | `EXECUTION_REPORT` | rollout/promote 失败 | `NOTIFY_EXECUTION_FAILURE` | `AWAIT_HUMAN_EXECUTION_FAILURE_DECISION` |
| `OBSERVING` | `OBSERVATION_REPORT` | `KEEP_OBSERVING` | `SCHEDULE_OBSERVATION` | `OBSERVING` |
| `OBSERVING` | `OBSERVATION_REPORT` | `CONTINUE_REVIEW_READY` | `NOTIFY_HUMAN_ROLLOUT_DECISION` | `AWAIT_HUMAN_ROLLOUT_DECISION` |
| `OBSERVING` | `OBSERVATION_REPORT` | `PAUSE_RECOMMENDED` | `NOTIFY_HUMAN_RISK_DECISION` | `AWAIT_HUMAN_ROLLOUT_DECISION` |
| `AWAIT_HUMAN_ROLLOUT_DECISION` | `HUMAN_APPROVAL` | 明确批准唯一下一档或 promote | `DISPATCH_EXECUTION` | `ROLLING_OUT` |
| `AWAIT_HUMAN_ROLLOUT_DECISION` | `HUMAN_APPROVAL` | 明确要求继续观察且绑定最新证据 | `SCHEDULE_OBSERVATION` | `OBSERVING` |
| `AWAIT_HUMAN_ROLLOUT_DECISION` | `HUMAN_PAUSE` | 明确要求暂停 | `MARK_PAUSED` | `PAUSED` |
| `AWAIT_HUMAN_EXECUTION_FAILURE_DECISION` | `HUMAN_APPROVAL` | 明确重试当前档位且绑定最新失败证据 | `DISPATCH_EXECUTION` | `ROLLING_OUT` |
| `AWAIT_HUMAN_EXECUTION_FAILURE_DECISION` | `HUMAN_PAUSE` | 明确要求暂停或先修复 | `MARK_PAUSED` | `PAUSED` |
| `ROLLING_OUT` | `EXECUTION_REPORT` | `PROMOTE` 成功 | `CREATE_RELEASE_NOTE_ISSUE` | `RELEASE_NOTE_PREPARING` |
| `RELEASE_NOTE_PREPARING` | `RELEASE_NOTE_REPORT` | 报告完整 | `NOTIFY_GITHUB_RELEASE_DECISION` | `AWAIT_GITHUB_RELEASE_CONFIRMATION` |
| `AWAIT_GITHUB_RELEASE_CONFIRMATION` | `HUMAN_APPROVAL` | 明确 GitHub + 版本 + 最新 Release Note | `DISPATCH_GITHUB_RELEASE` | `GITHUB_RELEASING` |
| `GITHUB_RELEASING` | `EXECUTION_REPORT` | GitHub 成功 | `NOTIFY_RELEASE_COMPLETED` | `RELEASE_COMPLETED` |
| `GITHUB_RELEASING` | `EXECUTION_REPORT` | GitHub 失败 | `NOTIFY_EXECUTION_FAILURE` | `AWAIT_HUMAN_GITHUB_FAILURE_DECISION` |
| `AWAIT_HUMAN_GITHUB_FAILURE_DECISION` | `HUMAN_APPROVAL` | 明确重试 GitHub 且绑定最新失败证据 | `DISPATCH_GITHUB_RELEASE` | `GITHUB_RELEASING` |
| `AWAIT_HUMAN_GITHUB_FAILURE_DECISION` | `HUMAN_PAUSE` | 明确要求暂停或先修复 | `MARK_PAUSED` | `PAUSED` |

## 精确档位

`nextStage(current)`：

```text
EXTERNAL_0  -> EXTERNAL_5
EXTERNAL_5  -> EXTERNAL_15
EXTERNAL_15 -> EXTERNAL_40
EXTERNAL_40 -> EXTERNAL_60
EXTERNAL_60 -> PROMOTE
```

其他输入均为非法。禁止从任意档位直接跳到更高档位。

## 风险语义

风险报告不得自动改变线上发布状态：

1. 发送或模拟发送风险通知。
2. 进入 `AWAIT_HUMAN_ROLLOUT_DECISION`。
3. 等待人工选择继续观察、批准唯一下一档，或明确暂停/先修复。
4. 没有人工决定时不派发任何发布执行任务。

这里的“不自动冻结”指不擅自设置 `PAUSED`、回退或修改 OSS；等待人工门禁期间仍禁止自动扩灰。
本版本未定义的 hotfix、rollback 或重新从 0% 开始等恢复动作不得猜测执行，需要后续版本化流程另行处理。

## 失败与恢复

- Change 报告缺字段或格式不合法：模拟通知人工并进入
  `CHANGE_ANALYSIS_BLOCKED`，不补写专业结论。其他阶段的无效报告返回
  `INVALID` 并列出原因。
- 通知失败：保留当前阶段并记录 `notification_failed`；不得假装人工已经收到通知。
- 执行失败：不自动重试写操作；先读取事实并等待人工。
- `PAUSED` 是 v1 验证流程的人工终止态；恢复流程需要后续版本另行定义，不得猜测。
- plan、观察报告或人工确认发生变化时，旧确认不得复用。
- `release_consumed_event_ids` 记录所有已消费 child/comment；`release_last_consumed_child_id`
  和 `release_last_approval_comment_id` 作为兼容字段。命中任一记录时不得再次消费。
