# 发布上线指南

> 本文档面向需要执行版本发布的同事，介绍引入灰度发布后的完整上线流程，并与旧流程做对比。

---

## 旧流程 vs 新流程对比


| 维度   | 旧流程（全量发布）                                 | 新流程（灰度发布）                        |
| ---- | ----------------------------------------- | -------------------------------- |
| 发布命令 | `release.sh --patch`                      | `release.sh --canary`            |
| 生效范围 | 所有用户在数分钟内全量更新                             | 按百分比逐步放量                         |
| 观察窗口 | 无                                         | 每个百分比阶段可观察                       |
| 止血速度 | 需要重新发布或手动 rollback                        | `rollout.sh --percentage 0` 秒级止血 |
| 回滚方式 | 发布旧版本 or 用户手动 `loongsuite-pilot rollback` | 止血即可，无需回滚                        |
| 适用场景 | 紧急 hotfix、基础设施变更                          | 常规功能迭代、有风险的变更                    |


**核心变化**：新流程在"发布"和"全量生效"之间增加了可控的灰度阶段。全量发布仍然可用，但建议日常迭代使用灰度流程。

---

## 推荐发布流程（灰度）

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌────────────┐
│  灰度发布    │ ──→ │  逐步放量     │ ──→ │  观察确认     │ ──→ │  提升为正式 │
│  percentage=0│     │  5% → 20% → │     │  检查日志/指标│     │  promote   │
└─────────────┘     └──────────────┘     └──────────────┘     └────────────┘
                            │
                            ↓ 发现问题
                    ┌──────────────┐     ┌──────────────┐
                    │  止血 (0%)    │ ──→ │  发布 hotfix  │ ──→ 重新放量
                    └──────────────┘     └──────────────┘
```

### Step 1: 灰度发布

```bash
# 从 master 创建 release 分支，bump 版本，打 tag，打包上传
# canary 默认 rollout_percentage=0，不会有用户立即更新
bash deploy/release.sh --canary
```

支持的版本 bump 参数（默认 `--patch`）：

- `--patch`：1.1.8 → 1.1.9
- `--minor`：1.1.8 → 1.2.0
- `--major`：1.1.8 → 2.0.0
- `--version 1.2.3`：指定版本号

发布完成后，`latest.json` 中 stable 信息不变，新增 `canary` 字段。老用户不受影响。

### Step 2: 逐步放量

```bash
# 先小范围验证
bash deploy/rollout.sh --percentage 5

# 观察日志和指标无异常后扩大
bash deploy/rollout.sh --percentage 20
bash deploy/rollout.sh --percentage 50

# 最终全量
bash deploy/rollout.sh --percentage 100
```

每次调整后，等待至少一个 updater 检查周期（默认 60s）让目标用户完成更新。

### Step 3: 提升为正式版

确认灰度版本稳定后，将其提升为 stable：

```bash
bash deploy/rollout.sh --promote
```

执行后：

- `latest.json` 顶层 stable 信息更新为 canary 版本
- `canary` 字段被清除
- 所有用户（包括老版本 updater）在下次检查时更新到该版本

### Step 4: 合并代码

```bash
# 回到 master 分支，合并 release 分支
git checkout master
git merge release/v1.1.9
git push
```

---

## 灰度期间发现问题

### 止血

```bash
# 立即阻止新用户进入 canary（已更新的用户不受影响，不会被降级）
bash deploy/rollout.sh --percentage 0
```

### 发布灰度修复（hotfix）

```bash
# 版本号不变，hotfix_version 自动递增
bash deploy/release.sh --canary --hotfix

# 重新小范围放量
bash deploy/rollout.sh --percentage 5
```

hotfix 特性：

- 不改变版本号（如 1.1.9 保持不变）
- `hotfix_version` 自动 +1（0 → 1 → 2 ...）
- 由于分桶固定，同一批用户会收到修复
- 已在 canary 的用户通过 `hotfix_version` 比较触发更新

---

## 全量发布（不走灰度）

紧急 hotfix 或确定无风险的变更，可跳过灰度直接全量：

```bash
bash deploy/release.sh --patch
```

等同旧流程：所有用户在下一个检查周期内全量更新。

---

## 灰度期间发布紧急 stable hotfix

如果 stable 用户遇到紧急 bug，但 canary 正在灰度中：

```bash
# 正常发布 stable hotfix（不带 --canary）
bash deploy/release.sh --patch
```

结果：

- 非灰度用户立即获得 hotfix
- 灰度用户的 canary 版本仍高于 stable，继续使用 canary 不受影响
- 如果 canary 也需要该修复 → 止血 + `release.sh --canary --hotfix`

---

## 发布检查清单

### 发布前

- 代码已合并到 master（或从 master 拉取最新）
- 本地 `npm run build && npm test` 通过
- 工作区干净（无未提交文件）
- `ossutil` 已配置（`ossutil ls oss://` 能执行）

### 灰度发布后

- 确认 `latest.json` 中 `canary` 字段正确（`curl` 验证）
- 放量 5% 后等待 2-3 分钟，检查 updater 日志无报错
- SLS 中对比 canary 和 stable 用户的错误率
- 逐步扩大到 20% → 50% → 100%
- `rollout.sh --promote` 提升为正式版
- release 分支合并回 master

### 验证命令

```bash
# 查看 OSS 上的 latest.json
curl -s https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite/loongsuite-pilot/latest.json | python3 -m json.tool

# 查看客户端当前版本
cat ~/.loongsuite-pilot/versions/$(cat ~/.loongsuite-pilot/current)/VERSION

# 查看客户端 config（installId、canary 状态）
cat ~/.loongsuite-pilot/config.json | python3 -m json.tool

# 查看 updater 日志
tail -50 ~/.loongsuite-pilot/logs/loongsuite-pilot-updater.log
```

---

## 常用命令速查


| 场景          | 命令                                    |
| ----------- | ------------------------------------- |
| 灰度发布（patch） | `release.sh --canary`                 |
| 灰度发布（minor） | `release.sh --canary --minor`         |
| 放量到 N%      | `rollout.sh --percentage N`           |
| 止血          | `rollout.sh --percentage 0`           |
| 灰度 hotfix   | `release.sh --canary --hotfix`        |
| 提升为正式版      | `rollout.sh --promote`                |
| 全量发布（跳过灰度）  | `release.sh --patch`                  |
| 查看当前灰度状态    | `rollout.sh --percentage 0 --dry-run` |


---

## 客户端灰度策略（调试用）

可通过修改客户端 `~/.loongsuite-pilot/config.json` 强制控制灰度行为：

```jsonc
{
  "canary": {
    "policy": "auto"   // 强制加入灰度（无视百分比）
  }
}
```

```jsonc
{
  "canary": {
    "policy": "off"    // 强制退出灰度
  }
}
```

不设置 `policy` 则由服务端百分比 + installId 分桶决定。

---

## FAQ

**Q: 灰度发布后，老版本 updater（不认识 canary 字段）会怎样？**

A: 完全不受影响。老 updater 只读 `latest.json` 顶层的 stable 信息，`canary` 字段被自然忽略。

**Q: 灰度用户在 promote 之后会再更新一次吗？**

A: 不会。promote 把 canary 版本提升为 stable，由于灰度用户已经在该版本上，`needsUpdate()` 判断无需更新。

**Q: 同一个用户每次灰度都会被选中吗？**

A: 不一定。分桶算法是 `hash(installId + canaryVersion) % 100`，混入了版本号。不同灰度版本会命中不同用户集合，避免同一批人始终当先锋。但同一个灰度版本内（包括 hotfix），分桶结果固定。

**Q: rollout percentage=0 和 promote 有什么区别？**

A: `percentage=0` 只是阻止新用户进入 canary，已在 canary 的用户不受影响且不会降级。`promote` 是将 canary 版本设为 stable，所有人最终都会更新到该版本。