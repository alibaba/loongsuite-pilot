# Issue 优先级

优先级写入 frontmatter `priority`，**并体现在文件名** `ISS-…-<P0>-….md`（见 [issue-format.md](issue-format.md)）。合成规则如下。

## 等级

| 级 | 含义 | 期望动作 |
|----|------|----------|
| `P0` | 紧急 | 本周内排期；大范围核心故障或明确扩散中的正确性缺陷 |
| `P1` | 高 | 近两周内处理；大影响或 L3 存活/数据主路径，修复路径清晰 |
| `P2` | 中 | 纳入迭代；噪声治理、阈值/语义优化，或不紧急的中等影响 |
| `P3` | 低 | 可观察/个案运维；影响面小且无舰队级扩散 |

## 评分维度

### 1. 影响范围（Impact）

以窗口内 **去重 Agent** 为主，用户数为辅：

| 档 | 参考 |
|----|------|
| XL | Agent ≥ 500，或 User ≥ 100 且触及采集/存活/升级主路径 |
| L | Agent 200–499，或 L3 存活类 Agent ≥ 100 |
| M | Agent 50–199 |
| S | Agent &lt; 50 |

可上调一档：已证实会阻断重启/升级 finalize、或与多类核心告警高共现（≥50%）。
可下调一档：已证实 **产品噪声**（可用性预期停止、阈值过敏）且无实测功能中断。

### 2. 严重度（Severity）

| 档 | 典型 |
|----|------|
| Critical | 采集/守护不可用（L3 存活）、重启必挂（指针/node-bin）、主通道丢数 |
| High | 持续错误环（如 watchdog 反复 restart+告警）、升级链路损坏 |
| Medium | L2 降级（nohup）、可恢复发送失败 |
| Low | 已证实主因是告警语义/阈值噪声 |

### 3. 修复难度（Difficulty）

| 档 | 典型 |
|----|------|
| Easy | 单模块小改（grace、降噪、拆 alarm type、调阈值），1 个小 PR |
| Medium | 跨模块或脚本+代码（安装自启 + watchdog），需联调 |
| Hard | 强依赖用户环境/批量运维、或根因需上机才能闭合 |

### 4. 合成规则（先看表，再书面说明）

| Impact × Severity ↓ \ Difficulty → | Easy | Medium | Hard |
|-----------------------------------|------|--------|------|
| XL + Critical/High | **P0** | **P0** | **P1** |
| L + Critical/High | **P0** | **P1** | **P1** |
| XL/L + Medium | **P1** | **P1** | **P2** |
| M + Critical/High | **P1** | **P1** | **P2** |
| M + Medium/Low（含噪声） | **P2** | **P2** | **P3** |
| S + Critical（正确性/重启必挂） | **P1** | **P1** | **P2** |
| S + 其它 | **P2** | **P3** | **P3** |

例外：

- **噪声下调**：主因已证实为误报/文案「unexpectedly」类 → 同 Impact 至少降一档（通常落到 P2）
- **正确性上调**：影响面虽小但升级/安装路径会系统性制造坏状态 → 至少 P1
- **阻塞修复**：P0/P1 必须写清「最小修复面」（改哪些文件/脚本）

## Issue 中怎么写

Frontmatter：

```yaml
priority: P1
```

Summary 增加一行：

```markdown
- 优先级: `P1`（Impact=L · Severity=Critical · Difficulty=Medium）— 一句话理由
```

正文增加一节（建议在 Summary 后）：

```markdown
## Priority

- 等级: P1
- Impact / Severity / Difficulty: …
- 理由: …
```

子 Agent 在结论中给出建议档与三维度；**主 Agent** 按上表裁定最终 `priority` 并落盘。
