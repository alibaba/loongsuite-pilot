# 安装指南

[English](../installation.md) | 简体中文

本文说明如何安装、验证、卸载 LoongSuite Pilot，或从源码运行。

## 前置要求

- Node.js 18 或更高版本
- `npm`
- `curl` 或 `wget`

## 从公开包安装

```bash
curl -fsSL https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh -o /tmp/loongsuite-pilot-installer.sh && bash /tmp/loongsuite-pilot-installer.sh install
```

安装器会检测支持的 Agent，让你选择要监控的 Agent，部署 Hook 或插件，写入本地配置，并启动后台服务。

## 带常用参数安装

```bash
curl -fsSL https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh -o /tmp/loongsuite-pilot-installer.sh && bash /tmp/loongsuite-pilot-installer.sh install \
  --agents "claude-code,cursor,codex" \
  --userId "your-user-id" \
  --sls-endpoint "https://cn-hangzhou.log.aliyuncs.com" \
  --sls-project "my-project" \
  --sls-logstore "my-logstore" \
  --mask-mode all
```

安装参数：

| 参数 | 说明 |
|------|------|
| `--version <ver>` | 安装指定版本，例如 `1.2.0`。 |
| `--agents <list>` | 逗号分隔的 Agent 列表，跳过交互选择。 |
| `--userId <id>` | 设置写入输出事件的用户标识。 |
| `--data-dir <path>` | 覆盖数据目录，默认 `~/.loongsuite-pilot`。 |
| `--package-url <url>` | 从自定义 URL 或本地 `file://` 路径安装。 |
| `--sls-endpoint <url>` | SLS endpoint。 |
| `--sls-project <name>` | SLS project。 |
| `--sls-logstore <name>` | SLS logstore。 |
| `--sls-ak-id <key>` | AK 模式的 Access Key ID。 |
| `--sls-ak-secret <key>` | AK 模式的 Access Key Secret。 |
| `--mask-mode <mode>` | 脱敏模式：`all`、`none` 或 `custom`。 |
| `--mask-types <list>` | 逗号分隔的脱敏类型，`--mask-mode custom` 时必填。 |
| `--collect-log <true\|false>` | 开启或关闭 SLS 日志上报。 |
| `--collect-trace <true\|false>` | 开启或关闭 Trace 上报。 |
| `--cms-license-key <key>` | CMS 或 ARMS Trace license key。 |
| `--cms-endpoint <url>` | CMS 或 ARMS Trace endpoint。 |
| `--cms-workspace <name>` | CMS workspace 值。 |
| `--service-name-prefix <name>` | 上报后端使用的 service name 前缀。 |
| `--system-service` | 注册为系统级服务，而不是用户级服务。 |
| `--lang <lang>` | 输出语言：`zh` 或 `en`。 |

## 验证安装

```bash
loongsuite-pilot status
loongsuite-pilot info
```

默认启用本地 JSONL 输出：

```bash
ls ~/.loongsuite-pilot/logs/output
```

## 服务管理

```bash
loongsuite-pilot start
loongsuite-pilot stop
loongsuite-pilot restart
loongsuite-pilot status
loongsuite-pilot info
loongsuite-pilot rollback
```

可选本地 Dashboard：

```bash
loongsuite-pilot monitor start
```

然后打开：

```text
http://127.0.0.1:8765/
```

## 卸载

保留数据：

```bash
curl -fsSL https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh -o /tmp/loongsuite-pilot-installer.sh && bash /tmp/loongsuite-pilot-installer.sh uninstall
```

移除安装文件和本地数据：

```bash
curl -fsSL https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh -o /tmp/loongsuite-pilot-installer.sh && bash /tmp/loongsuite-pilot-installer.sh uninstall --purge
```

## 从源码构建并运行

```bash
git clone https://github.com/loongsuite/loongsuite-pilot.git
cd loongsuite-pilot
npm install
npm run build
node scripts/postinstall.js
node dist/index.js
```

这会以前台方式启动 collector。启动时，Pilot 会读取 `agents.d/` 中的 Agent 定义，自动检测已安装 Agent，并为检测到的 Agent 部署采集能力。

## 将本地构建安装为服务

```bash
bash deploy/package.sh --opensource
bash deploy/installer-opensource.sh --package-url "file://$(pwd)/loongsuite-pilot.tar.gz"
```

## 下一步

- 在 [Agent 配置](agents.md) 选择 Agent。
- 在 [本地 JSONL 输出](local-jsonl-output.md) 验证本地输出。
- 在 [SLS 输出](sls-output.md) 配置 SLS 上报。
- 在 [Trace 输出](trace-output.md) 配置 Trace 上报。
- 在 [数据脱敏](masking.md) 配置密钥脱敏。
