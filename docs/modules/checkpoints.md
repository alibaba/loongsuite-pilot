# Module: checkpoints

> Last verified: 2026-05-13

## 职责 (Responsibility)

持久化状态管理层，为 Input 模块提供采集进度追踪和重复处理保护，确保进程重启后尽量从已确认的位置继续采集。

该模块只负责保存和读取 checkpoint 状态，不负责解析输入源内容，也不负责决定事件是否应被上报。

## 公共接口 (Public Interface)

- **StateStore** — Input 采集进度存储器，用于记录不同输入源的 offset、rowId、时间戳水位等游标状态。代码入口：[src/checkpoints/state-store.ts](../../../src/checkpoints/state-store.ts)
- **SnapshotStore** — IDE snapshot 去重存储器，用于记录已见过的 snapshot key，并为 snapshot 扫描提供建议起点。代码入口：[src/checkpoints/snapshot-store.ts](../../../src/checkpoints/snapshot-store.ts)

## 内部设计 (Internal Design)

### 代码布局 (Code Layout)

```
src/checkpoints/
├── state-store.ts     # input offset / cursor 状态持久化
└── snapshot-store.ts  # IDE snapshot 去重与 high watermark
```

### 运行时状态文件 (Runtime State Files)

```
~/.loongsuite-pilot/logs/
├── input-state.json      # StateStore 持久化文件
└── ...                   # 各 Input 可拥有自己的 SnapshotStore 文件
```

状态文件是 collector 重启恢复和去重的边界。修改格式前必须评估迁移、重复采集和漏采风险。

### StateStore
- 负责保存 Input 的采集游标，支持按 Input 或复合 key 记录状态。
- 常见用途包括日志文件字节偏移、SQLite rowId、时间戳水位、文件轮转辅助信息等。
- 调用方应通过 store 提供的方法更新状态，并在 collect cycle 结束后保存。

### InputState 结构
```ts
interface InputState {
  lastOffset?: number     // 字节偏移（Hook/Session inputs）
  lastFile?: string       // 当前处理的日志文件名
  lastRowId?: number      // SQLite rowid 游标
  lastTimestamp?: number  // 时间戳水位
  highWatermark?: number  // 通用水位值
  extra?: Record<string, unknown>  // 扩展字段（如 inode 追踪）
}
```

### SnapshotStore
- 负责保存 IDE snapshot 的处理记录，避免同一个 snapshot 被重复转换。
- key 由 Input 生成，必须在同一 Input 内保持稳定。
- store 可基于已处理记录提供建议扫描起点，用于减少历史扫描成本。
- 过期清理用于限制状态文件规模，但 retention 配置会影响去重窗口。

### 持久化时机
- **StateStore**：每次 Input collect cycle 结束后调用 `save()`；Orchestrator stop 时最终 save。
- **SnapshotStore**：每次 BaseIdeInput collect 末尾调用 `flush()`；`onStop()` 时最终 flush。

## 依赖关系 (Dependencies)

| 依赖模块 | 导入内容 |
|---------|---------|
| types | `InputState` |
| utils | `readJsonFile`, `writeJsonFile`, `createLogger` |

## 约束 (Constraints)

1. **单写者模型**：同一 filePath 不得有多个 StateStore/SnapshotStore 实例同时操作。
2. **load() 必须在使用前调用**：未加载状态会使 collector 按空 checkpoint 运行，可能导致重复采集。
3. **key 格式必须稳定**：SnapshotStore 的 key 生成逻辑一旦变更，历史去重记录将无法命中。
4. **retention 配置必须谨慎**：过短的保留时间会缩小去重窗口，增加重复处理风险。
5. **状态文件格式属于兼容边界**：修改字段或结构前必须考虑旧版本迁移。
6. **写入路径必须保持原子性**：不要绕过现有文件写入工具直接写 checkpoint 文件。

## AI 修改注意事项

- 先判断修改属于 checkpoint 存储语义、Input 调用方式，还是状态文件格式变更；不要把输入解析逻辑放进本模块。
- 不要随意重命名 Input id、复合 state key 或 snapshot key，这些值会影响历史状态命中。
- 修改保存、加载、过期清理或 suggested timestamp 行为时，需要同时检查相关 Input 的恢复和去重行为。
- 如果必须改变状态文件结构，应提供兼容读取或迁移策略，避免升级后重复采集或漏采。
