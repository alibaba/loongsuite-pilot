---
name: loongsuite-pilot-release
description: 执行 LoongSuite Pilot 版本发布流程，支持 stable 全量发布、canary 灰度发布、多次 rollout 放量/止血、canary hotfix、promote 转正式，以及正式发布后的中文 Release Note、tag 描述和 CR 创建。用于 /release、/release canary、/release rollout、/release promote、/release status 等发布相关请求；发布目标 internal（集团版）/external（商业版）不明确时必须先确认，任何上传或更新 OSS 前必须展示 summary 并等待用户明确确认。
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
/release [patch|minor|major|X.Y.Z] [--external]
/release canary [patch|minor|major|X.Y.Z] [--external]
/release canary hotfix [--external]
/release rollout <0-100> [--external]
/release promote [--external]
/release status [--external]
```

核心原则：

- stable 发布是一站式流程：发布脚本完成后，继续生成 Release Note、更新 tag 描述并创建 CR。
- canary 发布是分阶段流程：`canary`、`rollout`、`hotfix` 阶段不创建 CR，不发布正式 Release Note；只有 `promote` 成功后才做正式 Release Note/tag/CR。
- `--external` 必须在灰度生命周期的每一步保持一致；不要根据对话历史自动推断 internal/external。
- 发布目标不明确时必须暂停并询问用户选择 internal（集团版）或 external（商业版）。
- 任何会上传包或更新 OSS `latest.json` 的动作，都必须先展示发布 summary，并等待用户明确确认后再执行真实命令。
- 所有真实发布动作都依赖仓库内脚本：`deploy/release.sh` 与 `deploy/rollout.sh`。
- 发布动作成功后，如果配置了钉钉机器人环境变量，必须发送 Loongsuite 发布通知；通知失败只输出 warning，不阻断发布流程。

---

## 发布目标和确认闸门

### 目标解析

Map user wording to deploy mode:

- internal / 内部 / 集团版 → internal mode，不加 `--external`。
- external / 外部 / 商业版 / commercial → external mode，追加 `--external`。

If the user does not clearly specify internal or external for any release lifecycle request, stop and ask:

```text
这次要发布到 internal（集团版）还是 external（商业版）？
```

Do not infer deploy mode from prior conversation, branch name, default script behavior, or previous command output. The only exception is when the user explicitly includes `--external` or explicitly says internal/external in the current request.

### OSS 更新前确认

Before running any command that uploads a package or mutates OSS manifest state, show a summary and wait for explicit user confirmation.

Commands that require this confirmation:

- `bash deploy/release.sh ...` for stable release, canary release, and canary hotfix; this script builds and uploads.
- `bash deploy/rollout.sh --percentage <N> ...`; this mutates canary rollout in `latest.json`.
- `bash deploy/rollout.sh --promote ...`; this promotes canary to stable in `latest.json`.

Commands that do not require OSS-update confirmation:

- `git status`, `git fetch`, `git log`, tag inspection, and other read-only git checks.
- `bash deploy/release.sh ... --dry-run`.
- `bash deploy/rollout.sh ... --dry-run`.
- `/release status`, because it must be read-only.

Use dry-run/status output to build a summary whenever possible:

- For stable/canary/hotfix release, run `bash deploy/release.sh <args> --dry-run` after target is resolved.
- For rollout, run `bash deploy/rollout.sh --percentage <N> --dry-run [--external]`.
- For promote, run `bash deploy/rollout.sh --promote --dry-run [--external]`.

Summary template:

```text
发布确认：
- 动作：stable release | canary release | canary hotfix | rollout | promote
- 目标：internal（集团版） | external（商业版）
- 版本：vX.Y.Z / 当前 canary / 当前 stable -> canary
- 灰度比例：N%（仅 rollout）
- 会执行：<exact command>
- 影响：会上传包或更新 OSS latest.json；canary 阶段不会创建 CR，promote/stable 成功后会创建 CR

请明确回复“确认发布到 internal（集团版）”或“确认发布到 external（商业版）”后我再执行。
```

Only proceed when the user's reply clearly confirms both intent and target, e.g. `确认发布到 internal（集团版）`, `确认发布到 external（商业版）`, or an equally explicit sentence. If the reply is vague (`确认`, `ok`, `继续`) and target was not repeated, ask once more for explicit target confirmation.

---

## 命令路由

先解析用户输入为一个 intent，再执行对应流程。

| 用户输入 | Intent | 脚本命令 |
|---------|--------|----------|
| `/release` / `/release patch` | stable release | `bash deploy/release.sh --patch` |
| `/release minor` | stable release | `bash deploy/release.sh --minor` |
| `/release major` | stable release | `bash deploy/release.sh --major` |
| `/release 1.2.3` | stable release | `bash deploy/release.sh --version 1.2.3` |
| `/release canary` / `/release canary patch` | canary release | `bash deploy/release.sh --canary --patch` |
| `/release canary minor` | canary release | `bash deploy/release.sh --canary --minor` |
| `/release canary major` | canary release | `bash deploy/release.sh --canary --major` |
| `/release canary 1.2.3` | canary release | `bash deploy/release.sh --canary --version 1.2.3` |
| `/release canary hotfix` | canary hotfix | `bash deploy/release.sh --canary --hotfix` |
| `/release rollout 5` | rollout | `bash deploy/rollout.sh --percentage 5` |
| `/release rollout 0` | pause canary | `bash deploy/rollout.sh --percentage 0` |
| `/release promote` | promote | `bash deploy/rollout.sh --promote` |
| `/release status` | status | `bash deploy/rollout.sh --percentage 0 --dry-run` |

Append `--external` to the script command when the user passes `--external`.

Invalid combinations:

- Reject `hotfix` without `canary`.
- Reject rollout percentage outside `[0, 100]`.
- Reject multiple version bump tokens in the same command.

---

## Stable Release Flow

Use for `/release [patch|minor|major|X.Y.Z] [--external]`.

### Step 1: 解析目标和前置检查

- 如果用户未明确 internal/external，先按 [发布目标和确认闸门](#发布目标和确认闸门) 询问目标。
- 工作区必须干净（`git status --porcelain` 为空），否则中止并展示 `git status --short`。
- 获取远端最新状态：`git fetch origin --prune --prune-tags --quiet`。

### Step 2: dry-run summary 和确认

Run dry-run first:

```bash
bash deploy/release.sh <mapped-args> --dry-run
```

Extract `NEXT_VERSION`, `RELEASE_BRANCH`, and mode from output. Show the summary from [OSS 更新前确认](#oss-更新前确认), including the exact non-dry-run command.

Wait for explicit confirmation before continuing.

### Step 3: 执行发布脚本

Map bump arguments to `deploy/release.sh` and execute:

```bash
bash deploy/release.sh <mapped-args>
```

`deploy/release.sh` 自动完成：fetch tags → 创建 `release/vX.Y.Z` 分支 → bump `package.json` → commit → tag → build → upload → push。

从脚本输出提取：

- `NEXT_VERSION`
- `RELEASE_BRANCH=release/v${NEXT_VERSION}`
- `MODE=internal|external`

### Step 4: 生成并发布正式 Release Note

执行 [Release Note and CR Flow](#release-note-and-cr-flow)。

---

## Canary Release Flow

Use for `/release canary [patch|minor|major|X.Y.Z] [--external]`.

### Step 1: 解析目标和前置检查

- 如果用户未明确 internal/external，先按 [发布目标和确认闸门](#发布目标和确认闸门) 询问目标。
- 工作区必须干净（`git status --porcelain` 为空），否则中止并展示 `git status --short`。
- 获取远端最新状态：`git fetch origin --prune --prune-tags --quiet`。

### Step 2: dry-run summary 和确认

Run dry-run first:

```bash
bash deploy/release.sh --canary <bump-arg> [--external] --dry-run
```

Extract `NEXT_VERSION`, `release/v${NEXT_VERSION}`, and target mode. Show the summary from [OSS 更新前确认](#oss-更新前确认), emphasizing that rollout starts at `0%` and no CR will be created at this stage.

Wait for explicit confirmation before continuing.

### Step 3: 发布 canary

Execute:

```bash
bash deploy/release.sh --canary <bump-arg> [--external]
```

`deploy/release.sh` 会创建 release 分支、bump version、commit、tag、build、upload，并写入 `latest.json.canary`，默认 `rollout_percentage=0`。

### Step 4: 停在灰度态

不要生成 Release Note。
不要创建 CR。

输出下一步建议：

```text
canary vX.Y.Z 已发布，rollout_percentage=0。
下一步：/release rollout 5 [--external]
```

---

## Rollout Flow

Use for `/release rollout <0-100> [--external]`.

### Step 1: 解析目标

- 如果用户未明确 internal/external，先按 [发布目标和确认闸门](#发布目标和确认闸门) 询问目标。
- 不要求工作区干净；该流程只调整 OSS 上 `latest.json.canary.rollout_percentage`。

### Step 2: dry-run summary 和确认

Run dry-run first:

```bash
bash deploy/rollout.sh --percentage <N> [--external] --dry-run
```

Use output to summarize current stable/canary/rollout and the requested new percentage. Wait for explicit confirmation before continuing.

### Step 3: 更新 rollout

Execute:

```bash
bash deploy/rollout.sh --percentage <N> [--external]
```

Interpretation:

- `0`：止血，阻止新用户进入 canary；已进入 canary 的用户不会自动降级。
- `1-99`：按 installId 分桶逐步放量。
- `100`：所有可命中用户走 canary；稳定后应执行 `/release promote`。

成功后不要生成 Release Note，不要创建 CR。输出当前阶段和建议下一步。

---

## Canary Hotfix Flow

Use for `/release canary hotfix [--external]`.

### Step 1: 解析目标和建议先止血

- 如果用户未明确 internal/external，先按 [发布目标和确认闸门](#发布目标和确认闸门) 询问目标。

如果当前 canary rollout 大于 0，先建议执行：

```bash
bash deploy/rollout.sh --percentage 0 [--external]
```

用户已经明确要求 hotfix 时，可以继续执行 hotfix；不要额外强制确认“是否先止血”，但仍必须执行 OSS 更新前的 summary 确认。

### Step 2: 前置检查

工作区必须干净，并获取远端最新状态。

### Step 3: dry-run summary 和确认

Run dry-run first:

```bash
bash deploy/release.sh --canary --hotfix [--external] --dry-run
```

Show the summary from [OSS 更新前确认](#oss-更新前确认), emphasizing semver will remain unchanged and `hotfix_version` will increment in the canary manifest.

Wait for explicit confirmation before continuing.

### Step 4: 发布 hotfix

Execute:

```bash
bash deploy/release.sh --canary --hotfix [--external]
```

该模式保持 semver 不变，只通过 manifest 的 `canary.hotfix_version` 触发已进入 canary 的用户更新。

### Step 5: 停在灰度态

不要生成 Release Note。
不要创建 CR。

输出下一步建议：

```text
canary hotfix 已发布。
下一步：/release rollout 5 [--external]
```

---

## Promote Flow

Use for `/release promote [--external]`.

Promote 是灰度生命周期的正式收口：先把 canary 提升为 stable，再补正式 Release Note/tag/CR。

### Step 1: 解析目标

如果用户未明确 internal/external，先按 [发布目标和确认闸门](#发布目标和确认闸门) 询问目标。

### Step 2: 读取 promote 前状态和确认

在执行 promote 之前，读取当前 stable/canary 状态，用于后续 Release Note 范围：

```bash
bash deploy/rollout.sh --promote --dry-run [--external]
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
bash deploy/rollout.sh --promote [--external]
```

`deploy/rollout.sh` 会确认后把 `latest.json.canary` 提升到顶层 stable，删除 canary 字段，并复制 canary package 到 `latest/`。

### Step 4: 生成并发布正式 Release Note

执行 [Release Note and CR Flow](#release-note-and-cr-flow)，使用 Step 2 提取到的 `PREV_VERSION` 与 `NEXT_VERSION`。

---

## Status Flow

Use for `/release status [--external]`.

If the user did not clearly specify internal/external, ask which target to inspect because internal and external have different OSS manifests.

Execute:

```bash
bash deploy/rollout.sh --percentage 0 --dry-run [--external]
```

汇总输出：

- stable 版本
- canary 版本和 hotfix version
- rollout percentage
- mode: internal/external

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

3. 按 ClickHouse CHANGELOG 风格生成 tag releaseDescription，**用中文撰写** Release Note：

   ```markdown
   # Release vX.Y.Z

   ### LoongSuite Pilot release vX.Y.Z, YYYY-MM-DD

   #### 新 Agent 支持
   * <一句话描述新增 Agent 或采集链路，以及对用户的影响>。 [#CR_ID](https://code.alibaba-inc.com/sls/loongsuite-pilot/codereview/CR_ID) (作者)

   #### Pilot 新功能
   * <一句话描述新增 Pilot 平台能力，以及用户如何受益或如何启用>。 [#CR_ID](https://code.alibaba-inc.com/sls/loongsuite-pilot/codereview/CR_ID) (作者)

   #### 问题修复
   * <一句话描述修复的问题，以及修复后的用户可见效果>。 [#CR_ID](https://code.alibaba-inc.com/sls/loongsuite-pilot/codereview/CR_ID) (作者)
   ```

   分类规则：
   - `新 Agent 支持` → 新增 Agent、Agent 新采集链路、新 IDE/CLI 适配；该 section 放在所有功能类 section 前面。对已有 Agent 的采集增强、字段补充、trace 完整性提升、bug 修复不归入本类，应按语义归入 `改进` 或 `问题修复`。
   - `Pilot 新功能` → Pilot 平台自身能力，例如脱敏、灰度、监控、updater、输出通道、采集框架能力。
   - `性能优化` → `perf`，或明确的性能提升。
   - `改进` → 已有功能增强、CLI/安装脚本改进、配置优化、已有 Agent 采集字段补充。
   - `问题修复` → `fix`，或 bug 修复。
   - `构建/打包改进` → `build` / `deploy` / `chore(deploy)`，构建分离、打包脚本变更。
   - `release:` 开头 → 跳过
   - 无 prefix 或其他 → 归入最相近的类别（根据内容语义判断），如果无法归类放入改进
   - 空 section 不输出
   - 所有 description 翻译为中文

   撰写要求：
   - 每条变更使用一个扁平 bullet，格式为 `* <一句话描述用户可见的变更及影响>。 [#CR_ID](https://code.alibaba-inc.com/sls/loongsuite-pilot/codereview/CR_ID) (作者)`。
   - 每条 1-2 句话，说明「改了什么」和「对用户的影响」。
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

## DingTalk Notification Flow

发布通知是可选增强能力。只有配置了钉钉机器人环境变量时才发送；未配置时跳过，不视为失败。

### 配置方式

不要把 webhook 或 secret 写入仓库。使用环境变量：

```bash
export DINGTALK_RELEASE_WEBHOOK_INTERNAL='https://oapi.dingtalk.com/robot/send?access_token=...'
export DINGTALK_RELEASE_SECRET_INTERNAL='SEC...' # 如果机器人启用了加签

export DINGTALK_RELEASE_WEBHOOK_EXTERNAL='https://oapi.dingtalk.com/robot/send?access_token=...'
export DINGTALK_RELEASE_SECRET_EXTERNAL='SEC...' # 如果 external 使用不同机器人
```

如果 internal/external 共用同一个机器人，也可以使用通用变量：

```bash
export DINGTALK_RELEASE_WEBHOOK='https://oapi.dingtalk.com/robot/send?access_token=...'
export DINGTALK_RELEASE_SECRET='SEC...'
```

机器人如配置了关键词校验，通知标题和正文必须包含 `Loongsuite`。

### 调用脚本

使用仓库内脚本发送通知：

```bash
node .agents/skills/loongsuite-pilot-release/notify-dingtalk-release.mjs \
  --mode internal \
  --title "Loongsuite Pilot 开始灰度" \
  --action "canary release" \
  --version "vX.Y.Z" \
  --rollout "0%" \
  --branch "release/vX.Y.Z" \
  --tag "vX.Y.Z" \
  --next "/release rollout 5 internal"
```

脚本会自动：

- 根据 `--mode` 选择 internal/external webhook。
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
- 目标：internal（集团版）
- 版本：v1.2.3
- 灰度比例：0%
- 分支：release/v1.2.3
- Tag：v1.2.3
- 操作人：release skill
- 下一步：/release rollout 5 internal
```

rollout 示例消息：

```markdown
### Loongsuite Pilot 扩大灰度比例

- 状态：成功
- 动作：rollout
- 目标：internal（集团版）
- 版本：v1.2.3
- 灰度比例：10% -> 20%
- 操作人：石木 <suqing.cy@alibaba-inc.com>
```

---

## 护栏规则

- 不要自动 stash 或丢弃用户改动。
- internal（集团版）/external（商业版）不明确时必须先问用户；不得使用脚本默认值代替用户选择。
- 任何会上传包或更新 OSS `latest.json` 的命令执行前，必须先展示发布 summary，并等待用户明确确认目标和动作。
- `deploy/release.sh` / `deploy/rollout.sh` 自带的交互确认不能替代 skill 层的发布 summary 确认。
- stable/canary/hotfix 发布前必须要求工作区干净；rollout/status 可以不检查工作区。
- `deploy/release.sh` 内部会确认版本号（`Proceed with ... release?`），这是发布脚本的交互确认点。
- `deploy/rollout.sh --promote` 内部会确认 promote，这是 promote 的交互确认点。
- canary 发布、rollout、hotfix 阶段不得创建 CR，不得发布正式 Release Note。
- 只有 stable release 与 promote 成功后才执行 Release Note/tag/CR。
- dry-run、status、用户确认前不得发送钉钉发布通知。
- 钉钉通知失败不得阻断已经成功的发布、rollout、promote、tag 或 CR 流程。
- 删除远端 tag 不需要额外确认；发布流程已隐含授权。
- Release Note 所有内容用中文撰写。
- commit 分类基于 prefix，`release:` commit 始终跳过。
- 如果 `--external` 出现在 canary 生命周期任一阶段，提醒用户后续 rollout/promote 也必须带 `--external`。
