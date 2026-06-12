# SLS 上报链路诊断排查指南

本文档随 `loongsuite-pilot` 安装包一起分发，安装完成后自动写入
`~/.loongsuite-pilot/skills/references/sls-diagnostics.md`，随 pilot 升级自动更新。

覆盖 **pilot 向 SLS（Simple Log Service）上报数据的链路排查**——数据在本地正常采集但 SLS 查不到、上报失败、failed-logs 堆积等问题。
不覆盖 agent 侧的 hook/JSONL 数据采集问题（那些请查阅对应的 agent 分诊文档）。

---

## 上报链路概览

```
Input 采集到数据 → normalization → SlsFlusher
    ↓
SlsFlusher 按 endpoint 分别发送
    ├── webtracking 模式：HTTP POST → {project}.{endpoint}/logstores/{logstore}/track
    └── ak 模式：@alicloud/log SDK → postLogStoreLogs()
    ↓
发送失败（3 次重试后仍失败）
    → 写入 ~/.loongsuite-pilot/sls-failed-logs/{endpoint-name}.jsonl
```

关键事实：
- 两种发送模式：**webtracking**（无需 AK/SK，HTTP POST）和 **ak**（需 AK/SK，SDK）
- 默认 batch=20 条，flush 间隔 2 秒
- 失败自动重试 3 次（指数退避：1s → 2s → 4s），可重试的状态码：408、429、500、502、503、504
- 最终失败的日志持久化到 `sls-failed-logs/` 目录（不会丢失）
- 支持多 endpoint 同时发送（互不阻塞）

---

## 系统化排查顺序

SLS 上报异常时，**按以下顺序逐步排查**：

```
第 1 步 → SLS Flusher 是否启用
第 2 步 → endpoint 配置是否正确
第 3 步 → 运行时发送状态（服务日志）
第 4 步 → 失败日志分析
```

---

## 第 1 步：SLS Flusher 是否启用

SLS Flusher 启用条件：每个 endpoint 的 `mode` 所需凭证齐全时自动启用，也可在 `config.json` 中显式控制。

```bash
# 查看 config.json 中的 SLS 配置
python3 -m json.tool ~/.loongsuite-pilot/config.json 2>/dev/null \
  | python3 -c "
import json,sys
c=json.load(sys.stdin)
sls=c.get('sls',{})
print(json.dumps(sls, indent=2, ensure_ascii=False))
" 2>/dev/null || echo "config.json 不存在或无 sls 段"
```

配置优先级（从高到低）：

| 层级 | 来源 | 示例 |
|------|------|------|
| 1（最高） | 环境变量 | `LOONGSUITE_SLS_ENDPOINT`、`LOONGSUITE_SLS_PROJECT`、`LOONGSUITE_SLS_LOGSTORE`、`LOONGSUITE_SLS_MODE`、`LOONGSUITE_SLS_ACCESS_KEY_ID`、`LOONGSUITE_SLS_ACCESS_KEY_SECRET` |
| 2（最低） | `config.json` → `sls` 段 | `sls.endpoint`、`sls.project`、`sls.logstore`、`sls.mode` |

```bash
# 检查是否有 SLS 相关环境变量
env | grep -E '^LOONGSUITE_SLS_' 2>/dev/null || echo "无 LOONGSUITE_SLS_ 环境变量"
```

若 SLS 被禁用（`config.json` 的 `sls.enabled = false`），服务日志中不会有任何 SLS 发送日志。

---

## 第 2 步：endpoint 配置是否正确

### 2.1 endpoint 配置

用户通过 `config.json` 或环境变量配置 SLS endpoint：

- 必须同时提供 `project` 和 `logstore`，否则视为无效，回退到内部默认
- mode 推断规则：显式指定 > AK/SK 存在时自动用 `ak` > 默认 `webtracking`
- `endpoint` URL 会自动补 `https://` 前缀

### 2.2 验证 endpoint 配置正确

```bash
# 在服务日志中搜索实际使用的 endpoint 信息
grep -E '"tag":"SlsFlusher"' ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log \
  | grep -E 'batch sent|endpoint' | tail -5
```

---

## 第 3 步：运行时发送状态

### 3.1 正常发送日志

```bash
# 查看最近的 SLS 发送日志
grep '"tag":"SlsFlusher"' ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log | tail -20
```

| 日志关键字 | 含义 |
|-----------|------|
| `batch sent via webtracking` | webtracking 模式发送成功，含 project/logstore/count |
| `batch sent via ak` | ak 模式发送成功 |
| `SLS webtracking retrying` | 重试中（含 attempt 次数和 delayMs） |
| `SLS ak send retrying` | ak 模式重试中 |
| `SLS webtracking send failed after retries` | webtracking 3 次重试后失败 |
| `SLS send failed after retries` | ak 模式 3 次重试后失败 |
| `SLS endpoint flush failed` | endpoint 级别发送失败（一个 endpoint 的失败不阻塞其他 endpoint） |

### 3.2 发送参数

| 参数 | 默认值 | 配置方式 |
|------|-------|---------|
| batch 大小 | 20 条 | `config.json` → `sls.batchMaxSize` |
| flush 间隔 | 2 秒 | `config.json` → `sls.flushIntervalMs` |
| 重试次数 | 3 次 | 代码固定 |
| 重试退避 | 1s → 2s → 4s | 代码固定 |
| webtracking 超时 | 10 秒 | 代码固定 |
| webtracking 单批最大体积 | 2.8 MB | 代码固定 |
| webtracking 单批最大条数 | 4096 条 | 代码固定 |

### 3.3 可重试的错误

以下状态码或错误会触发自动重试：
- HTTP 状态码：408、429、500、502、503、504
- 网络错误：`ECONNRESET`、`ETIMEDOUT`、`ECONNREFUSED`、`socket hang up`、`TimeoutError`
- SLS 错误：`InternalServerError`、`ServerBusy`

不可重试的错误（立即失败）：
- 401 Unauthorized（AK/SK 无效）
- 403 Forbidden（权限不足）
- 404 Not Found（project/logstore 不存在）

---

## 第 4 步：失败日志分析

3 次重试后仍失败的日志会持久化到 `sls-failed-logs/` 目录：

```bash
# 查看失败日志目录
ls -la ~/.loongsuite-pilot/sls-failed-logs/

# 查看最近的失败记录（每行一个 JSON）
tail -5 ~/.loongsuite-pilot/sls-failed-logs/*.jsonl 2>/dev/null
```

失败日志格式：
```jsonc
{
  "ts": 1716000000000,        // 失败时间戳
  "endpoint": "internal-sls", // endpoint 名称
  "kind": "agentActivity",    // 数据类型
  "project": "...",           // SLS project
  "logstore": "...",          // SLS logstore
  "logGroup": { ... },        // 完整的日志内容（可用于手动重放）
  "error": "..."              // 错误详情
}
```

文件名按 endpoint 名称分隔：`{endpoint-name}.jsonl`，不同 endpoint 的失败互不干扰。

### 4.1 常见失败原因分析

```bash
# 提取失败原因统计
python3 -c "
import json, sys, collections
errors = collections.Counter()
import glob
for f in glob.glob('$HOME/.loongsuite-pilot/sls-failed-logs/*.jsonl'):
    for line in open(f):
        try:
            r = json.loads(line)
            errors[r.get('error','unknown')[:80]] += 1
        except: pass
for err, cnt in errors.most_common(10):
    print(f'{cnt:5d}  {err}')
" 2>/dev/null
```

### 4.2 清理失败日志

失败日志由 LogRetentionService 自动清理（默认保留 7 天）。手动清理：

```bash
# 确认无需重放后，清理所有失败日志
rm -f ~/.loongsuite-pilot/sls-failed-logs/*.jsonl
```

---

## 关键文件速查

| 文件 / 目录 | 作用 |
|---|---|
| `~/.loongsuite-pilot/config.json` | SLS 配置：`sls` 段（enabled/mode/endpoint/project/logstore/AK/SK） |
| `~/.loongsuite-pilot/logs/loongsuite-pilot-service.log` | 服务日志，搜索 `tag: SlsFlusher` 查看发送状态 |
| `~/.loongsuite-pilot/sls-failed-logs/` | 发送失败的日志持久化目录，按 endpoint 名称分文件 |
| `~/.loongsuite-pilot/sls-failed-logs/{endpoint-name}.jsonl` | 单个 endpoint 的失败记录（含完整 logGroup，可手动重放） |
| `~/.loongsuite-pilot/logs/output/` | JSONL Flusher 输出（如果同时启用了 JSONL，可作为数据对账基准） |

---

## 常见问题速查

| 现象 | 解决方法 |
|------|---------|
| 本地 `logs/output/` 有数据但 SLS 查不到 | 1) SLS Flusher 未启用 → 检查第 1 步；2) endpoint 配错 → 检查第 2 步；3) 发送失败 → 检查第 3 步的服务日志和第 4 步的失败日志 |
| 服务日志中无任何 `SlsFlusher` 日志 | SLS Flusher 未启用。检查 `config.json` 的 `sls.enabled` 和凭证是否齐全 |
| `SLS endpoint flush failed` 持续出现 | 某个 endpoint 持续不可达。不影响其他 endpoint 的发送。检查网络和 endpoint 配置 |
| `401 Unauthorized` | ak 模式下 AK/SK 无效。检查 `LOONGSUITE_SLS_ACCESS_KEY_ID` / `LOONGSUITE_SLS_ACCESS_KEY_SECRET` 或 `config.json` 中的值 |
| `403 Forbidden` | AK 对应的 RAM 角色无 SLS 写入权限。需要 `log:PostLogStoreLogs` 或 `log:PutWebtracking` 权限 |
| `404 Not Found` | project 或 logstore 不存在。在 SLS 控制台确认名称拼写正确 |
| `sls-failed-logs/` 目录持续增大 | 上报持续失败。先修复根因（网络/凭证/配置），修复后新数据会正常发送，历史失败数据保留在文件中 |
| 数据到了 SLS 但部分字段缺失 | 检查 `config.json` 的 `agents.<agentType>.captureMessageContent` 是否为 `false`（会脱敏代码内容字段） |
| webtracking 模式下数据量大时部分丢失 | 单批超过 4096 条或 2.8MB 时会自动分片。若分片后仍失败，检查 `sls-failed-logs/` 中的错误详情 |
| 多 endpoint 配置下部分 endpoint 失败 | 多个 endpoint 独立发送，互不影响。分别检查各自的网络和配置 |
| 多个 endpoint 完全相同 | 自动去重，只发送一次（按 endpoint URL + project + logstore 三元组去重） |
