# loongsuite-pilot-installer

Qoder CLI 插件：启用后，在每次会话启动时自动检测并安装、启用 `loongsuite-pilot`；已安装且配置未变时毫秒级跳过，无需任何手动操作。

## 安装

```bash
qodercli plugins install /path/to/loongsuite-pilot-installer   # 默认 user 级
# 重启 CLI 或 /plugins reload，下一次会话启动即自动安装

loongsuite-pilot status                     # 验证是否 running
```

安装是**后台静默**进行的：会话启动时若需要安装/重装，hook 立即返回并提示“正在后台安装”，真正的安装在独立后台进程完成，不阻塞会话；完成后自动生效。

## 工作方式

每次会话启动触发，行为如下：

- **已安装 + 配置未变 + 进程存活** → 直接跳过（毫秒级）
- **已安装 + 配置未变 + 进程已死** → 自动 `start` 拉起（秒级，不重装）
- **未安装 / 配置变更** → 后台安装/重装，完成即生效

Node 运行时自动准备：本机已有 node ≥ 22 则复用，否则自动下载并解包到插件数据目录（不依赖 nvm、不改用户 shell 配置）。macOS / Linux / Windows 全平台支持。

## 管理员配置

编辑 [config/install-params.conf](config/install-params.conf)（bash 语法）：

| 配置项 | 说明 |
|--------|------|
| `INSTALLER_URL` | loongsuite-pilot 安装脚本地址（`.sh`）；Windows 固定用同目录的 `installer.ps1`，除非这里显式填 `.ps1` 地址 |
| `NODE_VERSION` | Node 版本，默认 `22.22.2` |
| `NODE_DIST_BASE_URL` | Node 分发包下载源 |
| `INSTALL_ARGS` | 透传给 installer 的参数数组，按 `--参数名 "值"` 成对填写，新增参数无需改脚本 |

运行期环境变量可覆盖（优先级最高）：`LOONGSUITE_PILOT_INSTALLER_URL`、`LOONGSUITE_PILOT_NODE_DIST_BASE_URL`、`LOONGSUITE_PILOT_USER_ID`。

> 不传 `--user.id` 时 config.json 不写 `userId` 字段，由 pilot 运行时回退到 hostname。

## 批量更新配置

installer 对 `config.json` 是**合并语义**（未传的参数保留旧值），管理员下发新参数只需改配置并递增版本号，插件靠**参数指纹**自动判定变更并重装覆盖：

```
① 修改 config/install-params.conf
② 递增 .qoder-plugin/plugin.json 的 version   ← 必需！插件缓存按版本号复用
③ 重新分发给用户，plugins install
④ 用户下次会话 → 指纹不一致 → 后台重新 install 覆盖 → 写新指纹
⑤ 此后每次会话指纹命中，毫秒级静默跳过
```

重装用 `install` 覆盖（合并写 config.json），**保留本地日志与采集 offset**；如需清空本地数据，手动执行 `loongsuite-pilot uninstall --purge`。

> 首次安装插件时若本机已有手动安装的 pilot（无指纹记录），会被当作“配置不一致”重新 install 覆盖——确保最终配置以管理员下发为准。

## 日志与落盘位置

- 安装日志：`~/.qoder/plugins/data/loongsuite-pilot-installer-*/install.log`（Windows：`%USERPROFILE%\.qoder\plugins\data\...`）
- 插件本体：`~/.qoder/plugins/cache/local/loongsuite-pilot-installer/<版本>/`

> 插件缓存**按版本号复用**：改了代码但版本号不变时 `plugins install` 不会刷新缓存，开发期验证请先 `plugins uninstall` 或递增 `version`。

---

维护者（Node 分发打包、插件 zip 打包、内部实现机制、平台验证边界等）见 [../tools/README.md](../tools/README.md)。
