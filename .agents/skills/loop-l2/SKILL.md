---
name: loop-l2
description: L2 自动巡检循环 — Triage 扫描项目状态，发现可修复问题后调用 /develop（Quick + 非交互）完成隔离修复和验证，产出 Draft PR 等待人工审批
metadata:
  author: agent-data-collection
  version: "2.0"
  category: Loop
  requires:
    bins:
      - git
      - npm
    files:
      - STATE.md
      - LOOP.md
      - loop-constraints.md
      - loop-run-log.md
      - .claude/skills/loop-triage/SKILL.md
---

# /loop-l2 — L2 Assisted Fix Loop

在项目上执行一次 L2 循环：Triage 扫描 → 筛选可修复项 → 调用 `/develop` 完成修复 → 记录结果。

**Input**: 无（自动从项目状态推导）

**与 /develop 的关系**: loop-l2 负责"发现什么该修"，develop 负责"怎么修"。loop-l2 是 develop 的上游编排者，以非交互模式调用 develop 的 Quick 流水线。

---

## Phase 0: 环境与约束加载

读取以下文件建立上下文：

| 文件 | 用途 |
|------|------|
| `STATE.md` | 当前循环状态、上次运行结果 |
| `LOOP.md` | 循环配置、预算、kill switch |
| `loop-constraints.md` | 绑定性安全约束（**必须遵守**） |
| `.claude/skills/loop-triage/SKILL.md` | Triage 输出格式定义 |

**前置检查：**
- 若 `STATE.md` 含 `loop-pause-all` 标记 → 立即退出，不执行任何操作

---

## Phase 1: Triage

按 `.claude/skills/loop-triage/SKILL.md` 的格式定义执行扫描：

```bash
# 近期提交
git log --oneline -20

# 编译状态
npm run build && npm run typecheck

# 测试状态
npm test

# 近期变更中的 TODO/FIXME
git diff HEAD~5 --name-only | xargs grep -n "TODO\|FIXME\|HACK\|XXX" 2>/dev/null || true
```

产出 Triage 报告，包含：
- **High-Priority Items** — 今天应该处理的（编译错误、测试失败、明确 bug）
- **Watch Items** — 监控但不行动
- **Noise / Ignore** — 已审视、无需关注

---

## Phase 2: 筛选与路由

从 High-Priority 中筛选满足**全部条件**的条目：
- 明确有界（非架构重构）
- 预估改动 < 100 行
- 不涉及禁止路径（`.env`、`auth/`、`payments/`、`secrets/`、`credentials/`）
- 不涉及基础设施配置

| 筛选结果 | 后续 |
|----------|------|
| 有可修复项 | 选择优先级最高的 **1 项**，进入 Phase 3 |
| 无可修复项 | 更新 STATE.md，写入 run log，结束（report-only） |

---

## Phase 3: 调用 /develop 执行修复

将筛选出的问题转化为一条明确需求描述，以非交互模式调用 `/develop`：

```
/develop MODE=quick INTERACTIVE=false DELIVERY=draft_pr
需求：<从 triage High-Priority 条目转化的具体修复需求>
```

等效于调度 develop skill 时传入参数：
- `MODE=quick` — 跳过 Spec Explorer，直接 Coder → Tester → Code Reviewer
- `INTERACTIVE=false` — 无人值守，不弹 AskUserQuestion
- `DELIVERY=draft_pr` — 产出 Draft PR 而非正式 CR

### develop 执行流程（自动完成）

```
Worktree 隔离
  → Coder 修复（Direct 模式）
  → Tester 验证（E2E）
  → Code Reviewer 本地评审
  → 通过 → 创建 Draft PR
  → 失败 → 标记 FAILED，收尾
```

### 结果处理

从 develop 返回中提取：
- `OUTCOME`: 完成 / 暂停 / 失败
- `DELIVERY_LINK`: Draft PR URL 或 null
- `FEATURE_BRANCH`: 分支名
- `WORKTREE_PATH`: worktree 目录（供人工评审回流 `/develop ENTRY=resume` 反查）
- `REVIEW_LOG`: 评审记录（若有）

| develop 结果 | loop-l2 后续 |
|--------------|--------------|
| 完成（有 PR） | 记录成功，进入 Phase 4 |
| 失败（Coder/Tester/Reviewer 超限） | 标记为 escalated，进入 Phase 4 |

---

## Phase 4: Cleanup & Log

### 4.1 更新 STATE.md

- 移动已处理条目到相应区域
- 记录本次运行结果：
  - `fix-proposed`: develop 成功产出 Draft PR
  - `escalated`: develop 执行失败，问题需人工处理
  - `report-only`: Phase 2 未发现可修复项
- 更新 `Last run` 时间戳

### 4.2 追加 Run Log

在 `loop-run-log.md` 的 `## Recent Runs` 下追加：

```json
{
  "run_id": "<ISO-8601 timestamp>",
  "pattern": "daily-triage",
  "level": "L2",
  "duration_s": <运行秒数>,
  "items_found": <triage 发现总数>,
  "actions_taken": <0 或 1>,
  "escalations": <升级数>,
  "outcome": "report-only | fix-proposed | escalated | no-op",
  "pr": "<PR URL 或 null>",
  "develop_branch": "<feature branch 或 null>",
  "worktree_path": "<worktree 目录 或 null>"
}
```

---

## 完成输出

```markdown
## Loop L2 Run Complete

**Time:** <ISO timestamp>
**Outcome:** report-only / fix-proposed / escalated / no-op

### Triage Summary
- High-Priority: N items (M fixable)
- Watch: K items
- Noise: J items

### Fix Attempt (if any)
- Target: <问题描述>
- Delegated to: /develop (Quick, non-interactive, draft_pr)
- Result: 完成 / 失败
- PR: <URL 或 "none">
- Branch: <branch name>

### State Updates
- STATE.md: updated ✓
- loop-run-log.md: appended ✓
```

---

## 护栏规则

- 一次循环只处理一个问题（交给一次 /develop 调用）
- 预估改动 > 100 行的问题直接 escalate，不交给 develop
- `loop-pause-all` 激活时立即退出
- Token 预算达 80% 时降级为 L1 report-only
- develop 内部的回退重试上限由 develop 自身护栏控制（Tester 3 轮、Reviewer 2 轮）
- loop-l2 不额外重试——develop 失败即 escalate
- 遵守 loop-constraints.md 中所有约束（传递给 develop 的需求描述中需包含约束提醒）
