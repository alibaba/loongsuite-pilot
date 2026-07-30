# loongsuite-pilot-installer 插件 SessionStart hook（Windows）：
# 与 ensure-pilot.sh 等价 —— 幂等检测并安装 loongsuite-pilot，node 依赖统一使用
# v22.22.2（从 NODE_DIST_BASE_URL 下载 win-x64.zip，vendor\node 内有包则优先用本地包）。
# 管理员参数复用同一份 config\install-params.conf，kebab-case 自动转成 installer.ps1
# 需要的 PascalCase 参数。
# 用法：ensure-pilot.ps1 [-ProvisionNodeOnly]
[CmdletBinding()]
param(
    [switch]$ProvisionNodeOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$PluginRoot = if ($env:QODER_PLUGIN_ROOT) { $env:QODER_PLUGIN_ROOT } else { Split-Path -Parent $PSScriptRoot }
$DataDir = if ($env:QODER_PLUGIN_DATA) { $env:QODER_PLUGIN_DATA } else { Join-Path $env:USERPROFILE '.loongsuite-pilot-installer' }
$LogFile = Join-Path $DataDir 'install.log'
$LockDir = Join-Path $DataDir 'install.lock'
$PilotCmd = Join-Path $env:USERPROFILE '.local\bin\loongsuite-pilot.cmd'

# ---- 内置默认值（可被 config\install-params.conf 及环境变量覆盖） ----
$InstallerUrl = 'https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.ps1'
$NodeVersion = '22.22.2'
$NodeDistBaseUrl = 'https://taiye-test-sh.oss-cn-shanghai.aliyuncs.com/sensen-test'
$NodeMinMajor = 22
$InstallArgs = @()

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
function Write-Log($msg) {
    # 显式 UTF8：Add-Content 默认 ANSI/GBK 会把中文日志写成乱码
    "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg | Add-Content -Path $LogFile -Encoding UTF8
}

# ---- 解析 install-params.conf（bash 语法）：复用同一份管理员配置 ----
function Read-AdminConfig {
    $conf = Join-Path $PluginRoot 'config\install-params.conf'
    if (-not (Test-Path $conf)) { return }
    # 必须显式按 UTF-8 读：conf 含中文注释且无 BOM，PS 5.1 默认 ANSI/GBK 会吞并后续 ASCII 字节，破坏 INSTALL_ARGS 块的行结构
    $text = [System.IO.File]::ReadAllText($conf, [System.Text.Encoding]::UTF8)

    if ($text -match '(?m)^\s*NODE_VERSION\s*=\s*"([^"]*)"') { $script:NodeVersion = $Matches[1] }
    if ($text -match '(?m)^\s*NODE_DIST_BASE_URL\s*=\s*"([^"]*)"') { $script:NodeDistBaseUrl = $Matches[1] }
    # Windows 用 installer.ps1，因此忽略 conf 里指向 installer.sh 的 INSTALLER_URL，
    # 仅当管理员显式配置了 .ps1 地址时才采用
    if ($text -match '(?m)^\s*INSTALLER_URL\s*=\s*"([^"]*\.ps1)"') { $script:InstallerUrl = $Matches[1] }

    # INSTALL_ARGS=( --collect-log "true" ... ) → -CollectLog true ...
    if ($text -match '(?ms)^\s*INSTALL_ARGS\s*=\s*\((.*?)^\s*\)') {
        $body = $Matches[1]
        $tokens = [regex]::Matches($body, '"([^"]*)"|(--[\w\.\-]+)') | ForEach-Object {
            if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value }
        }
        $parsed = @()
        foreach ($t in $tokens) {
            if ($t -like '--*') {
                # --collect-log / --user.id → -CollectLog / -UserId
                $name = ($t.Substring(2) -split '[-\.]' | ForEach-Object {
                    if ($_.Length -gt 0) { $_.Substring(0, 1).ToUpper() + $_.Substring(1) }
                }) -join ''
                $parsed += "-$name"
            } else {
                $parsed += $t
            }
        }
        $script:InstallArgs = $parsed
    }
}

Read-AdminConfig

# 环境变量覆盖（优先级最高）
if ($env:LOONGSUITE_PILOT_INSTALLER_URL) { $InstallerUrl = $env:LOONGSUITE_PILOT_INSTALLER_URL }
if ($env:LOONGSUITE_PILOT_NODE_DIST_BASE_URL) { $NodeDistBaseUrl = $env:LOONGSUITE_PILOT_NODE_DIST_BASE_URL }
if ($env:LOONGSUITE_PILOT_USER_ID) { $InstallArgs += @('-UserId', $env:LOONGSUITE_PILOT_USER_ID) }

# ---- node >= 22 探测（本机已有则复用，不重复下载） ----
function Find-Node {
    $candidates = @()
    $bundled = Join-Path $DataDir 'node'
    if (Test-Path $bundled) {
        $candidates += Get-ChildItem -Path $bundled -Directory -Filter 'node-v*' |
            ForEach-Object { $_.FullName }
    }
    foreach ($dir in $candidates) {
        if (Test-Path (Join-Path $dir 'node.exe')) { return $dir }
    }
    $onPath = Get-Command node -ErrorAction SilentlyContinue
    if ($onPath) {
        $ver = (& $onPath.Source -v) -replace '^v', ''
        if ([int]($ver -split '\.')[0] -ge $NodeMinMajor) { return (Split-Path -Parent $onPath.Source) }
    }
    return $null
}

# ---- 下载/解包 node 分发包（仅 win-x64 已上传，ARM 上回退到 x64 走仿真） ----
function Install-Node {
    $extractDir = Join-Path $DataDir 'node'
    New-Item -ItemType Directory -Force -Path $extractDir | Out-Null

    $arches = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { @('arm64', 'x64') } else { @('x64') }
    foreach ($arch in $arches) {
        $zipName = "node-v$NodeVersion-win-$arch.zip"
        $vendorZip = Join-Path $PluginRoot "vendor\node\$zipName"
        try {
            if (Test-Path $vendorZip) {
                Write-Log "使用插件本地捆绑的 node 分发包: $zipName"
                $zip = $vendorZip
            } else {
                $zip = Join-Path $DataDir $zipName
                $url = "$NodeDistBaseUrl/$zipName"
                Write-Log "从 $url 下载 node 分发包"
                Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
            }
            Expand-Archive -Path $zip -DestinationPath $extractDir -Force
            if ($zip -ne $vendorZip) { Remove-Item $zip -Force -ErrorAction SilentlyContinue }
            return (Join-Path $extractDir "node-v$NodeVersion-win-$arch")
        } catch {
            Write-Log "node $arch 包获取失败: $($_.Exception.Message)"
        }
    }
    throw "无法获取 node v$NodeVersion (win)"
}

function Initialize-NodeRuntime {
    $binDir = Find-Node
    if ($binDir) {
        Write-Log "node 环境就绪: $binDir"
    } else {
        Write-Log "未检测到 node >= $NodeMinMajor，准备 node v$NodeVersion"
        $binDir = Install-Node
        Write-Log "node 就绪: $binDir ($(& (Join-Path $binDir 'node.exe') -v))"
    }
    $env:PATH = "$binDir;$(Join-Path $env:USERPROFILE '.local\bin');$env:PATH"
}

# ---- 测试入口：仅准备 node ----
if ($ProvisionNodeOnly) {
    Initialize-NodeRuntime
    & node -v
    exit 0
}

# ---- 幂等：已安装直接退出（每次会话启动都会触发本脚本） ----
if (Test-Path $PilotCmd) { exit 0 }

# ---- 并发锁：多会话同时启动时只允许一个实例执行安装 ----
# CLI 退出可能杀掉 hook 进程导致锁残留，超过 TTL 的旧锁直接接管
$LockTtlMinutes = 15
if (Test-Path $LockDir) {
    $age = (Get-Date) - (Get-Item $LockDir).CreationTime
    if ($age.TotalMinutes -gt $LockTtlMinutes) {
        Write-Log ("接管过期锁（存在 " + [int]$age.TotalMinutes + " 分钟）")
        Remove-Item $LockDir -Force -Recurse -ErrorAction SilentlyContinue
    }
}
try {
    New-Item -ItemType Directory -Path $LockDir -ErrorAction Stop | Out-Null
} catch {
    Write-Log '另一实例正在安装，跳过'
    exit 0
}

try {
    Write-Log '未检测到 loongsuite-pilot，开始自动安装'
    Write-Log "installer: $InstallerUrl"
    Write-Log "install args: $($InstallArgs -join ' ')"

    Initialize-NodeRuntime

    $installerTmp = Join-Path $DataDir 'installer.ps1'
    Invoke-WebRequest -Uri $InstallerUrl -OutFile $installerTmp -UseBasicParsing

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installerTmp install @InstallArgs *>&1 |
        Add-Content -Path $LogFile -Encoding UTF8
    if ($LASTEXITCODE -ne 0) { throw "installer exited with code $LASTEXITCODE" }

    $status = (& $PilotCmd status 2>&1) -join ' '
    Write-Log "✅ 安装完成。status: $status"
    # stdout 纯文本会作为 SessionStart 附加上下文注入对话，让用户感知安装结果
    Write-Output "loongsuite-pilot 已由插件自动安装完成：$status"
} catch {
    Write-Log "❌ 安装失败: $($_.Exception.Message)"
    Write-Error "loongsuite-pilot 自动安装失败，详见 $LogFile"
    exit 1
} finally {
    Remove-Item $LockDir -Force -Recurse -ErrorAction SilentlyContinue
}
