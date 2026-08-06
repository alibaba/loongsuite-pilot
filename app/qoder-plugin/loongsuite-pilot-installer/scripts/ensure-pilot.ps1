# loongsuite-pilot-installer 插件 SessionStart hook（Windows）：
# 与 ensure-pilot.sh 等价 —— 幂等检测并安装 loongsuite-pilot，node 依赖统一使用
# v22.22.2（从 NODE_DIST_BASE_URL 下载 win-x64.zip，vendor\node 内有包则优先用本地包）。
# 管理员参数复用同一份 config\install-params.conf，kebab-case 自动转成 installer.ps1
# 需要的 PascalCase 参数。
# 用法：ensure-pilot.ps1 [-ProvisionNodeOnly]
[CmdletBinding()]
param(
    [switch]$ProvisionNodeOnly,
    [switch]$RunInstall   # detach 出的独立进程用：直接执行重活，不再二次 detach
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$PluginRoot = if ($env:QODER_PLUGIN_ROOT) { $env:QODER_PLUGIN_ROOT } else { Split-Path -Parent $PSScriptRoot }
$DataDir = if ($env:QODER_PLUGIN_DATA) { $env:QODER_PLUGIN_DATA } else { Join-Path $env:USERPROFILE '.loongsuite-pilot-installer' }
$LogFile = Join-Path $DataDir 'install.log'
$LockDir = Join-Path $DataDir 'install.lock'
$PilotCmd = Join-Path $env:USERPROFILE '.local\bin\loongsuite-pilot.cmd'
$PilotHome = Join-Path $env:USERPROFILE '.loongsuite-pilot'   # pilot 数据目录（默认），内含 pid 文件，用于判活

# ---- 插件内置常量：安装器地址 / node 运行时（由维护者维护，管理员无需配置） ----
$InstallerUrl = 'https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot-dev/installer.ps1'
$NodeVersion = '22.22.2'
$NodeDistBaseUrl = 'https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/deps/node/22.22.2'
$NodeMinMajor = 22
# 管理员参数：仅 InstallArgs 从 config\install-params.conf 读取
$InstallArgs = @()

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
function Write-Log($msg) {
    # 显式 UTF8：Add-Content 默认 ANSI/GBK 会把中文日志写成乱码
    "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg | Add-Content -Path $LogFile -Encoding UTF8
}

# ---- 解析 install-params.conf（bash 语法）：只读管理员参数 INSTALL_ARGS ----
# 安装器地址 / node 版本 / node 下载源均为插件内置常量，不从 conf 读取
function Read-AdminConfig {
    $conf = Join-Path $PluginRoot 'config\install-params.conf'
    if (-not (Test-Path $conf)) { return }
    # 必须显式按 UTF-8 读：conf 含中文注释且无 BOM，PS 5.1 默认 ANSI/GBK 会吞并后续 ASCII 字节，破坏 INSTALL_ARGS 块的行结构。
    # 用 Get-Content -Encoding UTF8（cmdlet）而非 [System.IO.File]::ReadAllText：受限语言模式（ConstrainedLanguage）下禁止调用非核心 .NET 类型的静态方法
    $text = Get-Content -Raw -Path $conf -Encoding UTF8

    # INSTALL_ARGS=( --collect-log "true" ... ) → -CollectLog true ...
    # 受限语言模式禁用 [regex]::Matches，改用 -split 按行 + -match 逐行解析（均为语言运算符，CLM 允许）
    if ($text -match '(?ms)^\s*INSTALL_ARGS\s*=\s*\((.*?)^\s*\)') {
        $body = $Matches[1]
        $parsed = @()
        foreach ($line in ($body -split "`r?`n")) {
            $line = $line.Trim()
            if (-not $line -or $line.StartsWith('#')) { continue }
            # 每行形如 --collect-log "true"，也兼容无值的裸开关 --flag
            if ($line -match '^(--[\w\.\-]+)(?:\s+"([^"]*)")?\s*$') {
                # --collect-log / --user.id → -CollectLog / -UserId
                $name = ($Matches[1].Substring(2) -split '[-\.]' | ForEach-Object {
                    if ($_.Length -gt 0) { $_.Substring(0, 1).ToUpper() + $_.Substring(1) }
                }) -join ''
                $parsed += "-$name"
                if ($Matches[2]) { $parsed += $Matches[2] }
            }
        }
        $script:InstallArgs = $parsed
    }
}

Read-AdminConfig

# --user.id 来源优先级：管理员显式覆盖 > Qoder 注入的 QODER_USER_ID > 解析 hook stdin 的 extra.user.uid
# QODER_USER_ID 仅在 hook 运行时由 Qoder 注入到进程环境（交互 shell 里没有），与 stdin payload 同源
$userId = if ($env:LOONGSUITE_PILOT_USER_ID) { $env:LOONGSUITE_PILOT_USER_ID }
          elseif ($env:QODER_USER_ID) { $env:QODER_USER_ID }
          else { $null }
# 从 stdin 读 hook payload 解析 uid：受限语言模式禁用 [Console]，改用自动变量 $input
# （hook 运行时 Qoder 把 payload 送到 stdin 管道；未重定向时 $input 为空、不阻塞，故无需 IsInputRedirected 守卫）
if (-not $userId) {
    $payload = @($input) -join "`n"
    if ($payload -match '"uid"\s*:\s*"([^"]*)"') { $userId = $Matches[1] }
}
if ($userId) { $InstallArgs += @('-UserId', $userId) }

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
            # 受限语言模式下 Expand-Archive 不可用（Microsoft.PowerShell.Archive 脚本模块内部创建压缩类型被禁），
            # 改用系统自带 tar.exe（bsdtar，Win10 1803+/Server2019+ 内置）解 zip——外部程序，CLM 允许
            & tar.exe -xf $zip -C $extractDir
            if ($LASTEXITCODE -ne 0) { throw "tar 解包失败 (exit $LASTEXITCODE)" }
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

# ---- 测试入口：仅准备 node ----
if ($ProvisionNodeOnly) {
    Initialize-NodeRuntime
    & node -v
    exit 0
}

# ---- 参数指纹：判断"要装的参数是否和上次一致"。installer 对 config.json 是合并语义，
# 参数变更时重新 install 覆盖即可（installer 自身会 merge + 重启，故不再 uninstall -Purge）。
# 指纹不再单独决定退出：还要结合 pilot 是否在运行，避免"装过但进程已死"被误判为无需处理 ----
$FingerprintFile = Join-Path $DataDir 'install-args.sha256'

function Get-ArgsFingerprint {
    # 指纹仅用于“参数是否变化”的本地自比对（从不跨到 bash 侧），无需密码学哈希。
    # 受限语言模式（ConstrainedLanguage）下 Get-FileHash 同样不可用——它是脚本模块 cmdlet，
    # 内部创建 SHA256 类型会触发 “Cannot create type”；[Security.Cryptography]/[Text.Encoding]
    # 静态调用也被禁。故改用纯 PS 双滚动哈希（算术运算符 + String.ToCharArray 均为 CLM 允许），
    # 全程在内存计算不落盘，避免把 license key 明文写进指纹文件。
    $payload = "url=$InstallerUrl`n" + (($InstallArgs | ForEach-Object { "$_`n" }) -join '')
    $h1 = [long]0
    $h2 = [long]0
    foreach ($ch in $payload.ToCharArray()) {
        $code = [long][int]$ch
        $h1 = ($h1 * 131 + $code) % 1000000007
        $h2 = ($h2 * 1000003 + $code) % 998244353
    }
    return "$h1-$h2"
}

$CurrentFp = Get-ArgsFingerprint

function Test-PilotInstalled { Test-Path $PilotCmd }

function Test-FingerprintMatch {
    if (-not (Test-Path $FingerprintFile)) { return $false }
    return ((Get-Content -Raw $FingerprintFile).Trim() -eq $CurrentFp)
}

# pilot 是否在运行：读 pidfile 并确认对应进程存活（与 installer 判活方式一致，不 spawn node）
function Test-PilotRunning {
    $pidFile = Join-Path $PilotHome 'loongsuite-pilot.pid'
    if (-not (Test-Path $pidFile)) { return $false }
    $pidVal = (Get-Content -Raw $pidFile -ErrorAction SilentlyContinue).Trim()
    if ($pidVal -notmatch '^\d+$') { return $false }
    return [bool](Get-Process -Id ([int]$pidVal) -ErrorAction SilentlyContinue)
}

# ---- Invoke-Install：重活（抢锁 + node + 下载 installer + install + 写指纹）----
# 由 detach 出的独立进程（-RunInstall）执行：不随会话退出而中断，也不占用 hook 返回时间。
function Invoke-Install {
    # 并发锁：多会话同时启动时只允许一个实例执行安装。
    # 锁目录内写入持锁进程 PID；接管前先判活——只有 PID 确实已死才回收。detach 出的独立
    # 进程不受 hook 900s 约束，慢装存活时绝不按时间误判回收，否则会拉起第二个并发 install
    # 抢写 config.json。TTL 仅兜底“读不到 PID”的极端情况（刚建尚未写入 / pid 文件损坏）：
    # 读不到 PID 且超过 15 分钟才强制回收。
    $LockTtlMinutes = 15
    $LockPidFile = Join-Path $LockDir 'pid'
    if (Test-Path $LockDir) {
        $lockPid = if (Test-Path $LockPidFile) { (Get-Content -Raw $LockPidFile -ErrorAction SilentlyContinue).Trim() } else { '' }
        $expired = ((Get-Date) - (Get-Item $LockDir).CreationTime).TotalMinutes -gt $LockTtlMinutes
        $alive = ($lockPid -match '^\d+$') -and [bool](Get-Process -Id ([int]$lockPid) -ErrorAction SilentlyContinue)
        if ($alive) {
            Write-Log "另一实例（pid=$lockPid）正在安装，跳过"
            return
        }
        if ((-not $lockPid) -and (-not $expired)) {
            Write-Log '锁刚建立（持有者 PID 写入中），跳过'
            return
        }
        Write-Log "接管失效锁（pid=$(if ($lockPid) { $lockPid } else { '未知' })）"
        Remove-Item $LockDir -Force -Recurse -ErrorAction SilentlyContinue
    }
    try {
        New-Item -ItemType Directory -Path $LockDir -ErrorAction Stop | Out-Null
    } catch {
        Write-Log '另一实例正在安装，跳过'
        return
    }
    Set-Content -Path $LockPidFile -Value $PID -Encoding ASCII

    try {
        # 拿到锁后重新判定：可能另一实例已经装好了相同配置
        if ((Test-PilotInstalled) -and (Test-FingerprintMatch)) { return }

        # 未安装 → 直接装；已装但指纹不一致 → 重新 install 覆盖（不再 uninstall -Purge，保留本地数据）
        # 与 bash 侧一致：installer 的 install 自身会停旧进程、merge 覆盖并重启（含被运行中 node.exe/
        # wscript 启动器占用的文件），Windows 上实测可直接覆盖，无需预先手动停机/杀进程/删计划任务
        if (Test-PilotInstalled) {
            Write-Log '已安装但参数指纹不一致，按新配置重新 install（install 会停旧进程、merge 覆盖并重启）'
        }
        Write-Log "installer: $InstallerUrl"
        Write-Log "install args: $($InstallArgs -join ' ')"

        Initialize-NodeRuntime

        $installerTmp = Join-Path $DataDir 'installer.ps1'
        Invoke-WebRequest -Uri $InstallerUrl -OutFile $installerTmp -UseBasicParsing

        $rc = Invoke-Logged (@($installerTmp, 'install') + $InstallArgs)
        if ($rc -ne 0) { throw "installer exited with code $rc" }

        Set-Content -Path $FingerprintFile -Value $CurrentFp -Encoding ASCII
        # 直接调 .cmd 并取回字符串（不进管道），避免后台进程持有句柄导致挂死
        $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        $status = (& $PilotCmd status 2>$null) -join ' '
        $ErrorActionPreference = $prevEap
        Write-Log "✅ 安装完成。status: $status"
    } catch {
        Write-Log "❌ 安装失败: $($_.Exception.Message)"
    } finally {
        # 仅释放自己持有的锁：校验锁内 PID == 自己，避免误删被其它实例接管后重建的锁
        $ownerPid = if (Test-Path $LockPidFile) { (Get-Content -Raw $LockPidFile -ErrorAction SilentlyContinue).Trim() } else { '' }
        if ($ownerPid -eq "$PID") { Remove-Item $LockDir -Force -Recurse -ErrorAction SilentlyContinue }
    }
}

# ---- detached 独立进程入口：直接执行重活，跳过下面的快路径/detach，避免 fork 炸弹 ----
if ($RunInstall) { Invoke-Install; exit 0 }

# ---- 幂等快路径（每次会话启动都会触发本 hook，毫秒级）----
# 已安装 + 参数未变：在跑则秒过；进程已死则直接 start 复活（秒级，无需重新下载/安装）
if ((Test-PilotInstalled) -and (Test-FingerprintMatch)) {
    if (Test-PilotRunning) { exit 0 }
    Write-Log '已安装且参数未变，但服务未运行，尝试拉起'
    $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & $PilotCmd start *>> $LogFile
    $rc = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($rc -eq 0) { Write-Log '✅ 服务已拉起' } else { Write-Log "⚠️ 服务拉起失败 (rc=$rc)，详见日志" }
    exit 0
}

# ---- 需要安装/重装：detach 出独立进程执行重活，hook 立即返回 ----
# 好处：① 不阻塞会话 ② 分钟级安装不随 CLI 退出被腰斩（Start-Process 为独立进程）
# uid 靠 env 传给独立进程：其无 stdin payload，无法再从 stdin 解析 extra.user.uid
if ($userId) { $env:LOONGSUITE_PILOT_USER_ID = $userId }
Write-Log '触发后台安装/重装，detach 独立进程执行'
Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-RunInstall'
) | Out-Null
# stdout 作为 SessionStart 附加上下文注入对话，让用户知道正在后台安装
Write-Output "loongsuite-pilot 正在后台自动安装，完成后自动生效（详见 $LogFile）"
exit 0
