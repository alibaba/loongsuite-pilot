# Design: Enhance Alarm & Status Reporting

## Overview

在现有告警/状态上报框架内，最小侵入地完成三项增强。核心改动集中在 metrics 层，不触碰主数据管道。

## 1. 所有告警/状态事件追加 user_id

### 1.1 AlarmManager 扩展

```
AlarmManager 构造参数:
  现有: { ip: string, version: string }
  新增: { ip: string, version: string, userId: string }

AlarmEntry 接口新增:
  user_id: string
```

`serialize()` 输出的每条 `AlarmEntry` 自动携带构造时传入的 `userId`。

### 1.2 L2 指标扩展

`MetricsCollector` 的 `collectL2Inputs()` / `collectL2Flushers()` / `collectL2Alarms()` 输出的接口各新增 `user_id` 字段，值来自 `this.userId`（已在构造时传入）。

```
InputMetrics   += user_id: string
FlusherMetrics += user_id: string
AlarmMetrics   += user_id: string
```

### 1.3 Updater 进程

**入口改动** (`src/updater/index.ts`):

```ts
// 在 main() 中，已有 file = readJsonFile(configPath) 之后
const userId = process.env.LOONGSUITE_PILOT_USER_ID
  ?? file?.userId ?? file?.['user.id'] ?? os.hostname();
```

**UpdaterMetricsOptions 扩展**:
```
现有: { dataDir, version, collectorPidFile }
新增: { dataDir, version, collectorPidFile, userId }
```

**UpdaterEvent 接口新增**: `user_id: string`

`writeEvent()` 和 `writeAlarm()` 产出的记录均携带 `user_id`。

### 1.4 Orchestrator 传参

```ts
// 现有
this.alarmManager = new AlarmManager({ ip, version });
// 改为
this.alarmManager = new AlarmManager({ ip, version, userId: this.config.userId });
```

## 2. 工号格式校验告警

### 2.1 类型扩展

```ts
export type AlarmLevel = '1' | '2' | '3';
//                        ^^^ 新增 info 级别

export type AlarmType =
  | ... existing ...
  | 'USER_ID_FORMAT_ALARM';   // 新增
```

### 2.2 检测逻辑

在 `MetricsWriter.writeL1()` 内，紧跟 `checkThresholds()` 之后新增 `checkUserId()`:

```ts
private checkUserId(): void {
  const userId = this.collector.getUserId();
  if (/^\{.*\}$/.test(userId)) {
    this.alarmManager?.record(
      'USER_ID_FORMAT_ALARM',
      '1',
      `userId "${userId}" contains braces, expected plain number like "123456"`,
    );
  }
}
```

特点：
- 每次 L1 周期（10分钟）执行一次
- 使用 AlarmManager 的聚合机制（相同 key 只保留最新 message + count++）
- 用户修复 config 后，下次检测不再触发，count 归零

### 2.3 Updater 侧

`UpdaterMetrics` 在 `flush()` 中同样执行格式检查：

```ts
if (/^\{.*\}$/.test(this.userId)) {
  this.writeAlarm({
    alarm_type: 'USER_ID_FORMAT_ALARM',
    alarm_level: '1',
    alarm_message: `userId "${this.userId}" contains braces...`,
  });
}
```

由于 Updater 没有 AlarmManager 聚合，每次 flush 周期（30s）会独立产出。为避免噪音，加一个 `userIdAlarmEmitted` flag，整个生命周期只上报一次。

## 3. 隐私设置 Status 上报

### 3.1 数据形状

L1Metrics 新增字段：

```ts
privacy_settings: string  // JSON.stringify 结果
```

值示例：
```json
{
  "cursor": {"captureMessageContent": true},
  "qoder": {"captureMessageContent": false},
  "qoder-cli": {"captureMessageContent": true},
  "qoderwork": {"captureMessageContent": true},
  "codex": {"captureMessageContent": true},
  "claude-code": {"captureMessageContent": true}
}
```

### 3.2 数据来源

**方案：通过 `MetricsWriterOptions` 传入 `agentsConfig`**

```ts
interface MetricsWriterOptions {
  // ... existing
  agentsConfig?: AgentsConfig;  // 新增
}
```

`MetricsCollector` 构造时接收 `agentsConfig`，在 `collectL1()` 中序列化为 `privacy_settings`。

### 3.3 Orchestrator 传参

```ts
new MetricsWriter({
  dataDir: this.config.dataDir,
  version,
  userId: this.config.userId,
  getSnapshot: () => this.buildDataflowSnapshot(),
  alarmManager: this.alarmManager,
  agentsConfig: this.config.agents,  // 新增
});
```

### 3.4 flattenToStrings 兼容

`privacy_settings` 是字符串（已预先 JSON.stringify），所以 `flattenToStrings` 不会对其做嵌套展开，直接作为顶层字段传输。这与 `agent_versions` 的处理方式一致。

## 数据流变更图

```
                    ┌──────────────────────────────────────────────┐
                    │            Orchestrator                       │
                    │  config.userId ─────┬──────────┐             │
                    │  config.agents ─────┼────┐     │             │
                    └────────────────────┼────┼─────┼─────────────┘
                                         │    │     │
                    ┌────────────────────┼────┼─────┼─────────────┐
                    │   AlarmManager     │    │     │              │
                    │   + userId ←───────┘    │     │              │
                    │   → AlarmEntry.user_id  │     │              │
                    └─────────────────────────┼─────┼─────────────┘
                                              │     │
                    ┌─────────────────────────┼─────┼─────────────┐
                    │   MetricsWriter         │     │              │
                    │   + agentsConfig ←──────┘     │              │
                    │   → L1: privacy_settings      │              │
                    │   → L2: user_id               │              │
                    │   → checkUserId() alarm       │              │
                    └───────────────────────────────┼─────────────┘
                                                    │
                    ┌───────────────────────────────┼─────────────┐
                    │   UpdaterMetrics              │              │
                    │   + userId ←──────────────────┘              │
                    │   → UpdaterEvent.user_id                     │
                    │   → AlarmEntry.user_id                       │
                    │   → USER_ID_FORMAT_ALARM (once)              │
                    └─────────────────────────────────────────────┘
```

## 兼容性考虑

- SLS 侧：新增字段不影响已有查询；`user_id` 作为新 column 自动索引
- JSONL 落盘：新增字段直接序列化到 JSON 行中，无 schema 约束
- `flattenToStrings`：所有新增字段均为 string 类型，无嵌套展开问题
- 社区版 `sendRunningStatus`：其白名单 `SELECTED_FIELDS` 不含新字段，不受影响
