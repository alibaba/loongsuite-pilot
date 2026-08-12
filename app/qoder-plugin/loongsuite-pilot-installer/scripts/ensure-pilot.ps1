# loongsuite-pilot-installer plugin SessionStart hook (Windows).
# Equivalent to ensure-pilot.sh -- idempotently detect and install loongsuite-pilot.
# The node runtime is prepared by the installer itself; this hook no longer deals with it.
# Admin parameters come from the same config\install-params.conf; kebab-case keys are
# converted to the PascalCase parameters installer.ps1 expects.
# Usage: ensure-pilot.ps1
[CmdletBinding()]
param(
    [switch]$RunInstall   # for the detached child process: do the heavy work directly, no second detach
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$PluginRoot = if ($env:QODER_PLUGIN_ROOT) { $env:QODER_PLUGIN_ROOT } else { Split-Path -Parent $PSScriptRoot }
$DataDir = if ($env:QODER_PLUGIN_DATA) { $env:QODER_PLUGIN_DATA } else { Join-Path $env:USERPROFILE '.loongsuite-pilot-installer' }
$LogFile = Join-Path $DataDir 'install.log'
$LockDir = Join-Path $DataDir 'install.lock'
$PilotCmd = Join-Path $env:USERPROFILE '.local\bin\loongsuite-pilot.cmd'
$PilotHome = Join-Path $env:USERPROFILE '.loongsuite-pilot'   # pilot data dir (default); holds the pid file used for liveness checks

# ---- Plugin built-in constant: installer URL (maintainer-owned, not admin-configurable) ----
$InstallerUrl = 'https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.ps1'
# Admin parameters: only InstallArgs is read from config\install-params.conf
$InstallArgs = @()

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
function Write-Log($msg) {
    # Explicit UTF8: Add-Content defaults to ANSI/GBK, which garbles non-ASCII log text
    "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg | Add-Content -Path $LogFile -Encoding UTF8
}

# ---- Parse install-params.conf (bash syntax): read only the admin parameter INSTALL_ARGS ----
# The installer URL is a plugin built-in constant and is not read from the conf.
function Read-AdminConfig {
    $conf = Join-Path $PluginRoot 'config\install-params.conf'
    if (-not (Test-Path $conf)) { return }
    # Must be read as UTF-8 explicitly: the conf carries non-ASCII comments and has no BOM,
    # so PS 5.1's default ANSI/GBK decoding swallows following ASCII bytes and breaks the
    # line structure of the INSTALL_ARGS block.
    # Use Get-Content -Encoding UTF8 (a cmdlet) rather than [System.IO.File]::ReadAllText:
    # ConstrainedLanguage mode forbids static method calls on non-core .NET types.
    $text = Get-Content -Raw -Path $conf -Encoding UTF8

    # INSTALL_ARGS=( --collect-log "true" ... ) -> -CollectLog true ...
    # ConstrainedLanguage forbids [regex]::Matches; split into lines with -split and parse
    # each one with -match instead (both are language operators, allowed under CLM).
    if ($text -match '(?ms)^\s*INSTALL_ARGS\s*=\s*\((.*?)^\s*\)') {
        $body = $Matches[1]
        $parsed = @()
        foreach ($line in ($body -split "`r?`n")) {
            $line = $line.Trim()
            if (-not $line -or $line.StartsWith('#')) { continue }
            # Each line looks like --collect-log "true"; a bare valueless switch --flag also works
            if ($line -match '^(--[\w\.\-]+)(?:\s+"([^"]*)")?\s*$') {
                # --collect-log / --user.id -> -CollectLog / -UserId
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

# Priority for --user.id: explicit admin override > QODER_USER_ID injected by Qoder >
# extra.user.uid parsed from the hook's stdin payload.
# QODER_USER_ID is injected into the process environment only while a hook runs (it is
# absent in an interactive shell) and has the same origin as the stdin payload.
$userId = if ($env:LOONGSUITE_PILOT_USER_ID) { $env:LOONGSUITE_PILOT_USER_ID }
          elseif ($env:QODER_USER_ID) { $env:QODER_USER_ID }
          else { $null }
# Read the hook payload from stdin to get the uid: ConstrainedLanguage forbids [Console],
# so use the automatic variable $input instead. (While a hook runs Qoder pipes the payload
# to stdin; when not redirected $input is empty and does not block, so no
# IsInputRedirected guard is needed.)
if (-not $userId) {
    $payload = @($input) -join "`n"
    if ($payload -match '"uid"\s*:\s*"([^"]*)"') { $userId = $Matches[1] }
}
if ($userId) { $InstallArgs += @('-UserId', $userId) }

# ---- Run a child process and append all of its streams to the log ----
# File redirection is mandatory here rather than `| Add-Content`:
#   * a pipeline waits for the stdout handle to close, and the daemon the installer starts
#     inherits that handle -> hangs forever
#   * under EAP=Stop the child's stderr through a pipeline becomes a terminating error
function Invoke-Logged([string[]]$PsArgs) {
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File @PsArgs *>> $LogFile
        return $LASTEXITCODE
    } finally { $ErrorActionPreference = $prevEap }
}

# ---- Argument fingerprint: decides whether what we are about to install matches last
# time. The installer merges into config.json, so on a parameter change re-running install
# to overwrite is enough (the installer itself merges and restarts, hence no
# uninstall -Purge). The fingerprint alone no longer decides the exit: pilot liveness is
# checked too, so "installed but the process died" is not mistaken for nothing-to-do ----
$FingerprintFile = Join-Path $DataDir 'install-args.sha256'

function Get-ArgsFingerprint {
    # The fingerprint is only a local self-comparison of "did the parameters change" (it
    # never crosses over to the bash side), so no cryptographic hash is needed.
    # Get-FileHash is unavailable under ConstrainedLanguage as well -- it is a
    # script-module cmdlet whose internal SHA256 type creation trips "Cannot create type",
    # and static calls on [Security.Cryptography] / [Text.Encoding] are forbidden too.
    # Hence a pure-PS double rolling hash (arithmetic operators plus String.ToCharArray,
    # both CLM-allowed), computed entirely in memory so the license key never lands in the
    # fingerprint file.
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

# Is pilot running: read the pidfile and confirm that process is alive (same liveness
# check the installer uses; does not spawn node)
function Test-PilotRunning {
    $pidFile = Join-Path $PilotHome 'loongsuite-pilot.pid'
    if (-not (Test-Path $pidFile)) { return $false }
    $pidVal = (Get-Content -Raw $pidFile -ErrorAction SilentlyContinue).Trim()
    if ($pidVal -notmatch '^\d+$') { return $false }
    return [bool](Get-Process -Id ([int]$pidVal) -ErrorAction SilentlyContinue)
}

# ---- Invoke-Install: the heavy work (take the lock, download the installer, install,
# write the fingerprint; node is provided by the installer itself) ----
# Runs in the detached child process (-RunInstall): it is not cut short when the session
# exits, and it does not eat into the hook's return time.
function Invoke-Install {
    # Concurrency lock: when several sessions start at once, only one instance installs.
    # The holder's PID is written inside the lock dir; check liveness before taking over --
    # reclaim only once that PID is really dead. The detached child is not bound by the
    # hook's 900s limit, so a slow-but-alive install must never be reclaimed on a timer;
    # that would start a second concurrent install racing to write config.json. The TTL
    # only covers the corner case of an unreadable PID (lock just created and not yet
    # written / pid file corrupt): force-reclaim only after 15 minutes with no readable PID.
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
        # Re-check after taking the lock: another instance may already have installed the same config
        if ((Test-PilotInstalled) -and (Test-FingerprintMatch)) { return }

        # Not installed -> install. Installed but fingerprint differs -> re-run install to
        # overwrite (no uninstall -Purge, so local data survives).
        # Same as the bash side: the installer's install stops the old process, merges,
        # overwrites and restarts (including files held open by a running node.exe /
        # wscript launcher). Verified on Windows: overwriting in place works, so no manual
        # stop / kill / scheduled-task removal is needed first.
        if (Test-PilotInstalled) {
            Write-Log '已安装但参数指纹不一致，按新配置重新 install（install 会停旧进程、merge 覆盖并重启）'
        }
        Write-Log "installer: $InstallerUrl"
        Write-Log "install args: $($InstallArgs -join ' ')"

        $installerTmp = Join-Path $DataDir 'installer.ps1'
        Invoke-WebRequest -Uri $InstallerUrl -OutFile $installerTmp -UseBasicParsing

        $rc = Invoke-Logged (@($installerTmp, 'install') + $InstallArgs)
        if ($rc -ne 0) { throw "installer exited with code $rc" }

        Set-Content -Path $FingerprintFile -Value $CurrentFp -Encoding ASCII
        # Call the .cmd directly and take the string back rather than piping it, so a
        # background process holding the pipe handle cannot hang us
        $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        $status = (& $PilotCmd status 2>$null) -join ' '
        $ErrorActionPreference = $prevEap
        Write-Log "✅ 安装完成。status: $status"
    } catch {
        Write-Log "❌ 安装失败: $($_.Exception.Message)"
    } finally {
        # Release only our own lock: check that the PID inside matches ours, so we never
        # delete a lock another instance took over and recreated
        $ownerPid = if (Test-Path $LockPidFile) { (Get-Content -Raw $LockPidFile -ErrorAction SilentlyContinue).Trim() } else { '' }
        if ($ownerPid -eq "$PID") { Remove-Item $LockDir -Force -Recurse -ErrorAction SilentlyContinue }
    }
}

# ---- Detached-process entry point: do the heavy work directly, skipping the fast path
# and the detach below, to avoid a fork bomb ----
if ($RunInstall) { Invoke-Install; exit 0 }

# ---- Idempotent fast path (this hook fires on every session start, so it has to be
# millisecond-scale) ----
# Installed and parameters unchanged: instant pass if it is running; if the process died,
# just start it again (seconds, no re-download / re-install).
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

# ---- Install/reinstall needed: detach a child process for the heavy work and return
# from the hook immediately ----
# Why: (1) the session is not blocked; (2) a minutes-long install is not cut short when
# the CLI exits (Start-Process gives an independent process).
# The uid is handed to the child through the environment: it has no stdin payload and
# cannot parse extra.user.uid from stdin again.
if ($userId) { $env:LOONGSUITE_PILOT_USER_ID = $userId }
Write-Log '触发后台安装/重装，detach 独立进程执行'
Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-RunInstall'
) | Out-Null
# stdout is injected into the conversation as SessionStart context, so the user knows an
# install is running in the background
Write-Output "loongsuite-pilot 正在后台自动安装，完成后自动生效（详见 $LogFile）"
exit 0
