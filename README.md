# 多 AI Agent 轻量数据输入源

面向多种 AI Agent 的使用数据采集平台，支持自动发现、多种采集方式、多目标数据输出，架构高度可扩展。

## 环境依赖

| 依赖 | 版本要求 | 说明 |
|------|---------|------|
| Node.js | >= 18.x | 运行时，推荐 18 LTS 或更高 |
| npm | >= 8.x | 包管理器 |
| TypeScript | >= 5.3 | 开发依赖，已在 devDependencies 中声明 |
| better-sqlite3 | 9.x | 原生模块，需要编译工具链 (macOS: Xcode CLT, Linux: build-essential) |

```bash
# 验证环境
node -v   # >= v18.0.0
npm -v    # >= 8.0.0
```

## 本地开发与测试

### 开发环境准备

```bash
# 1. 克隆仓库
git clone <repository-url>
cd agent-data-collection

# 2. 安装依赖（包含 postinstall 钩子脚本安装）
npm install

# 3. 类型检查（推荐在编码过程中使用）
npm run typecheck
```

### 编译与运行

```bash
# 完整编译（输出到 dist/）
npm run build

# 启动服务（开发环境）
npm start
# 等价于: node dist/index.js
```

### 开发最佳实践

1. **增量编译**：修改代码后重新运行 `npm run build`，或启用 TypeScript watch 模式：
   ```bash
   npx tsc --watch
   ```

2. **直接运行测试**：编译后直接运行测试：
   ```bash
   node dist/index.js
   ```

3. **验证钩子安装**：检查 `~/.loongsuite-pilot/hooks/` 目录确认 hook 脚本已正确安装：
   ```bash
   ls -la ~/.loongsuite-pilot/hooks/
   ```

4. **查看日志输出**：检查数据采集日志：
   ```bash
   tail -f ~/.loongsuite-pilot/logs/output/*.jsonl
   ```

## 打包与部署

项目提供 `deploy/` 目录下的三个脚本完成打包、上传、远程安装/升级/卸载的全流程。这些脚本不会被打包进发布产物中。

```
deploy/
├── package.sh        # 编译 + 打包 tar.gz
├── upload.sh         # 上传 tar.gz + loongsuite-pilot-installer.sh 到 OSS
└── loongsuite-pilot-installer.sh  # 统一安装/升级/卸载脚本（用户侧执行）
```

### 第一步：打包

```bash
# 编译 TypeScript 并打包（输出 loongsuite-pilot.tar.gz）
bash deploy/package.sh

# 自定义输出路径
bash deploy/package.sh -o /tmp/loongsuite-pilot.tar.gz

# 跳过编译，使用已有 dist/
bash deploy/package.sh --skip-build
```

打包产物结构：
```
loongsuite-pilot.tar.gz
├── dist/              # 编译后的 JavaScript
├── assets/            # Hook 脚本
├── scripts/           # postinstall 脚本
├── package.json       # 包元信息
├── package-lock.json  # 依赖锁定
├── VERSION            # 版本信息（version / git_commit / git_branch / build_time）
└── README.md
```

### 第二步：上传到 OSS

需要先安装并配置 [ossutil](https://help.aliyun.com/document_detail/120075.html)：

```bash
# 安装 ossutil
brew install ossutil   # 或 pip install ossutil2

# 配置凭证
ossutil config -e oss-cn-hangzhou.aliyuncs.com -i <AK_ID> -k <AK_SECRET>

# 上传到 test 渠道（默认）
bash deploy/upload.sh

# 上传到 release 渠道（正式发布）
bash deploy/upload.sh --channel release

# 上传到个人隔离渠道（互不覆盖，适合多人并行测试）
bash deploy/upload.sh --channel test-taiye

# 自定义 bucket / 前缀 / 区域
bash deploy/upload.sh --bucket my-bucket --prefix my/path --region cn-beijing
```

#### 渠道隔离

支持三种渠道模式，产物上传到不同的 OSS 路径，互不干扰：

| 渠道 | 命令 | OSS 路径 |
|------|------|----------|
| `release` | `--channel release` | `loongsuite/loongsuite-pilot/latest/` |
| `test` | `--channel test`（默认） | `loongsuite-dev/loongsuite-pilot/latest/` |
| `test-<suffix>` | `--channel test-taiye` | `loongsuite-dev/test-taiye/loongsuite-pilot/latest/` |

`test-<suffix>` 用于多人并行开发时各自隔离测试环境，`<suffix>` 仅允许字母和数字。上传后生成的 installer 和安装包 URL 会自动指向对应的隔离路径。

上传后会打印一键安装命令。

### 第三步：远程安装/升级/卸载（用户侧）

`loongsuite-pilot-installer.sh` 支持三个子命令：`install`（默认）、`upgrade`、`uninstall`。

#### 安装

```bash
# 最简安装（不传子命令默认为 install）
curl -fsSL https://<BUCKET>.oss-<REGION>.aliyuncs.com/<PREFIX>/loongsuite-pilot-installer.sh | bash

# 从个人隔离渠道安装（使用对应渠道上传后打印的 URL）
curl -fsSL https://<BUCKET>.oss-<REGION>.aliyuncs.com/loongsuite-dev/test-taiye/loongsuite-pilot/loongsuite-pilot-installer.sh | bash

# 可选：内部/运维场景覆盖 SLS 后端配置（默认替换内置目的地）
curl -fsSL <URL>/loongsuite-pilot-installer.sh | bash -s -- install \
  --sls-endpoint "https://cn-hangzhou.log.aliyuncs.com" \
  --sls-project "my-project" \
  --sls-logstore "my-logstore" \
  --sls-ak-id "your-ak-id" \
  --sls-ak-secret "your-ak-secret"

# 可选：双写到「用户 SLS + 内置目的地」（dual-write）
# 显式传 --default-sls-override=false 即可，省略或传 true 表示仅写用户目的地
curl -fsSL <URL>/loongsuite-pilot-installer.sh | bash -s -- install \
  --sls-endpoint "https://cn-hangzhou.log.aliyuncs.com" \
  --sls-project "my-project" \
  --sls-logstore "my-logstore" \
  --sls-ak-id "your-ak-id" \
  --sls-ak-secret "your-ak-secret" \
  --default-sls-override=false
```

SLS 目的地解析规则：
- 不传任何 `--sls-*` 参数：仅写入内置目的地（默认行为，对外发布场景）。
- 传 `--sls-*` 参数（不传 `--default-sls-override` 或传 `true`）：用户目的地**替换**内置（运维/排障场景）。
- 传 `--sls-*` 参数 + `--default-sls-override=false`：双写到用户目的地与内置目的地（任一失败不影响另一路）。

安装流程：
1. 检查 Node.js >= 18、npm、curl/wget
2. 下载并解压安装包到 `~/.loongsuite-pilot/package`
3. `npm install --production` 安装依赖
4. 执行 `postinstall.js` 部署 hook 脚本到 `~/.loongsuite-pilot/hooks/`
5. 将安装参数写入 `~/.loongsuite-pilot/config.json`（默认 SLS 上报目的地由程序内置，不写入用户配置）
6. 安装 `loongsuite-pilot` 服务管理命令（root 用户链接到 `/usr/local/bin`，普通用户安装到 `~/.local/bin`）
7. 配置开机自启动（macOS: launchd / Linux: systemd user unit）
8. 自动启动服务

#### 升级

```bash
curl -fsSL <URL>/loongsuite-pilot-installer.sh | bash -s -- upgrade
```

升级流程（无缝，自动回滚）：
1. 比较新旧 VERSION，相同版本跳过
2. 停止当前服务
3. 备份旧版本到 `~/.loongsuite-pilot/package.bak`
4. 部署新版本、安装依赖、更新 hook 脚本
5. 启动新版本并验证进程存活
6. 成功则删除备份；**失败则自动恢复旧版本并重启**

升级不会修改 `config.json` 和数据目录，配置完全保留。

#### 卸载

```bash
# 卸载（保留配置和日志数据）
curl -fsSL <URL>/loongsuite-pilot-installer.sh | bash -s -- uninstall

# 彻底卸载（删除所有数据）
curl -fsSL <URL>/loongsuite-pilot-installer.sh | bash -s -- uninstall --purge
```

### 服务管理

安装完成后使用 `loongsuite-pilot` 命令管理服务：

```bash
loongsuite-pilot start             # 启动（后台运行）
loongsuite-pilot stop              # 停止
loongsuite-pilot restart           # 重启
loongsuite-pilot status            # 查看运行状态、版本和自启动状态
loongsuite-pilot run               # 前台运行采集器（供 launchd/systemd 调用）
loongsuite-pilot run-updater       # 前台运行更新器（供 launchd/systemd 调用）
loongsuite-pilot rollback          # 回滚到上一个版本
loongsuite-pilot autostart enable  # 开启开机自启动（包含采集器和更新器）
loongsuite-pilot autostart disable # 关闭开机自启动
loongsuite-pilot autostart status  # 查看自启动状态
loongsuite-pilot log               # 实时查看日志（tail -f）
loongsuite-pilot config            # 查看当前配置文件
loongsuite-pilot version           # 查看版本信息
```

修改配置后执行 `loongsuite-pilot restart` 即可生效：

```bash
# 编辑配置
vi ~/.loongsuite-pilot/config.json

# 重启生效
loongsuite-pilot restart
```

### 开机自启动

安装时默认自动配置开机自启动，支持 macOS 和 Linux：

| 平台 | 机制 | 配置文件位置 |
|------|------|------------|
| macOS | launchd (LaunchAgents) | `~/Library/LaunchAgents/com.loongsuite-pilot.plist` |
| Linux | systemd user unit | `~/.config/systemd/user/loongsuite-pilot.service` |

均为**用户级**注册，无需 root/sudo 权限。

```bash
# 查看自启动状态
loongsuite-pilot autostart status

# 手动开启/关闭
loongsuite-pilot autostart enable
loongsuite-pilot autostart disable
```

**工作原理**：

- `loongsuite-pilot autostart enable` 会同时注册两个服务：采集器（`loongsuite-pilot run`）和自动更新器（`loongsuite-pilot run-updater`）。`loongsuite-pilot run` 读取 `current` 指针文件动态解析版本目录和 node 路径（兼容 nvm/volta/fnm 等版本管理器）。
- **macOS**：通过 `KeepAlive.SuccessfulExit=false` 实现崩溃自动重启，`RunAtLoad=true` 实现登录自启动。`loongsuite-pilot stop` 正常退出（exit 0）不会触发重启。
- **Linux**：通过 `Restart=on-failure` 实现崩溃自动重启。如需在无登录会话时运行，需要 `loginctl enable-linger`（安装时会自动尝试）。

**注意**：当自启动已开启时，`loongsuite-pilot start/stop` 会自动委托给 launchd/systemd 管理，无需额外操作。

#### 高级：系统级 systemd 守护（可选）

如需系统级守护（root 运行），创建 `/etc/systemd/system/loongsuite-pilot.service`：

```ini
[Unit]
Description=LoongSuite Pilot
After=network.target

[Service]
Type=simple
User=collector
WorkingDirectory=/home/collector/.loongsuite-pilot/package
ExecStart=/usr/bin/node dist/index.js
Environment=AGENT_DATA_COLLECTION_CONFIG=/home/collector/.loongsuite-pilot/config.json
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now loongsuite-pilot
sudo journalctl -u loongsuite-pilot -f
```

### 自动更新

安装后默认开启自动更新。独立的 updater 进程每 4 小时检查一次远端版本，如有新版本会自动下载、部署并重启采集器，无需人工干预。

**架构**：

- **多版本目录**：所有版本安装在 `~/.loongsuite-pilot/versions/<ver>_<commit>/`，通过 `current` 指针文件指向当前版本。
- **独立进程**：updater 作为独立的 Node.js 进程运行（`loongsuite-pilot run-updater`），由 launchd/systemd 单独管理，与采集器主进程完全隔离。
- **固定引导脚本**：`loongsuite-pilot run` 读取 `current` 文件动态加载版本，更新只改 JSON 指针文件，不改服务注册。

**工作流程**：
1. updater 进程定期从 OSS 拉取 `latest.json` 版本清单
2. 与本地 `VERSION` 文件对比 `version` + `git_commit`
3. 如有新版本，下载安装包并解压到 `versions/<new_ver>/`
4. 运行 `npm install` 和 `postinstall.js`
5. 同步引导脚本和 `~/.local/bin/loongsuite-pilot` 命令入口
6. 原子更新 `current` 指针文件，保存旧版本到 `previous`
7. 调用 `loongsuite-pilot restart` 重启采集器（下次启动自动加载新版本）
8. 自动清理旧版本（仅保留 current + previous）

**手动回滚**：

```bash
loongsuite-pilot rollback    # 切换到上一个版本并重启
```

回滚会同步上一版本的引导脚本和 `~/.local/bin/loongsuite-pilot` 命令入口，确保命令脚本与回滚后的版本保持一致。

**配置**（`config.json` 或环境变量）：

```json
{
  "autoUpdate": {
    "enabled": true,
    "checkIntervalMs": 14400000,
    "manifestUrl": "https://bucket.oss.../latest.json",
    "packageUrl": "https://bucket.oss.../loongsuite-pilot.tar.gz"
  }
}
```

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `LOONGSUITE_PILOT_AUTO_UPDATE_ENABLED` | 是否启用自动更新 | `true` |
| `LOONGSUITE_PILOT_AUTO_UPDATE_INTERVAL_MS` | 检查间隔（毫秒） | `14400000` (4h) |
| `LOONGSUITE_PILOT_MANIFEST_URL` | 版本清单 URL | 从 `packageUrl` 推导 |
| `LOONGSUITE_PILOT_PACKAGE_URL` | 安装包 URL | 内置默认 OSS 地址 |

关闭自动更新：

```bash
# 方式一：环境变量
export LOONGSUITE_PILOT_AUTO_UPDATE_ENABLED=false

# 方式二：配置文件
vi ~/.loongsuite-pilot/config.json
# 添加 "autoUpdate": { "enabled": false }

loongsuite-pilot restart
```

## 配置

支持**配置文件**和**环境变量**两种方式，优先级：环境变量 > 配置文件 > 内置默认值。

### 配置文件

默认路径 `~/.loongsuite-pilot/config.json`，可通过 `AGENT_DATA_COLLECTION_CONFIG` 环境变量指定其他路径。

```json
{
  "enabled": true,
  "dataDir": "~/.loongsuite-pilot",
  "userId": "user-123",

  "sls": {
    "enabled": true,
    "batchMaxSize": 20,
    "flushIntervalMs": 2000
  },

  "jsonl": {
    "enabled": true,
    "outputDir": "~/.loongsuite-pilot/logs/output",
    "rotateDaily": true,
    "maxFileSizeMb": 100
  },

  "http": {
    "enabled": true,
    "url": "https://my-report-server.com/api/trace",
    "headers": { "Authorization": "Bearer xxx" },
    "batchMaxSize": 20,
    "flushIntervalMs": 5000,
    "requestTimeoutMs": 10000
  },

  "listeners": {
    "qoder":          { "enabled": true, "pollInterval": 60000 },
    "qoder-work":     { "enabled": true, "pollInterval": 60000 },
    "qoder-cli-hook": { "enabled": true, "pollInterval": 60000 },
    "cursor-hook":    { "enabled": true, "pollInterval": 60000 }
  },

  "agents": {
    "cursor": {
      "captureMessageContent": "true"
    },
    "qoder": {
      "captureMessageContent": "true"
    }
  }
}
```

默认 SLS 上报目的地由程序内置，不通过用户配置文件暴露。旧版本安装产生的 `sls.endpoint`、`sls.project`、`sls.logstore` 字段可以继续留在 `config.json` 中，但普通运行时不再读取这些字段；需要运维覆盖时，请使用 `SLS_ENDPOINT`、`SLS_PROJECT`、`SLS_LOGSTORE` 环境变量或安装脚本的显式 `--sls-*` 参数。

升级提示：如果你曾经通过 `config.json` 自定义 SLS 目的地，请改用环境变量或重新运行安装脚本并显式传入 `--sls-endpoint`、`--sls-project`、`--sls-logstore`。

> AK/SK 等敏感信息建议通过环境变量传入，配置文件中只放非敏感项。

#### 敏感内容上报控制

`agents` 按 `agent.type` 配置内容字段是否上报到输出通道（SLS / JSONL / HTTP）。当前阶段只实现 `captureMessageContent`：

- 默认值为 `true`：上报敏感内容字段。
- 设置为 `"false"` 或 `false`：删除敏感内容字段，但保留模型、token、cost、session、event 等非敏感元数据。

敏感内容字段包括 `input.messages`、`input.messages_delta`、`output.messages`、`tool.arguments`、`tool.result.payload`，以及 legacy 采集链路里的 `content` / `inlineDiffMessage`。

### 环境变量

环境变量会**覆盖**配置文件中的同名字段：

#### 全局控制

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `AGENT_DATA_COLLECTION_CONFIG` | 配置文件路径 | `~/.loongsuite-pilot/config.json` |
| `LOONGSUITE_PILOT_ENABLED` | 总开关 | `true` |
| `LOONGSUITE_PILOT_DATA_DIR` | 数据根目录 | `~/.loongsuite-pilot` |
| `LOONGSUITE_PILOT_DISCOVERY_INTERVAL_MS` | Agent 发现轮询间隔 | `300000` (5min) |
| `LOONGSUITE_PILOT_FORCE_POLLING` | 强制轮询（禁用 fs.watch） | `false` |
| `LOG_LEVEL` | 日志级别 (debug/info/warn/error) | `info` |

#### SLS（阿里云日志服务）

使用 `@alicloud/log` 官方 SDK，AK/SK 同时配置后自动启用：

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `SLS_ACCESS_KEY_ID` | AccessKey ID | 空 |
| `SLS_ACCESS_KEY_SECRET` | AccessKey Secret | 空 |
| `SLS_REGION` | SLS 地域 | `cn-hangzhou` |
| `SLS_PROJECT` | Agent 活动数据 Project | 空 |
| `SLS_LOGSTORE` | Agent 活动数据 Logstore | 空 |
| `SLS_AGENT_TELEMETRY_PROJECT` | Agent 遥测 Project（脱敏） | 空 |
| `SLS_AGENT_TELEMETRY_LOGSTORE` | Agent 遥测 Logstore（脱敏） | 空 |

#### JSONL / HTTP

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `JSONL_ENABLED` | 是否启用 JSONL 输出 | `true` |
| `JSONL_OUTPUT_DIR` | JSONL 文件输出目录 | `~/.loongsuite-pilot/logs/output` |
| `HTTP_REPORT_URL` | HTTP 上报地址（设置后启用） | 空 |
| `HTTP_REPORT_HEADERS` | 自定义请求头 (JSON string) | 空 |

#### 输入源轮询间隔

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `QODER_ANALYTICS_POLL_INTERVAL` | Qoder IDE 采集间隔 (ms) | `60000` |

## 项目结构

```
src/
├── index.ts                             # 主入口 + 默认配置 + 公共导出
├── types/                               # 类型定义层
│   ├── client-type.ts                   #   ClientType / CollectionMethod 枚举
│   ├── events.ts                        #   AgentActivityEntry / SessionRecord 等数据结构
│   └── index.ts                         #   统一导出 + Config 类型
├── utils/                               # 工具函数
│   ├── logger.ts                        #   结构化日志
│   ├── git-resolver.ts                  #   Git 仓库信息解析
│   └── fs-utils.ts                      #   文件系统操作
├── checkpoint/                         # ★ 持久化层（状态管理）
│   ├── snapshot-store.ts                #   快照去重 (pending/processed 状态机)
│   └── state-store.ts                   #   输入源偏移量/游标状态
├── normalization/                       # 归一化层
│   ├── entry-builder.ts                 #   构建统一 AgentActivityEntry + 序列化 + 脱敏
│   └── payload-normalizer.ts            #   HTTP/Hook 原始载荷标准化
├── flushers/                           # 数据输出层 (3 种输出通道)
│   ├── base-flusher.ts                 #   抽象 Flusher 接口
│   ├── sls-flusher.ts                  #   SLS 上报 (批量/健康检查/重试)
│   ├── jsonl-flusher.ts                #   本地 JSONL 文件 (按日轮转)
│   ├── http-flusher.ts                 #   HTTP POST 到外部服务
│   └── multi-flusher.ts               #   多目标扇出
├── inputs/                          # 输入源层
│   ├── base/                            #   ★ 6 种采集方式基类
│   │   ├── base-input.ts            #     根抽象类 (生命周期/定时/事件)
│   │   ├── base-ide-input.ts        #     IDE 历史快照轮询
│   │   ├── base-sqlite-input.ts     #     SQLite 增量轮询
│   │   ├── base-hook-input.ts       #     Hook JSONL 日志
│   │   ├── base-cli-forwarder.ts        #     CLI 遥测日志转发
│   │   └── base-session-input.ts    #     会话文件轮询
│   ├── qoder/                           #   Qoder IDE (快照轮询)
│   ├── qoder-work/                      #   Qoder Work (Hook JSONL)
│   ├── qoder-cli/                       #   Qoder CLI (Hook JSONL)
│   └── cursor-hook/                     #   Cursor Hook (Hook JSONL)
├── core/                                # 核心编排层
│   ├── orchestrator.ts                  #   中枢编排器 (串联所有子系统)
│   ├── input-manager.ts             #   输入源生命周期 + Git 富化 + 分发
│   ├── agent-discovery-service.ts       #   Agent 发现 (fs.watch + 轮询 + 状态机)
│   ├── agent-control-manager.ts         #   Agent 控制 (三层准入策略 on/off/auto)
│   └── config-loader.ts                 #   配置加载 (环境变量 + 配置文件 + 默认值)
├── server/
│   └── http-server.ts                   #   本地 HTTP 服务 (预留，暂未启用)
└── hooks/
    └── hook-manager.ts                  #   Hook 脚本注入/卸载管理
```

## 持久化层（Checkpoint）

持久化层负责在进程重启之间保存采集状态，避免数据重复采集或丢失。包含两个核心组件：

### StateStore - 输入源状态存储

**作用**：保存每个输入源的进度状态，支持增量采集。

**存储位置**：`~/.loongsuite-pilot/logs/input-state.json`

**状态字段**：
```typescript
interface InputState {
  lastOffset?: number;      // 文件读取偏移量（Hook/Session 输入源使用）
  lastRowId?: number;       // SQLite 行 ID（SQLite 输入源使用）
  lastTimestamp?: number;   // 最后处理的时间戳
  highWatermark?: number;   // 高水位线（已处理的最大时间戳）
  extra?: Record<string, unknown>;  // 自定义扩展字段（如文件 inode）
}
```

**使用场景**：
- **Hook JSONL 输入源**：记录文件读取字节偏移，避免重复读取
- **SQLite 输入源**：记录最后查询的 rowid，实现增量查询
- **Session 输入源**：记录文件偏移量和 inode（检测文件替换）
- **CLI Forwarder**：记录遥测日志文件的读取位置

**API 示例**：
```typescript
// 获取/设置偏移量
const offset = stateStore.getOffset('qoder-cli-hook');
stateStore.setOffset('qoder-cli-hook', 1024);

// 获取/设置 rowid
const rowId = stateStore.getRowId('qoder-work');
stateStore.setRowId('qoder-work', 12345);

// 通用状态更新
stateStore.update('my-input', { 
  lastTimestamp: Date.now(),
  extra: { customField: 'value' }
});
```

**工作流程**：
1. **启动时**：从 JSON 文件加载状态到内存（Map）
2. **运行时**：输入源更新状态，标记 dirty
3. **停止时**：仅在 dirty 时写入文件（优化 I/O）

### SnapshotStore - 快照去重存储

**作用**：防止 IDE 历史快照输入源重复处理相同的文件修改事件。

**存储位置**：`~/.loongsuite-pilot/logs/snapshot-store.json`

**核心机制**：基于 `pending/processed` 状态机的去重逻辑。

#### 应用场景：VSCode-style 文件编辑历史快照

Qoder IDE（基于 VSCode 架构）会自动保存用户的文件编辑历史，存储在：

```
~/Library/Application Support/Qoder/User/History/
├── abc12345/
│   └── entries.json    # 记录文件的所有修改快照
├── def67890/
│   └── entries.json
└── ...
```

每个 `entries.json` 的结构：
```json
{
  "resource": "/path/to/original/file.ts",
  "entries": [
    {
      "id": "snapshot-001",
      "timestamp": 1714000000000,
      "source": "Qoder AI Assistant"  // AI 生成的修改
    },
    {
      "id": "snapshot-002",
      "timestamp": 1714000001000,
      "source": "User Manual Edit"     // 用户手动修改（会被过滤）
    }
  ]
}
```

**为什么需要去重？**

输入源定期轮询（例如每 60 秒），但历史快照文件会持久保留在磁盘上：

```
时间线：
T0 (00:00)  → 扫描发现 file.ts@@1714000000000 → 处理并上报
T1 (01:00)  → 再次扫描，同一个快照还在 entries.json 中
              ↓
              如果不去重 → 重复上报！❌
              使用 SnapshotStore → shouldProcess() 返回 false → 跳过 ✅
```

**去重 Key 的构建**：
```typescript
const key = `${event.filePath}@@${event.sourceTimestamp}@@${event.agentType}`;
// 例如："/path/to/file.ts@@1714000000000@@qoder"
```

三元组保证唯一性：
- `filePath`: 文件路径
- `sourceTimestamp`: 快照时间戳
- `agentType`: Agent 类型（qoder/qoder-work 等）

**快照条目结构**：
```typescript
interface SnapshotEntry {
  key: string;           // 唯一键（例如："filePath@@timestamp@@agentType"）
  timestamp: number;     // 事件时间戳
  seenAt: number;        // 首次发现时间（用于过期清理）
  status: 'pending' | 'processed';  // 处理状态
  reason?: string;       // 处理结果说明（可选）
}
```

**去重流程**：
```typescript
// 1. 检查是否应该处理（不存在于存储中）
if (!snapshotStore.shouldProcess(key)) {
  continue;  // 已处理过，跳过
}

// 2. 标记为 pending（开始处理）
snapshotStore.markPending(key, timestamp);

// 3. 处理数据...
const entry = await buildEntry(event);

// 4. 标记为 processed（处理完成）
snapshotStore.markProcessed(key, 'success');
```

**高水位线机制**：
- 自动追踪所有 `processed` 状态的最大时间戳
- 重启时从 `highWatermark` 开始扫描，跳过已处理的数据
- 结合 `retentionMs`（默认 7 天）自动清理过期条目

**API 示例**：
```typescript
// 获取建议的起始时间戳（重启后使用）
const sinceTs = snapshotStore.getSuggestedSinceTimestamp();
// 返回: Math.max(highWatermark, Date.now() - 7天)

// 批量清理过期条目（自动在 flush 时调用）
// 超过 retentionMs 的条目会被删除
```

### 两个 Store 的对比

| 特性 | StateStore | SnapshotStore |
|------|-----------|---------------|
| **用途** | 采集进度跟踪 | 事件去重 |
| **粒度** | 每个输入源一条记录 | 每个事件一条记录 |
| **数据量** | 小（几个 KB） | 较大（随事件增长） |
| **清理策略** | 不清理 | 自动清理过期条目（7天） |
| **使用场景** | Hook/SQLite/Session 采集 | IDE 快照采集 |
| **关键字段** | offset/rowid | key/status/highWatermark |

### 持久化文件示例

**input-state.json**：
```json
{
  "qoder-cli-hook": {
    "lastOffset": 15234
  },
  "cursor-hook": {
    "lastOffset": 9342
  },
  "qoder-work": {
    "lastRowId": 8921
  }
}
```

**snapshot-store.json**：
```json
{
  "highWatermark": 1714000000000,
  "entries": [
    {
      "key": "/path/to/file.ts@@1714000000000@@qoder",
      "timestamp": 1714000000000,
      "seenAt": 1714000100000,
      "status": "processed",
      "reason": "success"
    }
  ]
}
```

## 采集方式与对应基类

| 采集方式 | 基类 | 原理 | 示例 Agent |
|---------|------|------|-----------|
| IDE 历史快照轮询 | `BaseIdeInput` | 定时读取 IDE 本地 DiskKV/历史文件 | Qoder |
| SQLite 增量轮询 | `BaseSqliteInput` | 增量查询本地 SQLite (rowid 游标) | Qoder Work |
| Hook JSONL 日志 | `BaseHookInput` | 注入 Hook 脚本拦截事件，读 JSONL | Qoder CLI / Cursor Hook |
| CLI 遥测日志转发 | `BaseCliForwarder` | 配置 Agent 遥测输出到文件，轮询转发 | (Gemini 模式) |
| 会话文件轮询 | `BaseSessionInput` | 读取 JSONL/JSON 会话记录文件 | — |

## 数据输出

系统通过 `MultiFlusher` 同时输出到多个目标：

| 输出通道 | 类 | 说明 |
|---------|---|------|
| SLS | `SlsFlusher` | 阿里云日志服务，批量(20条/2秒)，健康检查，失败重试 |
| JSONL | `JsonlFlusher` | 本地文件，按 `{clientType}-{YYYY-MM-DD}.jsonl` 轮转 |
| HTTP | `HttpFlusher` | POST 到指定服务，批量发送，自动重试 |

## 扩展指南

### 新增一个 Agent

添加一个新的 AI Agent 采集只需 **3 步**：

#### 场景 A：数据格式一致（使用现有基类）

如果新 Agent 的数据格式与现有采集方式匹配（如 JSONL 会话文件、SQLite、Hook JSONL 等），直接参考下面的 3 步即可。

#### 场景 B：数据格式不一致（需要自定义归一化）

如果新 Agent 的数据格式特殊，需要额外的转换逻辑，需要添加以下文件：

```
src/
├── inputs/
│   └── my-new-agent/
│       └── my-new-agent-input.ts      # ① 实现 Input（数据采集）
├── normalization/
│   └── my-new-agent-normalizer.ts         # ② 自定义归一化器（数据格式转换）
└── types/
    └── my-new-agent-types.ts              # ③ 类型定义（可选，如数据结构复杂）
```

**步骤说明：**

1. **创建 Input**（必须）
   - 选择合适的基类继承（或直接从 `BaseInput` 继承）
   - 实现数据采集逻辑，返回原始数据
   
2. **创建归一化器**（数据格式不一致时必须）
   ```typescript
   // src/normalization/my-new-agent-normalizer.ts
   import type { AgentActivityEntry } from '../types/index.js';
   import { buildAgentActivityEntry } from './entry-builder.js';
   
   export interface RawMyNewAgentPayload {
     // 定义新 Agent 的原始数据格式
     session_id: string;
     event_type: string;
     // ... 其他字段
   }
   
   export function normalizeMyNewAgentPayload(
     payload: RawMyNewAgentPayload,
   ): AgentActivityEntry {
     // 将特殊格式转换为标准的 AgentActivityEntry
     return buildAgentActivityEntry({
       sessionId: payload.session_id,
       userId: '',
       agentType: ClientType.MyNewAgent,
       actionType: normalizeActionType(payload.event_type),
       filePath: extractFilePath(payload),
       content: extractContent(payload),
       // ... 其他字段映射
     });
   }
   ```

3. **在 Input 中使用归一化器**
   ```typescript
   // src/inputs/my-new-agent/my-new-agent-input.ts
   import { normalizeMyNewAgentPayload } from '../../normalization/my-new-agent-normalizer.js';
   
   // 在数据处理时调用
   const entry = normalizeMyNewAgentPayload(rawData);
   ```

4. **类型定义**（可选）
   - 如果数据结构复杂，建议在 `types/` 下单独定义
   - 简单结构可以直接写在 input 或 normalizer 中

#### 第 1 步：声明 ClientType

在 `src/types/client-type.ts` 的 `ClientType` 枚举中添加：

```typescript
export enum ClientType {
  // ... existing ...
  MyNewAgent = 'my-new-agent',
}
```

#### 第 2 步：实现 Input

选择合适的基类，实现少量抽象方法。例如，若新 Agent 产生 JSONL 会话文件：

```typescript
// src/inputs/my-new-agent/my-new-agent-input.ts
import { ClientType } from '../../types/index.js';
import { BaseSessionInput, type SessionInputOptions } from '../base/base-session-input.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';

export class MyNewAgentInput extends BaseSessionInput {
  readonly id = 'my-new-agent';
  readonly clientType = ClientType.MyNewAgent;

  constructor(opts: { stateStore: SessionInputOptions['stateStore'] }) {
    super({
      stateStore: opts.stateStore,
      sessionDir: resolveHome('~/.my-new-agent/sessions'),
      filePattern: 'session-*.jsonl',
      pollIntervalMs: 30_000,
    });
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.my-new-agent'));
  }

  static getWatchPaths(): string[] {
    return [resolveHome('~/.my-new-agent')];
  }

  protected async discoverSessionFiles(): Promise<string[]> {
    // 返回要扫描的文件路径列表
  }

  protected async processSessionLine(
    record: Record<string, unknown>,
    filePath: string,
  ): Promise<AgentActivityEntry | null> {
    // 将一条 JSON 记录转换为 AgentActivityEntry，无关事件返回 null
  }
}
```

每个基类只需实现 2-3 个抽象方法：

| 基类 | 需要实现的方法 |
|------|--------------|
| `BaseIdeInput` | `scanHistoryEntries()`, `buildEntry()` |
| `BaseSqliteInput` | `readNewRows()`, `transformRow()` |
| `BaseHookInput` | `transformRecord()` |
| `BaseCliForwarder` | `isRelevantEvent()`, `transformPayload()` |
| `BaseSessionInput` | `discoverSessionFiles()`, `processSessionLine()` |

#### 第 3 步：注册到 Orchestrator

在 `src/core/orchestrator.ts` 的 `registerAllInputs()` 方法中添加：

```typescript
import { MyNewAgentInput } from '../inputs/my-new-agent/my-new-agent-input.js';

// 在 registerAllInputs() 中:
const myInput = new MyNewAgentInput({ stateStore: this.stateStore });
this.inputManager.registerInput(myInput);
entries.push(
  this.inputManager.buildDetectionEntry(myInput, {
    watchPaths: MyNewAgentInput.getWatchPaths(),
    isAvailable: MyNewAgentInput.checkAvailability,
    enabled: () => this.agentControlManager.resolveEnabled('my-new-agent', true),
  }),
);
```

完成后重新编译即可。系统会自动发现 Agent 安装、管理生命周期、输出到所有已配置的目标。

### 新增输出通道

继承 `BaseFlusher` 并实现 `send` / `sendBatch` / `flush` / `shutdown`，然后在 `orchestrator.ts` 的 `buildFlusher()` 中添加到 flushers 数组。

### 调整准入策略

编辑 `~/.loongsuite-pilot/agent-control.json` 文件：

```json
{
  "version": 3,
  "tools": {
    "qoder": "auto",
    "qoder-work": "on",
    "qoder-cli-hook": "off",
    "cursor-hook": "auto"
  }
}
```

模式说明：
- `"on"` - 强制启用
- `"off"` - 强制禁用
- `"auto"` - 自动检测（默认）

## 使用 Spec Kit 添加新 Agent（推荐流程）

本项目使用 [Spec Kit](https://github.com/nicholasgriffintn/speckit) 进行文档驱动开发。添加新 Agent 时，推荐按照以下标准化流程，从规格定义到实现逐步推进。

### 1. 安装 Spec Kit

Spec Kit 通过 Cursor IDE 的 Skills 机制集成，本仓库已包含所有必要的 skill 文件（`.cursor/skills/speckit-*/`）和配置（`.specify/`），无需额外安装。

如果是全新项目，可通过 npx 初始化：

```bash
npx speckit init --ai cursor-agent --script sh
```

初始化后生成的目录结构：

```
.specify/
├── memory/constitution.md    # 项目宪法（质量标准）
├── templates/                # spec/plan/tasks 模板
├── extensions.yml            # Git 等扩展钩子
└── workflows/                # 工作流注册
.cursor/
├── rules/specify-rules.mdc   # Cursor Agent 上下文规则
└── skills/speckit-*/SKILL.md  # 各 speckit 命令的 skill 定义
```

### 2. 创建 Agent Spec（规格说明）

在 Cursor 中使用 `/speckit-specify` 命令创建新 Agent 的规格文档。

**操作步骤**：

1. 在 `specs/` 下创建新目录，编号规则为 `1xx-agent-{name}`（101 起步，已有 101-104）：

```
specs/
├── 001-platform-base/        # 平台基础设施（已有）
├── 101-agent-qoder/          # Qoder IDE（已有）
├── 102-agent-qoder-work/     # Qoder Work（已有）
├── 103-agent-qoder-cli/      # Qoder CLI（已有）
└── 1xx-agent-my-new/         # ← 新 Agent
    └── spec.md
```

2. 在 Cursor 中输入命令：

```
/speckit-specify 新 Agent 名称及描述
```

**Spec 编写要点**：

spec.md 应包含以下章节，可参考 `specs/101-agent-qoder/spec.md` 的格式：

```markdown
# 功能规格说明：My New Agent

**功能分支**: `105-agent-my-new`
**创建日期**: 2026-xx-xx
**状态**: Draft
**依赖**: `001-platform-base`（输入源框架、持久化层、归一化层）

## 概述

描述 Agent 的类型、数据源、采集方式。以表格形式列出：

| 数据源 | 采集基类 | 数据格式 | 游标类型 |
|--------|---------|---------|---------|
| 会话文件 | BaseSessionInput | JSONL | StateStore (byte offset) |

## 用户场景与测试

### 用户故事 1 — 采集 xxx 数据（优先级：P1）

作为平台运维人员，我需要系统从 xxx 中采集 yyy 数据。

**验收标准**:
1. 系统定期扫描指定目录下的文件
2. 仅处理符合条件的事件记录
3. 正确分类 actionType（Create / Edit / ...）
4. 偏移量持久化，重启后增量读取
5. 异常记录跳过不中断采集

## 功能需求

- FR-001: 系统必须支持从 xxx 路径读取数据
- FR-002: ...

## 关键实体

描述数据流中的核心对象和字段映射关系。

## 成功标准

- 单元测试覆盖率 ≥ 80%
- 重启后无重复采集
- 异常文件不中断全局采集

## 范围外

明确列出不在本次迭代范围内的功能。

## 假设与依赖

- 依赖 `001-platform-base` 提供的基类和基础设施
- 目标 Agent 已安装在用户机器上
```

### 3. 规格评审与澄清

Spec 编写完成后，使用以下命令进行质量检查：

```
/speckit-checklist    # 生成规格质量检查清单
/speckit-clarify      # 识别规格中的模糊点，提出澄清问题
/speckit-analyze      # 跨文档一致性分析
```

确保所有检查项通过后再进入下一步。

### 4. 生成实现计划

```
/speckit-plan
```

该命令会读取 spec.md，结合项目宪法（constitution.md），生成：

- `plan.md` — 技术上下文、宪法合规检查、项目结构
- `research.md` — 技术决策和约束研究
- `data-model.md` — 数据模型定义
- `contracts/` — API 和行为契约
- `quickstart.md` — 快速上手指南

### 5. 生成任务清单

```
/speckit-tasks
```

基于 plan.md 和 spec.md 自动生成 `tasks.md`，包含：

- 分阶段的实现任务（Setup → Tests → Core → Integration → Polish）
- 每个任务的文件路径、依赖关系、并行标记 `[P]`
- TDD 顺序：先写测试，再写实现

### 6. 执行实现

```
/speckit-implement
```

按 tasks.md 中的任务清单逐项执行：

1. 在 `src/types/client-type.ts` 添加新的 `ClientType` 枚举值
2. 在 `src/inputs/{agent-name}/` 创建 Input 类（继承合适的基类）
3. 在 `src/core/orchestrator.ts` 的 `registerAllInputs()` 中注册
4. 编写单元测试和集成测试
5. 验证覆盖率达标

### 7. 完整命令速查

| 阶段 | 命令 | 产出 |
|------|------|------|
| 宪法 | `/speckit-constitution` | `constitution.md` |
| 规格 | `/speckit-specify` | `spec.md` |
| 检查 | `/speckit-checklist` | `checklists/*.md` |
| 澄清 | `/speckit-clarify` | spec.md 更新 |
| 分析 | `/speckit-analyze` | 一致性报告 |
| 计划 | `/speckit-plan` | `plan.md` + 设计文档 |
| 任务 | `/speckit-tasks` | `tasks.md` |
| 实现 | `/speckit-implement` | 源码 + 测试 |
| 提交 | `/speckit-git-commit` | Git commit |

### 8. 示例：从零添加一个 Session 文件类型的 Agent

```bash
# 1. 创建 spec 目录
mkdir -p specs/105-agent-example

# 2. 在 Cursor 中执行
/speckit-specify Example Agent — 从 ~/.example-agent/sessions/ 目录采集 JSONL 会话文件，
  提取 tool_call 类型事件，根据 tool_name 分类 actionType

# 3. 检查规格质量
/speckit-checklist

# 4. 生成计划和任务
/speckit-plan
/speckit-tasks

# 5. 执行实现（自动创建文件、编写测试）
/speckit-implement
```

实现完成后，你的新 Agent 将自动获得：

- 自动发现（`AgentDiscoveryService` 监控安装状态）
- 增量采集（`StateStore` 持久化偏移量）
- 多目标输出（SLS / JSONL / HTTP 同时输出）
- 准入控制（`AgentControlManager` 的 on/off/auto 三级模式）
- 优雅关闭（`Orchestrator` 统一管理生命周期）

## 集成 OTel Agent 插件（Trace → Event 采集）

> 本章节基于已落地的 `opentelemetry-instrumentation-claude` 与 `opentelemetry-instrumentation-codex` 两个插件的实战经验整理，给新插件作者一份可照抄的接入指引。

### 背景与数据流

许多 AI Agent 可观测插件仅原生支持 OTel Trace 采集；loongsuite-pilot 提供互补的事件级通道：插件以 hook 触发把每轮对话事件写入本地 JSONL 文件，pilot 增量读取、归一化、扇出到 SLS/JSONL/HTTP。

```
Agent CLI ─hook─► <plugin>-hook ─解析 transcript / 进程内拦截─► JSONL (event_t schema)
                                                                    │
                                                                    ▼
                  pilot BaseHookInput ─▶ AgentActivityEntry ─▶ MultiFlusher (SLS / JSONL / HTTP)
```

参考实现：claude 插件双路径（transcript + intercept.js），codex 插件单路径（仅 transcript）。详见 `context/claude-code-plugin-context.md` / `context/codex-plugin-context.md`。

### 7.1 插件侧契约

#### 7.1.1 JSONL 输出 schema

每行一个 JSON，字段遵循 [AI Agent EventSchema（event_t）](https://code.alibaba-inc.com/yt348264/ai-agent-audit/blob/main/docs/guide/architecture.md)。

- **event.name 枚举**：`llm.request` / `llm.response` / `tool.call` / `tool.result`
- **必填字段**：`time_unix_nano`、`event.id`、`event.name`、`session.id`、`user.id`、`agent.type`
- **文件命名**：必须匹配 `{prefix}-{YYYY-MM-DD}.jsonl`（pilot 的 `BaseHookInput` 按这个 glob 发现文件）
- **`agent.type`**：每个插件用唯一标识，例如 `"claude-code"` / `"codex"`，pilot Input 用它路由

#### 7.1.2 配置文件 `~/.<agent>/otel-config.json`

插件与 pilot 通过这个共享文件协商。约定字段：

```jsonc
{
  "log_enabled": true,                              // pilot 强制设为 true
  "log_dir": "~/.loongsuite-pilot/logs/<agent>",    // pilot 写入；插件不要硬编码
  "log_filename_format": "hook",                    // 决定文件名前缀
  "otlp_endpoint": "",                              // 用户可选；与 log 模式互不冲突
  "debug": false
}
```

- **环境变量 fallback**：每个字段都要支持环境变量覆盖（如 `OTEL_EXPORTER_OTLP_ENDPOINT`）
- **DEBUG 环境变量命名**：用 `<AGENT>_TELEMETRY_DEBUG`，避免和 `CLAUDE_TELEMETRY_DEBUG` 撞车

#### 7.1.3 install / uninstall 命令参数约定

pilot 安装脚本会调用 `<plugin>-hook install`，插件需支持以下参数：

| 参数 | 用途 | 必须支持 |
|---|---|---|
| `--quiet` | 抑制非错误 stderr，避免污染 pilot 日志 | ✅ |
| `--user` | 仅修改用户级配置，不动系统级 | 推荐 |
| `--no-alias` | 不写 shell profile（避免 pilot 场景下重复污染 .zshrc） | claude 类插件需要 |

`uninstall` 应当幂等且不依赖 `install` 时的状态文件。

#### 7.1.4 Hook trust 机制（按需）

如果目标 agent 启用了 hook trust（如 codex >= 2026-04-22 stable hooks），插件 install 时必须**在目标机器动态计算** trust hash 并写入 agent 配置文件——hash 包含绝对路径，**不能在打包时预计算**。详见 `codex-plugin-context.md` 第 4.2 / 9.4 节。

### 7.2 pilot 侧 Input 实现

继承 `BaseHookInput`，实现 3 个方法：

| 方法 | 职责 |
|---|---|
| `transformRecord(record)` | event_t 字段 → `AgentActivityEntry`（event.name → ActionType，抽 content/filePath） |
| `static checkAvailability()` | 检测日志目录是否存在 |
| `static getWatchPaths()` | 返回 fs.watch 的目录列表 |

参考实现：

- `src/inputs/claude-code-log/claude-code-log-input.ts`
- `src/inputs/codex-log/codex-log-input.ts`

在 `src/core/orchestrator.ts` 的 `registerAllInputs()` 注册即可。

### 7.3 部署链路

#### 7.3.1 目录与产物约定

| 路径 | 作用 |
|---|---|
| `loongsuite-pilot/plugins/<plugin>.tar.gz` | 仓库内同步的插件 tarball（CI 上传 OSS 时一并发布） |
| `~/.loongsuite-pilot/plugins/<plugin>/` | 安装后解压目录 |
| `~/.loongsuite-pilot/logs/<agent>/` | 插件输出 JSONL 的目录（pilot 创建并写入 `otel-config.json`） |
| `~/.<agent>/otel-config.json` | 双方共享配置文件 |

插件 `scripts/pack.sh` 把 `dist/` + `package.json` + `bin/` 打包到 `<plugin>.tar.gz`，**不打 node_modules**（pilot 安装时跑 `npm install --silent`）。

#### 7.3.2 `_install_plugin` 的两段式模式 ⚠️ 必须

pilot installer 中调用插件的统一函数。**关键设计**：解压重装与 hook 注册必须分离，否则重装 pilot 时 hooks 会丢失。

```bash
_install_plugin() {
    local plugin_label="$1" tarball_name="$2" dest_dir="$3" hook_cmd="$4"
    local hook_install_args="$5"   # 例: "--user --no-alias --quiet"
    local tarball_path="$PERMANENT_DIR/plugins/$tarball_name"

    # ── Phase 1: 解压重装（每次都做；如要做版本对比可在此加 if）──
    if [ -f "$tarball_path" ]; then
        rm -rf "$dest_dir" && mkdir -p "$dest_dir"
        tar -xzf "$tarball_path" -C "$dest_dir"
        ( cd "$dest_dir" && "$NPM_BIN" install --silent ) || return 0  # 失败不阻塞
    else
        return 0
    fi

    # ── Phase 2: 始终调用 install（幂等注册 hooks）──
    if [ -f "$dest_dir/bin/$hook_cmd" ]; then
        "$NODE_BIN" "$dest_dir/bin/$hook_cmd" install $hook_install_args 2>/dev/null || true
    fi
}
```

**调用时必须用 `||` 隔离失败**，否则插件失败会让整个 pilot 安装在 `set -e` 下崩掉：

```bash
install_otel_plugin || msg "  ⚠️  插件安装异常（不影响核心功能）"
```

#### 7.3.3 `otel-config.json` 协商写法

pilot 不能直接覆盖文件（用户可能配过 OTLP endpoint）。固定用 Node 内嵌脚本做合并：

```bash
"$NODE_BIN" -e "
const fs = require('fs');
const cfgPath = process.argv[1], logDir = process.argv[2];
let existing = {};
try { existing = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); } catch {}
existing.log_enabled = true;                                  // 强制启用
if (existing.log_dir === undefined || existing.log_dir === '') existing.log_dir = logDir;
if (existing.log_filename_format === undefined) existing.log_filename_format = 'hook';
fs.writeFileSync(cfgPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
" "$HOME/.<agent>/otel-config.json" "$DATA_DIR/logs/<agent>"
```

#### 7.3.4 卸载链路

主路径调用 `<plugin>-hook uninstall`。**fallback 路径**(插件文件已损坏/旧版本无 uninstall)：deploy 脚本必须自行手动清理，常见步骤：

1. 从 agent 配置文件（`settings.json` / `hooks.json`）中过滤含 `<plugin>-hook` 或 `hook-entry.sh` 的条目
2. 从 TOML 类配置（`config.toml`）按 BEGIN/END marker 删除插件写入段
3. 删 shell profile 中的 alias / env block（如适用）
4. 删缓存目录 `~/.cache/opentelemetry.instrumentation.<agent>/`

参考 `deploy/loongsuite-pilot-installer-inner.sh` 中 Claude/Codex 的卸载段。

### 7.4 已知陷阱

按已踩过的坑严重度排序：

1. **`_install_plugin` 用 marker 文件 early return 会丢 hooks**（claude context 7.4）— Phase 1/2 必须分离，Phase 2 始终跑 `install`。
2. **`hook-entry.sh` 硬编码绝对路径在远程开发机会 MODULE_NOT_FOUND**（claude context 7.3）— 模板要做相对路径优先 + 绝对路径 fallback + 找不到时 `exit 0`。
3. **`cat >> shell_profile` 会吞掉用户最后一行**（claude context 7.2）— 写入前用 `[ "$(tail -c1 "$f" | wc -l)" -eq 0 ] && echo "" >> "$f"` 保证尾部换行。
4. **TOML duplicate key 启动失败**（codex context 9.4）— 重写带表头的 trust state 块前必须先清掉同表头的旧"裸"段，不能光删 BEGIN/END marker 包裹的部分。
5. **agent 自身 feature flag 升级会让 install 写入失效或冗余**（codex context 9.4）— 写 `[features]` 字段前先确认 agent 当前版本是否还需要；若 default_enabled 已开，不要强写。
6. **agent 显式禁用功能不能被插件静默覆盖**（codex `hooks = false` 案例）— 检测到要改时必须 stderr 警告并告知影响范围。
7. **空 endpoint 环境变量比未设置更糟**（codex 常见问题）— `OTEL_EXPORTER_OTLP_ENDPOINT=""` 会让插件初始化报错；插件应当把空字符串视同未设置。

### 7.5 验证清单

- [ ] 运行 Agent CLI 产生事件 → JSONL 文件按日期生成，schema 符合 event_t
- [ ] `loongsuite-pilot status` 显示 Input 已注册，无 startup 异常
- [ ] 重启 pilot 后能从 `lastOffset` 增量继续（不重复采集）
- [ ] `loongsuite-pilot uninstall` 后 agent 配置文件干净，无插件残留
- [ ] 重新 `install` → `uninstall` → `install` 三轮幂等无副作用

## License

Private / Internal Use
