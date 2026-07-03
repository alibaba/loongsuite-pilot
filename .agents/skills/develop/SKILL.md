---
name: develop
description: 开发流水线引擎 — 接收明确需求描述，按指定模式执行 Worktree 隔离 → Coder → Tester → Code Reviewer 全流程。支持外部编排（如 loop-l2）直接传入模式，也支持交互式选择。
metadata:
  author: agent-data-collection
  version: "2.0"
  category: Pipeline
---

# /develop — 开发流水线引擎

接收一条明确的需求描述，在隔离环境中完成从编码到评审的全流程。

**Input**: `<需求描述>`（自然语言）

**Options**（可由调用方预设，未预设则交互询问）：
- `ENTRY`: new（默认，全新需求，走 Phase 0→6）/ resume（人工评审回流，走 RESUME 模式）
- `MODE`: full / quick / code_only
- `INTERACTIVE`: true（默认，有人值守）/ false（无人值守，跳过所有 AskUserQuestion）
- `DELIVERY`: cr（默认，创建正式 CR）/ draft_pr（创建 Draft PR）/ branch_only（仅留分支）

> `ENTRY=resume` 时不需要 `<需求描述>`，改为传入 `CR=<link>` 或 `BRANCH=<name>`，见下方 **RESUME 模式**。

---

## RESUME 模式：人工评审意见回流

> 触发：`/develop ENTRY=resume CR=<link>`（或 `BRANCH=<name>`）。人工在 CR/PR 上评审后，手动重入，把人工意见喂回内部循环。

复用 Phase 3→4→5 的回退循环，不新建流程。步骤：

### R1: 定位现场

从登记表（`loop-run-log.md` 的 `worktree_path` / `develop_branch` / `pr` 字段，或 `STATE.md`）用 `CR`/`BRANCH` 反查 `WORKTREE_PATH` 与 `FEATURE_BRANCH`。

### R2: 重入 worktree

- worktree 仍在 → `EnterWorktree(path="<WORKTREE_PATH>")` 原样切回分支现场。
- worktree 已被清理 → `EnterWorktree(name="<feature-slug>-r2")` 基于 `FEATURE_BRANCH` 重新拉出（先 `git fetch` 该分支）。

### R3: 摄取人工评论 → 转成 findings

- **CR（内网平台）**：MCP `list_merge_request_comments` 拉全部评论 + `get_merge_request_detail` 取 MR 上下文，过滤出**人工作者、未解决（closed=0）**的评论。
- **PR（GitHub）**：`gh pr view <link> --json comments,reviews` 拉取。

把每条评论归一成结构化 finding（`file` / `line` / 评论内容 / 提出人 / `noteId`），形状与 `REVIEW_LOG` 的 findings 一致。无法定位到具体行的全局评论，作为一条 general finding。

### R4: 喂回内部循环

将人工 findings **当作 Code Reviewer 的 Critical/High 一样处理**：
- Phase 3 Coder 逐条修复（`Agent(subagent_type="coder", prompt="按人工评审意见修复：<findings>")`）→ commit
- Phase 4 Tester 复测 E2E，确保未引入回归
- Phase 5 Step 1 可选再本地评审
- 每轮追加到 `REVIEW_LOG`，标注"人工评审轮 N"

> 人工评论若是提问/讨论而非修改要求，不派 Coder，改为在 R5 直接回复澄清。

### R5: 推送 + 回复评论

- push 到**同一个 `FEATURE_BRANCH`**——CR/PR 自动刷新，人工看到的是同一评审串。
- 对每条已处理评论回复并标记解决：
  - CR：`comment_merge_request`（`parentNoteId` 指向原评论）说明如何修复的 + `update_merge_request_comment_status(closed=1)`。
  - PR：`gh pr comment` / reply。
- 无法自动解决的（需人工决策 / 有分歧）→ 保留 open，在完成输出中单列"待人工确认项"。

### R6: 收尾

同 Phase 6，保留 worktree（`action="keep"`），等待人工下一轮评审。可再次 `ENTRY=resume` 循环。

---

## Phase 0: 路由选择

### 交互模式（INTERACTIVE=true，默认）

使用 **AskUserQuestion** 让用户选择流程模式：

| 模式 | 含义 | 流程 |
|------|------|------|
| **Full**（大需求） | 需要设计方案和任务拆分 | Spec Explorer → Coder → Tester → Code Reviewer |
| **Quick**（小需求） | 目标明确，直接实现 | Coder → Tester → Code Reviewer |
| **Code Only** | 只写代码，不测试不评审 | Coder only |

### 非交互模式（INTERACTIVE=false）

由调用方在 prompt 中指定 MODE，直接使用，不弹 AskUserQuestion。

示例调用方式：
```
Agent(subagent_type="coder" is wrong — use skill invocation)

/develop MODE=quick INTERACTIVE=false DELIVERY=draft_pr
需求：修复 TypeScript 编译错误 TS2345 in src/hooks/lifecycle.ts
```

记录 `PIPELINE_MODE`、`INTERACTIVE`、`DELIVERY`，后续步骤据此执行或跳过。

---

## Phase 1: Worktree 隔离（所有模式）

使用 **EnterWorktree** 工具为本次需求创建专属 worktree：

```
EnterWorktree(name="<feature-slug>")
```

- `<feature-slug>`：由需求描述生成的短横线命名（如 `add-login-cache`），仅含字母/数字/`.`/`_`/`-`。
- EnterWorktree 会在 `.claude/worktrees/` 下创建 worktree，并**新建一个分支**（默认从 `origin/master` fresh 拉出）。
- 该新分支即本次 pipeline 的 `FEATURE_BRANCH`；worktree 目录记为 `WORKTREE_PATH`。从工具返回中读取并记录二者。
- 创建后，当前会话的工作目录切换到该 worktree，**后续所有子 agent 都在此目录内执行**（子 agent 启动时继承编排者的 cwd）。

**关键约束：**
- 派生子 agent 时**不要**使用 `isolation: "worktree"`。本 pipeline 需要所有阶段**共享同一个 worktree**，靠编排者切入 worktree、子 agent 继承 cwd 来实现。
- Coder 无需再自行创建分支——直接在 worktree 已有的 `FEATURE_BRANCH` 上开发。

**交接给后续 Phase 的数据（全程携带）：**
- `WORKTREE_PATH`: worktree 目录
- `FEATURE_BRANCH`: worktree 分支名

---

## Phase 2: Spec Explorer（仅 Full 模式）

> 跳过条件：`PIPELINE_MODE != "full"`

使用 **Agent** 工具派生 `spec-explorer` 子 agent：

```
Agent(subagent_type="spec-explorer", prompt="<需求描述>，请探索方案并生成 OpenSpec 变更提案。")
```

子 agent 按其内置工作流执行：
1. 调用 `/opsx:explore` 探索需求空间和技术方案
2. 调用 `/opsx:propose` 生成变更提案
3. 返回 `CHANGE_NAME`

### 交互模式

展示提案摘要，使用 **AskUserQuestion** 等待用户确认：
- **确认** → 记录 `CHANGE_NAME`，进入 Phase 3
- **调整** → 根据反馈再次派生 spec-explorer 修改提案
- **放弃** → 终止 pipeline

### 非交互模式

直接接受提案，记录 `CHANGE_NAME`，进入 Phase 3。

**交接给 Phase 3 的数据：**
- `CHANGE_NAME`: OpenSpec change name
- `PIPELINE_MODE`: "full"

---

## Phase 3: Coder

使用 **Agent** 工具派生 `coder` 子 agent：

### Full 模式（有 OpenSpec change）

```
Agent(subagent_type="coder", prompt="Spec 模式：按 OpenSpec change '<CHANGE_NAME>' 实现所有 tasks。完成后停止，不执行 Post-Implementation Automation（Step 8-11）。输出 Coder 交接信息。")
```

### Quick / Code Only 模式（无 OpenSpec change）

```
Agent(subagent_type="coder", prompt="Direct 模式：<需求描述>。分析需求，拆分实现步骤，逐步实现，确保 tsc + vitest 通过，commit 到 feature 分支。输出 Coder 交接信息。")
```

Code Only 模式完成后**直接进入 Phase 6 收尾**，不进入 Tester 和 Reviewer。

**交接给 Phase 4 的数据：**
- `FEATURE_BRANCH`: feature 分支名
- `COMMIT_RANGE`: base..head SHA
- `CHANGE_SUMMARY`: 变更摘要

---

## Phase 4: Tester（Full / Quick 模式）

> 跳过条件：`PIPELINE_MODE == "code_only"`

使用 **Agent** 工具派生 `tester` 子 agent：

```
Agent(subagent_type="tester", prompt="在分支 '<FEATURE_BRANCH>' 上运行 E2E 测试。先基线构建（npm install && npm run build && npm run typecheck && npm test），再运行 ./scripts/e2e/run-e2e.sh install-smoke。输出 Tester 交接信息。")
```

结果处理：
- **PASSED** → 进入 Phase 5
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
      ├─ PASSED → 进入 Phase 5
      └─ FAILED → 继续循环（第 N+1 轮）

3 轮后仍失败 →
  - 交互模式：暂停 pipeline，输出失败详情，等待人工决策
  - 非交互模式：标记为 FAILED，进入 Phase 6 记录失败
```

**交接给 Phase 5 的数据：**
- `FEATURE_BRANCH`: 同上
- `E2E_RESULT`: "passed"
- `E2E_ATTEMPTS`: 尝试次数

---

## Phase 5: Code Reviewer（Full / Quick 模式）

> 跳过条件：`PIPELINE_MODE == "code_only"`

分两步执行：**Step 1 内部评审循环（不建 CR）** → **Step 2 交付**。

编排者维护一个累积记录 `REVIEW_LOG`，每一轮追加：轮次号、评审 findings（severity / file / line / 问题 / 修复建议）、Coder 的修复摘要、Tester 的复测结果。

### Step 1: 内部评审循环（最多 2 轮，不创建 CR）

派生 `code-reviewer` 子 agent 做**本地评审**：

```
Agent(subagent_type="code-reviewer", prompt="对分支 '<FEATURE_BRANCH>' 的 diff（<COMMIT_RANGE>）执行本地代码评审。不要创建 CR、不要发布评论到平台。仅按 /code-review 的分析标准输出结构化 findings（severity / file / line / 问题 / 修复建议）。输出 Reviewer 交接信息。")
```

将本轮 findings 追加到 `REVIEW_LOG`，然后判定：
- **无 Critical/High** → 结束内部循环，进入 Step 2
- **有 Critical/High** → 执行本轮回退修复：

```
本轮回退修复
  │
  ├─ 提取 Critical + High findings，生成修复需求
  ├─ 回退 Coder → 修复 → commit → 记入 REVIEW_LOG
  ├─ 回退 Tester → 复测 E2E → 记入 REVIEW_LOG
  └─ 重新本地评审
      ├─ 无 Critical/High → 进入 Step 2
      └─ 仍有 → 继续循环
```

**2 轮后仍有 Critical/High：**
- 交互模式：使用 **AskUserQuestion** 决策（继续 / 带问题提交 / 暂停）
- 非交互模式：标记 "unresolved_findings"，带问题交付

### Step 2: 交付

根据 `DELIVERY` 参数决定交付方式：

| DELIVERY | 操作 |
|----------|------|
| `cr` | 派生 `code-reviewer` 通过 `/submit-cr` 创建正式 CR（交互模式下先 AskUserQuestion 确认） |
| `draft_pr` | push branch，创建 Draft PR（附 REVIEW_LOG 摘要） |
| `branch_only` | 仅 push branch，不创建 CR/PR |

**交接给 Phase 6 的数据：**
- `DELIVERY_LINK`: CR/PR URL 或 branch name
- `REVIEW_ROUNDS`: 内部评审轮数
- `REVIEW_LOG`: 完整评审 + 修复记录

---

## Phase 6: Worktree 收尾（所有模式）

Pipeline 结束时，根据结局决定 worktree 去留（使用 **ExitWorktree**）：

- **交付成功**（CR/PR/branch 已推送） → `ExitWorktree(action="keep")`
- **Code Only 或需求被放弃且无保留价值** → `ExitWorktree(action="remove")`（无未提交改动时）
- **Pipeline 暂停 / 失败** → `action="keep"`，保留现场

---

## Pipeline 完成输出

```markdown
## /develop Pipeline 完成

**模式:** Full / Quick / Code Only
**交互:** 是 / 否
**需求:** <原始需求描述>
**分支:** <feature-branch-name>
**Worktree:** <worktree-path>（keep / removed）
**交付:** CR: <link> / Draft PR: <link> / Branch: <name>

### 各阶段结果

| 阶段 | 状态 | 详情 |
|------|------|------|
| Spec Explorer | ✓ 完成 / ⊘ 跳过 | change: <name> |
| Coder | ✓ 完成 | N tasks, tsc ✓, vitest ✓ |
| Tester | ✓ 通过 / ⊘ 跳过 | E2E passed (attempt N/3) |
| Code Reviewer | ✓ 已提交 / ⊘ 跳过 | 内部评审 M 轮 |

All done!
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

### 恢复方式
<如何继续的说明>
```

---

## 护栏规则

- 必须在 feature 分支上执行，禁止在 master/main 上开发
- 每个需求在独立 worktree 中执行，支持多 `/develop` 并行
- 子 agent 一律不加 `isolation: "worktree"`，共享同一 worktree
- 每个 Phase 之间的交接数据必须完整
- Tester 回退 Coder 最多 3 轮
- Code Reviewer 内部回退最多 2 轮
- 评审回退后必须重新跑 Tester（E2E），不可跳过
- Pipeline 中的 Coder 不执行 Post-Implementation Automation
- 非交互模式下所有 AskUserQuestion 点用默认策略替代（接受/继续）
- 任何阶段遇到不可恢复错误：交互模式暂停，非交互模式标记 FAILED 并收尾
- RESUME 模式必须推回**同一个** `FEATURE_BRANCH`，禁止新建分支/新 CR（否则评审串断裂）
- RESUME 模式处理过的人工评论必须回复并标记状态；无法自动解决的保留 open 并显式列出
- 交付成功后 worktree 必须 `keep`，且现场信息（worktree_path / branch / cr）需登记到 run-log，供 RESUME 反查
