---
name: develop
description: 弹性开发流水线 — 从需求到 CR 的全流程自动编排，支持大需求（含 Spec）和小需求（直接开发）两种模式
metadata:
  author: agent-data-collection
  version: "1.0"
  category: Pipeline
---

# /develop — 弹性开发 Pipeline

将需求从描述到代码评审全流程自动化，按需求规模选择流程深度。

**Input**: `<需求描述>`（自然语言，描述要做什么）

---

## Phase 0: 路由选择

使用 **AskUserQuestion** 让用户选择流程模式：

| 模式 | 含义 | 流程 |
|------|------|------|
| **Full**（大需求） | 需要设计方案和任务拆分 | Spec Explorer → Coder → Tester → Code Reviewer |
| **Quick**（小需求） | 目标明确，直接实现 | Coder → Tester → Code Reviewer |
| **Code Only** | 只写代码，不测试不评审 | Coder only |

记录用户选择的模式为 `PIPELINE_MODE`，后续步骤据此跳过或执行。

---

## Phase 1: Spec Explorer（仅 Full 模式）

> 跳过条件：`PIPELINE_MODE != "full"`

使用 **Agent** 工具派生 `spec-explorer` 子 agent：

```
Agent(subagent_type="spec-explorer", prompt="<需求描述>，请探索方案并生成 OpenSpec 变更提案。")
```

子 agent 按其内置工作流执行：
1. 调用 `/opsx:explore` 探索需求空间和技术方案
2. 调用 `/opsx:propose` 生成变更提案
3. 返回 `CHANGE_NAME`

收到子 agent 返回后，展示提案摘要，使用 **AskUserQuestion** 等待用户确认：
- **确认** → 记录 `CHANGE_NAME`，进入 Phase 2
- **调整** → 根据反馈再次派生 spec-explorer 修改提案
- **放弃** → 终止 pipeline

**交接给 Phase 2 的数据：**
- `CHANGE_NAME`: OpenSpec change name
- `PIPELINE_MODE`: "full"

---

## Phase 2: Coder

使用 **Agent** 工具派生 `coder` 子 agent：

### Full 模式（有 OpenSpec change）

```
Agent(subagent_type="coder", prompt="Spec 模式：按 OpenSpec change '<CHANGE_NAME>' 实现所有 tasks。完成后停止，不执行 Post-Implementation Automation（Step 8-11）。输出 Coder 交接信息。")
```

### Quick 模式（无 OpenSpec change）

```
Agent(subagent_type="coder", prompt="Direct 模式：<需求描述>。分析需求，拆分实现步骤，逐步实现，确保 tsc + vitest 通过，commit 到 feature 分支。输出 Coder 交接信息。")
```

### Code Only 模式

同 Quick 模式，完成后**直接结束 pipeline**，不进入 Tester 和 Reviewer。

**交接给 Phase 3 的数据：**
- `FEATURE_BRANCH`: feature 分支名
- `COMMIT_RANGE`: base..head SHA
- `CHANGE_SUMMARY`: 变更摘要

---

## Phase 3: Tester（Full / Quick 模式）

> 跳过条件：`PIPELINE_MODE == "code_only"`

使用 **Agent** 工具派生 `tester` 子 agent：

```
Agent(subagent_type="tester", prompt="在分支 '<FEATURE_BRANCH>' 上运行 E2E 测试。先基线构建（npm install && npm run build && npm run typecheck && npm test），再运行 ./scripts/e2e/run-e2e.sh install-smoke。输出 Tester 交接信息。")
```

结果处理：
- **PASSED** → 进入 Phase 4
- **FAILED** → 进入回退循环

### 回退循环（最多 3 轮）

```
E2E 失败
  │
  ├─ 分析根因
  │   ├─ transient（网络超时等）→ 直接重试 E2E
  │   └─ real bug → 生成修复需求
  │
  ├─ 回退 Coder（派生 coder 子 agent）
  │   ├─ Agent(subagent_type="coder", prompt="修复 E2E 失败：<失败分析>")
  │   ├─ Coder 修复代码、编译 + 单测、commit + push
  │
  └─ 重新派生 tester 子 agent 运行 E2E
      ├─ PASSED → 进入 Phase 4
      └─ FAILED → 继续循环（第 N+1 轮）

3 轮后仍失败 → 暂停 pipeline，输出失败详情，等待人工决策
```

**交接给 Phase 4 的数据：**
- `FEATURE_BRANCH`: 同上
- `E2E_RESULT`: "passed"
- `E2E_ATTEMPTS`: 尝试次数

---

## Phase 4: Code Reviewer（Full / Quick 模式）

> 跳过条件：`PIPELINE_MODE == "code_only"`

**使用 AskUserQuestion** 确认是否提交 CR 并执行评审：
- **确认** → 继续
- **跳过** → 结束 pipeline（代码已在分支上，E2E 已过）

使用 **Agent** 工具派生 `code-reviewer` 子 agent：

```
Agent(subagent_type="code-reviewer", prompt="对分支 '<FEATURE_BRANCH>' 执行代码评审。先通过 /submit-cr 创建 CR，再执行 /code-review 全流程（Phase 1-6），将评审意见发布到平台。输出 Code Reviewer 交接信息。")
```

2. **评审结果判定**：
   - 无 Critical/High findings → 输出交接信息，Pipeline 完成
   - 有 Critical/High findings → 进入评审回退循环

### 评审回退循环（最多 2 轮）

当 Code Reviewer 发现 Critical 或 High 级别问题时，自动回退 Coder 修复：

```
Code Reviewer 发现 Critical/High
  │
  ├─ 提取 Findings 列表（仅 Critical + High）
  │   生成修复需求：文件、行号、问题描述、修复建议
  │
  ├─ 回退 Coder（派生 coder 子 agent）
  │   ├─ Agent(subagent_type="coder", prompt="修复评审问题：<Findings 列表>")
  │   ├─ Coder 逐项修复、编译 + 单测、commit + push
  │
  ├─ 回退 Tester（派生 tester 子 agent）
  │   ├─ 重新运行 E2E 确保修复未引入回归
  │   └─ FAILED → 走 Tester 自身的回退循环
  │
  └─ 重新评审（派生 code-reviewer 子 agent）
      ├─ 增量评审：仅评审本轮修复涉及的变更
      ├─ 无 Critical/High → Pipeline 完成
      └─ 仍有 Critical/High → 继续循环（第 N+1 轮）

2 轮后仍有 Critical/High → 暂停 pipeline，输出：
  - 未解决的 Critical/High 列表
  - 已修复的问题列表
  - 等待人工决策（强制合入 / 继续修复 / 放弃）
```

**使用 AskUserQuestion** 决策仍存在 Critical/High 时的处理：
- **继续修复** → 再跑一轮（突破轮次限制，但需人工确认）
- **强制完成** → 在评审意见中标注"已知问题"，完成 Pipeline
- **暂停** → 保留当前状态，等待人工介入

---

## Pipeline 完成输出

```markdown
## /develop Pipeline 完成

**模式:** Full / Quick / Code Only
**需求:** <原始需求描述>
**分支:** <feature-branch-name>

### 各阶段结果

| 阶段 | 状态 | 详情 |
|------|------|------|
| Spec Explorer | ✓ 完成 / ⊘ 跳过 | change: <name> |
| Coder | ✓ 完成 | N tasks, tsc ✓, vitest ✓ |
| Tester | ✓ 通过 / ⊘ 跳过 | E2E passed (attempt N/3) |
| Code Reviewer | ✓ 已发布 / ⊘ 跳过 | CR: <link>, 回退修复 M 轮 |

### 评审摘要（如有）
- Critical: X | High: Y | Medium: Z | Low: W
- 评审回退修复: M 轮
- 阻断合入: 是/否

All done! CR is ready for human review.
```

---

## Pipeline 暂停输出

```markdown
## /develop Pipeline 暂停

**模式:** <mode>
**暂停阶段:** <phase>
**原因:** <原因说明>

### 已完成阶段
| 阶段 | 状态 |
|------|------|
| ... | ... |

### 未解决问题（如有）
| Severity | File | 问题 |
|----------|------|------|
| ... | ... | ... |

### 恢复方式
<如何继续的说明>
```

---

## 护栏规则

- 必须在 feature 分支上执行，禁止在 master/main 上开发
- 每个 Phase 之间的交接数据必须完整，不可跳过交接直接读取
- Tester 回退 Coder 最多 3 轮，超过必须暂停
- Code Reviewer 回退 Coder 最多 2 轮，超过需人工决策
- 评审回退后必须重新跑 Tester（E2E），不可跳过
- Code Reviewer 提交 CR 前必须获得用户确认
- Pipeline 中的 Coder 不执行 Post-Implementation Automation（与 `/opsx:apply` 独立使用时不同）
- 任何阶段遇到不可恢复错误，暂停 pipeline 并输出当前状态
