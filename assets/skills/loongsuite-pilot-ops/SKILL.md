---
name: loongsuite-pilot-ops
version: 0.6.1
description: >-
  安装、卸载 LoongSuite Pilot（面向研发团队的 AI Coding 数据采集工具，
  支持 Cursor / Qoder / Claude Code / Codex）。当用户提到 loongsuite-pilot 安装、
  pilot 部署、Node.js 前置条件、nvm 配置、Linux 7U glibc 补丁、SSH 远程安装、
  新增或追加 SLS flusher、自定义 SLS/WebTracking 上报配置时，
  务必使用本 Skill——即使用户只问“怎么装”也应触发。安装完成后可在
  ~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/ 目录下找到诊断排查与观测面板的详细参考文档。
---

# LoongSuite Pilot — 安装 / 配置 / 卸载

LoongSuite Pilot 是面向研发团队的 AI Coding 数据采集与效能评估工具，支持
Cursor、Qoder IDE/CLI、Claude Code、Codex 的数据自动采集与上报。

> 诊断排查请查阅 `~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/diagnostics.md`；
> 观测面板与运维手册请查阅 `~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/monitoring.md`。
> 以上两个文件在 pilot 安装完成后自动写入本地，可直接打开阅读。

## 重要说明

> **所有命令必须在完整权限环境下执行**（Shell 工具调用时设置 `required_permissions: ["all"]`）。
> 沙箱环境下 `nvm`、`sudo` 及 PID 读取会受限，导致安装或诊断结果不可信。

---

## 1. 前置条件

- Node.js >= 18，**必须通过 nvm 安装并使用 nvm 管理的 Node**（推荐 v22）
- 支持 **Mac** / **Linux 8U 开发机** / **Linux ECS**（Linux 需 `sudo` 权限）
- **Linux 7U 开发机**：需额外执行 glibc 兼容补丁（见第 5 节）

> ⚠️ **务必使用 nvm 的 Node，不要使用任何 Agent 自带的 Node 环境**
>
> 部分 AI Coding Agent（例如 **Codex**、以及其他自带运行时的 CLI 工具）会在安装时
> 内置一份 Node，并可能把 `node` 指向其私有目录（例如 `~/.codex/...` 或 Agent
> 自身安装目录下的版本）。这类 Node **仅供该 Agent 内部使用**，用它安装 pilot
> 会导致依赖错乱、hook 失效等问题。安装前务必确认：
>
> ```bash
> which node    # 路径应包含 .nvm，例如 ~/.nvm/versions/node/v22.x.x/bin/node
> node -v       # 输出应 >= v18.0.0
> ```
>
> 若 `which node` 指向任一 Agent 的私有目录（如 `~/.codex/`、Agent 安装目录等），
> 请先执行 `nvm use 22`（或在新终端中确认 `nvm` 已加载）后再继续安装。

---

## 2. 安装

执行以下两步完成标准安装（Mac / Linux 8U / ECS）：

```bash
# 步骤一：安装 nvm + Node.js（已有 node >= 18 可跳过）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 22

# 步骤二：安装 LoongSuite Pilot（将 <工号> 替换为 6 位员工号，含前导 0）
curl -fsSL https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite/loongsuite-pilot/loongsuite-pilot-installer-inner.sh \
  | bash -s -- install --user.id <工号>
```

安装成功后验证：

```bash
~/.local/bin/loongsuite-pilot status
~/.local/bin/loongsuite-pilot info
# diagnostics 与 monitoring 参考文档已自动写入 loongsuite-pilot-ops/references/
ls -l ~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/
```

---

## 3. 自定义 Logstore（可选）

安装时或安装完成后，询问用户是否需要使用自定义 Logstore 上报数据。

- 如果用户**不需要**自定义 Logstore，跳过本节，使用默认配置即可。
- 如果用户**需要**自定义 Logstore，先询问用户选择哪种访问方式，然后按对应流程操作：

询问用户：**是否使用 AK/SK 进行访问？**

- **方式一：使用 AK/SK 上报访问 Logstore**（需要提供 AK/SK 凭证）
- **方式二：使用 WebTracking 匿名上报**（需要在 Logstore 上开启 WebTracking）

如果用户提供的是 `region + project + logstore`，安装脚本没有 `--sls-region` 参数，需要先把
`region` 转成 `--sls-endpoint`：

```bash
--sls-endpoint "https://{region}.log.aliyuncs.com"
```

例如 `region=cn-hangzhou` 时，endpoint 是 `https://cn-hangzhou.log.aliyuncs.com`。
不要再使用 `--default-sls-override=false`，当前安装脚本会直接拒绝该参数。

---

### 方式一：使用 AK/SK 上报访问 Logstore

> ⚠️ **安全警告：以下命令包含 AK/SK 敏感信息，禁止发送给 Agent！**
>
> 请用户**自行复制**下方命令模板，**手动填入** AK/SK 等敏感参数后，
> **在自己的终端中直接执行**。切勿将填写好的命令粘贴回对话窗口或发送给任何 Agent，
> 以防 AK/SK 泄露。

请将以下命令模板展示给用户，让用户自行填写并执行：

```bash
curl -fsSL https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite/loongsuite-pilot/loongsuite-pilot-installer-inner.sh | bash -s -- install \
  --user.id={替换成你的工号，6位数字，如012345} \
  --sls-endpoint "{endpoint链接，如https://cn-hangzhou.log.aliyuncs.com}" \
  --sls-project "{project名字}" \
  --sls-logstore "{logstore名字}" \
  --sls-ak-id "{logstore ak}" \
  --sls-ak-secret "{logstore secret}"
```

**Agent 操作规范：**
1. 将上述命令模板**原样展示**给用户
2. 提醒用户将各占位符替换为实际值
3. **绝对不要**代替用户执行此命令
4. **绝对不要**要求用户将填好的命令发回给 Agent
5. 告知用户在终端执行完毕后，可以回来继续后续验证步骤

---

### 方式二：使用 WebTracking 匿名上报

将 Logstore 设置为 WebTracking Enabled（开启匿名上报），无需提供 AK/SK。

如果用户已经明确选择 WebTracking，并提供了 `user.id`、`region`/`endpoint`、`project`、
`logstore`，Agent 可以将占位符替换为实际值后代替用户执行安装命令；如果信息不完整，
再将以下命令模板展示给用户，让用户补齐：

```bash
curl -fsSL https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite/loongsuite-pilot/loongsuite-pilot-installer-inner.sh | bash -s -- install \
  --user.id={替换成你的工号，6位数字，如012345} \
  --sls-endpoint "{endpoint链接，如https://cn-hangzhou.log.aliyuncs.com}" \
  --sls-project "{project名字}" \
  --sls-logstore "{logstore名字}"
```

**Agent 操作规范：**
1. 先确认用户明确选择的是 WebTracking 匿名上报，不涉及 AK/SK
2. 如果用户提供的是 `region + project + logstore`，先按上文转换出 `--sls-endpoint`
3. 执行前确认当前 `node` 来自 `nvm`，且 `node -v` >= 18；否则先切换到 `nvm use 22`
4. 信息完整时，Agent **可以代替用户执行此命令**，并在安装后继续执行 `status` / `info` 验证
5. 提醒用户需要**提前在 SLS 控制台将对应 Logstore 开启 WebTracking**；如果安装或上报验证失败，优先提示检查 WebTracking 是否已开启

---

## 4. 添加一个新的 SLS flusher

当用户说“新增 SLS 上报”、“添加 SLS flusher”、“再加一个 logstore”、“配置发送采集数据到
project/region/logstore，走 WebTracking”时，**不要重新安装 pilot**，直接修改用户的
`~/.loongsuite-pilot/config.json`。

需要的信息：

- `project`
- `logstore`
- `region` 或完整 `endpoint`
- 访问方式。若用户明确说走 WebTracking，则不需要 AK/SK

如果用户提供的是 `region + project + logstore`，先转换：

```bash
endpoint="https://{region}.log.aliyuncs.com"
```

例如 `region=cn-heyuan` 时，endpoint 是 `https://cn-heyuan.log.aliyuncs.com`。

### 修改规则

只修改 `config.json` 的 `sls` 字段，保留 `enabled`、`dataDir`、`userId`、`autoUpdate`、
`installId` 等其他字段。

- 如果 `sls` 不存在、为 `null`、为空对象 `{}` 或空数组 `[]`，设置成单个对象：

```json
{
  "endpoint": "https://cn-heyuan.log.aliyuncs.com",
  "project": "ai-coding-devops",
  "logstore": "loongsuite-pilot-for-intern-contest2"
}
```

- 如果 `sls` 已经是对象，改成数组，并把旧对象和新对象都放进去：

```json
"sls": [
  {
    "endpoint": "https://cn-heyuan.log.aliyuncs.com",
    "project": "ai-coding-devops",
    "logstore": "loongsuite-pilot-for-internl-contest"
  },
  {
    "endpoint": "https://cn-heyuan.log.aliyuncs.com",
    "project": "ai-coding-devops",
    "logstore": "loongsuite-pilot-for-intern-contest2"
  }
]
```

- 如果 `sls` 已经是数组，向数组追加新对象；如果完全相同的 `endpoint + project + logstore`
  已存在，不要重复追加，直接告诉用户已存在。

WebTracking 模式不要写入 AK/SK。通常只写 `endpoint`、`project`、`logstore` 即可，pilot
会按默认 WebTracking 处理。

### 推荐执行方式

用结构化 JSON 修改，不要用字符串替换。执行前先备份：

```bash
CONFIG="$HOME/.loongsuite-pilot/config.json"
cp "$CONFIG" "$CONFIG.bak.$(date +%Y%m%d-%H%M%S)"
```

然后将下面变量替换成用户提供的新 flusher 信息后执行：

```bash
CONFIG="$HOME/.loongsuite-pilot/config.json"
NEW_ENDPOINT="https://cn-heyuan.log.aliyuncs.com"
NEW_PROJECT="ai-coding-devops"
NEW_LOGSTORE="loongsuite-pilot-for-intern-contest2"

python3 - "$CONFIG" "$NEW_ENDPOINT" "$NEW_PROJECT" "$NEW_LOGSTORE" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1]).expanduser()
new_endpoint, new_project, new_logstore = sys.argv[2:5]
new_sls = {
    "endpoint": new_endpoint,
    "project": new_project,
    "logstore": new_logstore,
}

cfg = json.loads(path.read_text())
sls = cfg.get("sls")

def is_empty(value):
    return value is None or value == {} or value == []

def same_endpoint(value):
    return (
        isinstance(value, dict)
        and value.get("endpoint") == new_sls["endpoint"]
        and value.get("project") == new_sls["project"]
        and value.get("logstore") == new_sls["logstore"]
    )

if is_empty(sls):
    cfg["sls"] = new_sls
elif isinstance(sls, list):
    if not any(same_endpoint(item) for item in sls):
        sls.append(new_sls)
    cfg["sls"] = sls
elif isinstance(sls, dict):
    if same_endpoint(sls):
        cfg["sls"] = sls
    else:
        cfg["sls"] = [sls, new_sls]
else:
    raise SystemExit(f"unsupported sls config type: {type(sls).__name__}")

path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n")
PY
```

修改后执行：

```bash
python3 -m json.tool ~/.loongsuite-pilot/config.json
```

告知用户：配置已写入，但需要 restart 后生效。

如果用户明确要求 restart，例如“完成后执行 restart”、“帮我重启生效”，继续执行：

```bash
~/.local/bin/loongsuite-pilot restart
~/.local/bin/loongsuite-pilot status
~/.local/bin/loongsuite-pilot info
```

如果用户没有明确要求 restart，只提醒用户稍后执行：

```bash
~/.local/bin/loongsuite-pilot restart
```

同时提醒：对应 Logstore 必须在 SLS 控制台开启 WebTracking，否则上报会失败。

---

## 5. Linux 7U 补丁（glibc 兼容）

> **仅限 Linux 7U 开发机**。其他环境跳过本节，直接执行第 2 节。

用以下步骤替代第 2 节的"步骤一"，再执行第 2 节的"步骤二"：

```bash
# 安装 nvm + Node.js
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 22

# 打 glibc 补丁（补丁前 node -v 会报 glibc 版本错误）
curl -o- https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite/loongsuite-pilot/patchelf_node_for_7u.sh | bash

node -v    # 补丁成功后正常输出版本号，再执行步骤二
```

---

## 6. SSH 远程开发场景

通过 Cursor / Qoder SSH 连接远程开发机时：

1. Pilot **必须安装在远程开发机**（本地 Mac 端无需安装）
2. 远程机上按第 2 节或第 4 节的流程执行安装
3. Hook 随 Cursor/Qoder Remote Server 在远端自动生效

---

## 7. 卸载

```bash
# 保留日志与配置（~/.loongsuite-pilot/logs、config.json）
curl -fsSL https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite/loongsuite-pilot/loongsuite-pilot-installer-inner.sh \
  | bash -s -- uninstall

# 彻底清理（连同数据目录，不可恢复）
curl -fsSL https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite/loongsuite-pilot/loongsuite-pilot-installer-inner.sh \
  | bash -s -- uninstall --purge
```

卸载脚本会自动清理 `loongsuite-pilot-ops/references/` 下的符号链接；本 `SKILL.md` 由用户手动维护，不受卸载影响。

---

## 8. 安装后的参考文档

pilot 安装成功后，以下两个文档自动写入本地，可直接打开阅读：

| 文件 | 内容 |
|------|------|
| `~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/diagnostics.md` | 5 步系统化诊断排查 + 常见问题速查 |
| `~/.loongsuite-pilot/skills/loongsuite-pilot-ops/references/monitoring.md` | 观测面板启停 + 全面健康检查 + 强制重启 + 版本回滚 |
