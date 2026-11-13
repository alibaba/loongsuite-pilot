# 鉴权

安装、查询、预览和发布共用 Query Skill 的授权。默认用 OAuth、国内站。在当前项目目录执行，`<agentloop-audit-query目录>` 替换为该 Skill 的安装路径；后续重试沿用同一入口。

## 环境

先检测当前环境，只执行对应的一条命令。

### Linux 和 macOS

找不到 `python3` 时用 `python`。

```bash
python3 "<agentloop-audit-query目录>/scripts/run.py" auth
```

### Windows

参数名与 Linux 和 macOS 相同。

```powershell
powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "<agentloop-audit-query目录>/scripts/run.ps1" auth
```

不要贴出 license key、API key 或 AccessKey。不要读取凭证文件。Qoder 插件沿用插件根的 `aliyun/`；独立安装使用 Query Skill 根的 `aliyun/`，与终端默认 `~/.aliyun/` 分开。

## 默认

沿用上面的入口，不要加 `--auth-mode` 或 `--oauth-site-type`。浏览器打开后，等用户完成阿里云登录。

## 用户要求

用户已经说明要求时，按对应方式执行，不要再问一遍。

### 国际站

`INTL` 是国际站 alibabacloud.com。沿用上面的入口，加上 `--auth-mode OAuth` 和 `--oauth-site-type INTL`。

### AccessKey

不要执行配置命令，不要让用户把 AccessKey Id 或 AccessKey Secret 发到对话里。请用户在本机终端执行 stderr 里的那条 `configure --mode AK` 命令。地域和语言按那个终端自己的提示填写，可以留空。凭证写入插件根或独立 Query Skill 的 `aliyun/config.json`，以终端实际提示的完整配置命令为准。用户回复已经配置后，沿用上面的入口，只加 `--auth-mode AK`，不要加 `--oauth-site-type`。如果脚本仍提示去本机终端配置，重复这段引导，不要打开配置文件。

### 另一个 Profile

沿用上面的入口，只加 `--profile "<名称>"`。不要改成别的名字。这个名称可用时直接用；不可用时仍走默认 OAuth。

## 鉴权失败

登录没完成或这一步报错时，再问用户两件事：站点用 CN 还是国际站，登录用 OAuth 还是 AccessKey。按用户的选择回到「用户要求」里对应的方式执行。

## 重新执行

`auth` 成功后，再执行原来的 `install`、`audit`、`report` 或 `publish`，只保留原命令自己的参数。授权参数留在 `auth` 上。
