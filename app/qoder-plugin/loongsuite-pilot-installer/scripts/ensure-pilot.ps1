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

# ---- 运行子进程并把所有流追加到日志 ----
# 必须用文件重定向而不是 `| Add-Content`：
#   • 管道会等 stdout 句柄关闭，installer 启动的后台守护进程会继承句柄 → 永远挂死
#   • EAP=Stop 下子进程的 stderr 经管道会变成终止性错误
function Invoke-Logged([string[]]$PsArgs) {
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File @PsArgs *>> $LogFile
        return $LASTEXITCODE
    } finally { $ErrorActionPreference = $prevEap }
}

# ---- 硬停 pilot：Windows 下不停干净时 installer 删不掉数据目录 ----
function Stop-PilotHard {
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if (Test-Path $PilotCmd) { & $PilotCmd stop *>> $LogFile }
        # 移除计划任务，否则会重新拉起守护进程
        Get-ScheduledTask -ErrorAction SilentlyContinue |
            Where-Object { $_.TaskName -match 'Loongsuite' } | ForEach-Object {
                Stop-ScheduledTask -TaskName $_.TaskName -TaskPath $_.TaskPath -ErrorAction SilentlyContinue
                Unregister-ScheduledTask -TaskName $_.TaskName -TaskPath $_.TaskPath -Confirm:$false -ErrorAction SilentlyContinue
            }
        # 杀掉持有数据目录的 wscript 启动器与 node 守护进程
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -match '\.loongsuite-pilot' } | ForEach-Object {
                Write-Log ("停止残留进程 " + $_.Name + " pid " + $_.ProcessId)
                Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            }
        Start-Sleep -Seconds 2
    } finally { $ErrorActionPreference = $prevEap }
}

# ---- 测试入口：仅准备 node ----
if ($ProvisionNodeOnly) {
    Initialize-NodeRuntime
    & node -v
    exit 0
}

# ---- 参数指纹：installer 对 config.json 是合并语义（未传参数保留旧值），
# 因此参数变更时必须先 uninstall -Purge 再重装，否则旧配置会残留 ----
$FingerprintFile = Join-Path $DataDir 'install-args.sha256'

function Get-ArgsFingerprint {
    $payload = "url=$InstallerUrl`n" + (($InstallArgs | ForEach-Object { "$_`n" }) -join '')
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($payload))
        return -join ($bytes | ForEach-Object { $_.ToString('x2') })
    } finally { $sha.Dispose() }
}

$CurrentFp = Get-ArgsFingerprint

function Test-PilotInstalled { Test-Path $PilotCmd }

function Test-FingerprintMatch {
    if (-not (Test-Path $FingerprintFile)) { return $false }
    return ((Get-Content -Raw $FingerprintFile).Trim() -eq $CurrentFp)
}

# ---- 幂等：已安装且参数未变则立即退出（每次会话启动都会触发本脚本） ----
if ((Test-PilotInstalled) -and (Test-FingerprintMatch)) { exit 0 }

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
    # 拿到锁后重新判定：可能另一实例已经装好了相同配置
    if ((Test-PilotInstalled) -and (Test-FingerprintMatch)) { exit 0 }

    $needReinstall = Test-PilotInstalled
    if ($needReinstall) { Write-Log '已安装但参数指纹不一致，卸载后按新配置重装' }
    Write-Log "installer: $InstallerUrl"
    Write-Log "install args: $($InstallArgs -join ' ')"

    Initialize-NodeRuntime

    $installerTmp = Join-Path $DataDir 'installer.ps1'
    Invoke-WebRequest -Uri $InstallerUrl -OutFile $installerTmp -UseBasicParsing

    if ($needReinstall) {
        Stop-PilotHard
        $rc = Invoke-Logged @($installerTmp, 'uninstall', '-Purge')
        # 数据目录偶尔仍被残留句柄占用，补一手强删，否则旧 config 会被合并保留
        $pilotHome = Join-Path $env:USERPROFILE '.loongsuite-pilot'
        if (Test-Path $pilotHome) {
            & cmd /c "rmdir /s /q `"$pilotHome`"" *>> $LogFile
        }
        if ((Test-PilotInstalled) -or (Test-Path $pilotHome)) {
            Write-Log "⚠️ 卸载未完全成功 (rc=$rc)，继续尝试安装（installer 会覆盖同名配置项）"
        } else {
            Write-Log '旧版本已卸载'
        }
    }

    $rc = Invoke-Logged (@($installerTmp, 'install') + $InstallArgs)
    if ($rc -ne 0) { throw "installer exited with code $rc" }

    Set-Content -Path $FingerprintFile -Value $CurrentFp -Encoding ASCII
    # 直接调 .cmd 并取回字符串（不进管道），避免后台进程持有句柄导致挂死
    $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $status = (& $PilotCmd status 2>$null) -join ' '
    $ErrorActionPreference = $prevEap
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
