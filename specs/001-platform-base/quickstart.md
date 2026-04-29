# Quickstart: 平台基础设施（Platform Base）

**Feature**: `001-platform-base`

## 环境准备

```bash
# Node.js 18+（推荐使用 nvm）
nvm use 18

# 安装依赖
npm install --legacy-peer-deps

# 类型检查
npm run typecheck

# 运行测试
npm test

# 运行测试（覆盖率）
npm run test:coverage
```

## 启动系统

### 最小配置启动（仅 JSONL 输出）

```bash
# 使用默认配置启动
npm start
```

系统将自动：
1. 创建数据目录 `~/.ai-agent-collector/`
2. 加载状态文件（首次运行时初始化为空）
3. 使用 JSONL 兜底输出到 `~/.ai-agent-collector/logs/output/`
4. 启动 Agent 发现服务，检测已安装的 AI Agent

### 配置文件启动

```bash
# 自定义配置文件路径
AGENT_DATA_COLLECTION_CONFIG=./config.json npm start
```

配置文件示例（`config.json`）：

```json
{
  "dataDir": "~/.ai-agent-collector",
  "sls": {
    "enabled": true,
    "accessKeyId": "YOUR_AK",
    "accessKeySecret": "YOUR_SK",
    "endpoint": "https://cn-hangzhou.log.aliyuncs.com",
    "endpoints": [
      { "project": "my-project", "logstore": "agent-activity", "kind": "agentActivity" },
      { "project": "my-project", "logstore": "agent-telemetry", "kind": "agentTelemetry", "redact": true }
    ]
  },
  "jsonl": { "enabled": true, "rotateDaily": true },
  "http": {
    "enabled": true,
    "url": "https://my-server.com/api/collect",
    "headers": { "Authorization": "Bearer xxx" }
  },
  "listeners": {
    "qoder": { "enabled": true, "pollInterval": 60000 },
    "qoder-work": { "enabled": true, "pollInterval": 60000 },
    "qoder-cli-hook": { "enabled": true, "pollInterval": 60000 }
  }
}
```

### 环境变量覆盖

```bash
# SLS 输出（优先于配置文件）
SLS_ACCESS_KEY_ID=xxx SLS_ACCESS_KEY_SECRET=yyy SLS_ENDPOINT=https://cn-hangzhou.log.aliyuncs.com \
  SLS_PROJECT=my-project SLS_LOGSTORE=agent-activity npm start

# HTTP 输出
HTTP_REPORT_URL=https://my-server.com/api/collect npm start

# 禁用 JSONL 输出
JSONL_ENABLED=false npm start

# 强制轮询模式（禁用 fs.watch）
AAC_FORCE_POLLING=true npm start
```

## 验证采集

```bash
# 查看输出文件
ls ~/.ai-agent-collector/logs/output/

# 查看 Qoder IDE 数据
cat ~/.ai-agent-collector/logs/output/Qoder-$(date +%Y-%m-%d).jsonl | head -5

# 查看采集状态
cat ~/.ai-agent-collector/logs/input-state.json | python3 -m json.tool
```

## 新增 Agent

参考 `src/inputs/qoder-work/qoder-work-input.ts` 实现：

1. 在 `src/types/client-type.ts` 添加 `ClientType` 枚举值
2. 创建 `src/inputs/{agent}/{agent}-input.ts`，继承合适的基类
3. 在 `src/core/orchestrator.ts` 的 `registerAllInputs()` 中注册

## 开发测试

```bash
# 运行全部测试
npm test

# 运行特定模块测试
npx vitest run tests/unit/flushers/
npx vitest run tests/unit/normalization/
npx vitest run tests/unit/core/

# Watch 模式
npm run test:watch

# 覆盖率报告
npm run test:coverage
```
