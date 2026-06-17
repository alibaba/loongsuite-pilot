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
$NODE_PIN_FILE = Join-Path $CACHE_DIR "node-bin"
$INIT_TYPE_FILE = Join-Path $DATA_DIR "init-type"

$TASK_NAME_COLLECTOR = "LoongsuitePilot"
$TASK_NAME_UPDATER = "LoongsuitePilotUpdater"
$TASK_FOLDER = "\LoongsuitePilot"

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

function Install-CollectorTask {
    param([string]$nodeBin)
    $entry = Join-Path $BOOTSTRAP_DIR "collector-daemon.js"
    if (-not (Test-Path $entry)) {
        Write-Host "Bootstrap script missing: $entry"
        return $false
    }

    $action = New-ScheduledTaskAction `
        -Execute "powershell.exe" `
        -Argument "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -Command `"`$env:AGENT_DATA_COLLECTION_CONFIG='$CONFIG_FILE'; & '$nodeBin' '$entry'`"" `
        -WorkingDirectory $CACHE_DIR

    # Two triggers: AtLogOn for initial start + repeating every 5 min as a watchdog.
    # If the process crashes or is killed, the repeating trigger re-launches it.
    # MultipleInstances=IgnoreNew ensures a second instance is never spawned while running.
    $triggerLogon = New-ScheduledTaskTrigger -AtLogOn
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

    # S4U logon type: runs under the user's identity in a non-interactive session,
    # so the process survives RDP/SSH disconnect without requiring a stored password.
    $principal = New-ScheduledTaskPrincipal -UserId (whoami) -LogonType S4U -RunLevel Limited

    # Remove existing task first (schtasks is more reliable than Unregister-ScheduledTask)
    # Use try/catch because schtasks stderr + $ErrorActionPreference=Stop can throw
    try { schtasks.exe /Delete /TN "$TASK_FOLDER\$TASK_NAME_COLLECTOR" /F 2>$null | Out-Null } catch {}
    try { schtasks.exe /Delete /TN "$TASK_NAME_COLLECTOR" /F 2>$null | Out-Null } catch {}

    Register-ScheduledTask `
        -TaskName $TASK_NAME_COLLECTOR `
        -TaskPath "$TASK_FOLDER\" `
        -Action $action `
        -Trigger @($triggerLogon, $triggerRepeat) `
        -Settings $settings `
        -Principal $principal `
        -Description "LoongSuite Pilot data collector" `
        -ErrorAction Stop | Out-Null

    return $true
}

function Install-UpdaterTask {
    param([string]$nodeBin)
    $entry = Join-Path $BOOTSTRAP_DIR "updater-daemon.js"
    if (-not (Test-Path $entry)) { return $false }

    $action = New-ScheduledTaskAction `
        -Execute "powershell.exe" `
        -Argument "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -Command `"`$env:AGENT_DATA_COLLECTION_CONFIG='$CONFIG_FILE'; & '$nodeBin' '$entry'`"" `
        -WorkingDirectory $CACHE_DIR

    $triggerLogon = New-ScheduledTaskTrigger -AtLogOn
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

    $principal = New-ScheduledTaskPrincipal -UserId (whoami) -LogonType S4U -RunLevel Limited

    try { schtasks.exe /Delete /TN "$TASK_FOLDER\$TASK_NAME_UPDATER" /F 2>$null | Out-Null } catch {}
    try { schtasks.exe /Delete /TN "$TASK_NAME_UPDATER" /F 2>$null | Out-Null } catch {}

    Register-ScheduledTask `
        -TaskName $TASK_NAME_UPDATER `
        -TaskPath "$TASK_FOLDER\" `
        -Action $action `
        -Trigger @($triggerLogon, $triggerRepeat) `
        -Settings $settings `
        -Principal $principal `
        -Description "LoongSuite Pilot auto-updater" `
        -ErrorAction Stop | Out-Null

    return $true
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
        }
    } catch {
        Write-Host "Task Scheduler registration failed: $_" -ForegroundColor Yellow
    }

    # Fallback: background process (like nohup on Linux)
    Write-Host "Using background process fallback." -ForegroundColor Yellow
    Write-Host "   Service will NOT auto-start on boot." -ForegroundColor Yellow

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
    { $_ -in "help","--help","-h" } { Cmd-Help }
    default {
        Write-Host "Unknown command: $Command"
        Cmd-Help
        exit 1
    }
}
