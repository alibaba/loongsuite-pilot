# loongsuite-pilot-installer

Qoder CLI 插件：安装并启用后，在下一次会话启动时自动检测并安装 `loongsuite-pilot`。

## 工作机制

`SessionStart`（`matcher: startup`、`async: true`）hook 触发 [scripts/ensure-pilot.sh](scripts/ensure-pilot.sh)：

1. **幂等检查** — `~/.local/bin/loongsuite-pilot` 已存在则立即退出（0.002s，无感）
2. **并发锁** — 多会话同时启动时只有一个实例执行安装
3. **Node 运行时** — 本机已有 node ≥ 22 则复用；否则按平台从 OSS 下载 Node v22.22.2 并解包到插件数据目录（不依赖 nvm、不写用户 shell 配置）
4. **安装 pilot** — 下载 installer 并透传管理员配置的参数

## 管理员配置

编辑 [config/install-params.conf](config/install-params.conf)（bash 语法，hook 会 source 它）：

| 配置项 | 说明 |
|--------|------|
| `INSTALLER_URL` | loongsuite-pilot 安装脚本地址 |
| `NODE_VERSION` | Node 版本，默认 `22.22.2` |
| `NODE_DIST_BASE_URL` | Node 分发包下载源（默认 OSS），分发包平铺在该前缀下：`<base>/node-v<ver>-<platform>.tar.gz` |
| `INSTALL_ARGS` | 透传给 `installer.sh install` 的参数数组，按 `--参数名 "值"` 成对填写，新增参数无需改脚本 |

运行期环境变量可覆盖（优先级最高）：`LOONGSUITE_PILOT_INSTALLER_URL`、`LOONGSUITE_PILOT_NODE_DIST_BASE_URL`、`LOONGSUITE_PILOT_USER_ID`。

## Node 分发包

默认从 OSS 在线下载，**仓库与插件都不携带任何 node 二进制**。当前源：

```
https://taiye-test-sh.oss-cn-shanghai.aliyuncs.com/sensen-test/node-v22.22.2-<platform>.tar.gz
```

已上传的平台：`darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64`、`win-x64`（均为公读）。

维护者刷新/换版本时，先拉取产物（含 sha256 校验，输出到 `vendor/node/`）：

```bash
./scripts/package-node-dists.sh             # 默认 22.22.2
./scripts/package-node-dists.sh 22.22.2     # 显式指定版本
```

然后上传到 `NODE_DIST_BASE_URL` 对应前缀（注意平铺、公读）：

```bash
ossutil cp -r -f vendor/node/ oss://taiye-test-sh/sensen-test/ --acl public-read
```

产物不入 git（约 241MB，已 gitignore），上传后本地可删。若需**离线分发**，把对应平台的包放回插件 `vendor/node/` 一同拷给用户，脚本会优先用本地包、不访问网络。

## 安装与验证

```bash
qodercli plugins install /path/to/loongsuite-pilot-installer   # 默认 user 级
# 或从市场：qodercli plugins marketplace add <市场目录/仓库> && qodercli plugins install loongsuite-pilot-installer
# 重启 CLI 或 /plugins reload，下一次会话启动即自动安装

loongsuite-pilot status                     # 验证
```

安装日志：`~/.qoder/plugins/data/loongsuite-pilot-installer-*/install.log`

## 已知限制

- Windows 暂不支持自动安装（hook 为 bash 脚本），Node 的 `win-x64.zip` 已纳入分发矩阵备用
- 仅在 macOS(arm64) 上做过端到端验证；其他平台走同一代码路径但未实测
- OSS 上的分发包需为公读（`--acl public-read`），因为 hook 用匿名 curl 下载
