---
name: loongsuite-pilot-release
description: 执行 LoongSuite Pilot external（商业版）和 GitHub 开源版发布流程；新版本开始时先固定同一份源码并发布 GitHub 开源版，再启动商业版 stable 或 canary，后续支持多次 rollout 放量/止血、canary hotfix、promote 转正式，以及中文 Release Note、tag 描述和 CR 创建。用于 /release、/release canary、/release rollout、/release promote、/release status、发布开源版等发布相关请求；当前不再发布 internal（集团版），所有商业版发布命令必须使用 --external；任何上传或更新 OSS、推送 GitHub tag/branch 或创建公开 GitHub Release 前必须展示 summary 并等待用户明确确认。
metadata:
  requires:
    bins:
      - git
      - node
      - bash
---
# Release Skill

执行 LoongSuite Pilot 发布生命周期。

**Input**:

```text
/release [patch|minor|major|X.Y.Z] external
/release canary [patch|minor|major|X.Y.Z] external
/release canary hotfix external
/release rollout <0-100> external
/release promote external
/release status external
```

核心原则：

- stable 发布是一站式流程：发布脚本完成后，继续生成 Release Note、更新 tag 描述并创建 CR。
- canary 发布是分阶段流程：`canary`、`rollout`、`hotfix` 阶段不创建 CR，不发布正式 Release Note；只有 `promote` 成功后才做正式 Release Note/tag/CR。
- 当前发布目标固定为 external（商业版）；所有 `deploy/release.sh` 和 `deploy/rollout.sh` 发布命令都必须带 `--external`。
- 不再发布 internal（集团版）。如果用户明确要求 internal、内部或集团版，停止并说明当前 skill 已按要求下线 internal 发布。
- 任何会上传包或更新 OSS `latest.json` 的动作，都必须先展示发布 summary，并等待用户明确确认后再执行真实命令。
- 所有商业版真实发布动作都依赖仓库内脚本：`deploy/release.sh` 与 `deploy/rollout.sh`；GitHub 开源版真实发布依赖 skill 内 `publish-github-opensource.sh`。
- 新版本的 stable 或 canary 流程必须先固定版本和内部源码，发布并验证 GitHub 开源版，再开始商业版发布；rollout、canary hotfix、promote 只继续已有商业版生命周期，不重复发布开源版。
- 开源版必须先 dry-run、展示 summary，并等待用户明确确认 `确认发布 GitHub 开源版 vX.Y.Z` 后才允许推送 GitHub tag/branch、上传公开 OSS 或创建 GitHub Release。开源版完成后，商业版仍需单独 summary 和 `确认发布到 external（商业版）`。
- GitHub 开源版发布的源码来源必须来自本次已固定的内部 release 分支 `.opensource-sync-state` marker commit；不要因为 GitHub `main` 有更新就自动改用最新 `main`。
- 发布动作成功后，如果配置了钉钉机器人环境变量，必须发送 Loongsuite 发布通知；通知失败只输出 warning，不阻断发布流程。

### 既有流程兼容性契约

本 skill 只把 GitHub 开源版调整到新版本商业发布之前；商业版自身的命令、确认门禁、阶段边界和收口顺序保持不变：

- 新版本公共前置：前置检查 → 解析版本并记录 `origin/master` → GitHub 开源版 dry-run/summary → GitHub 版本明确确认 → 创建本地冻结分支 `release/vX.Y.Z` → 发布并验证开源版。
- stable：公共前置完成 → 商业版 dry-run/summary → external 明确确认 → `deploy/release.sh --version X.Y.Z --external` → Release Note/tag/CR → 商业版通知。
- canary：公共前置完成 → 商业版 dry-run/summary → external 明确确认 → `deploy/release.sh --canary --version X.Y.Z --external` → 商业版通知 → 停在灰度态。
- rollout：dry-run/summary → external 明确确认 → `deploy/rollout.sh --percentage` → 商业版通知 → 停在灰度态。
- canary hotfix：前置检查 → dry-run/summary → external 明确确认 → `deploy/release.sh --canary --hotfix` → 商业版通知 → 停在灰度态。
- promote：读取状态/dry-run/summary → external 明确确认 → `deploy/rollout.sh --promote` → Release Note/tag/CR → 商业版通知。

顺序调整不得造成两边源码漂移：公共前置固定的内部 commit、内部 release 分支中的 `.opensource-sync-state`、GitHub 开源版 source commit 和后续商业版 release 分支必须保持一致。如果其中任一项在确认后变化，停止并重新展示 summary。rollout、hotfix、promote 不得重复创建 GitHub Release，也不得改变 canary、rollout、hotfix 阶段“不创建 CR、不发布正式 Release Note”的边界。Release Note 风格调整只改变正文结构和措辞，不改变 commit 范围、tag 指向、tag 发布或 CR 创建时机。

---

## 发布目标和确认闸门

### 目标解析

Map user wording to deploy mode:

- external / 外部 / 商业版 / commercial → external mode，追加 `--external`。
- internal / 内部 / 集团版 → unsupported。停止并说明当前 skill 已按要求不再发布 internal（集团版）。

If the user does not clearly specify external/commercial for any release lifecycle request, stop and ask for explicit external authorization:

```text
当前 release skill 只发布 external（商业版）。请明确回复“确认发布到 external（商业版）”后我再执行。
```

Do not infer deploy mode from prior conversation, branch name, default script behavior, or previous command output. The only supported deploy mode is external, and real commands must include `--external`.

### OSS 更新前确认

Before running any command that uploads a package or mutates OSS manifest state, show a summary and wait for explicit user confirmation.

Commands that require this confirmation:

- `bash deploy/release.sh ... --external` for stable release, canary release, and canary hotfix; this script builds and uploads.
- `bash deploy/rollout.sh --percentage <N> --external`; this mutates canary rollout in `latest.json`.
- `bash deploy/rollout.sh --promote --external`; this promotes canary to stable in `latest.json`.
- `.agents/skills/loongsuite-pilot-release/scripts/publish-github-opensource.sh ...`; this can push GitHub release branch, create GitHub tag/Release, and upload public OSS artifacts.

Commands that do not require OSS-update confirmation:

- `git status`, `git fetch`, `git log`, tag inspection, and other read-only git checks.
- `bash deploy/release.sh ... --external --dry-run`.
- `bash deploy/rollout.sh ... --external --dry-run`.
- `/release status`, because it must be read-only.

Use dry-run/status output to build a summary whenever possible:

- For stable/canary/hotfix release, run `bash deploy/release.sh <args> --external --dry-run` after target is resolved.
- For rollout, run `bash deploy/rollout.sh --percentage <N> --external --dry-run`.
- For promote, run `bash deploy/rollout.sh --promote --external --dry-run`.
- For GitHub open-source release, resolve the pinned source commit first, prepare the release-note file, then run `.agents/skills/loongsuite-pilot-release/scripts/publish-github-opensource.sh --version X.Y.Z --source <marker> --notes-file <notes.md> --dry-run`.

Summary template:

```text
发布确认：
- 动作：stable release | canary release | canary hotfix | rollout | promote
- 目标：external（商业版）
- 版本：vX.Y.Z / 当前 canary / 当前 stable -> canary
- 灰度比例：N%（仅 rollout）
- 会执行：<exact command>
- 影响：会上传包或更新 OSS latest.json；canary 阶段不会创建 CR，promote/stable 成功后会创建 CR

请明确回复“确认发布到 external（商业版）”后我再执行。
```

Only proceed when the user's reply clearly confirms both intent and target, e.g. `确认发布到 external（商业版）` or an equally explicit sentence. If the reply is vague (`确认`, `ok`, `继续`) and target was not repeated, ask once more for explicit external confirmation.

For GitHub open-source release, require a separate explicit confirmation containing both target and version, e.g. `确认发布 GitHub 开源版 v1.2.3`. Do not treat external confirmation as authorization to publish open-source artifacts.

新版本 stable/canary 的确认顺序固定为：先请求并完成 GitHub 开源版确认与发布，再展示商业版 summary 并请求 external 确认。不得合并两个确认，也不得在 GitHub 开源版尚未验证成功时提前执行商业版。

---

## 命令路由

先解析用户输入为一个 intent，再执行对应流程。

| 用户输入 | Intent | 脚本命令 |
|---------|--------|----------|
| `/release` / `/release patch` | stable release | `bash deploy/release.sh --patch --external` |
| `/release minor` | stable release | `bash deploy/release.sh --minor --external` |
| `/release major` | stable release | `bash deploy/release.sh --major --external` |
| `/release 1.2.3` | stable release | `bash deploy/release.sh --version 1.2.3 --external` |
| `/release canary` / `/release canary patch` | canary release | `bash deploy/release.sh --canary --patch --external` |
| `/release canary minor` | canary release | `bash deploy/release.sh --canary --minor --external` |
| `/release canary major` | canary release | `bash deploy/release.sh --canary --major --external` |
| `/release canary 1.2.3` | canary release | `bash deploy/release.sh --canary --version 1.2.3 --external` |
| `/release canary hotfix` | canary hotfix | `bash deploy/release.sh --canary --hotfix --external` |
| `/release rollout 5` | rollout | `bash deploy/rollout.sh --percentage 5 --external` |
| `/release rollout 0` | pause canary | `bash deploy/rollout.sh --percentage 0 --external` |
| `/release promote` | promote | `bash deploy/rollout.sh --promote --external` |
| `/release status` | status | `bash deploy/rollout.sh --percentage 0 --external --dry-run` |

Always include `--external`; do not use the script's internal default.

表中的 stable/canary 命令用于首次 dry-run 解析版本。GitHub 开源版发布完成后，真实商业版命令必须改为对应的显式 `--version ${NEXT_VERSION}`，避免重新计算版本。

Invalid combinations:

- Reject `hotfix` without `canary`.
- Reject rollout percentage outside `[0, 100]`.
- Reject multiple version bump tokens in the same command.

---

## New Version Start Flow: Open-source First

新版本 stable/canary 必须先执行本流程。rollout、canary hotfix、promote 不执行。

### Step 1: 解析版本并固定内部源码

1. 要求工作区干净并获取远端最新状态：

   ```bash
   git status --porcelain
   git fetch origin --prune --prune-tags --quiet
   ```

2. 使用用户原始 bump 参数运行商业版 dry-run，只解析 `NEXT_VERSION`，不请求商业版发布确认：

   ```bash
   bash deploy/release.sh <mapped-args> --external --dry-run
   ```

3. 固定本次内部源码和开源 marker：

   ```bash
   INTERNAL_SOURCE_SHA=$(git rev-parse origin/master)
   RELEASE_BRANCH="release/v${NEXT_VERSION}"
   OPEN_SOURCE_SOURCE=$(git show "${INTERNAL_SOURCE_SHA}:.opensource-sync-state" 2>/dev/null || true)
   ```

4. 检查内部远端 `RELEASE_BRANCH` 和 `v${NEXT_VERSION}` 不存在。检查 GitHub checkout 中存在 `OPEN_SOURCE_SOURCE`。任一检查失败都停止，不得改用 GitHub 最新 `main`。

5. 在 GitHub 开源版 summary 中同时展示 `INTERNAL_SOURCE_SHA`、`OPEN_SOURCE_SOURCE` 和即将创建的本地 `RELEASE_BRANCH`。用户明确确认 GitHub 开源版后、任何公开远端写入前，创建本地冻结分支：

   ```bash
   if git show-ref --verify --quiet "refs/heads/${RELEASE_BRANCH}"; then
     test "$(git rev-parse "refs/heads/${RELEASE_BRANCH}")" = "${INTERNAL_SOURCE_SHA}"
   else
     git branch "${RELEASE_BRANCH}" "${INTERNAL_SOURCE_SHA}"
   fi
   ```

   如果本地分支已经存在，只允许其 commit 等于 `INTERNAL_SOURCE_SHA`；不一致时停止，不得 reset、覆盖或删除用户分支。该分支只在本地冻结源码，此时不要推送内部远端。

### Step 2: 先发布并验证 GitHub 开源版

执行 [GitHub Open-source First Flow](#github-open-source-first-flow)，版本固定为 `NEXT_VERSION`，源码固定为 `OPEN_SOURCE_SOURCE`。必须完成独立 dry-run、summary 和 `确认发布 GitHub 开源版 vX.Y.Z`。

只有 GitHub release 分支、tag、Release 和公开 OSS 全部验证成功，或者已存在的同版本发布经过验证且 source/产物完全一致，才允许进入商业版。失败或尚未确认时停止，不能先发商业版。

### Step 3: 商业版前一致性复核

开始商业版 dry-run 前重新检查：

```bash
git rev-parse "refs/heads/${RELEASE_BRANCH}"
git show "${RELEASE_BRANCH}:.opensource-sync-state"
git ls-remote origin "refs/heads/${RELEASE_BRANCH}" "refs/tags/v${NEXT_VERSION}"
```

- `RELEASE_BRANCH` 必须仍指向 `INTERNAL_SOURCE_SHA`。
- marker 必须仍等于已发布开源版的 `OPEN_SOURCE_SOURCE`。
- 内部远端 release 分支和 tag 必须仍不存在；如果等待开源发布期间已有其他人发布同版本，停止处理冲突。
- `origin/master` 后续新增 commit 不影响本次已冻结版本；不要 rebase、merge 或重建 `RELEASE_BRANCH`。
- 商业版命令必须改用显式版本 `--version ${NEXT_VERSION}`，不能在开源版发布后重新计算 patch/minor/major。

任一项不一致时停止并重新展示计划，不能静默使用更新后的 `master`。

---

## Stable Release Flow

Use for `/release [patch|minor|major|X.Y.Z] external`.

### Step 1: 解析目标和前置检查

- 如果用户未明确 external（商业版），先按 [发布目标和确认闸门](#发布目标和确认闸门) 要求确认。
- 先完整执行 [New Version Start Flow: Open-source First](#new-version-start-flow-open-source-first)，确保开源版已发布并固定 `NEXT_VERSION`、`INTERNAL_SOURCE_SHA`、`RELEASE_BRANCH`。
- 商业版发布前工作区仍必须干净，否则中止并展示 `git status --short`。

### Step 2: dry-run summary 和确认

Run dry-run first:

```bash
bash deploy/release.sh --version ${NEXT_VERSION} --external --dry-run
```

验证 dry-run 输出的 `NEXT_VERSION`、`RELEASE_BRANCH` 和 mode 与公共前置固定值一致。展示 [OSS 更新前确认](#oss-更新前确认) 的商业版 summary，包括精确的非 dry-run 命令。

Wait for explicit confirmation before continuing.

### Step 3: 执行发布脚本

Map bump arguments to `deploy/release.sh` and execute:

```bash
bash deploy/release.sh --version ${NEXT_VERSION} --external
```

`deploy/release.sh` 自动完成：fetch tags → 切换到公共前置已冻结的 `release/vX.Y.Z` 分支 → bump `package.json` → commit → tag → build → upload → push。若脚本没有识别到该本地分支，停止检查，不得让它改从更新后的 `origin/master` 创建新分支。

从脚本输出提取：

- `NEXT_VERSION`
- `RELEASE_BRANCH=release/v${NEXT_VERSION}`
- `MODE=external`

### Step 4: 生成并发布正式 Release Note

执行 [Release Note and CR Flow](#release-note-and-cr-flow)。

### Step 5: 发送商业版通知

按 [DingTalk Notification Flow](#dingtalk-notification-flow) 保持原有时机发送商业版完成通知。开源版已在本次新版本商业发布之前完成，此处不要重复发布开源版。

---

## Canary Release Flow

Use for `/release canary [patch|minor|major|X.Y.Z] external`.

### Step 1: 解析目标和前置检查

- 如果用户未明确 external（商业版），先按 [发布目标和确认闸门](#发布目标和确认闸门) 要求确认。
- 先完整执行 [New Version Start Flow: Open-source First](#new-version-start-flow-open-source-first)，确保开源版已发布并固定 `NEXT_VERSION`、`INTERNAL_SOURCE_SHA`、`RELEASE_BRANCH`。
- 商业版发布前工作区仍必须干净，否则中止并展示 `git status --short`。

### Step 2: dry-run summary 和确认

Run dry-run first:

```bash
bash deploy/release.sh --canary --version ${NEXT_VERSION} --external --dry-run
```

验证 dry-run 输出与公共前置固定值一致。展示 [OSS 更新前确认](#oss-更新前确认) 的商业版 summary，强调 rollout 从 `0%` 开始且此阶段不创建 CR。

Wait for explicit confirmation before continuing.

### Step 3: 发布 canary

Execute:

```bash
bash deploy/release.sh --canary --version ${NEXT_VERSION} --external
```

`deploy/release.sh` 会切换到公共前置已冻结的 release 分支、bump version、commit、tag、build、upload，并写入 `latest.json.canary`，默认 `rollout_percentage=0`。若脚本没有识别到该本地分支，停止检查，不得改用更新后的 `origin/master`。

### Step 4: 停在灰度态

不要生成 Release Note。
不要创建 CR。

输出下一步建议：

```text
canary vX.Y.Z 已发布，rollout_percentage=0。
下一步：/release rollout 5 external
```

---

## Rollout Flow

Use for `/release rollout <0-100> external`.

### Step 1: 解析目标

- 如果用户未明确 external（商业版），先按 [发布目标和确认闸门](#发布目标和确认闸门) 要求确认。
- 不要求工作区干净；该流程只调整 OSS 上 `latest.json.canary.rollout_percentage`。

### Step 2: dry-run summary 和确认

Run dry-run first:

```bash
bash deploy/rollout.sh --percentage <N> --external --dry-run
```

Use output to summarize current stable/canary/rollout and the requested new percentage. Wait for explicit confirmation before continuing.

### Step 3: 更新 rollout

Execute:

```bash
bash deploy/rollout.sh --percentage <N> --external
```

Interpretation:

- `0`：止血，阻止新用户进入 canary；已进入 canary 的用户不会自动降级。
- `1-99`：按 installId 分桶逐步放量。
- `100`：所有可命中用户走 canary；稳定后应执行 `/release promote`。

成功后不要生成 Release Note，不要创建 CR。输出当前阶段和建议下一步。

---

## Canary Hotfix Flow

Use for `/release canary hotfix external`.

### Step 1: 解析目标和建议先止血

- 如果用户未明确 external（商业版），先按 [发布目标和确认闸门](#发布目标和确认闸门) 要求确认。

如果当前 canary rollout 大于 0，先建议执行：

```bash
bash deploy/rollout.sh --percentage 0 --external
```

用户已经明确要求 hotfix 时，可以继续执行 hotfix；不要额外强制确认“是否先止血”，但仍必须执行 OSS 更新前的 summary 确认。

### Step 2: 前置检查

工作区必须干净，并获取远端最新状态。

### Step 3: dry-run summary 和确认

Run dry-run first:

```bash
bash deploy/release.sh --canary --hotfix --external --dry-run
```

Show the summary from [OSS 更新前确认](#oss-更新前确认), emphasizing semver will remain unchanged and `hotfix_version` will increment in the canary manifest.

Wait for explicit confirmation before continuing.

### Step 4: 发布 hotfix

Execute:

```bash
bash deploy/release.sh --canary --hotfix --external
```

该模式保持 semver 不变，只通过 manifest 的 `canary.hotfix_version` 触发已进入 canary 的用户更新。

### Step 5: 停在灰度态

不要生成 Release Note。
不要创建 CR。

输出下一步建议：

```text
canary hotfix 已发布。
下一步：/release rollout 5 external
```

---

## Promote Flow

Use for `/release promote external`.

Promote 是灰度生命周期的正式收口：先把 canary 提升为 stable，再补正式 Release Note/tag/CR。

### Step 1: 解析目标

如果用户未明确 external（商业版），先按 [发布目标和确认闸门](#发布目标和确认闸门) 要求确认。

### Step 2: 读取 promote 前状态和确认

在执行 promote 之前，读取当前 stable/canary 状态，用于后续 Release Note 范围：

```bash
bash deploy/rollout.sh --promote --external --dry-run
```

从输出提取：

- `PREV_VERSION`：当前 stable 版本
- `NEXT_VERSION`：当前 canary 版本
- `HOTFIX_VERSION`：当前 canary hotfix version（如有）
- `RELEASE_BRANCH=release/v${NEXT_VERSION}`

该命令是 dry-run，不会修改 OSS。

Show the summary from [OSS 更新前确认](#oss-更新前确认), emphasizing this will replace stable with canary and then create Release Note/tag/CR after success.

Wait for explicit confirmation before continuing.

### Step 3: 执行 promote

Execute:

```bash
bash deploy/rollout.sh --promote --external
```

`deploy/rollout.sh` 会确认后把 `latest.json.canary` 提升到顶层 stable，删除 canary 字段，并复制 canary package 到 `latest/`。

### Step 4: 生成并发布正式 Release Note

执行 [Release Note and CR Flow](#release-note-and-cr-flow)，使用 Step 2 提取到的 `PREV_VERSION` 与 `NEXT_VERSION`。

### Step 5: 发送商业版通知

按 [DingTalk Notification Flow](#dingtalk-notification-flow) 保持原有时机发送商业版完成通知。开源版已在该版本 canary 开始前完成，promote 阶段不要重复发布开源版。

---

## Status Flow

Use for `/release status external`.

If the user did not clearly specify external/commercial, ask for external confirmation because the skill no longer inspects or publishes internal manifests.

Execute:

```bash
bash deploy/rollout.sh --percentage 0 --external --dry-run
```

汇总输出：

- stable 版本
- canary 版本和 hotfix version
- rollout percentage
- mode: external

不要修改 OSS，不要创建 Release Note，不要创建 CR。

---

## Release Note and CR Flow

仅在 stable release 或 promote 成功后执行。canary 发布、rollout、canary hotfix 阶段不执行。

### Step 1: 生成 Release Note

自动执行，无需用户触发。

1. 确定 tag 范围：

   ```bash
   CURRENT_TAG="v${NEXT_VERSION}"
   PREV_TAG=$(git tag -l 'v*' --sort=-v:refname | grep -v "^${CURRENT_TAG}$" | head -1)
   ```

   promote 场景使用 promote 前读取到的 stable/canary 版本：

   ```bash
   CURRENT_TAG="v${NEXT_VERSION}"
   PREV_TAG="v${PREV_VERSION}"
   ```

2. 收集 commits：

   stable release 沿用 tag 范围：

   ```bash
   git log ${PREV_TAG}..${CURRENT_TAG} --format="%h|%an|%s%n%b" --no-merges
   ```

   promote 场景如果 tag 尚未重建，使用 release 分支 commit：

   ```bash
   TAG_REF=$(git rev-parse "release/v${NEXT_VERSION}" 2>/dev/null || git rev-parse HEAD)
   git log ${PREV_TAG}..${TAG_REF} --format="%h|%an|%s%n%b" --no-merges
   ```

   从 commit message 和 body 中提取 CR 链接，支持 `codereview/NNNNNN` 或 `Link: https://...codereview/NNNNNN`。同一 CR 的多条 commit 合并成一条 release note；无 CR 链接时保留 commit hash 作为追溯信息，但不要把 hash 写进正文描述。

3. 按 GitHub Release Note 风格生成 tag releaseDescription，**用中文撰写**，面向商业版用户说明可见变化：

   ```markdown
   # LoongSuite Pilot vX.Y.Z

   ## 新 Agent 支持
   * <一句话描述新增 Agent 或采集链路，以及对用户的影响>。 [#CR_ID](https://code.alibaba-inc.com/sls/loongsuite-pilot/codereview/CR_ID) (作者)

   ## Pilot 新功能
   * <一句话描述新增 Pilot 平台能力，以及用户如何受益或如何启用>。 [#CR_ID](https://code.alibaba-inc.com/sls/loongsuite-pilot/codereview/CR_ID) (作者)

   ## 改进
   * <一句话描述已有功能体验、兼容性或稳定性增强>。 [#CR_ID](https://code.alibaba-inc.com/sls/loongsuite-pilot/codereview/CR_ID) (作者)

   ## 问题修复
   * <一句话描述修复的问题，以及修复后的用户可见效果>。 [#CR_ID](https://code.alibaba-inc.com/sls/loongsuite-pilot/codereview/CR_ID) (作者)

   ## 构建与安全
   * <一句话描述安装、打包、发布、安全扫描等用户或运维可感知变化>。 [#CR_ID](https://code.alibaba-inc.com/sls/loongsuite-pilot/codereview/CR_ID) (作者)
   ```

   分类规则：
   - `新 Agent 支持` → 新增 Agent、Agent 新采集链路、新 IDE/CLI 适配；该 section 放在所有功能类 section 前面。对已有 Agent 的采集增强、字段补充、trace 完整性提升、bug 修复不归入本类，应按语义归入 `改进` 或 `问题修复`。
   - `Pilot 新功能` → Pilot 平台自身能力，例如脱敏、灰度、监控、updater、输出通道、采集框架能力。
   - `改进` → 已有功能增强、CLI/安装脚本改进、配置优化、已有 Agent 采集字段补充、性能优化。
   - `问题修复` → `fix`，或 bug 修复。
   - `构建与安全` → `build` / `deploy` / `chore(deploy)` / `ci` / 安装器、打包、发布、安全扫描、依赖与运行时分发。
   - `release:` 开头 → 跳过
   - 无 prefix 或其他 → 归入最相近的类别（根据内容语义判断），如果无法归类放入改进
   - 空 section 不输出
   - 所有 description 翻译为中文

   撰写要求：
   - 每条变更使用一个扁平 bullet，格式为 `* <一句话描述用户可见的变更及影响>。 [#CR_ID](https://code.alibaba-inc.com/sls/loongsuite-pilot/codereview/CR_ID) (作者)`。
   - 每条 1-2 句话，说明「改了什么」和「对用户的影响」。
   - 口吻对齐 GitHub 开源版 Release Note：标题短、分类清楚、每条从用户价值或可见行为开始，不把内部模块名、commit prefix 或实现细节放在句首。
   - 商业版 tag 描述可以保留内部 Code CR 链接；正文描述本身不要依赖内部术语才能看懂。
   - 不使用子标题、表格、代码块，不使用 commit hash 作为正文内容。
   - 破坏性变更必须写明如何恢复旧行为或迁移路径。

### Step 2: 发布 Release Note 到 Tag

直接执行，不再额外确认。获取 tag 应指向的 commit SHA：

- stable release：`git rev-parse HEAD`
- promote：`git rev-parse "release/v${NEXT_VERSION}" 2>/dev/null || git rev-parse HEAD`

**先检查 tag 状态，按需操作：**

1. 检查远端 tag 是否存在及指向的 commit：
   ```bash
   git ls-remote origin refs/tags/${CURRENT_TAG}
   ```

2. 检查本地 tag 是否存在及指向的 commit：
   ```bash
   git rev-parse ${CURRENT_TAG}^{commit} 2>/dev/null
   ```

3. 根据检查结果决定操作：

   - **tag 不存在（本地+远端均无）**→ 直接通过 `mcp__code__create_tag` 创建，一步到位
   - **tag 已存在且 commit 一致** → 需要删除后重建以附加 releaseDescription：
     - 删除本地 tag：`git tag -d ${CURRENT_TAG}`
     - 删除远端 tag：`git push origin :refs/tags/${CURRENT_TAG}`
     - 通过 `mcp__code__create_tag` 重建
   - **tag 已存在但 commit 不一致** → 同上，删除后重建

4. `mcp__code__create_tag` 参数：
   - repo: 从 `git remote get-url origin` 提取仓库路径
   - tagName: `v${NEXT_VERSION}`
   - ref: tag 指向的 commit SHA
   - message: `Release v${NEXT_VERSION}`
   - releaseDescription: 生成的中文 Release Note 内容

5. 同步远端 tag 到本地：
   ```bash
   git fetch origin --tags
   ```

### Step 3: 创建 CR

输出发布结果后，直接调用 `/submit-cr` 创建 CR 合入 master：

```
============================================================
✅ Release v${NEXT_VERSION} 发布完成

   Tag:      v${NEXT_VERSION}（含 Release Note）
   Branch:   release/v${NEXT_VERSION}
   Channel:  release
   Mode:     ${MODE}

   正在创建 CR 合入 master...
============================================================
```

然后通过 Skill 工具调用 `submit-cr`，自动完成 CR 创建。

---

## GitHub Open-source First Flow

在联合发布中由 [New Version Start Flow: Open-source First](#new-version-start-flow-open-source-first) 调用，且必须在商业版 stable/canary 的真实命令之前完成。用户明确只要求发布 GitHub 开源版时也可以单独执行，完成后停止，不自动启动商业版。rollout、canary hotfix、promote 阶段不执行，也不重复创建同版本 GitHub Release。

目标 checkout 默认是 `~/github-loongsuite-pilot`（即 `/Users/lukechen/github-loongsuite-pilot`）。开源版版本必须与本次计划中的商业版版本一致：`v${NEXT_VERSION}`。如果用户要求不同版本，停止当前联合流程并展示差异，不得继续商业版。

### Step 1: 解析 GitHub 开源源码来源

联合发布时，本次固定的 `INTERNAL_SOURCE_SHA` 及其 `.opensource-sync-state` 是两种发行版共同的源码锚点。dry-run/summary 阶段先从固定 commit 读取：

```bash
OPEN_SOURCE_SOURCE=$(git show "${INTERNAL_SOURCE_SHA}:.opensource-sync-state" 2>/dev/null || true)
```

用户明确确认 GitHub 开源版后，按公共前置要求创建或验证本地 `release/v${NEXT_VERSION}` 冻结分支，再从该分支重新读取 marker 并要求与 `OPEN_SOURCE_SOURCE` 完全一致。marker 不存在、为空、发生变化、或对应 commit 在 `~/github-loongsuite-pilot` 中不存在时停止；不要改用 GitHub 最新 `main` 兜底。

单独发布 GitHub 开源版时，不创建新的内部 release 分支；必须从已经存在的本地或远端内部 `release/v${NEXT_VERSION}` 读取 `.opensource-sync-state`，沿用原有 source guard。找不到对应内部 release 分支时停止。

必须遵守：

- 不要用 GitHub `main` 的最新 commit 代替 `.opensource-sync-state` marker。
- 不要用 `~/github-loongsuite-pilot` 当前分支的 HEAD 代替 marker；该 checkout 可能停在功能分支。
- 不要在开源版发布后重新从更新后的 `origin/master` 创建商业版 release 分支；商业版必须继续使用已冻结的本地 release 分支。
- 如果 GitHub `main` 在确认后又新增 commit，仍然使用已确认的 marker commit；除非用户重新明确确认新的开源源码 commit。
- 如果 marker commit 上的 release workflow 或 packaging 基础设施坏了，优先只做最小发布基础设施修复；不要顺手把产品源码切到更晚的 `main`。

### Step 2: 生成开源版 Release Note 文件

开源版 Release Note 使用中文、面向公开用户、按 GitHub 风格分类输出。要求：

- 基于 GitHub release commit 范围生成，不包含内部-only 变更。
- 内部 Code CR 链接不要写入公开 Release Note；能映射到 GitHub PR 时使用 GitHub PR 链接。
- 每条说明用户可见变化和影响。
- 使用与商业版一致的结构：`# LoongSuite Pilot vX.Y.Z`、`## 新 Agent 支持`、`## Pilot 新功能`、`## 改进`、`## 问题修复`、`## 构建与安全`。
- 将内容写入临时 release-note 文件，例如 `/tmp/loongsuite-pilot-github-release-vX.Y.Z.md`，作为发布脚本的 `--notes-file`。

### Step 3: dry-run summary 和确认

使用 skill 内脚本做 dry-run，不直接手写 release 命令：

```bash
.agents/skills/loongsuite-pilot-release/scripts/publish-github-opensource.sh \
  --version ${NEXT_VERSION} \
  --source ${OPEN_SOURCE_SOURCE} \
  --notes-file /tmp/loongsuite-pilot-github-release-v${NEXT_VERSION}.md \
  --dry-run
```

该脚本会创建临时隔离 release checkout，并确保隔离环境里的 `origin/main` 解析到 `OPEN_SOURCE_SOURCE`。不要 stash、清理或切换用户的 `~/github-loongsuite-pilot` 当前 checkout。

参考已验证模式：`019f920c-96b0-73b0-b56b-24388c0fb2a6` 中 v1.1.4 发布固定在用户确认的 GitHub source commit `4fd50bd`，release commit 为 `11dcd417`；后续即使 `main` 变化，也没有自动切到更新 commit。

展示 summary：

```text
GitHub 开源版发布确认：
- 动作：open-source release
- 版本：vX.Y.Z
- 内部固定 commit：<INTERNAL_SOURCE_SHA>
- 源码 commit：<.opensource-sync-state marker>
- 内部冻结分支：release/vX.Y.Z（确认后仅在本地创建，商业版沿用）
- GitHub release 分支：release/vX.Y.Z
- 会执行：.agents/skills/loongsuite-pilot-release/scripts/publish-github-opensource.sh --version X.Y.Z --source <marker> --notes-file <notes.md>
- 影响：会推送 GitHub release 分支、创建 GitHub tag/Release、上传公开 OSS tar.gz/zip/latest/installer
- 稳定性：脚本会先 npm ci/build/package，再远端写入；不会用 git push tag 触发 GitHub Actions tag-push release workflow

请明确回复“确认发布 GitHub 开源版 vX.Y.Z”后我再执行。
```

只有用户明确确认开源版目标和版本后，才能执行真实发布。`确认发布到 external（商业版）` 不能替代这个确认。

### Step 4: 执行开源版发布

执行 skill 内脚本：

```bash
.agents/skills/loongsuite-pilot-release/scripts/publish-github-opensource.sh \
  --version ${NEXT_VERSION} \
  --source ${OPEN_SOURCE_SOURCE} \
  --notes-file /tmp/loongsuite-pilot-github-release-v${NEXT_VERSION}.md
```

该脚本内置以下防错步骤：

- 在任何远端写入前运行 `npm ci`、`npm run build`、`deploy/package-opensource.sh --skip-build`。
- 如果本机缺 `zip`，使用 Python zip fallback，不依赖 GitHub Actions runner。
- 只用 `git push` 推 release 分支，不用 `git push` 推 tag；tag 由 `gh release create --target <release commit>` 创建，避免触发当前 `push tags: v*` 的 Release workflow。
- 上传开源 OSS 的 6 个目标：versioned `tar.gz`、versioned `zip`、latest `tar.gz`、latest `zip`、`installer.sh`、`installer.ps1`。
- GitHub Release 资产名称必须是 `loongsuite-pilot.tar.gz`、`loongsuite-pilot.zip`、`installer.sh`、`installer.ps1`。

### Step 5: 验证

脚本会自动验证；完成后仍要在最终回复中报告：

- GitHub `release/vX.Y.Z` 分支和 `vX.Y.Z` tag 指向 release commit。
- GitHub Release 是 public、non-draft、non-prerelease，并包含 `loongsuite-pilot.tar.gz`、`loongsuite-pilot.zip`、`installer.sh`、`installer.ps1`。
- 公开 OSS versioned/latest tar.gz 和 zip 可下载，`VERSION` 内的 `version`、`git_commit`、`git_branch` 与 release commit 一致。
- `unzip -t loongsuite-pilot.zip` 通过。

验证失败时报告失败点并停止；此时商业版尚未开始，不得跳过开源版失败继续发布商业版。

---

## DingTalk Notification Flow

发布通知是可选增强能力。只有配置了钉钉机器人环境变量时才发送；未配置时跳过，不视为失败。

### 配置方式

不要把 webhook 或 secret 写入仓库。使用环境变量：

```bash
export DINGTALK_RELEASE_WEBHOOK_EXTERNAL='https://oapi.dingtalk.com/robot/send?access_token=...'
export DINGTALK_RELEASE_SECRET_EXTERNAL='SEC...' # 如果 external 使用不同机器人
```

也可以使用通用变量：

```bash
export DINGTALK_RELEASE_WEBHOOK='https://oapi.dingtalk.com/robot/send?access_token=...'
export DINGTALK_RELEASE_SECRET='SEC...'
```

机器人如配置了关键词校验，通知标题和正文必须包含 `Loongsuite`。

### 调用脚本

使用仓库内脚本发送通知：

```bash
node .agents/skills/loongsuite-pilot-release/notify-dingtalk-release.mjs \
  --mode external \
  --title "Loongsuite Pilot 开始灰度" \
  --action "canary release" \
  --version "vX.Y.Z" \
  --rollout "0%" \
  --branch "release/vX.Y.Z" \
  --tag "vX.Y.Z" \
  --next "/release rollout 5 external"
```

脚本会自动：

- 根据 `--mode external` 选择 external webhook。
- 对启用加签的机器人计算钉钉签名。
- 发送 markdown 消息。
- 默认操作人优先读取 `git config user.name` 和 `git config user.email`；如需覆盖，显式传 `--operator`。
- 在未配置 webhook 或发送失败时输出 warning 并以 `0` 退出，避免通知问题中断发布。

### 发送时机

只在真实动作成功后发送通知；dry-run、status、用户确认前不发送。

- stable release：`deploy/release.sh` 成功，Release Note/tag/CR 完成后发送，包含版本、分支、tag、CR 链接（如可获得）。
- canary release：`deploy/release.sh --canary` 成功后发送，标题必须使用 `Loongsuite Pilot 开始灰度`，包含版本、分支、tag、rollout `0%`，下一步建议 rollout。
- rollout：`deploy/rollout.sh --percentage <N>` 成功后发送，标题必须使用 `Loongsuite Pilot 扩大灰度比例`，包含当前 stable/canary 和灰度比例变化；不要输出“下一步”。
- canary hotfix：`deploy/release.sh --canary --hotfix` 成功后发送，包含 canary 版本和 hotfix version（如可获得）。
- promote：`deploy/rollout.sh --promote` 成功，Release Note/tag/CR 完成后发送，标题必须使用 `Loongsuite Pilot 正式发布`，包含上一 stable、提升后的 stable、tag、CR 链接（如可获得）。

示例消息：

```markdown
### Loongsuite Pilot 开始灰度

- 状态：成功
- 动作：canary release
- 目标：external（商业版）
- 版本：v1.2.3
- 灰度比例：0%
- 分支：release/v1.2.3
- Tag：v1.2.3
- 操作人：release skill
- 下一步：/release rollout 5 external
```

rollout 示例消息：

```markdown
### Loongsuite Pilot 扩大灰度比例

- 状态：成功
- 动作：rollout
- 目标：external（商业版）
- 版本：v1.2.3
- 灰度比例：10% -> 20%
- 操作人：石木 <suqing.cy@alibaba-inc.com>
```

---

## Multica external 工作流契约

当任务明确携带 `workflow_version=1` 和 `release_target=external` 时，本节覆盖通用目标选择：

- 目标固定为 external（商业版），所有预计发布命令都必须包含 `--external`。
- internal 请求返回 `INVALID_TARGET`，不得回退到脚本默认值。
- 新版本 `EXTERNAL_0` 只有在同版本 GitHub 开源版已经发布并验证、且 source marker 与固定内部 release 分支一致时才允许执行；否则返回 `NOT_EXECUTED`。
- 固定顺序为 `0 → 5 → 15 → 40 → 60 → promote`，禁止跳档和 `rollout 100`。
- 每次只处理协调 Agent 已授权的一步，不决定后续动作。

当 `VALIDATION_MODE=true` 时：

- 不运行 `deploy/release.sh`、`deploy/rollout.sh`、通知脚本或 GitHub 写命令，包括 dry-run。
- 不执行 git fetch、分支、Tag、OSS、CR、GitHub 或 Multica 写操作。
- 只校验命令构造、目标、版本、人工批准和报告字段。
- 输入不是 external 或缺少最新人工批准时返回 `NOT_EXECUTED`。

向协调 Agent 输出：

```json
{
  "report_type": "execution-report",
  "mode": "PLAN",
  "requested_action": "EXTERNAL_0",
  "outcome": "PLAN_READY",
  "target": "external",
  "target_version": "vX.Y.Z",
  "executed_stage": "",
  "plan_id": "fixture-plan-id",
  "evidence_url": "fixture://plan",
  "error": ""
}
```

不得输出具有流程决策含义的 `next_action`。

---

## 护栏规则

- 不要自动 stash 或丢弃用户改动。
- 发布目标固定为 external（商业版）；internal（集团版）请求必须拒绝，不得使用脚本默认 internal 值。
- 任何会上传包或更新 OSS `latest.json` 的命令执行前，必须先展示发布 summary，并等待用户明确确认目标和动作。
- `deploy/release.sh` / `deploy/rollout.sh` 自带的交互确认不能替代 skill 层的发布 summary 确认。
- stable/canary/hotfix 发布前必须要求工作区干净；rollout/status 可以不检查工作区。
- `deploy/release.sh` 内部会确认版本号（`Proceed with ... release?`），这是发布脚本的交互确认点。
- `deploy/rollout.sh --promote` 内部会确认 promote，这是 promote 的交互确认点。
- canary 发布、rollout、hotfix 阶段不得创建 CR，不得发布正式 Release Note。
- 新版本 stable/canary 开始前必须先固定版本和内部源码，并完成同版本 GitHub 开源版发布与验证；rollout、hotfix、promote 不重复发布开源版。
- 只有 stable release 与 promote 成功后才执行商业版 Release Note/tag/CR。
- GitHub 开源版发布必须单独 dry-run、summary 和明确版本确认；商业版确认不能替代开源版确认。
- GitHub 开源版发布必须使用内部 release 分支 `.opensource-sync-state` marker commit 作为源码来源；不得自动使用 GitHub 最新 `main` 或当前 checkout HEAD。
- dry-run、status、用户确认前不得发送钉钉发布通知。
- 钉钉通知失败不得阻断已经成功的发布、rollout、promote、tag 或 CR 流程。
- 删除远端 tag 不需要额外确认；发布流程已隐含授权。
- Release Note 所有内容用中文撰写。
- commit 分类基于 prefix，`release:` commit 始终跳过。
- 如果 `--external` 出现在 canary 生命周期任一阶段，提醒用户后续 rollout/promote 也必须带 `--external`。
