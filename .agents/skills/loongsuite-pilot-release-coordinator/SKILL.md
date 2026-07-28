---
name: loongsuite-pilot-release-coordinator
description: 协调 LoongSuite Pilot external（商业版）候选分析、灰度观察、人工门禁、promote、Release Note 与 GitHub 下游发布。用于发布父 Issue 被创建、子 Issue 完成、观察报告到达、人工评论到达、watchdog 续跑或需要判断唯一下一步时；只做编排和验证，不执行发布。
---

# LoongSuite Pilot External Release Coordinator

把父 Issue metadata 视为工作流事实来源。每次运行都重新读取父 Issue、子 Issue、评论与 metadata，再计算唯一允许的下一步。

本 Skill 不执行 `release`、`rollout`、`promote`、hotfix、rollback、OSS、Tag、CR 或 GitHub 写操作。专业结论分别来自发布说明、发布执行和灰度观察 Agent。

## 每次运行

1. 完整读取 [references/state-machine.md](references/state-machine.md)。
2. 需要解析成员结果时，完整读取 [references/report-contracts.md](references/report-contracts.md)。
3. 读取父 Issue 的 metadata、所有直接子 Issue、触发评论和未消费的结构化报告。
4. 把状态快照传给：

   ```bash
   node .agents/skills/loongsuite-pilot-release-coordinator/scripts/validate-transition.mjs \
     --input <snapshot.json>
   ```

5. 只接受校验器输出的 `allowed_action`。输出为 `WAIT` 或 `INVALID` 时不得自行推测。
6. 使用 `release_consumed_event_ids`、兼容的
   `release_last_consumed_child_id` / `release_last_approval_comment_id`
   和 `release_notification_keys` 保证每个事件只消费、每类通知只发送一次。

## 强制边界

始终遵守：

- 目标只能是 `external`（商业版）。出现 `internal` 目标请求时返回
  `allowed_action=INVALID`，并在 `reason` 中标记 `INVALID_TARGET`。
- 灰度顺序固定为 `0 → 5 → 15 → 40 → 60 → promote`，禁止跳档和 `rollout 100`。
- 每档观察满 30 分钟后才允许请求人工判断下一步。
- `PASS` 或 `CONTINUE_REVIEW_READY` 只是证据，不是批准。
- `PAUSE_RECOMMENDED` 或风险报告只通知人工并进入等待决策；不得自行设置 `PAUSED`、执行 `rollout 0`、hotfix 或 rollback。
- Agent/自动化评论以及“确认”“继续”“OK”等模糊评论无效。
- 人工批准必须绑定 external、目标版本、当前档位、下一动作以及最新 plan/观察报告。
- `NO_RELEASE` 保留 24 小时人工覆盖窗口；到期后才允许结束父 Issue。

## 验证模式

本版本只允许 `VALIDATION_MODE=true`：

- 不创建、更新或关闭 Multica Issue。
- 不写 metadata，不发送评论，不触发 Agent。
- 不调用钉钉或 Webhook。
- 不运行发布脚本，包括真实 release、rollout、promote 和 GitHub 写操作。
- 只使用 fixtures/schema 验证状态转换、人工门禁、报告字段和幂等规则。
- 输出 `VALIDATION_RESULT`，列出模拟状态、模拟动作、所需人工输入和拒绝原因。

如果输入不是验证模式，立即返回 `PRODUCTION_APPLY_DISABLED`。

## 成员交互

- 发布说明 Agent：只消费 `change-report`，不补写 Change 结论。
- 发布执行 Agent：只消费 plan/执行事实，不采用它提出的流程建议。
- 灰度观察 Agent：只消费只读观察事实；风险只触发人工通知和等待。
- 人工：唯一能够批准开始 0%、下一档、promote 或 GitHub 发布的角色。

## 输出

返回结构化结果：

```json
{
  "validation_mode": true,
  "current_phase": "OBSERVING",
  "current_stage": "EXTERNAL_15",
  "event_type": "OBSERVATION_REPORT",
  "allowed_action": "NOTIFY_HUMAN_ROLLOUT_DECISION",
  "next_phase": "AWAIT_HUMAN_ROLLOUT_DECISION",
  "requires_human": true,
  "reason": "观察报告已可供人工判断"
}
```
