# 设计文档：灰度发布（Canary Release）

> **状态**: Reviewed   **作者**: shimu   **日期**: 2026-06-03

---

## 1. 背景与问题

### 当前发布流程

```plaintext
release.sh → package.sh(打包) → upload.sh(上传 OSS)
                                      ↓
                              latest.json + tarball
                                      ↓
                       所有 updater 轮询 → 发现新版本 → 全量更新
```

每个客户端的 updater 进程每 60s 轮询 OSS 上的 `latest.json`，发现版本更新后自动下载并部署。这是一个**全量发布**模型：`latest.json` 一旦更新，所有客户端在下一个轮询周期内都会开始更新。

### 问题

- **无法分批发布**：新版本发布后，所有用户在数分钟内全部更新
- **爆炸半径不可控**：如果新版本存在 bug，所有用户同时受影响
- **缺乏观察窗口**：无法先在小范围验证，再逐步扩大
- **回滚不够快**：当前回滚需要重新发布或手动执行 `loongsuite-pilot rollback`

### 目标

1. 支持按百分比逐步发布新版本（如 5% → 20% → 50% → 100%）
2. 支持客户端主动选择是否参与灰度（`canary.policy`）
3. 紧急情况下可秒级停止灰度
4. 向后兼容：老版本 updater 不受影响
5. 不引入新的服务端基础设施（仍然基于 OSS 静态文件）

---

## 2. 整体方案

### 核心思路

在现有 `latest.json` 中新增 `canary` 字段，描述灰度版本信息和规则。新版本 updater 拉取后，根据本地 `installId` 计算哈希值，确定性地决定当前客户端应该使用 stable 还是 canary 版本。

### 架构图

```plaintext
                    OSS (静态文件)
            ┌──────────────────────────┐
            │  latest.json             │ ← 包含 stable 信息 + canary 字段
            │  1.0.35/tarball          │
            │  1.0.36/tarball          │
            └──────────────────────────┘
                        ↑
               发布者通过脚本更新
               rollout.sh --percentage N

            ┌──────────────────────────┐
            │      Updater (客户端)     │
            │                          │
            │  1. fetch latest.json    │
            │  2. 有 canary? → 分桶    │
            │  3. 确定目标版本          │
            │  4. 下载 & 部署           │
            └──────────────────────────┘
```

---

## 3. 数据结构设计

### 3.1 `latest.json`（扩展）

```json
{
  "version": "1.0.35",
  "git_commit": "a1b2c3d",
  "package_url": "https://<bucket>/<prefix>/1.0.35/loongsuite-pilot.tar.gz",
  "sha256": "abc123...",
  "released_at": "2026-06-01T10:00:00Z",

  "canary": {
    "version": "1.0.36",
    "git_commit": "e4f5g6h",
    "package_url": "https://<bucket>/<prefix>/1.0.36/loongsuite-pilot.tar.gz",
    "sha256": "def456...",
    "released_at": "2026-06-02T10:00:00Z",
    "rollout_percentage": 10
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| 顶层字段 | VersionManifest | 当前稳定版（stable），必须存在 |
| `canary` | CanaryManifest \| null | 灰度版本信息，无灰度时为 null 或不存在 |
| `canary.rollout_percentage` | number (0-100) | 灰度比例 |
| `canary.hotfix_version` | number \| undefined | 灰度 hotfix 迭代号，默认不存在。需要对灰度版本发布修复时设置此字段（从 1 开始递增），用于触发已在 canary 上的用户更新到修复版本 |

TypeScript 类型定义：

```typescript
interface CanaryManifest extends VersionManifest {
  rollout_percentage: number;
  hotfix_version?: number;
}
```

**向后兼容**：老版本 updater 不认识 `canary` 字段，JSON.parse 后自然忽略，只读顶层的 `version` 等字段，行为跟现在完全一样。

### 3.2 客户端配置（config.json 扩展）

新增以下字段：

```json
{
  "installId": "a3f8c1d2-7b4e-4f9a-b2c1-e5d6f7a8b9c0",
  "canary": {
    "hotfix_version": 0
  }
}
```

用户可按需在 `canary` 对象中设置 `"policy": "auto"` 或 `"policy": "off"`。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `installId` | string (UUID) | 自动生成 | 安装标识，用于百分比分桶，每台机器唯一 |
| `canary.policy` | `'auto'` \| `'off'` | 不设置 | `auto`：始终使用 canary 版本；`off`：永远不参与灰度。不设置则由服务端百分比控制 |
| `canary.hotfix_version` | number | 0 | updater 自动维护，记录当前安装的灰度 hotfix 版本。用于与 latest.json 中的 hotfix_version 比较，判断是否需要更新 |

决策优先级：`policy=off` > `policy=auto` > 百分比分桶。

---

## 4. 客户端分桶逻辑

### 4.1 分桶标识：installId

安装时自动生成 UUID，写入 `config.json`。每台机器唯一、始终存在、不依赖用户配置、不会变。

补生成策略：updater 首次运行灰度逻辑时，若 config.json 中无 installId，自动生成并写入。

### 4.2 分桶算法

`bucket = hash(installId + version) % 100`

混入 version。如果 `bucket < rollout_percentage` 则使用 canary，否则使用 stable。

完整决策流程：

1. 没有 canary 字段 → 使用 stable
2. `canary.policy = 'off'` → 使用 stable
3. `canary.policy = 'auto'` → 使用 canary
4. `bucket < rollout_percentage` → 使用 canary
5. 其他 → 使用 stable

### 4.3 灰度修复与 hotfix_version

当灰度版本出现 bug 需要修复时，通过新增/递增 `hotfix_version` 发布修复版本, version不变，只改hotfix_version：

1. stable=1.0.35, canary: version=1.0.36, percentage=5（无 hotfix_version）
2. 5% 用户升级到 1.0.36
3. 发现 bug，止血：percentage=0
4. 修复后发布：canary: version=1.0.36, hotfix_version=1, percentage=5
5. 由于固定分桶，同一批 5% 用户命中 canary
6. `needsUpdate()` 比较：同版本 1.0.36，远端 hotfix_version=1 > 本地 hotfix_version=0 → 需要更新
7. 更新完成后，config.json 写入 canary.hotfix_version=1

`hotfix_version` 默认不存在，首次灰度发布时不需要设置。仅在需要对同一灰度版本发布修复时才出现（从 1 开始，后续递增 2, 3, ...）。

优点：

- 主版本号不会因灰度迭代而膨胀
- 同一批用户作为先锋队，出问题时沟通成本低
- promote 时版本号保持干净

---

## 5. Updater 改造

### 5.1 更新检查流程（改造后）

```plaintext
check()
  │
  ├─ fetch latest.json → 解析
  │   ├─ 有 canary 字段 → resolveTargetVersion()
  │   │         根据 canary.policy / bucket 决定目标版本
  │   │
  │   └─ 无 canary 字段
  │         → 使用顶层 stable 版本（跟现在一样）
  │
  ├─ needsUpdate(local, target, channel)
  │   ├─ 目标版本更高 → 需要更新
  │   ├─ 版本相同，channel=canary，且远端 hotfix_version > 本地 hotfix_version → 需要更新
  │   ├─ 版本相同且 git_commit 不同 → 需要更新（rebuild）
  │   └─ 其他 → 跳过
  │
  │   canary 更新完成后，将远端 hotfix_version 写入 config.json canary.hotfix_version
  │
  └─ downloadAndDeploy() → 重启 collector → 清理旧版本（已有行为，不变）
```

### 5.2 只升不降（Forward-Only）

`needsUpdate()` 保持只升不降：只接受升级，拒绝降级。

已在 canary 上的用户不会被降级回 stable，而是等待修复版本。由于灰度本身就是小比例用户，等待窗口的影响可控。

优点：

- `needsUpdate()` 逻辑几乎不变，保持简单
- 无需处理降级带来的数据/配置兼容性问题
- 版本流向始终单调递增，状态可预测

### 5.3 installId 补生成

updater 首次执行灰度逻辑时，检查 config.json 中是否有 installId。若无，自动生成 UUID 并写入。

---

## 6. 发布流程改造

### 6.1 完整发布流程示例

```plaintext
──── 1. 灰度发布 ────
$ release.sh --canary
  → 正常打包、上传 tarball
  → 更新 latest.json：canary 字段设为新版本，percentage=0
  → 顶层 stable 信息不变

──── 2. 逐步扩大 ────
$ rollout.sh --percentage 5       → 5% 用户开始灰度
$ rollout.sh --percentage 20      → 扩大到 20%
$ rollout.sh --percentage 50      → 扩大到 50%

──── 3. 灰度修复（如果需要） ────
$ rollout.sh --percentage 0       → 止血：阻止新用户进入 canary
$ release.sh --canary --hotfix    → 发布修复版本，保持版本号，hotfix_version 自动递增
$ rollout.sh --percentage 5       → 重新灰度

──── 4. 全量发布 ────
$ rollout.sh --promote
  → 顶层 version/package_url 等更新为 canary 版本
  → canary 字段清空
  → 所有用户（包括老 updater）获得新版本
```

### 6.2 latest.json 各操作下的变化

| 操作 | 顶层 stable 信息 | canary 字段 |
| --- | --- | --- |
| 正常发布 (`release.sh --patch`) | 更新为新版本 | 保持不变 |
| 灰度发布 (`release.sh --canary`) | **不变** | 设为新版本，percentage=0（首次无 hotfix_version，hotfix 时递增） |
| 调整比例 (`rollout.sh --percentage N`) | 不变 | 更新 rollout_percentage |
| 止血 (`rollout.sh --percentage 0`) | 不变 | rollout_percentage=0 |
| 提升 (`rollout.sh --promote`) | 更新为 canary 版本 | 清空为 null |

### 6.3 脚本改造

| 文件 | 改动 |
| --- | --- |
| `deploy/release.sh` | 支持 `--canary` 和 `--hotfix` 参数 |
| `deploy/upload.sh` | 灰度模式下更新 `latest.json` 的 canary 字段 |
| `deploy/rollout.sh` | **新增**：灰度比例控制（`--percentage N`）、提升（`--promote`） |

`release.sh` 灰度相关参数：

- `release.sh --canary`：新灰度发布。bump 版本号（默认 patch），创建 canary 字段，无 hotfix_version。可配合 `--minor` / `--major` 控制 bump 类型
- `release.sh --canary --hotfix`：灰度修复。保持版本号不变，自动递增 hotfix_version（读取当前值 +1，无则设为 1）。当前无 canary 时报错退出

---

## 7. 向后兼容

老用户全程无感，无需分阶段迁移：

1. 通过现有 `latest.json` 全量发布包含灰度逻辑的新 updater
2. 之后随时可以开始灰度发布（`release.sh --canary`）

**老 updater 天然安全**：老 updater 解析 latest.json 后只读顶层的 version/package\_url 等字段，`canary` 字段被自然忽略。无论是否有灰度发布进行中，老 updater 行为完全不变。

| 客户端版本 | canary 字段 | 行为 |
| --- | --- | --- |
| 老 updater | 不感知 | 只读顶层 stable 信息，安全 |
| 新 updater | 存在 | 根据分桶逻辑决定版本 |
| 新 updater | 不存在 | 使用顶层 stable 信息，等同现有行为 |

---

## 8. 可观测性

Updater 日志增强：

```plaintext
[Updater] rollout resolved: channel=canary, target=1.0.36, hotfix_version=2, bucket=23, percentage=30
[Updater] rollout resolved: channel=stable, target=1.0.35, bucket=78, percentage=30
```

updater 更新事件中增加：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `update_channel` | `"stable"` / `"canary"` | 当前客户端所在通道 |
| `rollout_percentage` | number | 当前灰度比例 |
| `bucket` | number | 该客户端的分桶值（便于排查） |

可在 SLS 中按 `update_channel` 分组，对比 canary 和 stable 用户的错误率、性能指标等。

---

## 9. 边界情况与容错

所有 canary 相关逻辑包在 try 块内，任何异常自动 fallback 到使用顶层 stable 信息。

| 异常场景 | 处理方式 | 结果 |
| --- | --- | --- |
| latest.json 网络超时 / 404 | 现有逻辑不变 | 跳过本次检查，下次重试 |
| canary 字段格式损坏或字段缺失 | 视为无 canary | 使用 stable |
| canary 缺少 rollout\_percentage | 视为无 canary | 使用 stable |
| canary 的 tarball 下载失败 | 现有的指数退避重试 | 行为与 stable 下载失败一致 |
| installId 为空（未生成） | hash("") 仍有确定性输出 | 功能正常，分桶不够理想 |

**核心保证**：最差情况下（canary 相关代码全部失败），行为退化到跟今天完全一样——灰度功能不生效，但不影响正常更新。

### 灰度期间发布紧急 stable hotfix

如果 stable 需要紧急修复，但 canary 正在灰度中：

- 正常发布 hotfix 到 stable（`release.sh --patch`，不带 `--canary`）
- latest.json 顶层 stable 版本更新，canary 字段保持
- 非灰度用户立即获得 hotfix
- 灰度用户的 canary 版本仍高于 stable，继续使用 canary
- 如果 canary 也需要该 hotfix → 止血 + 合入修复后通过 `release.sh --canary --hotfix` 递增 hotfix\_version 继续灰度

---

## 10. 待讨论事项

- **灰度版本最大存活时间**：是否需要设置 canary 的 TTL（如 7 天内必须 promote），防止灰度被遗忘
- **灰度观察面板**：是否需要在 SLS 中建立专门的灰度发布监控 dashboard
