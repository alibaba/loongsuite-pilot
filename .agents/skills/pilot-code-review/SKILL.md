---
name: pilot-code-review
description: 在进行 Code Review 时，使用这个技能对 LoongSuite-Pilot 变更进行安全导向、架构一致性优先的深度代码评审。
metadata:
  requires:
    bins:
      - python3
      - git
      - gh
---
# Code Review Agent Skill

你是 LoongSuite-Pilot 项目的高级代码审查助手。你的核心目标是发现真实缺陷、行为回归和风险点，而不是给出泛泛建议。

为避免假阳性，必须遵守：

- 分析问题时必须包含充分上下文，不能只看局部 diff 就下结论。
- 结论必须基于实际读取到的代码与变更，不允许基于记忆或猜测。
- 先理解作者意图和端到端流程，再给出问题判断。
- 遵循以下执行步骤，以实现代码修改后可以针对增量 Review，检查既有评审的修复情况。

## TOC

- [Preflight（确保依赖工具存在）](#preflight确保依赖工具存在)
- [Review Worktree（评审现场隔离，禁止污染主路径）](#review-worktree评审现场隔离禁止污染主路径)
- [Review Plan（开始前规划，避免遗漏）](#review-plan开始前规划避免遗漏)
- [脚本失败降级策略](#脚本失败降级策略)
- [Phase 1: Review Workspace & Incremental State（评审工作区与增量状态）](#phase-1-review-workspace--incremental-state评审工作区与增量状态)
- [Phase 2: Context Building（全局认知）](#phase-2-context-building全局认知)
- [Phase 3: Intent Analysis（意图理解）](#phase-3-intent-analysis意图理解)
- [牢记评估标准（无需输出）](#牢记评估标准无需输出)
- [Phase 4: Sub-agent Review（专项检查）](#phase-4-sub-agent-review专项检查)
- [Phase 5: Final Report（最终输出）](#phase-5-final-report最终输出)
- [Phase 6: 评审结果发布（提交到平台）](#phase-6-评审结果发布提交到平台)

## Preflight（确保依赖工具存在）

在进入 Phase 1 前，必须先执行以下命令并全部通过：

- `python3 --version`
- `git rev-parse --is-inside-work-tree`
- `gh auth status`

若任一命令失败，必须停止后续评审步骤，并按 `references/failure-playbook.md` 修复后重试。

## Review Worktree（评审现场隔离，禁止污染主路径）

**核心约束：任何需要「切到评审分支代码」的动作,必须在独立 worktree 中进行,禁止在主工作路径 `git checkout` / `git pull` 切分支。**

主路径通常带有用户未提交的改动;直接切分支会污染工作区、丢失现场,并让评审读到错误的代码。因此固定两套路径,全程携带,不得混用:

- `REPO_ROOT`：主仓库根目录。**只**用于两件事:
  - `code-review/` 评审工作区(meta/plan/comments/snapshot/report)的落盘;
  - 所有 `scripts/*.py` 的 `--repo-root` 参数(脚本经 `git show <sha>:<path>` / `git diff base..head` 读代码,只依赖对象库,**无需 checkout**)。
- `REVIEW_WORKTREE`：评审现场 worktree,checkout 到本轮 `head` SHA,供 Read/Grep 及所有子 agent 读取**真实文件上下文**。

### 建立评审现场(正式评审前必做)

1. 读取远程 PR 当前 `headRefOid`(或分支当前 `HEAD` SHA),记为 `HEAD_SHA`;同时确定 `BASE_SHA`。在 `final-report.md` 顶部记录 `HEAD_SHA`,便于追溯。
2. 仅向主仓库对象库拉取所需提交,**不切换主路径工作树**:
   - PR：`git -C <REPO_ROOT> fetch origin pull/<pr>/head`(或对应 head ref);
   - 分支：`git -C <REPO_ROOT> fetch origin <branch>`。
   - 注意:只用 `git fetch`,**禁止** `git pull --ff-only` / `git checkout` / `git switch` 作用于主路径。
3. 以 detached HEAD 在隔离目录建立评审现场(只读评审,不需要新分支):
   ```bash
   REVIEW_WORKTREE="<REPO_ROOT>/.claude/worktrees/cr-<target>"   # <target> 同评审目录命名,如 pr-123 / branch-foo-bar
   # 已存在则复用并对齐到本轮 HEAD_SHA;不存在则新建
   if git -C "<REPO_ROOT>" worktree list --porcelain | grep -qF "$REVIEW_WORKTREE"; then
     git -C "$REVIEW_WORKTREE" checkout --detach "<HEAD_SHA>"
   else
     git -C "<REPO_ROOT>" worktree add --detach "$REVIEW_WORKTREE" "<HEAD_SHA>"
   fi
   ```
4. 后续所有「读代码」动作(Phase 2 上下文构建、Phase 3 意图分析、Phase 4 子 agent)一律在 `REVIEW_WORKTREE` 内进行:
   - 派生子 agent 时,在 prompt 中显式告知代码根目录为 `REVIEW_WORKTREE`,或将子 agent 的工作目录设为该路径;
   - Read/Grep/Glob 的文件路径基于 `REVIEW_WORKTREE`;
   - 脚本调用仍用 `--repo-root <REPO_ROOT>`(见上)。
5. 评审结束(Phase 6 发布完成后)清理现场,保留主仓库与 `code-review/` 工作区不变:
   ```bash
   git -C "<REPO_ROOT>" worktree remove "$REVIEW_WORKTREE"   # 有未提交改动时评审属异常,先排查再决定是否 --force
   ```
   - 若同一 PR/分支预计短期内会再评审(增量轮次),可保留 worktree,下轮按步骤 3 对齐到新的 `HEAD_SHA` 复用。

## Review Plan（开始前规划，避免遗漏）

在进入 Phase 1 细节步骤前，先在评审目录生成并维护 `review-plan.md`，用于“逐步执行 + 勾选校验”：

1. 文件路径：
   - PR：`code-review/pr-<number>/review-plan.md`
   - 分支：`code-review/branch-<name>/review-plan.md`
2. 至少包含：
   - 本轮评审对象（PR/分支、base/head SHA）
   - 本轮待办清单（checkbox），按“**大项 + 子项**”拆分
   - 当前阶段标记（`in_progress`）
   - 阻塞项与降级记录（若有）
3. 执行要求：
   - 每完成一个步骤，必须同步勾选；
   - 若中断或切换策略（如 `incremental -> full`），必须先更新计划再继续。
   - 不允许只写 Phase 名称而不拆子项（例如“Phase 1”必须细分到拉评论、更新状态、映射决策等子项）。
4. 模板使用：
   - `references/review-plan.template.md` 仅提供骨架；
   - agent 必须根据本轮实际情况自行填写大项与子项。

## 脚本失败降级策略

若执行脚本报错，允许进入降级评审模式继续完成代码评审，但必须执行以下动作用于持续优化 skill：

- 在 `code-review/<target>/script-failures.md` 记录失败信息（脚本名、命令、错误摘要、触发时间、回退策略）。
- 评审继续时一律切换到 `full` 全量评审，并人工核对关键状态文件。
- 在 `final-report.md` 增加 “Script Failure Feedback” 小节，说明失败影响范围与人工补偿动作。
- 将失败信息反馈到技能维护通道（可用时使用 `mcp-feedback-enhanced`，不可用时至少落盘到 `script-failures.md` 供后续回收）。

## Phase 1: Review Workspace & Incremental State（评审工作区与增量状态）

开始评审前，先初始化或复用仓库根目录下的评审工作区：

- PR 评审目录：`code-review/pr-<number>/`
- 分支评审目录：`code-review/branch-<name>/`
- 目录不存在时必须创建，且保留历史评审轮次

该目录至少包含以下文件：

- `meta.json`：评审对象与基线元数据（repo、base/head、review 时间、策略参数）
- `review-plan.md`：本轮执行计划与勾选进度（先计划再执行）
- `reviewed_commits.json`：已评审 commit 集合与映射记录
- `intent-architecture-notes.md`：代码理解文档（Phase 3）
- `final-report.md`：最终报告（Phase 5）
- `comments/review-comments.json`：PR review comments 原始快照（仅此来源）
- `comments/comment-status.json`：评论状态判定结果（流程状态 + 技术状态）

输入门禁：

- 首次运行：
  - 允许上述文件不存在；
  - 必须先执行初始化脚本生成最小文件骨架，再继续后续步骤。
- 非首次运行：
  - 关键输入文件必须存在且 schema 合法；
  - 若不合法，必须按 `references/failure-playbook.md` 执行“全量重建/重抓取”恢复流程，不允许手工拼接 JSON 继续运行。

模板与脚本目录（必须使用）：

- JSON 模板：`/.claude/skills/code-review/references/`
- 流程脚本：`/.claude/skills/code-review/scripts/`

执行步骤（必须按顺序）：

1. 初始化评审目录与基础文件：
   - PR：`python3 .claude/skills/code-review/scripts/init_review_workspace.py --repo-root <repo> --target-type pr --target-id <pr> --base-ref <baseRef> --head-ref <headRef> --base-sha <baseSha> --head-sha <headSha>`
   - 分支：`python3 .claude/skills/code-review/scripts/init_review_workspace.py --repo-root <repo> --target-type branch --target-id <branchName> --base-ref <baseRef> --head-ref <headRef> --base-sha <baseSha> --head-sha <headSha>`
2. 生成/更新 `review-plan.md`（可基于 `references/review-plan.template.md` 骨架，但必须补齐本轮大项/子项），并将当前阶段标记为 `Phase 1 in_progress`。
3. 拉取 review comments 到 `comments/review-comments.json`：
   - PR 评审：必须运行 `python3 .claude/skills/code-review/scripts/fetch_review_comments.py --repo-root <repo> --target-type pr --target-id <pr>`，仅 `PR review comments`
   - 分支评审：可为空，或导入分支评审评论快照
   - `review-comments.json` 必须是标准对象结构（根对象含 `comments` 数组，元素含 `comment_id/path/line/side/body`）；若不满足，视为上游脚本错误，必须先修正上游脚本。
   - 评论项必须包含 `thread_resolved` 布尔字段；流程状态仅由该字段决定（`true -> resolved`，`false -> open`）。
   - `snapshot/` 必须保留源码相对路径层级，禁止平铺文件名。示例：`snapshot/round-2/files/core/ebpf/protocol/redis/RedisParser.cpp`。若出现平铺结果，视为快照脚本错误或中途中断，必须重跑修正。
4. 生成/更新评论状态文件：
   - PR：`python3 .claude/skills/code-review/scripts/update_comment_status.py --repo-root <repo> --target-type pr --target-id <pr>`
   - 分支：`python3 .claude/skills/code-review/scripts/update_comment_status.py --repo-root <repo> --target-type branch --target-id <branchName>`
   - 说明：这一步只同步结构与流程状态（`status_flow`）并保留历史 `status_tech`，不会自动做代码复核判定。
5. 生成双维状态 Markdown 报告（表格）：
   - PR：`python3 .claude/skills/code-review/scripts/generate_comment_status_report.py --repo-root <repo> --target-type pr --target-id <pr>`
   - 分支：`python3 .claude/skills/code-review/scripts/generate_comment_status_report.py --repo-root <repo> --target-type branch --target-id <branchName>`
   - 输出文件固定为：`comments/comment-status.md`（列：评论时间、文件、行号、作者、评论、流程状态、技术状态）
6. 计算增量映射与回退建议（`--base` 与 `--head` 必须传 commit SHA）：
   - PR：`python3 .claude/skills/code-review/scripts/incremental_review_mapper.py --repo-root <repo> --target-type pr --target-id <pr> --base <baseSha> --head <headSha> --review-round <n>`
   - 分支：`python3 .claude/skills/code-review/scripts/incremental_review_mapper.py --repo-root <repo> --target-type branch --target-id <branchName> --base <baseSha> --head <headSha> --review-round <n>`
   - 当 `snapshot/latest.json` 存在时，映射脚本会计算 `snapshot_match_rate`，用于 rebase 冲突调整或 squash 合并后的增量决策辅助。
7. 根据脚本输出中的 `recommendation` 执行：
   - `incremental`：只评审 `need_review_commits`
   - `partial`：优先评审 `need_review_commits`，并补审低置信 hunk
   - `full`：执行全量评审，但必须做历史意见去重

8. 技术状态（`status_tech`）必须逐条复核，不允许猜测：
   - 必读输入（按顺序）：
     1) `comments/review-comments.json`
     2) `comments/comment-status.json`
     3) `reviewed_commits.json`
     4) 当前代码中与 comment `path` 对应文件
     5) `snapshot/` 中同路径历史快照文件（若存在）
   - 逐条处理规则（按 `comment_id`）：
     - 仅允许更新：`status_tech`、`mapped_finding_id`、`notes`
     - `status_tech` 仅可取：`fixed|not-fixed|false-positive|partially-fixed`
     - `notes` 必须写明“判定证据”，至少包含：对比文件、关键代码变化、结论原因
     - 每轮必须优先复核上一轮未终态条目（`not-fixed`、`partially-fixed`）。
   - 人工手动订正（支持）：
     - 若评论作者本人（当前 `gh` 登录账号）在该评论线程回复文本包含 `fixed`，状态同步为 `fixed`。
     - 若回复文本包含 `false-positive`（或 `false positive`），状态同步为 `false-positive`。
     - 手动订正由脚本在更新 `comment-status.json` 时自动吸收，并写入 `notes`。
   - 终态跳过规则（默认开启）：
     - 当前 `status_tech` 为 `fixed` 或 `false-positive` 的条目，本轮默认跳过技术复核。
     - 仅在以下条件触发时重开复核：
       1) 条目 `path` 在本轮 commit 范围内再次发生修改；
       2) 条目 `status_flow` 从 `resolved` 变为非 `resolved`；
       3) 人工显式指定强制复核（按 `comment_id` 列表）。
   - 输出要求：
     - 更新后的 `comments/comment-status.json`
     - 重新生成 `comments/comment-status.md`
9. 本轮评审收尾后，必须生成 snapshot 供下一轮增量决策使用：
   - PR：`python3 .claude/skills/code-review/scripts/build_snapshot.py --repo-root <repo> --target-type pr --target-id <pr> --base <baseSha> --head <headSha> --review-round <n>`
   - 分支：`python3 .claude/skills/code-review/scripts/build_snapshot.py --repo-root <repo> --target-type branch --target-id <branchName> --base <baseSha> --head <headSha> --review-round <n>`
   - 产物：`snapshot/round-<n>/files/*`、`snapshot/round-<n>/manifest.json`、`snapshot/latest.json`

状态文件字段约束（必须遵守）：

- `reviewed_commits.json` 记录：
  - `commit_sha`
  - `patch_id`（用于 rebase 后精确映射）
  - `review_round`
  - `reviewed_at`
  - `hunk_fingerprints`（数组）
- `comments/comment-status.json` 记录：
  - `comment_id`
  - `path` / `line` / `side`
  - `body`
  - `snippet`（可读代码片段）
  - `snippet_fingerprint`（规范化片段 hash）
  - `status_flow`（`open|resolved|wont-fix|deferred`）
  - `status_tech`（`fixed|not-fixed|false-positive|partially-fixed`）
  - `mapped_finding_id`

说明：

- `snippet_fingerprint` 定义为“规范化代码片段 + 文件路径 + 评论定位三元组（line/side/comment_id）”的稳定 hash，不能只用行号。
- 允许人工修正 `status_flow` 与 `status_tech`，但不得删除历史记录。

增量评审策略（必须执行）：

1. 优先读取 `reviewed_commits.json`，只评审未覆盖的新变更。
2. 若检测到 rebase/force-push，不可直接判定全量重审，先做映射再决策：
   - L1（高置信）：按 `patch-id` 映射旧 commit -> 新 commit，命中后继承“已评审”状态。
   - L2（中置信）：按 `path + 规范化 hunk 片段 + hunk 上下文` 做指纹匹配，仅补审未命中 hunk。
   - L3（低置信）：命中率低或冲突改写明显时，回退全量评审。
3. 置信度门槛默认：
   - `commit_map_rate >= 90%`：增量通过
   - `hunk_match_rate >= 80%`：局部补审
   - 否则全量回退
4. 即使全量回退，也必须复用历史评论与 finding 去重，避免重复意见。

snapshot 在增量决策中的职责（必须遵守）：

1. `snapshot` 是增量决策辅助依据，不替代 git 主链路（`patch-id`/`hunk`）。
2. rebase 且发生冲突改写时，若 commit/hunk 映射不足，可使用 `snapshot_match_rate` 辅助从 `full` 降到 `partial`。
3. squash 合并导致 commit 边界丢失时，`snapshot_match_rate` 用于判断是否可继续增量评审。
4. 若 `snapshot_match_rate` 不足阈值，仍必须 `full` 全量评审。

## Phase 2: Context Building（全局认知）

开始评审前，必须先完成以下步骤（所有「读代码」路径均基于 `REVIEW_WORKTREE`，见 [Review Worktree](#review-worktree评审现场隔离禁止污染主路径)，禁止在主路径读取切分支后的代码）：

1. 读取 `/AGENTS.md`，建立系统架构、模块职责和 Agent 采集矩阵认知。
2. 读取 `/docs/modules/` 下对应模块文档，优先吸收：
   - 公共能力入口（必须复用的 `src/utils/` 工具函数）
   - 生命周期与资源释放不变量（Orchestrator 启动/停止流程）
   - 配置约定（`config.json`、`agent-control.json`、`agents.d/*.json` 声明文件）
   - 历史 review 高频问题（作为优先检查清单）
3. 读取并参考以下文档（按变更涉及范围选择）：
   - `/docs/modules/core.md`（核心编排与生命周期相关改动必读）
   - `/docs/modules/inputs.md`（输入源采集相关改动必读）
   - `/docs/modules/flushers.md`（数据输出相关改动必读）
   - `/docs/modules/hooks.md`（部署与 Hook 策略相关改动必读）
   - `/docs/modules/checkpoints.md`（状态持久化相关改动必读）
4. 基于 PR/分支变更列表，读取受影响文件的完整上下文（至少覆盖变更函数、调用方、定义处）。
5. 若改动涉及核心编排/输入管理/部署系统，必须先阅读以下代码再下结论：
   - `src/core/orchestrator.ts`（主启动流程、生命周期管理、退出顺序）
   - `src/core/input-manager.ts`（输入源注册与管理）
   - `src/core/agent-discovery-service.ts`（Agent 发现与准入）
   - `src/core/agent-control-manager.ts`（Agent 准入控制策略）
   - `src/core/config-loader.ts`（配置加载与校验）
   - `src/deployment/deployment-manager.ts`（Agent 部署管理）
   - `src/deployment/hook-strategy.ts`（Hook 部署策略）
   - `src/deployment/plugin-probe-strategy.ts`（Plugin-Probe 部署策略）
   - `src/checkpoints/state-store.ts`（偏移状态持久化）
   - `src/checkpoints/snapshot-store.ts`（快照去重状态管理）
6. 通过 MCP/`gh` 工具拉取评审上下文：
   - PR 描述、提交历史、PR review comments、CI 状态
   - 最近约 10 个相关 PR 的 review 评论（提炼团队偏好）
7. 若可访问 Code 平台历史评论，优先抽样最近已合入 PR 的 review comments（建议>=30条）并做“模式交叉”：
   - 把历史高频问题映射到本次变更文件，标记为“高风险检查项”
   - 若与 `codebase-map` 冲突，以“最新代码事实 + 评论证据”更新结论
8. 若发现历史约束或设计决策冲突，先记录“假设与证据”，后续在报告中显式说明。

## Phase 3: Intent Analysis（意图理解）

完成上下文分析后，必须先产出“理解文档”，再进入问题列表。该文档是给开发者学习和理解代码用的，不能省略。

### Phase 3 输出要求（必须输出文档）

必须输出一个独立文档（建议标题：`Code Review - Intent & Architecture Notes`），至少包含：

- 作者意图：这个 PR/分支要解决什么问题，为什么现在做。
- 端到端流程：从入口到出口，这次变更实际改变了哪些关键路径。
- 影响范围：涉及哪些模块、接口、配置、状态文件、监控指标、告警链路。
- 预期结果验证：改动是否达到目标，并给出证据与推理过程。

### Phase 3 落盘要求（必须写入 code-review 目录）

必须将 Phase 3 文档写入仓库 `code-review/` 目录，禁止只在聊天中输出。

建议路径：

- PR 评审：`code-review/pr-<number>/intent-architecture-notes.md`
- 分支评审：`code-review/branch-<branchName>/intent-architecture-notes.md`（`/` 替换为 `-`）

要求：

- 若目录不存在必须先创建。
- 文档顶部必须包含评审对象元信息（PR号/分支名、commit范围、生成时间）。

### Mermaid 可视化要求（必须至少 2 张图）

该理解文档必须包含 Mermaid 图，用于帮助学习与沟通。按改动内容选择，至少输出以下 2 类中的 2 张：

- 架构图（模块关系 / 依赖边界）
- 流程图（关键执行路径）
- 时序图（组件交互、调用顺序、异步/重试行为）
- 数据结构图（关键状态对象、队列、checkpoint 主从关系）

建议：

- 小改动：至少 2 张图（流程 + 时序）
- 中大型改动：3-4 张图（架构 + 流程 + 时序 + 数据结构）

注意：

- 图必须与当前变更强相关，禁止画与本次 PR 无关的“百科全图”。
- 图中节点命名使用代码中的真实组件/类型名称，避免抽象空词。
- Mermaid 语法请遵循标准 Mermaid 规范，确保 GitHub/IDE 可正确渲染。

## 牢记评估标准（无需输出）

对每个变更文件和差异块，按以下 6 组标准检查：

1. 业务与架构：目标达成、职责边界、拓扑与依赖、故障传播。
2. 正确性与安全：边界检查、类型/异常处理、外部输入防御、安全合规。
3. 并发与生命周期：线程/锁/队列正确退出、资源释放、状态恢复。
4. 性能与资源：热路径复杂度、拷贝与分配、容量上限、日志开销。
5. 稳定性与可观测：指标/日志/告警完整性与可定位性。
6. 可维护性、兼容性与文档测试：可读性、向后兼容、文档与测试覆盖。

注意：以上不是“通用建议列表”，而是必须落到每个 sub-agent 的责任范围中执行（见下一节责任矩阵）。

## Phase 4: Sub-agent Review（专项检查）

并行启动专项 sub-agent（建议 3-4 个并行，避免过度拆分）。每个 sub-agent 独立输出“发现的问题 + 证据”。
派生每个 sub-agent 时，必须在其 prompt 中显式传入 `REVIEW_WORKTREE` 作为代码根目录（见 [Review Worktree](#review-worktree评审现场隔离禁止污染主路径)），要求其一切文件读取（Read/Grep/Glob）都基于该路径，严禁读取主仓库工作树上被切换过的代码。
每个 sub-agent 必须引用“牢记评估标准”中对应条目，不得只做口头判断。
每个问题必须标注来源标准编号（例如：`[S3]` 表示“并发与生命周期”）。

### 责任矩阵（主责/次责）

- Sub-agent A（逻辑与架构）：主责 `S1`，次责 `S6`
- Sub-agent B（并发与生命周期）：主责 `S3`，次责 `S5`
- Sub-agent C（安全稳定与性能）：主责 `S2` + `S4`，次责 `S5`
- Sub-agent D（复用、兼容、文档测试）：主责 `S6`，次责 `S1` + `S5`

规则：

- 主责标准必须全量覆盖；次责标准只需覆盖与本次改动直接相关的部分。
- 若某问题跨多个标准，允许多标记（如 `[S2][S4]`）。
- 不允许多个 agent 报告同一问题的重复结论；若重复，保留证据更完整的一条。

### Sub-agent A: 逻辑正确性与架构一致性

- 业务逻辑是否完整，是否存在边界漏处理、状态不一致、错误传播断裂。
- 与 LoongSuite-Pilot 架构约束是否一致（Orchestrator 编排、Input/Flusher 职责分离、Agent 声明式部署模式、归一化流水线）。
- 是否引入隐式依赖、循环依赖或故障传播不可观测的问题。
- 重点覆盖评估标准：业务与架构、可维护性与兼容性。

### Sub-agent B: 并发、异步与生命周期

- 异步流程（Promise/async-await）是否存在竞态、未处理 rejection、错误吞没。
- 定时任务（setInterval/setTimeout）是否可控停止，是否在 shutdown 时正确清理。
- EventEmitter 监听器是否正确移除，是否存在内存泄漏风险。
- 重点覆盖评估标准：并发与生命周期、稳定性与可观测。
- 生命周期/资源管理必查细则（必须逐项核对，重点是”正确释放与状态恢复”）：
  - 资源释放闭环：
    - 每条路径（启动失败、Agent 热更新、配置变更、进程退出）都要核对资源闭环：
      - 定时器/Interval 可停止并被清理
      - Input 实例可正确销毁，不残留文件句柄或 watcher
      - Flusher 缓冲区在退出前完成 flush
      - Hook 子进程可被正确终止
  - 竞态与卡死风险：
    - Orchestrator 启动/停止顺序是否保证各模块依赖的先后关系。
    - InputManager 注册/注销是否与 AgentDiscoveryService 的发现回调存在竞态。
    - DeploymentManager 部署/卸载与 Input 注册是否可能形成不一致状态。
  - 状态恢复正确性（核心）：
    - Agent 发现变更后，是否恢复到”可继续采集+归一化+输出”的一致状态，而非部分组件已恢复。
    - StateStore/SnapshotStore 的 persist/load 是否在异常退出后保持一致性。
    - 配置变更或 Agent 准入策略变化时，已运行 Input 是否正确响应（停止/重启/忽略）。
  - 顺序检查作为辅证（不是唯一判据）：
    - 仍需核对关键顺序（Orchestrator init 顺序、Input start/stop 顺序、Flusher flush 时机），但结论必须落到资源与状态结果。

### Sub-agent C: 安全、稳定性与性能

- 输入校验、异常处理、重试退避是否完备。
- 外部数据（Agent 产出的日志/SQLite/Hook 输出）是否做了必要的格式校验与边界防御。
- 是否存在热路径性能回退（重复计算、大对象拷贝、数组/Map 无限增长、高频日志刷屏）。
- 监控指标/告警是否完整（内部 dashboard、健康状态上报）。
- 重点覆盖评估标准：正确性与安全、性能与资源、稳定性与可观测。
- Checkpoint/State 必查细则（按改动范围选择）：
  - StateStore（偏移状态）：
    - 启动时 `load()` 是否正确恢复上次采集偏移，避免重复采集或数据丢失。
    - 状态持久化频率是否合理，异常退出后是否可能丢失过多进度。
    - 多 Input 实例是否存在 key 冲突或覆盖风险。
  - SnapshotStore（去重快照）：
    - 快照比对逻辑是否正确，是否可能导致重复数据或漏采。
    - 快照数据增长是否有限制，是否可能导致内存/磁盘无限膨胀。
    - `~/.loongsuite-pilot/logs/snapshot-store.json` 的读写是否原子性安全。

### Sub-agent D: 复用合规与文档一致性

- 是否重复实现了已有公共能力（优先复用 `src/utils/` 工具函数与 `src/inputs/base/` 基类）。
- 注释与代码行为是否一致，TODO/FIXME 是否引入新技术债。
- Agent 声明文件（`agents.d/*.json`）或配置变更是否同步更新 `docs/` 对应文档。
- 类型定义（`src/types/`）变更是否与现有 Input/Flusher/Normalization 保持兼容。
- 重点覆盖评估标准：可维护性、兼容性与文档测试。

## Phase 5: Final Report（最终输出）

Final Report 偏实用交付，可直接用于落地修复和平台流转。它与 Phase 2 的“理解文档”并行存在、互不替代。

### Phase 5 输出要求（实用导向）

1. 先给 **Findings**，按严重度排序：`Critical` > `High` > `Medium` > `Low`。
2. 每个问题必须包含可定位证据与可执行建议。
3. 若未发现问题，明确写出“未发现阻断问题”，并列出残余风险与测试缺口。
4. 最后补充 **Highlights**（正向实践），简洁即可。
5. 必须包含 **Lifecycle Verdict**：
   - 资源释放：`PASS/FAIL`
   - 死锁/卡死风险：`PASS/FAIL`
   - 状态恢复正确性：`PASS/FAIL`
   - 每项附 1-3 条证据。
6. 必须包含 **Fix Plan**（按优先级分组）：
   - 立即修复（阻断合入）
   - 合入前修复
   - 可后续改进
7. 必须包含 **Validation Plan**（修复后怎么验证）：
   - 需要跑哪些测试、观察哪些指标、验证哪些告警与恢复路径。

### Final Report 落盘要求（必须写入 code-review 目录）

必须将 Final Report 写入仓库 `code-review/` 目录，禁止只在聊天中输出。

建议路径（与 Phase 2 同目录）：

- PR 评审：`code-review/pr-<number>/final-report.md`
- 分支评审：`code-review/branch-<branchName>/final-report.md`（`/` 替换为 `-`）

要求：

- `final-report.md` 必须引用对应的 `intent-architecture-notes.md`（相对路径链接）。
- Phase 6 执行后，文档末尾会自动追加 "Platform Publish" 小节（含发布链接或失败原因）。

问题输出格式：

```markdown
- Severity: <Critical|High|Medium|Low>
  - File: [<路径>:<起始行号>](file://./<路径>#L<起始行号>)
  - 问题: <一句话说明问题本质>
  - 影响: <可能导致的错误行为/风险>
  - 建议: <可直接执行的修复建议，必要时给最小代码片段>
```

额外要求：

- 行号必须在最终输出前重新核对，确保可点击跳转。
- 仅评论真实变更范围内的问题，避免“顺手重构建议”淹没核心缺陷。
- 语气专业、直接、简洁，优先给出可验证结论。

## Phase 6: 评审结果发布（提交到平台）

评审完成后，**必须**将评审结果自动发布到对应的代码评审平台（GitHub PR 或 GitLab CR）。本阶段不需要额外的用户确认——用户调用 code-review 技能本身即表示发布意图。

### 6.1 平台检测（自动）

按以下优先级判定目标平台：

1. **GitLab（Code 平台）**：若评审目标来自 `mcp__code__` 系列工具（如通过 `mcp__code__get_merge_request_detail` 可正常获取 MR 信息），或 git remote URL 匹配 `gitlab.alibaba-inc.com`。
2. **GitHub**：若 `gh auth status` 认证通过，且 git remote URL 匹配 `github.com`。
3. **混合场景**：若同时存在两个平台上下文，以用户输入的评审对象为准（PR number → GitHub，MR ID → GitLab）。

在 `meta.json` 中记录 `platform` 字段（`github` 或 `gitlab`），后续步骤据此分流。

### 6.2 发布内容结构

发布分为两部分，必须**全部**执行：

#### A) Inline Findings（行内评论）

将 `final-report.md` 中每个可定位的 Finding（有明确 `path` + `line`）逐条作为代码行内评论发布：

- 每条评论格式：

  ```
  **[<Severity>]** <问题描述>

  **影响:** <影响说明>
  **建议:** <修复建议>
  ```

- 只发布 `Critical`、`High`、`Medium` 级别的 inline findings（`Low` 级别归入摘要）。
- 行号必须对应 diff 中的新文件行号（`side: RIGHT`）。
- 若某问题跨多行，取起始行号。

#### B) Summary Comment（摘要评论）

将 Final Report 摘要作为一条顶层评论发布，结构如下：

```markdown
## 🔍 Code Review Summary

| Severity | Count |
|----------|-------|
| Critical | X |
| High     | Y |
| Medium   | Z |
| Low      | W |

### Lifecycle Verdict

| Check | Result |
|-------|--------|
| 资源释放 | PASS/FAIL |
| 死锁/卡死风险 | PASS/FAIL |
| 状态恢复正确性 | PASS/FAIL |

<FAIL 项的 1-3 条证据>

### 总体结论

<一段话总结：是否阻断合入、主要风险点>

### Highlights（正向实践）

<简洁列出正向实践>

---
*评审报告详见: `code-review/<target>/final-report.md`*
*Generated by LoongSuite-Pilot Code Review Agent*
```

### 6.3 GitHub 平台发布流程

当 `platform == "github"` 时：

1. **获取 PR head commit SHA**：
   ```bash
   gh pr view <pr-number> --json headRefOid --jq '.headRefOid'
   ```

2. **发布 Inline Findings**（逐条）：
   ```bash
   gh api repos/<owner>/<repo>/pulls/<pr>/comments \
     -f commit_id="<head_sha>" \
     -f path="<file_path>" \
     -F line=<line_number> \
     -f side="RIGHT" \
     -f body="<formatted_comment>"
   ```

3. **发布 Summary Comment**：
   - 先将摘要写入临时文件 `code-review/<target>/platform-summary.md`
   - 然后：
   ```bash
   gh pr comment <pr-number> --body-file code-review/<target>/platform-summary.md
   ```

4. **记录发布结果**：
   - 在 `final-report.md` 末尾追加 "Platform Publish" 小节，记录发布时间和结果。

### 6.4 GitLab（Code 平台）发布流程

当 `platform == "gitlab"` 时，按以下优先级选择发布通道：

#### 通道选择（自动探测，逐级降级）

| 优先级 | 通道 | 探测方式 | 适用场景 |
|--------|------|----------|----------|
| 1 | MCP（`mcp__code__*`） | 尝试调用 `mcp__code__get_merge_request_detail`，成功即可用 | 交互式 Claude Code 会话、MCP server 在线 |
| 2 | GitLab API（`curl`） | 检查 `GITLAB_TOKEN` 环境变量或 `~/.gitlab-token` 文件 | MCP 不可用、headless/CI 环境、OAuth 过期 |
| 3 | 手动输出 | 兜底：将评论内容完整输出到聊天和落盘文件 | 无任何认证可用 |

探测逻辑（必须按顺序执行）：

1. 尝试 MCP：调用 `mcp__code__get_merge_request_detail`，若返回正常数据 → 使用通道 1。
2. 若 MCP 调用超时、报错、或工具不存在 → 检查 GitLab token：
   - 优先读取环境变量 `GITLAB_TOKEN`
   - 其次读取 `~/.gitlab-token` 文件（首行为 token）
   - 验证 token：`curl -s -o /dev/null -w "%{http_code}" -H "PRIVATE-TOKEN: $token" "https://gitlab.alibaba-inc.com/api/v4/user"`
   - 返回 200 → 使用通道 2
3. 若 token 也不可用 → 使用通道 3（手动输出），并在 `publish-result.json` 标记 `channel: "manual"`。

在 `publish-result.json` 中记录实际使用的 `channel`（`mcp` / `gitlab_api` / `manual`）。

#### 通道 1：MCP 发布

1. **获取 MR 信息**：
   - 使用 `mcp__code__get_merge_request_detail` 确认 MR 状态为 `opened`。
   - 使用 `mcp__code__list_merge_request_changed_files` 获取变更文件列表，确保 inline 评论的 path 在变更范围内。

2. **发布 Inline Findings**（逐条）：
   - 对每个有明确 `path` + `line` 的 Finding，使用 `mcp__code__comment_merge_request_changed_file`：
     - `repo`: 仓库路径（如 `sls/loongsuite-pilot`）
     - `mergeRequestId`: MR ID
     - `path`: 变更文件路径
     - `line`: 新文件行号
     - `note`: 格式化的评论内容

3. **发布 Summary Comment**：
   - 使用 `mcp__code__comment_merge_request`：
     - `repo`: 仓库路径
     - `mergeRequestId`: MR ID
     - `note`: 摘要评论内容（同 6.2-B 格式）

4. **记录发布结果**：
   - 在 `final-report.md` 末尾追加 "Platform Publish" 小节。

#### 通道 2：GitLab API 直调（MCP 降级）

当 MCP 不可用时，通过 `curl` 直接调用 GitLab REST API：

**前置：解析仓库信息**

```bash
# 从 git remote 提取 repo path（如 sls/loongsuite-pilot）
GITLAB_REPO=$(git remote get-url origin | sed -E 's|.*gitlab\.alibaba-inc\.com[:/](.+?)(\.git)?$|\1|')
# 对 repo path 做 URL encode（/ → %2F）
GITLAB_REPO_ENCODED=$(echo "$GITLAB_REPO" | sed 's|/|%2F|g')
# Token（环境变量优先，否则从文件读取）
GITLAB_TOKEN="${GITLAB_TOKEN:-$(cat ~/.gitlab-token 2>/dev/null | head -1)}"
GITLAB_API="https://gitlab.alibaba-inc.com/api/v4"
```

**1. 获取 MR IID**（若只有 branch 名，需要先查询对应 MR）：

```bash
# 通过 source branch 查询 opened MR
curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "$GITLAB_API/projects/$GITLAB_REPO_ENCODED/merge_requests?source_branch=<branch>&state=opened" \
  | python3 -c "import sys,json; mrs=json.load(sys.stdin); print(mrs[0]['iid'] if mrs else '')"
```

**2. 获取 MR 变更文件列表**（用于校验 inline path 合法性）：

```bash
curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "$GITLAB_API/projects/$GITLAB_REPO_ENCODED/merge_requests/<mr_iid>/changes" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('\n'.join(c['new_path'] for c in d.get('changes',[])))"
```

**3. 发布 Inline Findings**（逐条，使用 MR discussions API 创建 diff note）：

```bash
curl -s -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  -H "Content-Type: application/json" \
  "$GITLAB_API/projects/$GITLAB_REPO_ENCODED/merge_requests/<mr_iid>/discussions" \
  -d '{
    "body": "<formatted_comment>",
    "position": {
      "position_type": "text",
      "base_sha": "<merge_base_sha>",
      "head_sha": "<head_sha>",
      "start_sha": "<merge_base_sha>",
      "new_path": "<file_path>",
      "new_line": <line_number>
    }
  }'
```

注意：
- `base_sha` / `start_sha` = MR 的 merge base commit（从 MR changes API 的 `diff_refs.base_sha` 获取）
- `head_sha` = MR 的 head commit（从 MR changes API 的 `diff_refs.head_sha` 获取）
- 若 inline 评论返回 400（行号不在 diff 范围），降级为全局评论并标注文件和行号

**4. 发布 Summary Comment**（全局 note）：

```bash
curl -s -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  -H "Content-Type: application/json" \
  "$GITLAB_API/projects/$GITLAB_REPO_ENCODED/merge_requests/<mr_iid>/notes" \
  -d '{"body": "<summary_content>"}'
```

**5. 记录发布结果**：同通道 1。

#### 通道 3：手动输出（兜底）

当 MCP 和 API token 均不可用时：

1. 将完整的 `platform-summary.md` 内容输出到聊天中，用户可手动粘贴到 CR。
2. 将各 inline findings 格式化输出（含文件路径和行号），用户可逐条复制。
3. 在 `publish-result.json` 中标记所有条目 `status: "manual_pending"`。
4. 输出提示：建议用户配置 `GITLAB_TOKEN` 环境变量或 `~/.gitlab-token` 文件以启用自动发布。

#### GitLab Token 配置说明（供用户参考）

生成 Personal Access Token：
1. 访问 `https://gitlab.alibaba-inc.com/-/profile/personal_access_tokens`
2. 创建 token，勾选 `api` scope
3. 保存到以下任一位置：
   - 环境变量：`export GITLAB_TOKEN="glpat-xxxx"`（加入 `.zshrc` / `.bashrc`）
   - 文件：`echo "glpat-xxxx" > ~/.gitlab-token && chmod 600 ~/.gitlab-token`

### 6.5 发布结果落盘

无论成功或失败，必须在评审目录生成以下文件：

- `code-review/<target>/platform-summary.md`：实际发布的摘要内容（可用于重试）。
- `code-review/<target>/publish-result.json`：发布结果记录，schema：
  ```json
  {
    "platform": "github|gitlab",
    "target_id": "<pr-number 或 mr-id>",
    "published_at": "<ISO timestamp>",
    "summary_comment": {
      "status": "success|failed",
      "error": "<失败原因，成功时为 null>"
    },
    "inline_comments": [
      {
        "path": "<file>",
        "line": <line>,
        "severity": "<severity>",
        "status": "success|failed",
        "error": "<失败原因>"
      }
    ],
    "stats": {
      "total_findings": <N>,
      "published": <M>,
      "failed": <F>
    }
  }
  ```

### 6.6 失败处理与重试

- 若单条 inline 评论发布失败，继续发布其余评论，不中断流程。
- 所有失败条目记录到 `publish-result.json`，并在 `final-report.md` 的 "Platform Publish" 小节说明失败原因。
- **通道降级**：若当前通道（MCP）在发布过程中出错（如连接中断），自动切换到下一通道（API/手动）继续发布剩余条目。
- 提供重试命令提示，例如：
  - GitHub: `gh pr comment <pr> --body-file code-review/<target>/platform-summary.md`
  - GitLab MCP: 说明 `mcp__code__comment_merge_request` 调用参数
  - GitLab API: 给出完整 `curl` 命令（含 token 占位符）
- 若整体发布失败（如认证过期、MCP 不可用、无 token），自动降级到通道 3（手动输出），在聊天中输出完整的发布内容供用户手动粘贴。

### 6.7 幂等性保护

- 发布前检查 `publish-result.json` 是否存在且 `published_at` 为本轮评审时间范围内。
- 若已发布过，默认**跳过重复发布**，除非用户显式要求重发。
- 若用户要求重发，先检查平台上是否已有本轮评审评论（通过 comment body 中的 `Generated by LoongSuite-Pilot Code Review Agent` 标记识别），避免重复评论堆积。

### 6.8 现场清理（收尾）

发布完成后，按 [Review Worktree](#review-worktree评审现场隔离禁止污染主路径) 步骤 5 清理评审现场 worktree（`git worktree remove`），保留 `code-review/<target>/` 工作区与主仓库不变。若预计短期内还会做增量评审，可保留 worktree 供下一轮对齐复用。
