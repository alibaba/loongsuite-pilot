# 归一化层 (src/normalization/)

> 将各 Agent 特有的原始数据格式统一转换为 AgentActivityEntry 标准结构。

## 模块组成

| 文件 | 职责 |
|------|------|
| `entry-builder.ts` | 构建统一 AgentActivityEntry + 序列化 + 脱敏 |
| `payload-normalizer.ts` | HTTP/Hook 原始载荷标准化 |

## 数据转换流

```
各 Input 原始数据
    │
    ▼
PayloadNormalizer (载荷标准化)
    │
    ▼
EntryBuilder.buildAgentActivityEntry()
    │  ├─ 字段映射
    │  ├─ ActionType 推断
    │  ├─ 敏感内容脱敏（按 agents 配置）
    │  └─ 序列化为扁平结构
    ▼
AgentActivityEntry (统一输出格式)
```

## AgentActivityEntry 字段定义

<!-- TODO: 列出所有字段、类型、是否必填、说明 -->
<!-- TODO: 给出一个完整的示例 -->

## ActionType 映射规则

<!-- TODO: 描述各 Agent 事件如何映射到统一的 ActionType 枚举 -->
<!-- TODO: 列出 event.name → ActionType 的映射表 -->

## 敏感内容脱敏

<!-- TODO: 描述 captureMessageContent 配置项的作用 -->
<!-- TODO: 列出被标记为敏感的字段清单 -->
<!-- TODO: 描述脱敏后保留的元数据 -->

## 添加新归一化器

<!-- TODO: 描述为新 Agent 数据格式编写 normalizer 的步骤 -->
<!-- TODO: 描述如何在 Input 中调用自定义 normalizer -->
