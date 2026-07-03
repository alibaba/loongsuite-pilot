---
name: loop-triage
description: 巡检扫描 — 检查项目编译状态、测试结果、CI 管线、近期提交，产出结构化的优先级报告供 loop-l2 消费
metadata:
  author: agent-data-collection
  version: "2.0"
  category: Loop
  requires:
    bins:
      - git
      - npm
---

# Loop Triage

对项目执行一次全面巡检，产出结构化的优先级分类报告。本 skill 由 `/loop-l2` 在 Phase 1 调用，也可独立使用。

**Input**: 无（从项目当前状态推导）

---

## 扫描范围

### 1. 编译状态

```bash
npm run build && npm run typecheck
```

关注：TypeScript 编译错误、类型不匹配、缺少导入。

### 2. 测试状态

```bash
npm test
```

关注：失败的单测、新增未覆盖的路径。

### 3. 近期提交

```bash
git log --oneline --since="48 hours ago"
```

关注：是否有 revert、紧急修复、TODO 标注的临时方案。

### 4. 代码异味

```bash
git diff HEAD~5 --name-only | xargs grep -n "TODO\|FIXME\|HACK\|XXX" 2>/dev/null || true
```

关注：近期引入的技术债标记。

### 5. CI 管线状态

检查 `.aoneci/` 配置和最近的 CI 运行结果（如有 MCP code 平台可访问）。

### 6. STATE.md 历史

读取 `STATE.md` 中上次运行的 Post-Run Critique，避免重复上报同一问题。

---

## 输出格式

```markdown
## Triage Report — <ISO date>

### High-Priority Items

| # | 问题 | 影响 | 建议动作 | 预估改动量 |
|---|------|------|----------|-----------|
| 1 | <一行描述> | <影响范围> | <具体修复方向> | <行数估算> |

### Watch Items

| # | 问题 | 原因暂不处理 |
|---|------|-------------|
| 1 | <描述> | <为什么放 Watch> |

### Noise / Ignore

- <已审视但无需关注的条目，一行一条>

### State Updates

- <循环应记住的事实，供下次运行参考>

### Post-Run Critique（供下次运行自省）

- High-noise: <本次误报的条目>
- False positives: <本次多余的 High-Priority>
- Adjustment: <下次扫描应调整的策略>
```

---

## 分类标准

### High-Priority 准入条件（必须全部满足）

- 今天一个合理的工程师看到会想处理
- 有明确的修复方向（非"需要讨论"）
- 不是已知的长期问题（除非恶化）

### 降级到 Watch 的情况

- 问题存在但不紧急（无实际影响）
- 需要更多信息才能判断修复方向
- 依赖外部条件（等上游修复、等人回复）

### 归入 Noise 的情况

- 已知的 flaky test（STATE.md 中标注过的）
- dependabot / 自动升级 PR（无 breaking change）
- 纯格式化 / lint warning（不影响运行）

---

## 与 loop-l2 的协作

当由 `/loop-l2` 调用时，loop-l2 会从 High-Priority 中筛选可修复项（< 100 行、不涉及禁止路径）交给 `/develop` 处理。因此：

- High-Priority 中的"建议动作"要具体到可执行（不是"调查一下"）
- "预估改动量"要尽量准确，直接影响 loop-l2 的路由判断
- 超出自动修复范围的问题（架构变更、需要讨论）放 Watch，附注原因

---

## 规则

- 极度简洁，循环和人都不想看废话
- 不要在 triage 阶段提出架构重构——这里只做信号发现，不做发明
- 不重复上报 STATE.md 中已标记为 "escalated" 或 "in-progress" 的条目
- 尊重项目现有约定（读取 AGENTS.md 和 loop-constraints.md）
- 一次 triage 的 High-Priority 不超过 5 条——强迫优先级排序
