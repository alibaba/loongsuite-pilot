# LoongSuite-Pilot E2E 远程测试完整操作指南

本文档详细说明如何在远程开发机上执行各类 E2E 测试场景，包括部署测试、自动升级测试等。

---

## 📋 前置条件

### 1. 本地环境准备

```bash
# 克隆项目（如果尚未在 sensen/feat-e2e-test 分支）
git checkout sensen/feat-e2e-test

# 安装依赖
npm install

# 确认 Node.js 版本 >= 18
node -v
```

### 2. 远程机器要求

- **操作系统**：Linux 7U/8U、macOS（均可）
- **SSH 访问**：能通过 SSH 登录（推荐密钥认证，密码认证也可但需设置 `E2E_SSH_PASSWORD_AUTH=1`）
- **网络**：能访问 OSS（下载安装包）和 SLS（上报数据）
- **权限**：普通用户即可（部分场景需要 sudo 配置自启或 reboot）

### 3. SLS 控制台准备

- 拥有 SLS Project 和 Logstore
- 知道 AK/SK（如需自定义 SLS 端点）

---

## 🚀 场景 1：首次安装冒烟测试（install-smoke）

**目标**：验证 LoongSuite-Pilot 能在远程机器上成功安装并采集 Agent 数据。

### 操作步骤

```bash
# 1. 设置 SSH 目标
export E2E_SSH_TARGET='your-user@remote-host'
# 或使用分开的变量
# export E2E_SSH_USER='your-user'
# export E2E_SSH_HOST='remote-host'

# 2. 设置用户 ID（你的工号）
export E2E_USER_ID='your-employee-id'

# 3. 选择场景
export E2E_SCENARIO=install-smoke

# 4. （可选）自定义 SLS 配置
export E2E_SLS_PROJECT='your-sls-project'
export E2E_SLS_LOGSTORE='your-sls-logstore'
export E2E_SLS_ENDPOINT='https://cn-hangzhou.log.aliyuncs.com'
export E2E_SLS_ACCESS_KEY_ID='your-ak'
export E2E_SLS_ACCESS_KEY_SECRET='your-sk'

# 5. （可选）启用 Agent 矩阵探针（安装 Cursor/Claude/Codex/Qoder CLI 并执行测试）
export E2E_USE_MATRIX_PROBE=1

# 6. 如果需要安装 Agent CLI，设置对应的 API Key
export E2E_WRITE_REMOTE_CODEX_CONFIG=1
export E2E_CODEX_OPENAI_API_KEY='dashscope-api-key'
export E2E_CLAUDE_BAILIAN=1
export E2E_CLAUDE_BAILIAN_API_KEY='bailian-api-key'
export E2E_WRITE_REMOTE_CLAUDE_ONBOARDING_SKIP=1
export E2E_QODER_PERSONAL_ACCESS_TOKEN='qoder-pat-token'

# 7. 执行测试
npm run test:e2e:remote
```

### 预期结果

- ✅ SSH 连接成功
- ✅ pilot 安装成功（`~/.loongsuite-pilot` 目录创建）
- ✅ `loongsuite-pilot` 命令可用
- ✅ 如果启用了矩阵探针，会安装并执行 Codex/Claude/Cursor/Qoder CLI 的探针
- ✅ SLS 控制台能看到对应 Agent 的数据

### 验证 SLS 数据

登录 SLS 控制台 → 选择 Project/Logstore → 执行查询：

```sql
* | select "gen_ai.agent.type", "event.name", count(*) as cnt group by "gen_ai.agent.type", "event.name"
```

---

## 🔄 场景 2：卸载测试（uninstall）

**目标**：验证 pilot 能完整卸载，不留残留。

### 操作步骤

```bash
export E2E_SSH_TARGET='your-user@remote-host'
export E2E_SCENARIO=uninstall

npm run test:e2e:remote
```

### 预期结果

- ✅ `~/.loongsuite-pilot` 目录被删除（如果未加 `--purge`，config 会保留）
- ✅ `loongsuite-pilot` 命令从 PATH 中移除
- ✅ systemd/launchd 服务单元被删除

### 手动验证

```bash
# SSH 到远程机器
ssh your-user@remote-host

# 检查是否还有残留
ls -la ~/.loongsuite-pilot 2>&1  # 应该报 No such file
which loongsuite-pilot 2>&1      # 应该报 not found
systemctl --user list-units | grep loongsuite-pilot  # 应该为空
```

---

## 🔌 场景 3：重启后自动拉起测试（reboot-autostart）

**目标**：验证系统重启后 pilot 能通过 systemd/launchd 自动启动。

### ✅ 前置条件：配置免密 sudo（一次性）

SSH 非交互模式下 sudo 无法读取密码，**必须在远端机器配置免密 sudo**：

```bash
# 登录远端机器（仅首次需要）
ssh your-user@remote-host

# 添加免密 reboot 权限（范围最小化）
echo "$USER ALL=(ALL) NOPASSWD: /sbin/reboot, /usr/sbin/reboot" | sudo tee /etc/sudoers.d/loongsuite-pilot-e2e
sudo chmod 440 /etc/sudoers.d/loongsuite-pilot-e2e

# 验证（应直接返回，无密码提示）
sudo -n /sbin/reboot --help >/dev/null && echo "✓ passwordless sudo reboot OK"
exit
```

### ⚠️ 重要说明

此场景分**两个阶段**，需要**两次 SSH 执行**：

1. **阶段 1**：安装 pilot → **自动触发重启**（脚本异步调度 reboot + 主动 exit 0）
2. **阶段 2**：等待 ~30s 机器恢复 → SSH 登录 → 验证自启

### 操作步骤

#### 阶段 1：安装并自动触发重启

```bash
export E2E_SSH_TARGET='your-user@remote-host'
export E2E_USER_ID='your-employee-id'
export E2E_SCENARIO=reboot-autostart
export E2E_SSH_PASSWORD_AUTH=1   # 若使用密码登录 SSH

npm run test:e2e:remote
```

**脚本行为**（全自动，无需人工介入）：
1. 安装 pilot 并验证服务状态（systemd user/system-level / launchd / pgrep 四级检测）
2. 写入重启标记文件 `~/.loongsuite-pilot/.e2e-reboot-marker`
3. 通过 `nohup bash -c 'sleep 1 && sudo reboot' &` + `disown` **异步**触发 reboot
4. 脚本主动 `exit 0`，让 SSH 在远端 sshd 被 kill 前优雅关闭
5. 本地 runner 双重保险：即使得到 `Connection reset by peer`，只要匹配到 `Reboot scheduled` 或 SSH 断开标志，仍视为成功

**预期输出**：

```
✓ Marker written: /home/xxx/.loongsuite-pilot/.e2e-reboot-marker
=== Phase 4: Triggering reboot (SSH will disconnect — this is EXPECTED) ===
ℹ  'Connection reset by peer' / 'Broken pipe' is normal: remote sshd is killed during reboot.
✓ Reboot scheduled (will fire in ~1 second)
[e2e] reboot-autostart: remote reboot triggered (SSH disconnect is EXPECTED).
ℹ  Wait ~30s for the host to come back online, then run:
    export E2E_SCENARIO=post-reboot-verify
    npm run test:e2e:remote
```

**等待 30 秒到 1 分钟**让机器完成重启。

#### 阶段 2：重启后验证

```bash
export E2E_SSH_TARGET='your-user@remote-host'
export E2E_SCENARIO=post-reboot-verify

npm run test:e2e:remote
```

### 预期结果

- ✅ 重启标记文件存在（证明是同一台机器）
- ✅ `loongsuite-pilot` 命令可用
- ✅ systemd unit `loongsuite-pilot.service` 状态为 `active`（可能是 system-level 或 user-level）
- ✅ pilot 进程正在运行
- ✅ `~/.loongsuite-pilot` 数据目录完整

### 手动验证

```bash
ssh your-user@remote-host

# 检查标记文件
cat ~/.loongsuite-pilot/.e2e-reboot-marker

# 检查服务状态（先试 system-level，再试 user-level）
systemctl is-active loongsuite-pilot.service    # system-level
systemctl --user is-active loongsuite-pilot.service  # user-level

# 检查进程
ps aux | grep loongsuite-pilot | grep -v grep

# 检查日志（自适应 system/user level）
journalctl -u loongsuite-pilot.service --since "10 minutes ago" | tail -50 2>/dev/null || \
  journalctl --user -u loongsuite-pilot.service --since "10 minutes ago" | tail -50
```

---

## 👥 场景 4：单机器多账号安装（multi-account）

**目标**：验证同一台机器上可以为多个用户分别安装 pilot，互不干扰。

### 操作步骤

```bash
export E2E_SSH_TARGET='your-user@remote-host'
export E2E_USER_IDS='user-id-1,user-id-2,user-id-3'
export E2E_SCENARIO=multi-account

npm run test:e2e:remote
```

### 脚本行为

1. 解析逗号分隔的用户 ID 列表
2. 对每个用户：
   - 尝试创建 `user0`, `user1`, `user2` 等系统用户（需要 sudo）
   - 如果无法创建用户，则在当前用户下使用隔离目录 `~/.loongsuite-pilot-test-user0`
   - 执行 pilot 安装，配置对应的 `userId`
3. 验证所有安装是否成功

### 预期结果

- ✅ 每个用户都有独立的 `~/.loongsuite-pilot` 目录
- ✅ 每个用户的 `config.json` 中 `userId` 不同
- ✅ 各用户的 pilot 服务独立运行（如果都启用了 systemd）

### 验证多账号隔离

```bash
ssh your-user@remote-host

# 检查各用户目录
sudo ls -la /home/user0/.loongsuite-pilot/config.json
sudo ls -la /home/user1/.loongsuite-pilot/config.json

# 查看各用户的 userId 配置
sudo cat /home/user0/.loongsuite-pilot/config.json | grep userId
sudo cat /home/user1/.loongsuite-pilot/config.json | grep userId

# 如果是在当前用户下隔离安装
ls -la ~/.loongsuite-pilot-test-user0/config.json
cat ~/.loongsuite-pilot-test-user0/config.json | grep userId
```

---

## ⬆️ 场景 5：自动升级测试（auto-upgrade）

**目标**：验证 pilot 安装后，执行 `upgrade` 命令能成功升级到最新版本，且服务自动重启、配置保留。

### 操作步骤

```bash
export E2E_SSH_TARGET='your-user@remote-host'
export E2E_USER_ID='your-employee-id'
export E2E_SCENARIO=auto-upgrade

npm run test:e2e:remote
```

### 脚本行为（6 个阶段）

1. **Phase 1**：初始安装 pilot
2. **Phase 2**：验证初始服务运行，记录当前版本和 git commit
3. **Phase 3**：触发升级（`curl installer | bash -s -- upgrade`）
4. **Phase 4**：等待 10 秒后验证新版本
5. **Phase 5**：验证服务自动重启
6. **Phase 6**：验证数据完整性（config.json 保留、versions 目录存在）

### 预期结果

- ✅ 初始安装成功
- ✅ 升级命令执行成功
- ✅ 版本号/commit 发生变化（如果不是最新版会提示）
- ✅ 升级后服务自动重启并处于 active 状态
- ✅ `config.json` 配置未丢失
- ✅ `~/.loongsuite-pilot/versions/` 目录存在多版本管理

### 手动验证升级细节

```bash
ssh your-user@remote-host

# 查看当前版本（info 命令；`version` 命令不存在）
loongsuite-pilot info

# 查看 VERSION 文件
cat ~/.loongsuite-pilot/VERSION

# 查看多版本目录
ls -la ~/.loongsuite-pilot/versions/

# 查看 current 指针
cat ~/.loongsuite-pilot/current

# 查看 previous 指针（用于回滚）
cat ~/.loongsuite-pilot/previous

# 验证服务状态（先试 system-level，再试 user-level）
systemctl status loongsuite-pilot.service 2>/dev/null || \
  systemctl --user status loongsuite-pilot.service

# 查看升级相关日志
journalctl -u loongsuite-pilot.service --since "5 minutes ago" | tail -50 2>/dev/null || \
  journalctl --user -u loongsuite-pilot.service --since "5 minutes ago" | tail -50
```

### 测试版本回滚（可选）

```bash
# 如果升级后有问题，可以手动回滚到 previous 版本
loongsuite-pilot rollback

# 验证回滚后的版本
loongsuite-pilot info

# 验证服务重启
systemctl status loongsuite-pilot.service 2>/dev/null || \
  systemctl --user status loongsuite-pilot.service
```

---

## 🔢 场景 5.5：Agent 版本矩阵测试（version-matrix）

**目标**：验证 pilot 对每个 npm 渠道 Agent（Codex / Claude Code / Qoder）的**最近 N 个历史版本**都能正常采集数据。

### 前置条件

1. 远端已跑过 `install-smoke` 并成功（pilot + hook 已就位）
2. 远端可访问 npm registry（会跳 `npm view <pkg> versions --json`）

### 操作步骤

```bash
export E2E_SSH_TARGET='your-user@remote-host'
export E2E_SCENARIO=version-matrix

# 每个 agent 跑最近几个版本（默认 3）
export E2E_AGENT_VERSIONS_N=3

# 可选：只测指定 agent（binary 或 id，逗号分隔）
# export E2E_AGENT_VERSIONS_FILTER='codex'
# export E2E_AGENT_VERSIONS_FILTER='codex,claude'

# 统一传入各 agent 的 API Key（便于 probe 真实上报 SLS）
export E2E_CODEX_OPENAI_API_KEY='your-codex-key'
export E2E_CLAUDE_BAILIAN=1
export E2E_CLAUDE_BAILIAN_API_KEY='your-bailian-key'
export E2E_QODER_PERSONAL_ACCESS_TOKEN='your-qoder-pat'

npm run test:e2e:remote
```

### 脚本行为详解

对每个存在 `npmPackage` 字段的 agent，远端脚本串行：

1. `npm view <pkg> versions --json` 拉全量版本，取尾部 N 个（最新）
2. `npm uninstall -g <pkg>` 清环境
3. 循环每个版本：
   - `npm install -g <pkg>@<version>`
   - `<binary> --version` 打印实际版本
   - 执行 agent 的 `defaultProbeSh`（会触发 pilot hook 采集）
   - `npm uninstall -g <pkg>` （串行隔离）
4. 收尾回装 `<pkg>@latest`（`E2E_VERSION_MATRIX_RESTORE_LATEST=0` 关闭）

### 预期输出（示例）

```
[version-matrix] mode=serial; versions_per_agent=3; filter=<none>
########################################
# [version-matrix] agent=Codex CLI (binary=codex, pkg=@openai/codex)
########################################
[version-matrix] querying npm: @openai/codex
[version-matrix] Codex CLI most recent versions (latest first):
  - 0.45.0
  - 0.44.2
  - 0.44.1

>>> [version-matrix] agent=Codex CLI version=0.45.0 >>>
codex 0.45.0
[probe output ...]
<<< [version-matrix] agent=Codex CLI version=0.45.0 probe exit 0 <<<

>>> [version-matrix] agent=Codex CLI version=0.44.2 >>>
...
```

### 验证 SLS 数据

上报数据不按版本拆分 userId。通过运行时间段 + 每条日志的 `>>> agent=X version=Y >>>` 分隔线在 SLS 对齐数据：

```sql
* 
| select __time__, "gen_ai.agent.type", "gen_ai.agent.version", "event.name"
| where "gen_ai.agent.type" in ('codex','claude-code','qoder-cli-hook')
| order by __time__ asc
| limit 500
```

结合本地终端打印的时间戳 + version 分隔线，可以按版本分段检查事件是否完整。

### 常见问题

| 现象 | 原因 / 处理 |
|------|------|
| `[version-matrix] ERROR: loongsuite-pilot not installed` | 先跑 install-smoke；或 `export E2E_VERSION_MATRIX_REQUIRE_PILOT=0` 先跑通 agent 层 |
| `npm view` 返回空 | 远端网络访不了 npm registry，需要配镜像或代理 |
| 某个中间版本 install failed | 该版本被废弃或有安装问题，脚本会打印错误后自动跳过继续下一个 |
| 测完后 `latest` 没恢复 | 检查 `E2E_VERSION_MATRIX_RESTORE_LATEST` 是否被设为 `0`；网络异常也会导致 |

---

## 🧪 场景 6：完整 E2E 测试矩阵（组合场景）

**目标**：模拟真实用户从安装到使用的全流程。

### 操作流程

```bash
# === 第一步：安装并验证 ===
export E2E_SSH_TARGET='your-user@remote-host'
export E2E_USER_ID='your-employee-id'
export E2E_SCENARIO=install-smoke
export E2E_USE_MATRIX_PROBE=1
# ... 设置各种 API Key ...
npm run test:e2e:remote

# === 第二步：验证 SLS 数据 ===
# 手动登录 SLS 控制台查看数据

# === 第三步：测试自动升级 ===
export E2E_SCENARIO=auto-upgrade
npm run test:e2e:remote

# === 第四步：测试重启恢复 ===
export E2E_SCENARIO=reboot-autostart
export E2E_SSH_PASSWORD_AUTH=1
npm run test:e2e:remote

# 等待 1-2 分钟...

export E2E_SCENARIO=post-reboot-verify
npm run test:e2e:remote

# === 第五步：清理环境 ===
export E2E_SCENARIO=uninstall
npm run test:e2e:remote
```

---

## 🔍 故障排查

### 1. SSH 连接失败

```bash
# 测试 SSH 连通性
ssh -v your-user@remote-host echo "SSH works"

# 如果使用密钥
ssh -i /path/to/key your-user@remote-host echo "Key auth works"

# 设置密码认证
export E2E_SSH_PASSWORD_AUTH=1
```

### 2. 安装失败

```bash
# 查看详细日志
export E2E_ARTIFACT_DIR=./e2e-artifacts
npm run test:e2e:remote

# 查看产物目录
ls -la ./e2e-artifacts/
cat ./e2e-artifacts/install-smoke-*.txt
```

### 3. 服务未启动

```bash
# SSH 到远程机器手动排查
ssh your-user@remote-host

# 检查 systemd 状态
systemctl --user status loongsuite-pilot.service

# 查看日志
journalctl --user -u loongsuite-pilot.service --no-pager | tail -100

# 手动启动
loongsuite-pilot start

# 检查 Node.js 版本
node -v  # 需要 >= 18
```

### 4. SLS 没有数据

可能原因：
- Agent CLI 未安装或未执行探针
- Agent 需要 API Key 才能产生数据（如 Qoder CLI 需要 PAT）
- SLS 配置错误（检查 `~/.loongsuite-pilot/config.json`）

```bash
# SSH 到远程机器检查配置
ssh your-user@remote-host
cat ~/.loongsuite-pilot/config.json

# 查看 pilot 日志
tail -f ~/.loongsuite-pilot/logs/loongsuite-pilot-service.log

# 查看输出文件
tail -f ~/.loongsuite-pilot/logs/output/*.jsonl
```

### 5. 重启后服务未自动启动

```bash
# 检查 system-level systemd（安装器默认创建的单元）
systemctl is-enabled loongsuite-pilot.service    # 期望 enabled
systemctl status loongsuite-pilot.service

# 如未启用，手动启用
sudo systemctl enable loongsuite-pilot.service
sudo systemctl start loongsuite-pilot.service

# 查看 system-level 服务文件
cat /etc/systemd/system/loongsuite-pilot.service

# 备选：user-level systemd（仅在安装器回退到用户级时适用）
systemctl --user is-enabled loongsuite-pilot.service
systemctl --user enable loongsuite-pilot.service
cat ~/.config/systemd/user/loongsuite-pilot.service

# 检查 linger（仅 user-level 单元需要，用户注销后服务继续运行）
loginctl show-user $USER | grep Linger
sudo loginctl enable-linger $USER
```

### 6. `Connection reset by peer` 或 `Broken pipe`

在 `reboot-autostart` 场景下**这不是错误**——这是 `sudo reboot` 成功触发后，远端 sshd 被关闭导致的 TCP RST。

脚本已内置容错：
- 远端脚本用 `nohup ... sleep 1 && sudo reboot &` 异步触发，给 SSH 留出优雅关闭窗口
- 本地 runner 打印 `[e2e] reboot-autostart: remote reboot triggered (SSH disconnect is EXPECTED).` 后 `exit 0`

如果看到的是 `passwordless sudo is required for auto-reboot` 错误，说明未配置免密 sudo，请按“场景 3 前置条件”章节执行。

---

## 📊 测试检查清单

执行完所有场景后，确认以下项目：

- [ ] **首次安装**：pilot 成功安装，命令可用，目录结构完整
- [ ] **卸载**：pilot 完全卸载，无残留文件和服务
- [ ] **重启自启**：机器重启后 pilot 自动拉起，服务状态 active
- [ ] **多账号隔离**：多个用户的 pilot 独立安装，配置互不干扰
- [ ] **自动升级**：升级后版本更新，服务重启，配置保留
- [ ] **Agent 版本矩阵**：Codex/Claude/Qoder 最近 N 个版本皆能被 pilot 采集
- [ ] **SLS 数据**：各 Agent 的采集数据能在 SLS 控制台查询到
- [ ] **Linux 7U 兼容**：在旧 glibc 机器上（如 CentOS 7）能正常运行（使用 patchelf 补丁）

---

## 📝 环境变量速查表

| 变量 | 必填 | 说明 |
|------|------|------|
| `E2E_SSH_TARGET` | ✅ | `user@host` |
| `E2E_USER_ID` | 部分场景 | 你的工号 |
| `E2E_USER_IDS` | multi-account | 逗号分隔的多工号 |
| `E2E_SCENARIO` | ✅ | 场景名称 |
| `E2E_SSH_PASSWORD_AUTH` | 可选 | `1` 启用 SSH 密码认证（与 reboot 场景无关；密钥登录免设） |
| `E2E_AGENT_VERSIONS_N` | version-matrix | 每个 agent 要测的最近几个版本（默认 3，上限 20） |
| `E2E_AGENT_VERSIONS_FILTER` | 可选 | version-matrix 过滤器（binary/id，逗号分隔） |
| `E2E_VERSION_MATRIX_REQUIRE_PILOT` | 可选 | 默认 `1`；设 `0` 跳过 pilot 存在性检查 |
| `E2E_VERSION_MATRIX_RESTORE_LATEST` | 可选 | 默认 `1`；设 `0` 不回装 latest |
| `E2E_USE_MATRIX_PROBE` | 可选 | `1` 启用 Agent 探针 |
| `E2E_SLS_PROJECT` | 可选 | 自定义 SLS Project |
| `E2E_SLS_LOGSTORE` | 可选 | 自定义 SLS Logstore |
| `E2E_ARTIFACT_DIR` | 可选 | 保存测试产物 |
| `E2E_PROFILE` | 可选 | `linux-7u` / `linux-8u` |

---

## 🎯 常见问题 FAQ

### Q: 如何测试特定的安装版本？

A: 设置 `E2E_INSTALLER_URL` 指向特定的 installer 脚本：

```bash
export E2E_INSTALLER_URL='https://your-oss/path/to/specific-installer.sh'
```

### Q: reboot 场景为什么需要免密 sudo？

A: SSH 非交互式管道中 `sudo` 无 tty 无法读密码，所以远端的 `sudo reboot` 必须是免密的。这与 SSH 登录时用的是密码还是密钥**无关**。最小权限配置：

```bash
# 仅限 reboot，更安全
ssh your-user@remote-host
echo "$USER ALL=(ALL) NOPASSWD: /sbin/reboot, /usr/sbin/reboot" | sudo tee /etc/sudoers.d/loongsuite-pilot-e2e
sudo chmod 440 /etc/sudoers.d/loongsuite-pilot-e2e
sudo -n /sbin/reboot --help >/dev/null && echo "✓ passwordless sudo reboot OK"
```

若未配置，脚本会报 `passwordless sudo is required for auto-reboot` 并退出。

### Q: 如何在本地调试 E2E 脚本？

A: 可以先用 `preflight` 场景测试 SSH 连通性：

```bash
export E2E_SCENARIO=preflight
npm run test:e2e:remote
```

### Q: SLS 数据多久能看到？

A: 通常 1-5 分钟。pilot 默认 2 秒批量刷新一次。

### Q: 多账号场景需要 root 权限吗？

A: 需要 sudo 创建用户。如果没有 sudo，脚本会回退到"隔离目录模式"（在当前用户下创建多个独立目录）。

---

## 📚 相关文档

- [SKILL.md](../../../.cursor/skills/loongsuite-pilot-remote-e2e/SKILL.md) - E2E 测试 Skill 文档
- [agent-matrix.json](../../../scripts/e2e/agent-matrix.json) - Agent 矩阵定义
- [run-remote-e2e.mjs](../../../scripts/e2e/run-remote-e2e.mjs) - E2E 入口脚本
- [ssh-runner.mjs](../../../scripts/e2e/lib/ssh-runner.mjs) - SSH 执行基础设施
- [README.md](../../../README.md) - 项目主文档
