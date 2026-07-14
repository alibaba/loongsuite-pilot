# loongsuite-pilot.ps1 — Service management for loongsuite-pilot (Windows)
# Uses Windows Task Scheduler for autostart (analogous to macOS launchd)
#
# Usage:
#   loongsuite-pilot start
#   loongsuite-pilot stop
#   loongsuite-pilot restart
#   loongsuite-pilot status
#   loongsuite-pilot info
#   loongsuite-pilot rollback
#   loongsuite-pilot help

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command = "status",

    [Parameter(Position = 1, ValueFromRemainingArguments)]
    [string[]]$SubArgs
)

$ErrorActionPreference = "Stop"

# ============================================================
# Constants & Paths
# ============================================================
$CACHE_DIR = Join-Path $env:USERPROFILE ".loongsuite-pilot"
$DATA_DIR = if ($env:LOONGSUITE_PILOT_DATA_DIR) { $env:LOONGSUITE_PILOT_DATA_DIR } else { $CACHE_DIR }
$VERSIONS_DIR = Join-Path $CACHE_DIR "versions"
$CURRENT_FILE = Join-Path $CACHE_DIR "current"
$PREVIOUS_FILE = Join-Path $CACHE_DIR "previous"
$BOOTSTRAP_DIR = Join-Path $CACHE_DIR "bin"
$PACKAGE_DIR = Join-Path $CACHE_DIR "package"
$PID_FILE = Join-Path $DATA_DIR "loongsuite-pilot.pid"
$UPDATER_PID_FILE = Join-Path $DATA_DIR "loongsuite-pilot-updater.pid"
$LOG_DIR = Join-Path $DATA_DIR "logs"
$LOG_FILE = Join-Path $LOG_DIR "loongsuite-pilot-service.log"
$UPDATER_LOG_FILE = Join-Path $LOG_DIR "loongsuite-pilot-updater.log"
$CONFIG_FILE = Join-Path $DATA_DIR "config.json"
$SPAN_ATTR_FILE = Join-Path $DATA_DIR "span-attributes.json"
$NODE_PIN_FILE = Join-Path $CACHE_DIR "node-bin"
$INIT_TYPE_FILE = Join-Path $DATA_DIR "init-type"

# Task names are per-user: multiple users can run on one machine, each with their
# own data dir under %USERPROFILE%. A global task name would collide -- the second
# user cannot delete or overwrite the first user's task (Access is denied), so it
# would fail with "already exists" and drop to the background fallback. The shared
# \LoongsuitePilot folder stays cross-user writable; only the task name is scoped.
# Tag from whoami (DOMAIN\user) -- the same identity used for the task principal --
# not $env:USERNAME (bare SAM name): two same-named accounts from different domains
# (CORP\alice vs DEV\alice) would otherwise share one task name and re-introduce the
# cross-user "already exists" collision this scoping is meant to prevent.
$USER_TAG = ((whoami) -replace '[^A-Za-z0-9._-]', '_')
$TASK_NAME_COLLECTOR = "LoongsuitePilot-$USER_TAG"
$TASK_NAME_UPDATER = "LoongsuitePilotUpdater-$USER_TAG"
$TASK_FOLDER = "\LoongsuitePilot"

# Legacy global task names (pre per-user naming) -- cleaned up best-effort on start.
$LEGACY_TASK_NAMES = @("LoongsuitePilot", "LoongsuitePilotUpdater")

$LOONGSUITE_PILOT_BIN = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot.cmd"

# ============================================================
# Helpers
# ============================================================
function Ensure-Dirs {
    @($LOG_DIR, $BOOTSTRAP_DIR) | ForEach-Object {
        if (-not (Test-Path $_)) { New-Item -ItemType Directory -Path $_ -Force | Out-Null }
    }
}

function Test-NodeSuitable {
    param([string]$bin)
    if (-not $bin -or -not (Test-Path $bin)) { return $false }
    try {
        $ver = & $bin --version 2>$null
        if (-not $ver) { return $false }
        $major = [int]($ver -replace '^v','').Split('.')[0]
        return $major -ge 18
    } catch { return $false }
}

function Resolve-Node {
    # 1. Pinned file
    if (Test-Path $NODE_PIN_FILE) {
        $pinned = (Get-Content $NODE_PIN_FILE -ErrorAction SilentlyContinue).Trim()
        if ($pinned -and (Test-NodeSuitable $pinned)) {
            return $pinned
        }
    }

    # 2. Fallback search
    $candidates = @()

    # nvm-windows
    if ($env:NVM_HOME -and (Test-Path $env:NVM_HOME)) {
        Get-ChildItem $env:NVM_HOME -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { $candidates += Join-Path $_.FullName "node.exe" }
    }

    # fnm
    $fnmDir = Join-Path $env:USERPROFILE ".fnm\node-versions"
    if (Test-Path $fnmDir) {
        Get-ChildItem $fnmDir -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { $candidates += Join-Path $_.FullName "installation\node.exe" }
    }

    # Volta, standard paths
    $candidates += Join-Path $env:USERPROFILE ".volta\bin\node.exe"
    $candidates += "C:\Program Files\nodejs\node.exe"
    $candidates += "C:\Program Files (x86)\nodejs\node.exe"

    # PATH lookup
    $pathNode = Get-Command node -ErrorAction SilentlyContinue
    if ($pathNode) { $candidates += $pathNode.Source }

    foreach ($c in $candidates) {
        if (Test-NodeSuitable $c) {
            # Auto-heal: update pin file
            $parentDir = Split-Path $NODE_PIN_FILE
            if (-not (Test-Path $parentDir)) { New-Item -ItemType Directory -Path $parentDir -Force | Out-Null }
            Set-Content -Path $NODE_PIN_FILE -Value $c
            return $c
        }
    }
    return $null
}

function Sync-BootstrapScripts {
    $versionDir = Resolve-CurrentVersion
    if (-not $versionDir) { return }
    $srcDir = Join-Path $versionDir "scripts"
    $collectorSrc = Join-Path $srcDir "collector-daemon.js"
    if (-not (Test-Path $collectorSrc)) { return }
    if (-not (Test-Path $BOOTSTRAP_DIR)) { New-Item -ItemType Directory -Path $BOOTSTRAP_DIR -Force | Out-Null }
    Copy-Item $collectorSrc $BOOTSTRAP_DIR -Force
    $updaterSrc = Join-Path $srcDir "updater-daemon.js"
    if (Test-Path $updaterSrc) { Copy-Item $updaterSrc $BOOTSTRAP_DIR -Force }
}

function Sync-InstalledScriptsFromVersion {
    param([string]$versionDir)
    $srcDir = Join-Path $versionDir "scripts"
    $required = @("collector-daemon.js", "updater-daemon.js")
    foreach ($f in $required) {
        if (-not (Test-Path (Join-Path $srcDir $f))) { return $false }
    }

    if (-not (Test-Path $BOOTSTRAP_DIR)) { New-Item -ItemType Directory -Path $BOOTSTRAP_DIR -Force | Out-Null }
    foreach ($f in $required) {
        $tmp = Join-Path $BOOTSTRAP_DIR "$f.tmp"
        Copy-Item (Join-Path $srcDir $f) $tmp -Force
        Move-Item $tmp (Join-Path $BOOTSTRAP_DIR $f) -Force
    }
    return $true
}

# ============================================================
# Version resolution
# ============================================================
function Resolve-CurrentVersion {
    if (Test-Path $CURRENT_FILE) {
        $dir = (Get-Content $CURRENT_FILE -ErrorAction SilentlyContinue).Trim()
        $path = Join-Path $VERSIONS_DIR $dir
        if ($dir -and (Test-Path $path)) { return $path }
    }
    $indexJs = Join-Path $PACKAGE_DIR "dist\index.js"
    if (Test-Path $indexJs) { return $PACKAGE_DIR }
    return $null
}

function Resolve-PreviousVersion {
    if (Test-Path $PREVIOUS_FILE) {
        $dir = (Get-Content $PREVIOUS_FILE -ErrorAction SilentlyContinue).Trim()
        $path = Join-Path $VERSIONS_DIR $dir
        if ($dir -and (Test-Path $path)) { return $path }
    }
    return $null
}

function Get-VersionInfo {
    param([string]$dir)
    $vf = Join-Path $dir "VERSION"
    $info = @{ version = ""; git_commit = ""; build_time = "" }
    if (Test-Path $vf) {
        Get-Content $vf | ForEach-Object {
            if ($_ -match "^(\w+)=(.+)$") {
                $info[$Matches[1]] = $Matches[2]
            }
        }
    }
    return $info
}

function Show-VersionString {
    param([string]$dir)
    $info = Get-VersionInfo $dir
    if ($info.version) {
        return "v$($info.version) ($($info.git_commit), $($info.build_time))"
    }
    return "unknown"
}

# ============================================================
# Process management
# ============================================================
function Test-PidRunning {
    param([string]$pidFile)
    if (-not (Test-Path $pidFile)) { return $false }
    $pidVal = (Get-Content $pidFile -ErrorAction SilentlyContinue).Trim()
    if (-not $pidVal) {
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        return $false
    }
    $proc = Get-Process -Id $pidVal -ErrorAction SilentlyContinue
    if ($proc) { return $true }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    return $false
}

function Stop-PidFile {
    param([string]$pidFile)
    if (-not (Test-PidRunning $pidFile)) {
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        return
    }
    $pidVal = (Get-Content $pidFile -ErrorAction SilentlyContinue).Trim()
    try { Stop-Process -Id $pidVal -ErrorAction SilentlyContinue } catch {}
    $count = 0
    while ($count -lt 10) {
        $proc = Get-Process -Id $pidVal -ErrorAction SilentlyContinue
        if (-not $proc) { break }
        Start-Sleep -Seconds 1
        $count++
    }
    # Force kill if still running
    try { Stop-Process -Id $pidVal -Force -ErrorAction SilentlyContinue } catch {}
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

function Stop-OrphanProcesses {
    Get-Process -Name "node" -ErrorAction SilentlyContinue |
        Where-Object {
            try {
                $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine
                $cmdLine -match "collector-daemon" -or $cmdLine -match "updater-daemon"
            } catch { $false }
        } | ForEach-Object {
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }
}

# ============================================================
# Task Scheduler management
# ============================================================
function Get-TaskExists {
    param([string]$taskName)
    $task = Get-ScheduledTask -TaskName $taskName -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
    return $null -ne $task
}

function Get-TaskRunning {
    param([string]$taskName)
    $task = Get-ScheduledTask -TaskName $taskName -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
    if (-not $task) { return $false }
    return $task.State -eq "Running"
}

# Register a scheduled task, trying S4U first, then falling back to Interactive.
# S4U runs under the user's identity in a non-interactive session (survives
# RDP/SSH disconnect, no stored password) but requires the "Log on as a batch
# job" right, which standard (non-admin) users lack -- so S4U registration throws
# "Access is denied" (0x80070005) for them. Interactive needs no special right and
# still auto-starts at logon, so it is the fallback before dropping to a plain
# background process.
function Register-PilotTask {
    param(
        [string]$taskName,
        $action,
        $triggers,
        $settings,
        [string]$description
    )
    $userId = whoami
    $lastErr = $null
    foreach ($logonType in @("S4U", "Interactive")) {
        # Clear any task a previous attempt left behind. A failed S4U registration
        # can still create the task entry before erroring on the principal, which
        # would make the Interactive retry fail with "already exists".
        try { schtasks.exe /Delete /TN "$TASK_FOLDER\$taskName" /F 2>$null | Out-Null } catch {}
        try {
            # On-disk location of the task definition (absolute filesystem path).
            $diskPath = "$env:SystemRoot\System32\Tasks$TASK_FOLDER\$taskName"
            Write-Host "   Registering '$taskName' (user=$userId, logon=$logonType, path=$diskPath)..."
            $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType $logonType -RunLevel Limited
            Register-ScheduledTask `
                -TaskName $taskName `
                -TaskPath "$TASK_FOLDER\" `
                -Action $action `
                -Trigger $triggers `
                -Settings $settings `
                -Principal $principal `
                -Description $description `
                -ErrorAction Stop | Out-Null
            Write-Host "   Registered '$taskName' with logon type $logonType" -ForegroundColor Green
            return $true
        } catch {
            $lastErr = $_
            # Log every attempt (incl. HRESULT) so the failing logon type is
            # visible, not just the last error thrown to the caller.
            $hr = ""
            if ($_.Exception -and $null -ne $_.Exception.HResult) {
                $hr = " (HRESULT 0x{0:X8})" -f $_.Exception.HResult
            }
            Write-Host "   $logonType registration failed$hr : $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
    throw $lastErr
}

# Build a VBScript launcher that runs node fully hidden, and return a task action
# that invokes it via wscript.exe. Interactive-principal tasks run in the user's
# desktop session, where powershell.exe still pops a console window despite
# -WindowStyle Hidden (the window the user sees). wscript.exe is a GUI-subsystem
# host (no console of its own) and WshShell.Run(cmd, 0, True) launches node with a
# hidden window and waits for it, so the task stays "Running" and the repeating
# watchdog trigger keeps working -- but nothing is visible and there is no window
# to accidentally close. Paths are baked into the .vbs (no argument passing) to
# avoid quoting issues across the Task Scheduler + wscript layers.
function New-HiddenTaskAction {
    param([string]$vbsPath, [string]$nodeBin, [string]$entry)
    # Double any embedded quote so a path with a " cannot terminate the VBScript
    # string literal early (defensive: Windows paths cannot contain ", but
    # $CONFIG_FILE/$CACHE_DIR derive from the user-settable LOONGSUITE_PILOT_DATA_DIR).
    $cfgEsc   = $CONFIG_FILE -replace '"', '""'
    $cwdEsc   = $CACHE_DIR   -replace '"', '""'
    $nodeEsc  = $nodeBin     -replace '"', '""'
    $entryEsc = $entry       -replace '"', '""'
    $vbs = @"
Set sh = CreateObject("WScript.Shell")
sh.Environment("PROCESS").Item("AGENT_DATA_COLLECTION_CONFIG") = "$cfgEsc"
sh.CurrentDirectory = "$cwdEsc"
sh.Run """$nodeEsc"" ""$entryEsc""", 0, True
"@
    # Unicode (UTF-16 LE + BOM): wscript reads a BOM-less .vbs as the system ANSI
    # code page, while -Encoding Default is ANSI on Windows PowerShell 5.1 but UTF-8
    # on PowerShell 7+. A non-ASCII path (e.g. a Chinese %USERPROFILE%) would then be
    # mojibake and the daemon would fail to launch. A BOM is read correctly
    # regardless of PowerShell version or system code page.
    Set-Content -Path $vbsPath -Value $vbs -Encoding Unicode
    return (New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbsPath`"" -WorkingDirectory $CACHE_DIR)
}

function Install-CollectorTask {
    param([string]$nodeBin)
    $entry = Join-Path $BOOTSTRAP_DIR "collector-daemon.js"
    if (-not (Test-Path $entry)) {
        Write-Host "Bootstrap script missing: $entry"
        return $false
    }

    $action = New-HiddenTaskAction (Join-Path $BOOTSTRAP_DIR "collector-launch.vbs") $nodeBin $entry

    # Two triggers: AtLogOn for initial start + repeating every 5 min as a watchdog.
    # If the process crashes or is killed, the repeating trigger re-launches it.
    # MultipleInstances=IgnoreNew ensures a second instance is never spawned while running.
    # -User scopes the logon trigger to the current user; without it the trigger
    # fires for ALL users, which requires admin rights and fails registration with
    # "Access is denied" (0x80070005) for standard users.
    $triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User (whoami)
    $triggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date) `
        -RepetitionInterval (New-TimeSpan -Minutes 5)

    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -DontStopOnIdleEnd `
        -MultipleInstances IgnoreNew `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero)

    # Remove existing task first (schtasks is more reliable than Unregister-ScheduledTask)
    # Use try/catch because schtasks stderr + $ErrorActionPreference=Stop can throw
    try { schtasks.exe /Delete /TN "$TASK_FOLDER\$TASK_NAME_COLLECTOR" /F 2>$null | Out-Null } catch {}
    try { schtasks.exe /Delete /TN "$TASK_NAME_COLLECTOR" /F 2>$null | Out-Null } catch {}

    return (Register-PilotTask `
        -taskName $TASK_NAME_COLLECTOR `
        -action $action `
        -triggers @($triggerLogon, $triggerRepeat) `
        -settings $settings `
        -description "LoongSuite Pilot data collector")
}

function Install-UpdaterTask {
    param([string]$nodeBin)
    $entry = Join-Path $BOOTSTRAP_DIR "updater-daemon.js"
    if (-not (Test-Path $entry)) { return $false }

    $action = New-HiddenTaskAction (Join-Path $BOOTSTRAP_DIR "updater-launch.vbs") $nodeBin $entry

    # -User scopes the trigger to the current user (all-users trigger needs admin).
    $triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User (whoami)
    $triggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date) `
        -RepetitionInterval (New-TimeSpan -Minutes 5)

    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -DontStopOnIdleEnd `
        -MultipleInstances IgnoreNew `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 5) `
        -ExecutionTimeLimit ([TimeSpan]::Zero)

    try { schtasks.exe /Delete /TN "$TASK_FOLDER\$TASK_NAME_UPDATER" /F 2>$null | Out-Null } catch {}
    try { schtasks.exe /Delete /TN "$TASK_NAME_UPDATER" /F 2>$null | Out-Null } catch {}

    return (Register-PilotTask `
        -taskName $TASK_NAME_UPDATER `
        -action $action `
        -triggers @($triggerLogon, $triggerRepeat) `
        -settings $settings `
        -description "LoongSuite Pilot auto-updater")
}

function Remove-AllTasks {
    foreach ($name in @($TASK_NAME_UPDATER, $TASK_NAME_COLLECTOR)) {
        $task = Get-ScheduledTask -TaskName $name -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
        if ($task) {
            if ($task.State -eq "Running") {
                Stop-ScheduledTask -TaskName $name -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
            }
        }
        try { schtasks.exe /Delete /TN "$TASK_FOLDER\$name" /F 2>$null | Out-Null } catch {}
        try { schtasks.exe /Delete /TN "$name" /F 2>$null | Out-Null } catch {}
    }
    # Clean up the hidden VBScript launchers created by New-HiddenTaskAction so
    # removing the tasks leaves no orphaned launcher scripts behind.
    foreach ($vbs in @("collector-launch.vbs", "updater-launch.vbs")) {
        Remove-Item (Join-Path $BOOTSTRAP_DIR $vbs) -Force -ErrorAction SilentlyContinue
    }
}

# ============================================================
# CMD: run (foreground, called by Task Scheduler)
# ============================================================
function Cmd-Run {
    Ensure-Dirs
    Sync-BootstrapScripts

    $entry = Join-Path $BOOTSTRAP_DIR "collector-daemon.js"
    if (-not (Test-Path $entry)) {
        Write-Error "Bootstrap script missing"
        exit 1
    }

    $nodeBin = Resolve-Node
    if (-not $nodeBin) {
        Write-Error "node runtime not found"
        exit 1
    }

    Set-Content -Path $PID_FILE -Value $PID
    $env:AGENT_DATA_COLLECTION_CONFIG = $CONFIG_FILE
    & $nodeBin $entry
}

function Cmd-RunUpdater {
    Ensure-Dirs
    Sync-BootstrapScripts

    $entry = Join-Path $BOOTSTRAP_DIR "updater-daemon.js"
    if (-not (Test-Path $entry)) {
        Write-Error "Bootstrap script missing"
        exit 1
    }

    $nodeBin = Resolve-Node
    if (-not $nodeBin) {
        Write-Error "node runtime not found"
        exit 1
    }

    Set-Content -Path $UPDATER_PID_FILE -Value $PID
    $env:AGENT_DATA_COLLECTION_CONFIG = $CONFIG_FILE
    & $nodeBin $entry
}

# ============================================================
# CMD: start
# ============================================================
function Cmd-Start {
    if (Test-PidRunning $PID_FILE) {
        $pidVal = (Get-Content $PID_FILE).Trim()
        Write-Host "loongsuite-pilot is already running (PID $pidVal)"
        return
    }

    Ensure-Dirs
    Sync-BootstrapScripts

    $nodeBin = Resolve-Node
    if (-not $nodeBin) {
        Write-Error "node runtime not found"
        exit 1
    }
    Write-Host "   node: $nodeBin"
    Write-Host "   bootstrap dir: $BOOTSTRAP_DIR"
    Write-Host "   config: $CONFIG_FILE"

    # Best-effort cleanup of legacy global-named tasks from older versions. If they
    # are owned by another account (e.g. an earlier admin run) the delete is denied
    # and simply left alone -- the per-user task name avoids colliding with them.
    foreach ($legacy in $LEGACY_TASK_NAMES) {
        try { schtasks.exe /Delete /TN "$TASK_FOLDER\$legacy" /F 2>$null | Out-Null } catch {}
    }

    # Try Task Scheduler
    $taskInstalled = $false
    try {
        $ok1 = Install-CollectorTask $nodeBin
        $ok2 = Install-UpdaterTask $nodeBin
        if ($ok1) {
            Start-ScheduledTask -TaskName $TASK_NAME_COLLECTOR -TaskPath "$TASK_FOLDER\" -ErrorAction Stop
            if ($ok2) {
                Start-ScheduledTask -TaskName $TASK_NAME_UPDATER -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
            }
            Set-Content -Path $INIT_TYPE_FILE -Value "taskscheduler"
            for ($i = 0; $i -lt 5; $i++) {
                Start-Sleep -Seconds 2
                if (Get-TaskRunning $TASK_NAME_COLLECTOR) {
                    Write-Host "loongsuite-pilot started (Task Scheduler)"
                    return
                }
            }
            # Registered but never reached Running within 10s. The task is installed
            # with a 5-min watchdog trigger, so do NOT drop to the background fallback:
            # that would start a second collector alongside the task once the watchdog
            # fires (duplicate collection). Surface the last result and let the
            # watchdog keep retrying -- autostart is already configured.
            $t = Get-ScheduledTaskInfo -TaskName $TASK_NAME_COLLECTOR -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
            $rc = if ($t) { "0x{0:X8}" -f $t.LastTaskResult } else { "unknown" }
            Write-Host "Task registered but not running after 10s (LastTaskResult=$rc)." -ForegroundColor Yellow
            Write-Host "   Autostart is configured; the 5-min watchdog trigger will keep retrying." -ForegroundColor Yellow
            Write-Host "   Check the task in Task Scheduler and the log below." -ForegroundColor Yellow
            return
        }
    } catch {
        $hr = ""
        if ($_.Exception -and $null -ne $_.Exception.HResult) {
            $hr = " (HRESULT 0x{0:X8})" -f $_.Exception.HResult
        }
        Write-Host "Task Scheduler registration failed$hr : $($_.Exception.Message)" -ForegroundColor Yellow
    }

    # Fallback: background process (like nohup on Linux).
    # Remove any task that may have been registered before we hit the error above
    # (e.g. collector registered, then updater registration threw): leaving it in
    # place would let its logon/watchdog trigger start a second collector alongside
    # the background process below. Background mode owns the lifecycle from here.
    Remove-AllTasks
    Write-Host "Using background process fallback." -ForegroundColor Yellow
    Write-Host "   Service will NOT auto-start on boot." -ForegroundColor Yellow
    Write-Host "   stdout log: $LOG_FILE" -ForegroundColor Yellow
    Write-Host "   stderr log: $(Join-Path $LOG_DIR 'loongsuite-pilot-service-err.log')" -ForegroundColor Yellow

    $entry = Join-Path $BOOTSTRAP_DIR "collector-daemon.js"
    if (-not (Test-Path $entry)) {
        Write-Error "Bootstrap script missing"
        exit 1
    }

    $errLog = Join-Path $LOG_DIR "loongsuite-pilot-service-err.log"
    $proc = Start-Process -FilePath "powershell.exe" `
        -ArgumentList "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -Command `"`$env:AGENT_DATA_COLLECTION_CONFIG='$CONFIG_FILE'; & '$nodeBin' '$entry' >> '$LOG_FILE' 2>> '$errLog'`"" `
        -WorkingDirectory $CACHE_DIR `
        -WindowStyle Hidden `
        -PassThru

    Set-Content -Path $PID_FILE -Value $proc.Id
    Set-Content -Path $INIT_TYPE_FILE -Value "background"
    Write-Host "loongsuite-pilot started (PID $($proc.Id), background)"

    # Also start updater
    $updaterEntry = Join-Path $BOOTSTRAP_DIR "updater-daemon.js"
    if ((Test-Path $updaterEntry) -and -not (Test-PidRunning $UPDATER_PID_FILE)) {
        $updaterErrLog = Join-Path $LOG_DIR "loongsuite-pilot-updater-err.log"
        $uproc = Start-Process -FilePath "powershell.exe" `
            -ArgumentList "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -Command `"`$env:AGENT_DATA_COLLECTION_CONFIG='$CONFIG_FILE'; & '$nodeBin' '$updaterEntry' >> '$UPDATER_LOG_FILE' 2>> '$updaterErrLog'`"" `
            -WorkingDirectory $CACHE_DIR `
            -WindowStyle Hidden `
            -PassThru
        Set-Content -Path $UPDATER_PID_FILE -Value $uproc.Id
        Write-Host "loongsuite-pilot updater started (PID $($uproc.Id))"
    }
}

# ============================================================
# CMD: stop
# ============================================================
function Cmd-Stop {
    # Stop Task Scheduler tasks
    foreach ($name in @($TASK_NAME_UPDATER, $TASK_NAME_COLLECTOR)) {
        $task = Get-ScheduledTask -TaskName $name -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
        if ($task -and $task.State -eq "Running") {
            Stop-ScheduledTask -TaskName $name -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
        }
    }

    # Stop PID-tracked processes
    Stop-PidFile $PID_FILE
    Stop-PidFile $UPDATER_PID_FILE

    # Kill orphan processes
    Stop-OrphanProcesses

    Write-Host "loongsuite-pilot stopped"
}

# ============================================================
# CMD: restart
# ============================================================
function Cmd-Restart {
    Cmd-Stop
    Start-Sleep -Seconds 1
    Cmd-Start
}

# ============================================================
# CMD: restart-collector (used by updater after deploying a new version)
# ============================================================
function Cmd-RestartCollector {
    # Stop collector only (leave updater running)
    $task = Get-ScheduledTask -TaskName $TASK_NAME_COLLECTOR -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
    if ($task -and $task.State -eq "Running") {
        Stop-ScheduledTask -TaskName $TASK_NAME_COLLECTOR -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
    }
    Stop-PidFile $PID_FILE

    # Kill orphan collector processes
    Get-Process -Name "node" -ErrorAction SilentlyContinue |
        Where-Object {
            try {
                $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine
                $cmdLine -match "collector-daemon"
            } catch { $false }
        } | ForEach-Object {
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }

    Start-Sleep -Seconds 1
    Ensure-Dirs
    Sync-BootstrapScripts

    $nodeBin = Resolve-Node
    if (-not $nodeBin) {
        Write-Error "node runtime not found"
        exit 1
    }

    # Restart via Task Scheduler if registered
    $restarted = $false
    if (Get-TaskExists $TASK_NAME_COLLECTOR) {
        try {
            # Re-register with potentially updated paths
            Install-CollectorTask $nodeBin | Out-Null
            Start-ScheduledTask -TaskName $TASK_NAME_COLLECTOR -TaskPath "$TASK_FOLDER\" -ErrorAction Stop
            Write-Host "collector restarted (Task Scheduler)"
            $restarted = $true
        } catch {}
    }

    if (-not $restarted) {
        $entry = Join-Path $BOOTSTRAP_DIR "collector-daemon.js"
        if (-not (Test-Path $entry)) {
            Write-Error "Bootstrap script missing"
            exit 1
        }
        $errLog = Join-Path $LOG_DIR "loongsuite-pilot-service-err.log"
        $proc = Start-Process -FilePath "powershell.exe" `
            -ArgumentList "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -Command `"`$env:AGENT_DATA_COLLECTION_CONFIG='$CONFIG_FILE'; & '$nodeBin' '$entry' >> '$LOG_FILE' 2>> '$errLog'`"" `
            -WorkingDirectory $CACHE_DIR `
            -WindowStyle Hidden `
            -PassThru
        Set-Content -Path $PID_FILE -Value $proc.Id
        Write-Host "collector restarted (PID $($proc.Id))"
    }

    # Schedule updater restart in background (equivalent to setsid on Linux)
    Start-Job -ScriptBlock {
        Start-Sleep -Seconds 10
        & $using:LOONGSUITE_PILOT_BIN restart-updater
    } | Out-Null
}

# ============================================================
# CMD: restart-updater
# ============================================================
function Cmd-RestartUpdater {
    # Stop updater
    $task = Get-ScheduledTask -TaskName $TASK_NAME_UPDATER -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
    if ($task -and $task.State -eq "Running") {
        Stop-ScheduledTask -TaskName $TASK_NAME_UPDATER -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
    }
    Stop-PidFile $UPDATER_PID_FILE

    Get-Process -Name "node" -ErrorAction SilentlyContinue |
        Where-Object {
            try {
                $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine
                $cmdLine -match "updater-daemon"
            } catch { $false }
        } | ForEach-Object {
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }

    Start-Sleep -Seconds 1
    Ensure-Dirs
    Sync-BootstrapScripts

    $nodeBin = Resolve-Node
    if (-not $nodeBin) {
        Write-Error "node runtime not found"
        return
    }

    # Restart via Task Scheduler
    $restarted = $false
    if (Get-TaskExists $TASK_NAME_UPDATER) {
        try {
            Install-UpdaterTask $nodeBin | Out-Null
            Start-ScheduledTask -TaskName $TASK_NAME_UPDATER -TaskPath "$TASK_FOLDER\" -ErrorAction Stop
            Start-Sleep -Seconds 1
            if (Get-TaskRunning $TASK_NAME_UPDATER) {
                Write-Host "updater restarted (Task Scheduler)"
                $restarted = $true
            }
        } catch {}
    }

    if (-not $restarted) {
        $entry = Join-Path $BOOTSTRAP_DIR "updater-daemon.js"
        if (-not (Test-Path $entry)) {
            Write-Host "Updater bootstrap script missing"
            return
        }
        $updaterErrLog = Join-Path $LOG_DIR "loongsuite-pilot-updater-err.log"
        $proc = Start-Process -FilePath "powershell.exe" `
            -ArgumentList "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -Command `"`$env:AGENT_DATA_COLLECTION_CONFIG='$CONFIG_FILE'; & '$nodeBin' '$entry' >> '$UPDATER_LOG_FILE' 2>> '$updaterErrLog'`"" `
            -WorkingDirectory $CACHE_DIR `
            -WindowStyle Hidden `
            -PassThru
        Set-Content -Path $UPDATER_PID_FILE -Value $proc.Id
        Write-Host "updater restarted (PID $($proc.Id))"
    }
}

# ============================================================
# CMD: status
# ============================================================
function Cmd-Status {
    $verInfo = ""
    $versionDir = Resolve-CurrentVersion
    if ($versionDir) {
        $info = Get-VersionInfo $versionDir
        if ($info.version) {
            $verInfo = " v$($info.version) ($($info.git_commit))"
        }
    }

    # Collector status
    $collectorRunning = $false
    if (Test-PidRunning $PID_FILE) {
        $pidVal = (Get-Content $PID_FILE).Trim()
        Write-Host "loongsuite-pilot${verInfo} is running (PID $pidVal)"
        $collectorRunning = $true
    } elseif (Get-TaskRunning $TASK_NAME_COLLECTOR) {
        Write-Host "loongsuite-pilot${verInfo} is running (Task Scheduler)"
        $collectorRunning = $true
    }
    if (-not $collectorRunning) {
        Write-Host "loongsuite-pilot${verInfo} is not running"
    }

    # Updater status
    if (Test-PidRunning $UPDATER_PID_FILE) {
        $pidVal = (Get-Content $UPDATER_PID_FILE).Trim()
        Write-Host "   updater: running (PID $pidVal)"
    } elseif (Get-TaskRunning $TASK_NAME_UPDATER) {
        Write-Host "   updater: running (Task Scheduler)"
    } else {
        Write-Host "   updater: stopped"
    }

    # Autostart status
    if (Get-TaskExists $TASK_NAME_COLLECTOR) {
        $task = Get-ScheduledTask -TaskName $TASK_NAME_COLLECTOR -TaskPath "$TASK_FOLDER\"
        $triggerInfo = if ($task.Triggers.Count -gt 0) { $task.Triggers[0].CimClass.CimClassName } else { "none" }
        Write-Host "   autostart: enabled (Task Scheduler, trigger: AtLogon)"
    } else {
        $initType = ""
        if (Test-Path $INIT_TYPE_FILE) { $initType = (Get-Content $INIT_TYPE_FILE -ErrorAction SilentlyContinue).Trim() }
        if ($initType -eq "background") {
            Write-Host "   autostart: disabled (background process fallback)"
        } else {
            Write-Host "   autostart: not configured"
        }
    }
}

# ============================================================
# CMD: info
# ============================================================
function Cmd-Info {
    $versionDir = Resolve-CurrentVersion
    if ($versionDir) {
        $vf = Join-Path $versionDir "VERSION"
        if (Test-Path $vf) {
            Get-Content $vf
        } else {
            Write-Host "version=unknown"
        }
    } else {
        Write-Host "version=unknown"
    }

    Write-Host ""
    Write-Host "data_dir=$DATA_DIR"
    Write-Host "config=$CONFIG_FILE"
    Write-Host "log=$LOG_FILE"
    Write-Host "versions_dir=$VERSIONS_DIR"

    if (Test-Path $NODE_PIN_FILE) {
        $pinnedNode = (Get-Content $NODE_PIN_FILE -ErrorAction SilentlyContinue).Trim()
        if ($pinnedNode -and (Test-Path $pinnedNode)) {
            $nodeVer = & $pinnedNode --version 2>$null
            Write-Host "node_bin=$pinnedNode"
            Write-Host "node_version=$nodeVer"
        } else {
            Write-Host "node_bin=$pinnedNode (stale)"
            $resolved = Resolve-Node
            if ($resolved) {
                $nodeVer = & $resolved --version 2>$null
                Write-Host "node_version=$nodeVer"
            }
        }
    } else {
        Write-Host "node_bin=not pinned"
        $resolved = Resolve-Node
        if ($resolved) {
            $nodeVer = & $resolved --version 2>$null
            Write-Host "node_resolved=$resolved"
            Write-Host "node_version=$nodeVer"
        }
    }

    Write-Host ""
    if (Test-Path $CONFIG_FILE) {
        Get-Content $CONFIG_FILE
    }
}

# ============================================================
# CMD: rollback
# ============================================================
function Cmd-Rollback {
    if (-not (Test-Path $PREVIOUS_FILE)) {
        Write-Error "No previous version to roll back to"
        exit 1
    }

    $prevDir = (Get-Content $PREVIOUS_FILE -ErrorAction SilentlyContinue).Trim()
    $prevPath = Join-Path $VERSIONS_DIR $prevDir
    if (-not $prevDir -or -not (Test-Path $prevPath)) {
        Write-Error "Previous version directory not found: $prevDir"
        exit 1
    }

    $currDir = ""
    if (Test-Path $CURRENT_FILE) {
        $currDir = (Get-Content $CURRENT_FILE -ErrorAction SilentlyContinue).Trim()
    }

    # Swap current/previous pointers
    Set-Content -Path $CURRENT_FILE -Value $prevDir
    if ($currDir) {
        Set-Content -Path $PREVIOUS_FILE -Value $currDir
    }

    # Sync scripts from the rollback target
    $ok = Sync-InstalledScriptsFromVersion $prevPath
    if (-not $ok) {
        # Revert pointer swap
        if ($currDir) {
            Set-Content -Path $CURRENT_FILE -Value $currDir
            Set-Content -Path $PREVIOUS_FILE -Value $prevDir
            Sync-InstalledScriptsFromVersion (Join-Path $VERSIONS_DIR $currDir) | Out-Null
        }
        Write-Error "Failed to sync scripts for rollback target: $prevDir"
        exit 1
    }

    Write-Host "Rolled back to version: $prevDir"
    Write-Host "   Restarting service..."
    Cmd-Restart
}

# ============================================================
# CMD: log (tail service log)
# ============================================================
function Cmd-Log {
    if (Test-Path $LOG_FILE) {
        Get-Content $LOG_FILE -Tail 50 -Wait
    } else {
        Write-Host "No log file found: $LOG_FILE"
    }
}

# ============================================================
# CMD: help
# ============================================================
# Manage span-attributes.json — user-defined attributes injected into trace
# spans (not the event log). The collector re-reads the file per turn, so
# changes take effect without a restart.
function Cmd-SpanAttr {
    $sub = if ($SubArgs.Count -ge 1) { $SubArgs[0] } else { "" }

    if ($sub -ieq "clear") {
        if (Test-Path $SPAN_ATTR_FILE) { Remove-Item $SPAN_ATTR_FILE -Force }
        Write-Host "cleared custom span attributes ($SPAN_ATTR_FILE)"
        return
    }

    if ($sub.ToLower() -in @("set", "unset", "list")) {
        $nodeBin = Resolve-Node
        if (-not $nodeBin) { Write-Error "[span-attr] node runtime not found"; exit 1 }
        $js = @'
const fs = require("fs");
const file = process.argv[1], op = process.argv[2], key = process.argv[3], value = process.argv[4];
const RESERVED = ["gen_ai.","git.","workspace.","event.","trace_","user.","cost_","agent.","time_unix_nano","observed_time_unix_nano"];
const isReserved = k => RESERVED.some(p => k === p || k.indexOf(p) === 0);
function read() { try { const o = JSON.parse(fs.readFileSync(file, "utf-8")); return (o && typeof o === "object" && !Array.isArray(o)) ? o : {}; } catch { return {}; } }
function write(o) { const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + "\n"); fs.renameSync(tmp, file); }
if (op === "set") {
  if (!key || value === undefined) { console.error("usage: span-attr set <key> <value>"); process.exit(1); }
  if (isReserved(key)) { console.error("refused: \"" + key + "\" uses a reserved prefix (gen_ai./git./workspace./event./trace_/user./cost_/agent./...)"); process.exit(1); }
  const o = read(); o[key] = String(value); write(o); console.log("set " + key + "=" + o[key]);
} else if (op === "unset") {
  if (!key) { console.error("usage: span-attr unset <key>"); process.exit(1); }
  const o = read(); if (Object.prototype.hasOwnProperty.call(o, key)) { delete o[key]; write(o); console.log("unset " + key); } else { console.log("(no such key: " + key + ")"); }
} else if (op === "list") {
  const o = read(); const ks = Object.keys(o);
  if (ks.length === 0) { console.log("(no custom span attributes)"); } else { for (const k of ks) console.log(k + "=" + o[k]); }
}
'@
        $rest = if ($SubArgs.Count -ge 2) { $SubArgs[1..($SubArgs.Count - 1)] } else { @() }
        & $nodeBin -e $js $SPAN_ATTR_FILE $sub @rest
        exit $LASTEXITCODE
    }

    Write-Host "Usage: loongsuite-pilot span-attr <set|unset|list|clear>"
    Write-Host ""
    Write-Host "  set <key> <value>   Set a custom trace span attribute"
    Write-Host "  unset <key>         Remove a custom attribute"
    Write-Host "  list                Show current custom attributes"
    Write-Host "  clear               Remove all custom attributes"
    Write-Host ""
    Write-Host "Attributes are injected into trace spans only (not the event log)."
    Write-Host "Reserved-prefix keys (gen_ai./git./workspace./event./trace_/user./cost_/agent./...) are rejected."
    Write-Host "Changes take effect on the next turn - no restart needed."
    if ($sub -ne "" -and $sub.ToLower() -notin @("help", "-h", "--help")) { exit 1 }
}

function Cmd-Help {
    Write-Host "Usage: loongsuite-pilot <command>"
    Write-Host ""
    Write-Host "Commands:"
    Write-Host "  start           Start the collector service"
    Write-Host "  stop            Stop the collector service"
    Write-Host "  restart         Restart the collector service"
    Write-Host "  status          Show service status (default)"
    Write-Host "  info            Show version and config info"
    Write-Host "  log             Tail the service log"
    Write-Host "  span-attr ...   Manage custom trace span attributes (set/unset/list/clear)"
    Write-Host "  rollback        Roll back to the previous version"
    Write-Host "  help            Show this help message"
}

# ============================================================
# Dispatch
# ============================================================
switch ($Command.ToLower()) {
    "start"              { Cmd-Start }
    "stop"               { Cmd-Stop }
    "restart"            { Cmd-Restart }
    "status"             { Cmd-Status }
    "info"               { Cmd-Info }
    "log"                { Cmd-Log }
    "rollback"           { Cmd-Rollback }
    "restart-collector"  { Cmd-RestartCollector }
    "restart-updater"    { Cmd-RestartUpdater }
    "run"                { Cmd-Run }
    "run-updater"        { Cmd-RunUpdater }
    "span-attr"          { Cmd-SpanAttr }
    { $_ -in "help","--help","-h" } { Cmd-Help }
    default {
        Write-Host "Unknown command: $Command"
        Cmd-Help
        exit 1
    }
}
