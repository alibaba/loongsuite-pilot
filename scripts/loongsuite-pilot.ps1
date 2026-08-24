# loongsuite-pilot.ps1 -- Service management for loongsuite-pilot (Windows)
# Uses Windows Task Scheduler for autostart (analogous to macOS launchd)
#
# Usage:
#   loongsuite-pilot start
#   loongsuite-pilot stop
#   loongsuite-pilot restart
#   loongsuite-pilot status
#   loongsuite-pilot info
#   loongsuite-pilot token-usage
#   loongsuite-pilot rollback
#   loongsuite-pilot worker connect|list|status|disconnect|delete
#   loongsuite-pilot help

$CliArgs = @($args)
$Command = if ($CliArgs.Count -ge 1) { [string]$CliArgs[0] } else { "status" }
$SubArgs = if ($CliArgs.Count -ge 2) { [string[]]$CliArgs[1..($CliArgs.Count - 1)] } else { @() }
$ErrorActionPreference = "Stop"

# ============================================================
# Constants & Paths
# ============================================================
$DEFAULT_PILOT_DIR = Join-Path $env:USERPROFILE ".loongsuite-pilot"
$LAYOUT_FILE = Join-Path $PSScriptRoot "loongsuite-pilot-layout.json"
$INSTALL_LAYOUT = $null
if (Test-Path -LiteralPath $LAYOUT_FILE) {
    try {
        $INSTALL_LAYOUT = Get-Content -LiteralPath $LAYOUT_FILE -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {}
}
$CACHE_DIR = if ($env:LOONGSUITE_PILOT_CACHE_DIR) {
    $env:LOONGSUITE_PILOT_CACHE_DIR
} elseif ($INSTALL_LAYOUT -and $INSTALL_LAYOUT.cacheDir) {
    [string]$INSTALL_LAYOUT.cacheDir
} else {
    $DEFAULT_PILOT_DIR
}
$DATA_DIR = if ($env:LOONGSUITE_PILOT_DATA_DIR) {
    $env:LOONGSUITE_PILOT_DATA_DIR
} elseif ($INSTALL_LAYOUT -and $INSTALL_LAYOUT.dataDir) {
    [string]$INSTALL_LAYOUT.dataDir
} else {
    $DEFAULT_PILOT_DIR
}
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
$RUNTIME_FILE = Join-Path $LOG_DIR "runtime.json"
$CONFIG_FILE = Join-Path $DATA_DIR "config.json"
$SPAN_ATTR_FILE = Join-Path $DATA_DIR "span-attributes.json"
$NODE_PIN_FILE = Join-Path $CACHE_DIR "node-bin"
$INIT_TYPE_FILE = Join-Path $DATA_DIR "init-type"

# >>> pilot-account-identity >>>
# Windows account identity, DOMAIN\user, without whoami. On 5.1 a native command's
# stdout is decoded with [Console]::OutputEncoding -- the console codepage, 437 on an
# en-US box -- so `whoami` returns "host\??" for a non-ASCII account name: every
# character the codepage cannot represent arrives as a literal U+003F, measured on a
# C:\Users\<CJK name> profile. That corrupted string used to reach
# New-ScheduledTaskPrincipal -UserId, where Task Scheduler rejected the registration
# with "No mapping between account names and security IDs was done" (HRESULT
# 0x80131500), so such a user never got an autostart task at all; it also collapsed
# every non-ASCII account to the same "___" task-name tag.
#
# The environment variables carry the real UTF-16 string and are CLM-safe, unlike
# [Security.Principal.WindowsIdentity]::GetCurrent() (CLM: "Method invocation is
# supported only on core types") and unlike [Environment]::UserName. USERDOMAIN is not
# always an account domain: under some logon providers (OpenSSH sshd among them) it is
# the literal "WORKGROUP", which maps to no SID either, so fall back to the machine
# name -- which is also what whoami prints for a local account, keeping the tag below
# byte-identical for ASCII users who upgrade in place.
function Get-PilotAccountName {
    $user = [string]$env:USERNAME
    if (-not $user) { return "" }
    $domain = [string]$env:USERDOMAIN
    if ((-not $domain) -or ($domain -eq "WORKGROUP")) { $domain = [string]$env:COMPUTERNAME }
    if ($domain) { return ($domain + "\" + $user) }
    return $user
}

# Task names are per-user: multiple users can run on one machine, each with their
# own data dir under %USERPROFILE%. A global task name would collide -- the second
# user cannot delete or overwrite the first user's task (Access is denied), so it
# would fail with "already exists" and drop to the background fallback. The shared
# \LoongsuitePilot folder stays cross-user writable; only the task name is scoped.
# Tag from the full DOMAIN\user identity, not $env:USERNAME alone (bare SAM name):
# two same-named accounts from different domains (CORP\alice vs DEV\alice) would
# otherwise share one task name and re-introduce the cross-user "already exists"
# collision this scoping is meant to prevent. Task names live in the file system, so
# everything outside [A-Za-z0-9._-] becomes "_" -- which turns a non-ASCII account
# name into a row of underscores that two such users on one machine would fight over,
# hence the short deterministic digest appended in that case only. ASCII installs keep
# the exact tag they already have, so their registered tasks stay upgradeable in place.
function Get-PilotUserTag {
    $name = (Get-PilotAccountName).ToLower()
    $tag = $name -replace '[^A-Za-z0-9._-]', '_'
    if ($name -match '[^\x20-\x7E]') {
        $hash = 0
        foreach ($ch in $name.ToCharArray()) { $hash = ($hash * 31 + [int]$ch) % 1000000007 }
        $tag = $tag + "-" + $hash
    }
    return $tag
}
# <<< pilot-account-identity <<<

$USER_TAG = Get-PilotUserTag
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

# The pin file holds one absolute path to node.exe, and for a managed runtime that path
# sits under the data dir -- i.e. under %USERPROFILE%, which can be non-ASCII. 5.1
# defaults both Get-Content and Set-Content to the ANSI codepage, so an unqualified
# write stored "C:\Users\??.HOST\..." and every reader then failed Test-NodeSuitable and
# silently fell back to whatever node.exe the fallback search found first -- on a shared
# machine that was another account's nvm install. -Encoding UTF8 always emits a BOM on
# 5.1 (there is no utf8NoBOM), and U+FEFF is not whitespace, so .Trim() alone leaves it
# in the path: strip it explicitly before trimming.
function Resolve-Node {
    # 1. Pinned file
    if (Test-Path $NODE_PIN_FILE) {
        $pinned = ([string](Get-Content -LiteralPath $NODE_PIN_FILE -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)).Trim([char]0xFEFF).Trim()
        if ($pinned -and (Test-NodeSuitable $pinned)) {
            return $pinned
        }
    }

    # 2. Fallback search
    $candidates = @()

    # nvm-windows. Both probes below must be non-fatal. NVM_HOME is often a *machine*
    # level variable pointing into another account's profile
    # (C:\Users\Administrator\AppData\Local\nvm was measured), and that directory's DACL
    # grants nothing to the current user: a bare Test-Path raises a PermissionDenied
    # UnauthorizedAccessException record, which this file's $ErrorActionPreference = "Stop"
    # promotes to a terminating error. Resolve-Node runs on the way into start / stop /
    # status / restart-collector, so one unreadable third-party node manager took down
    # every service command -- including the restart-collector the updater issues after
    # deploying a version. The Get-ChildItem calls were already guarded; these two were
    # not. -LiteralPath as well, because a version manager path may contain [ or ].
    if ($env:NVM_HOME -and (Test-Path -LiteralPath $env:NVM_HOME -ErrorAction SilentlyContinue)) {
        Get-ChildItem $env:NVM_HOME -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { $candidates += Join-Path $_.FullName "node.exe" }
    }

    # fnm -- same unreadable-directory hazard as the nvm branch above.
    $fnmDir = Join-Path $env:USERPROFILE ".fnm\node-versions"
    if (Test-Path -LiteralPath $fnmDir -ErrorAction SilentlyContinue) {
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
            Set-Content -LiteralPath $NODE_PIN_FILE -Value $c -Encoding UTF8
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

function Get-CollectorRuntime {
    # Use [datetime] (a Constrained-Language core type) instead of [datetimeoffset],
    # which is not a core type and throws under CLM (WDAC). Comparisons stay correct
    # because every value below is a local-time [datetime].
    param([datetime]$NotBefore = [datetime]::MinValue)
    if (-not (Test-Path -LiteralPath $RUNTIME_FILE)) { return $null }
    try {
        $runtime = Get-Content -LiteralPath $RUNTIME_FILE -Raw -Encoding UTF8 | ConvertFrom-Json
        # Get-Date (a cmdlet) parses the ISO-8601 timestamp without the CLM-forbidden
        # [datetimeoffset]::Parse / [CultureInfo]::InvariantCulture / [DateTimeStyles],
        # normalizing any offset to local time to match (Get-Date) below.
        $updatedAt = Get-Date -Date ([string]$runtime.updatedAt)
        $pidValue = [int]$runtime.pid
        if (
            $runtime.status -ne "active" -or
            $pidValue -le 0 -or
            $updatedAt -lt $NotBefore -or
            $updatedAt -lt (Get-Date).AddMinutes(-2) -or
            -not (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)
        ) {
            return $null
        }
        return $runtime
    } catch {
        return $null
    }
}

function Test-CollectorRunning {
    return $null -ne (Get-CollectorRuntime)
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
    # $Match limits which daemons are terminated; the default kills both. Callers that
    # re-register a single task (Install-CollectorTask / Install-UpdaterTask) pass a
    # narrow pattern so they only reap the daemon they are about to re-launch.
    param([string]$Match = "collector-daemon|updater-daemon")
    Get-Process -Name "node" -ErrorAction SilentlyContinue |
        Where-Object {
            try {
                $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine
                $cmdLine -match $Match
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

function Wait-ForCollectorHeartbeat {
    param([int]$TimeoutSeconds = 15)
    $notBefore = (Get-Date).AddSeconds(-2)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if (
            (Get-CollectorRuntime -NotBefore $notBefore) -or
            (Test-PidRunning $PID_FILE)
        ) {
            return $true
        }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Start-CompatibleExistingCollectorTask {
    $task = $null
    for ($attempt = 0; $attempt -lt 5 -and -not $task; $attempt++) {
        $task = Get-ScheduledTask `
            -TaskName $TASK_NAME_COLLECTOR `
            -TaskPath "$TASK_FOLDER\" `
            -ErrorAction SilentlyContinue
        if (-not $task) { Start-Sleep -Seconds 1 }
    }
    if (-not $task) { return $false }

    $expectedLauncher = Join-Path $BOOTSTRAP_DIR "collector-launch.vbs"
    $action = $task.Actions | Select-Object -First 1
    $actionArgs = if ($action) { [string]$action.Arguments } else { "" }
    $actionExe = if ($action) { [string]$action.Execute } else { "" }
    # Split-Path -Leaf and case-folded string ops instead of [System.IO.Path]::GetFileName
    # and String.IndexOf(StringComparison), which are forbidden under Constrained Language
    # Mode (WDAC). $actionExe is typically the bare "wscript.exe".
    $exeLeaf = if ($actionExe) { Split-Path -Leaf $actionExe } else { "" }
    $isWscript = $exeLeaf -ieq "wscript.exe"
    $usesExpectedLauncher = $actionArgs.ToLower().Contains($expectedLauncher.ToLower())
    if (-not $isWscript -or -not $usesExpectedLauncher) {
        Write-Host "Existing collector task uses an incompatible action; refusing to reuse it." -ForegroundColor Yellow
        return $false
    }

    try {
        if ($task.State -eq "Running") {
            Stop-ScheduledTask `
                -TaskName $TASK_NAME_COLLECTOR `
                -TaskPath "$TASK_FOLDER\" `
                -ErrorAction SilentlyContinue
            for ($attempt = 0; $attempt -lt 10; $attempt++) {
                Start-Sleep -Seconds 1
                $task = Get-ScheduledTask `
                    -TaskName $TASK_NAME_COLLECTOR `
                    -TaskPath "$TASK_FOLDER\" `
                    -ErrorAction SilentlyContinue
                if (-not $task -or $task.State -ne "Running") { break }
            }
        }
        Start-ScheduledTask `
            -TaskName $TASK_NAME_COLLECTOR `
            -TaskPath "$TASK_FOLDER\" `
            -ErrorAction Stop
        return (Wait-ForCollectorHeartbeat -TimeoutSeconds 30)
    } catch {
        Write-Host "Existing collector task could not be started: $($_.Exception.Message)" -ForegroundColor Yellow
        return $false
    }
}

# Register a scheduled task, preferring Interactive and falling back to S4U.
# Interactive tasks remain manageable by the same standard user. S4U stays
# available for environments that explicitly grant batch-logon rights.
function Register-PilotTask {
    param(
        [string]$taskName,
        $action,
        $triggers,
        $settings,
        [string]$description
    )
    $userId = Get-PilotAccountName
    $lastErr = $null
    foreach ($logonType in @("Interactive", "S4U")) {
        # Clear any task a previous attempt left behind. A failed registration can
        # still create the task entry before erroring on the principal.
        #
        # The delete output stays suppressed: on a fresh install there is nothing to
        # delete and schtasks exits non-zero, so its stderr is noise (and a bare stderr
        # line can turn terminating under $ErrorActionPreference = "Stop"). A task that
        # SURVIVES the delete is a different story and worth a line -- it means this
        # process has no write access to the task and the registration below is about to
        # fail with "Access is denied" or a name collision. Without this, the only
        # symptom was the registration error, which reads like a bug in the principal.
        try { schtasks.exe /Delete /TN "$TASK_FOLDER\$taskName" /F 2>$null | Out-Null } catch {}
        if (Get-TaskExists $taskName) {
            Write-Host "   '$taskName' survived the delete; re-registration will likely be denied" -ForegroundColor Yellow
        }
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
    # $CONFIG_FILE/$CACHE_DIR derive from user-settable data/cache directories).
    $cfgEsc   = $CONFIG_FILE -replace '"', '""'
    $dataEsc  = $DATA_DIR    -replace '"', '""'
    $cacheEsc = $CACHE_DIR   -replace '"', '""'
    $cwdEsc   = $CACHE_DIR   -replace '"', '""'
    $nodeEsc  = $nodeBin     -replace '"', '""'
    $entryEsc = $entry       -replace '"', '""'
    $vbs = @"
Set sh = CreateObject("WScript.Shell")
sh.Environment("PROCESS").Item("AGENT_DATA_COLLECTION_CONFIG") = "$cfgEsc"
sh.Environment("PROCESS").Item("LOONGSUITE_PILOT_DATA_DIR") = "$dataEsc"
sh.Environment("PROCESS").Item("LOONGSUITE_PILOT_CACHE_DIR") = "$cacheEsc"
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
    $triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User (Get-PilotAccountName)
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

    # Kill any collector daemon left running under the OLD task registration BEFORE we
    # delete/re-create the task. Deleting a task does not stop its running child, and the
    # freshly registered task's MultipleInstances=IgnoreNew only counts instances under the
    # new registration -- so without this reap the orphan keeps running alongside the new
    # instance and both write the same output (duplicate-collection incident root cause).
    Stop-OrphanProcesses -Match "collector-daemon"

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
    $triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User (Get-PilotAccountName)
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

    # Reap any orphaned updater daemon from the old registration before re-creating
    # the task (same rationale as Install-CollectorTask above).
    Stop-OrphanProcesses -Match "updater-daemon"

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
    $launchers = @{
        $TASK_NAME_COLLECTOR = "collector-launch.vbs"
        $TASK_NAME_UPDATER = "updater-launch.vbs"
    }
    foreach ($name in @($TASK_NAME_UPDATER, $TASK_NAME_COLLECTOR)) {
        $task = Get-ScheduledTask -TaskName $name -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
        if ($task) {
            if ($task.State -eq "Running") {
                Stop-ScheduledTask -TaskName $name -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
            }
        }
        try { schtasks.exe /Delete /TN "$TASK_FOLDER\$name" /F 2>$null | Out-Null } catch {}
        try { schtasks.exe /Delete /TN "$name" /F 2>$null | Out-Null } catch {}
        # Never remove a launcher while an inaccessible task still references it.
        if (-not (Get-TaskExists $name)) {
            Remove-Item `
                (Join-Path $BOOTSTRAP_DIR $launchers[$name]) `
                -Force `
                -ErrorAction SilentlyContinue
        }
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

    # Windows has no exec(2): node runs as our child, so it publishes its own pid file
    # (see src/index.ts) instead of us recording the wrapper pid here. Export the data
    # dir so node's env-first resolution writes $DATA_DIR\loongsuite-pilot.pid -- the exact
    # path stop/status read.
    $env:LOONGSUITE_PILOT_DATA_DIR = $DATA_DIR
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

    # See Cmd-Run: node publishes its own pid file on Windows. Export the data dir so
    # node writes $DATA_DIR\loongsuite-pilot-updater.pid where stop/status read it.
    $env:LOONGSUITE_PILOT_DATA_DIR = $DATA_DIR
    $env:AGENT_DATA_COLLECTION_CONFIG = $CONFIG_FILE
    & $nodeBin $entry
}

# ============================================================
# CMD: start
# ============================================================
function Cmd-Start {
    $runtime = Get-CollectorRuntime
    if ($runtime) {
        Write-Host "loongsuite-pilot is already running (PID $($runtime.pid))"
        return
    }
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
            if (Wait-ForCollectorHeartbeat) {
                Write-Host "loongsuite-pilot started (Task Scheduler)"
                return
            }
            $t = Get-ScheduledTaskInfo -TaskName $TASK_NAME_COLLECTOR -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
            $rc = if ($t) { "0x{0:X8}" -f $t.LastTaskResult } else { "unknown" }
            throw "Collector task produced no runtime heartbeat (LastTaskResult=$rc)."
        }
    } catch {
        $hr = ""
        if ($_.Exception -and $null -ne $_.Exception.HResult) {
            $hr = " (HRESULT 0x{0:X8})" -f $_.Exception.HResult
        }
        Write-Host "Task Scheduler registration failed$hr : $($_.Exception.Message)" -ForegroundColor Yellow
        # An older task may be inaccessible for replacement but still be owned by
        # this user and point at the stable launcher path. The launcher was just
        # regenerated with the new Node/config/package paths, so it is safe to
        # start and reuse that task after validating its action.
        if (Start-CompatibleExistingCollectorTask) {
            Set-Content -Path $INIT_TYPE_FILE -Value "taskscheduler"
            Write-Host "Reused existing scheduled task: $TASK_NAME_COLLECTOR" -ForegroundColor Green
            return
        }
    }

    # No background fallback -- Task Scheduler registration is required.
    $staleTask = Get-ScheduledTask `
        -TaskName $TASK_NAME_COLLECTOR `
        -TaskPath "$TASK_FOLDER\" `
        -ErrorAction SilentlyContinue
    if ($staleTask -and [string]$staleTask.Principal.LogonType -eq "S4U") {
        Write-Host "A stale S4U collector task blocks replacement by the current user." -ForegroundColor Yellow
        Write-Host "   Remove it once from an elevated PowerShell, then run start/install again:" -ForegroundColor Yellow
        Write-Host "   schtasks.exe /Delete /TN `"$TASK_FOLDER\$TASK_NAME_COLLECTOR`" /F" -ForegroundColor Yellow
    }
    Write-Error "Failed to register system service via Task Scheduler."
    Write-Host "   Possible causes:" -ForegroundColor Yellow
    Write-Host "     - 'Log on as a batch job' right not granted (S4U)" -ForegroundColor Yellow
    Write-Host "     - Task Scheduler service not running" -ForegroundColor Yellow
    Write-Host "     - Insufficient permissions for task registration" -ForegroundColor Yellow
    exit 1
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
        # Re-register with potentially updated paths -- best-effort, and deliberately
        # in its OWN try so a failure here can no longer skip the start below.
        #
        # A scheduled task grants its own principal only Read: every write ACE sits on
        # BUILTIN\Administrators, and UAC filters that group out of the token of a
        # -RunLevel Limited task, which is what our two daemons run as. So the updater
        # that invokes restart-collector cannot touch its own task definition. Measured
        # on a Medium-integrity Limited task against a task registered earlier:
        # schtasks /Delete, Register-ScheduledTask and Register-ScheduledTask -Force all
        # fail with "Access is denied" -- -Force is not a fix -- while
        # Start-ScheduledTask succeeds, because starting needs no write access.
        #
        # Nothing is lost by skipping the re-registration: Install-CollectorTask rewrites
        # collector-launch.vbs and reaps orphaned daemons before it reaches the
        # registration, and the task action invokes that .vbs by a path that does not
        # change across versions -- so the surviving registration already launches the
        # new version. Sharing one try was the whole defect: a cosmetic re-register
        # failure aborted before Start-ScheduledTask, and with init_type=taskscheduler
        # the self-heal branch below is skipped, so the update ended in "Service manager
        # failed to restart collector" + exit 1 while the collector stayed down until the
        # task's own 5-minute watchdog trigger happened to relaunch it.
        try {
            Install-CollectorTask $nodeBin | Out-Null
        } catch {
            Write-Host "Task re-registration skipped (start still attempted): $($_.Exception.Message)" -ForegroundColor Yellow
        }
        try {
            Start-ScheduledTask -TaskName $TASK_NAME_COLLECTOR -TaskPath "$TASK_FOLDER\" -ErrorAction Stop
            Write-Host "collector restarted (Task Scheduler)"
            $restarted = $true
        } catch {
            Write-Host "Task Scheduler restart failed: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }

    if (-not $restarted) {
        # Self-healing: try to register Task Scheduler for degraded (background/unknown) installs
        $initType = ""
        if (Test-Path $INIT_TYPE_FILE) { $initType = (Get-Content $INIT_TYPE_FILE -ErrorAction SilentlyContinue).Trim() }
        # "background" is a legacy init-type value from pre-Task-Scheduler installs (aligned with Linux nohup/unknown)
        if ($initType -in @("background", "unknown", "")) {
            try {
                $ok = Install-CollectorTask $nodeBin
                if ($ok) {
                    Start-ScheduledTask -TaskName $TASK_NAME_COLLECTOR -TaskPath "$TASK_FOLDER\" -ErrorAction Stop
                    Start-Sleep -Seconds 1
                    if (Get-TaskRunning $TASK_NAME_COLLECTOR) {
                        Set-Content -Path $INIT_TYPE_FILE -Value "taskscheduler"
                        Write-Host "collector self-healed: registered with Task Scheduler"
                        $restarted = $true
                    }
                }
            } catch {
                Write-Host "Self-heal failed: $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
        if (-not $restarted) {
            if ($initType -in @("background", "unknown", "")) {
                $entry = Join-Path $BOOTSTRAP_DIR "collector-daemon.js"
                if (-not (Test-Path $entry)) {
                    Write-Error "Bootstrap script missing"
                    exit 1
                }
                $errLog = Join-Path $LOG_DIR "loongsuite-pilot-service-err.log"
                # node publishes its own pid file on Windows (see src/index.ts); export the
                # data dir so it lands at $DATA_DIR\loongsuite-pilot.pid. No Set-Content here --
                # $proc.Id would be the wrapper pid, not node's.
                Start-Process -FilePath "powershell.exe" `
                    -ArgumentList "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -Command `"`$env:LOONGSUITE_PILOT_DATA_DIR='$DATA_DIR'; `$env:AGENT_DATA_COLLECTION_CONFIG='$CONFIG_FILE'; & '$nodeBin' '$entry' >> '$LOG_FILE' 2>> '$errLog'`"" `
                    -WorkingDirectory $CACHE_DIR `
                    -WindowStyle Hidden
                Write-Host "collector restarted (background fallback, self-heal failed)" -ForegroundColor Yellow
            } else {
                Write-Error "Service manager failed to restart collector (init_type=$initType)"
                exit 1
            }
        }
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
        # Best-effort re-registration in its own try, for the same reason as in
        # Cmd-RestartCollector above (a -RunLevel Limited task cannot rewrite its own
        # definition; only starting it works). See the comment there.
        try {
            Install-UpdaterTask $nodeBin | Out-Null
        } catch {
            Write-Host "Task re-registration skipped (start still attempted): $($_.Exception.Message)" -ForegroundColor Yellow
        }
        try {
            Start-ScheduledTask -TaskName $TASK_NAME_UPDATER -TaskPath "$TASK_FOLDER\" -ErrorAction Stop
            Start-Sleep -Seconds 1
            if (Get-TaskRunning $TASK_NAME_UPDATER) {
                Write-Host "updater restarted (Task Scheduler)"
                $restarted = $true
            }
        } catch {
            Write-Host "Task Scheduler restart failed: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }

    if (-not $restarted) {
        # Self-healing: try to register Task Scheduler for degraded (background/unknown) installs
        $initType = ""
        if (Test-Path $INIT_TYPE_FILE) { $initType = (Get-Content $INIT_TYPE_FILE -ErrorAction SilentlyContinue).Trim() }
        # "background" is a legacy init-type value from pre-Task-Scheduler installs (aligned with Linux nohup/unknown)
        if ($initType -in @("background", "unknown", "")) {
            try {
                $ok = Install-UpdaterTask $nodeBin
                if ($ok) {
                    Start-ScheduledTask -TaskName $TASK_NAME_UPDATER -TaskPath "$TASK_FOLDER\" -ErrorAction Stop
                    Start-Sleep -Seconds 1
                    if (Get-TaskRunning $TASK_NAME_UPDATER) {
                        Set-Content -Path $INIT_TYPE_FILE -Value "taskscheduler"
                        Write-Host "updater self-healed: registered with Task Scheduler"
                        $restarted = $true
                    }
                }
            } catch {
                Write-Host "Self-heal failed: $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
        if (-not $restarted) {
            if ($initType -in @("background", "unknown", "")) {
                $entry = Join-Path $BOOTSTRAP_DIR "updater-daemon.js"
                if (-not (Test-Path $entry)) {
                    Write-Host "Updater bootstrap script missing"
                    return
                }
                $updaterErrLog = Join-Path $LOG_DIR "loongsuite-pilot-updater-err.log"
                # node publishes its own pid file on Windows (see src/updater/index.ts); export
                # the data dir so it lands at $DATA_DIR\loongsuite-pilot-updater.pid. No
                # Set-Content -- $proc.Id would be the wrapper pid, not node's.
                Start-Process -FilePath "powershell.exe" `
                    -ArgumentList "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -Command `"`$env:LOONGSUITE_PILOT_DATA_DIR='$DATA_DIR'; `$env:AGENT_DATA_COLLECTION_CONFIG='$CONFIG_FILE'; & '$nodeBin' '$entry' >> '$UPDATER_LOG_FILE' 2>> '$updaterErrLog'`"" `
                    -WorkingDirectory $CACHE_DIR `
                    -WindowStyle Hidden
                Write-Host "updater restarted (background fallback, self-heal failed)" -ForegroundColor Yellow
            } else {
                Write-Error "Service manager failed to restart updater (init_type=$initType)"
                return
            }
        }
    }
}

# ============================================================
# CMD: status
# ============================================================
function Get-DashboardPort {
    try {
        if (Test-Path $CONFIG_FILE) {
            $config = Get-Content -LiteralPath $CONFIG_FILE -Raw -Encoding UTF8 | ConvertFrom-Json
            $port = $config.dashboard.port
            if ($null -ne $port -and $port -isnot [string] -and $port -isnot [bool]) {
                $numericPort = [double]$port
                $integerPort = [long]$numericPort
                if ($numericPort -eq $integerPort -and
                    $integerPort -ge 1 -and $integerPort -le 65535) {
                    return [int]$integerPort
                }
            }
        }
    } catch {}
    return 8765
}

function Test-DashboardAvailable {
    param([int]$Port)
    $nodeBin = Resolve-Node
    if (-not $nodeBin) { return $false }

    $probe = @'
const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");
let finished = false;
let timer;
const finish = (code) => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  process.exit(code);
};
const request = http.request({
  host: "127.0.0.1",
  port: Number(process.argv[1]),
  path: "/metrics-summary.json",
  method: "HEAD",
}, (response) => {
  response.resume();
  const expectedInstance = crypto.createHash("sha256")
    .update(path.resolve(process.argv[2]))
    .digest("hex");
  const isPilot = response.headers["x-loongsuite-pilot-dashboard"] === "metrics-summary-v1"
    && response.headers["x-loongsuite-pilot-instance"] === expectedInstance;
  finish(isPilot && (response.statusCode === 200 || response.statusCode === 503) ? 0 : 1);
});
request.on("error", () => finish(1));
request.end();
timer = setTimeout(() => {
  request.destroy();
  finish(1);
}, 300);
'@

    try {
        & $nodeBin -e $probe $Port $DATA_DIR *> $null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

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
    $runtime = Get-CollectorRuntime
    if ($runtime) {
        Write-Host "loongsuite-pilot${verInfo} is running (PID $($runtime.pid), heartbeat)"
        $collectorRunning = $true
    } elseif (Test-PidRunning $PID_FILE) {
        $pidVal = (Get-Content $PID_FILE).Trim()
        Write-Host "loongsuite-pilot${verInfo} is running (PID $pidVal)"
        $collectorRunning = $true
    }
    if (-not $collectorRunning) {
        Write-Host "loongsuite-pilot${verInfo} is not running"
        if (Get-TaskRunning $TASK_NAME_COLLECTOR) {
            Write-Host "   collector task: running without a runtime heartbeat" -ForegroundColor Yellow
        }
    }
    if ($collectorRunning) {
        $dashboardPort = Get-DashboardPort
        if (Test-DashboardAvailable -Port $dashboardPort) {
            Write-Host "   dashboard: http://127.0.0.1:$dashboardPort/"
        } else {
            Write-Host "   dashboard: unavailable (http://127.0.0.1:$dashboardPort/)" -ForegroundColor Yellow
        }
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
        $pinnedNode = ([string](Get-Content -LiteralPath $NODE_PIN_FILE -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)).Trim([char]0xFEFF).Trim()
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
        # -Encoding UTF8: node writes config.json as UTF-8 with no BOM, and 5.1's
        # BOM sniffing then falls back to ANSI, printing a Chinese prefix as mojibake.
        Get-Content $CONFIG_FILE -Encoding UTF8
    }
}

# ============================================================
# CMD: rollback
# ============================================================
function Remove-HermesPluginForRollback {
    param([string]$TargetVersionPath)

    if (Test-Path (Join-Path $TargetVersionPath "agents.d\hermes-agent.json")) { return }

    $hermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:USERPROFILE ".hermes" }
    $pluginDir = Join-Path $hermesHome "plugins\loongsuite-pilot"
    $stateFile = Join-Path $DATA_DIR "deployed-agents.json"
    $state = $null
    if (Test-Path $stateFile) {
        try {
            # -Encoding UTF8 on the read too: node writes this file as UTF-8 without a
            # BOM, and 5.1's Get-Content falls back to the ANSI codepage when there is no
            # BOM to sniff. Without it a non-ASCII targetDir comes back mangled and the
            # plugin at that path goes uncleaned.
            $state = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $recorded = $state.'hermes-agent'.targetDir
            # Regex instead of [System.IO.Path]::IsPathRooted: System.IO.Path is not a
            # Constrained-Language core type, so the call throws under CLM (WDAC). The
            # catch below would swallow it and reset $state, silently leaving a plugin
            # installed at a custom targetDir uncleaned. Matches a drive-absolute path
            # (C:\ or C:/) or a UNC share (\\server\share); deliberately rejects the
            # drive-relative "C:dir" and root-relative "\dir" forms that IsPathRooted
            # accepts, since neither is safe to use as an absolute delete target.
            if ($recorded -and ([string]$recorded) -match '^([A-Za-z]:[\\/]|\\\\[^\\/]+[\\/])') {
                $pluginDir = [string]$recorded
            }
        } catch {
            $state = $null
        }
    }

    $marker = Join-Path $pluginDir ".loongsuite-pilot-managed.json"
    if (-not (Test-Path $marker)) { return }
    try {
        # Same as above: the marker is written by node (directory-plugin-strategy) as
        # BOM-less UTF-8.
        $meta = Get-Content $marker -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($meta.owner -ne "loongsuite-pilot" -or $meta.agentId -ne "hermes-agent") { return }
        Remove-Item $pluginDir -Recurse -Force
        if ($state -and $state.'hermes-agent') {
            # Select-Object -ExcludeProperty (a cmdlet) instead of
            # $state.PSObject.Properties.Remove(): PSMemberInfoCollection is not a
            # Constrained-Language core type, so the method call throws under CLM (WDAC)
            # and the state file would keep a stale hermes-agent entry. -Property * is
            # required alongside -ExcludeProperty on PowerShell 5.1.
            $pruned = $state | Select-Object -Property * -ExcludeProperty 'hermes-agent'
            $tmp = "$stateFile.tmp"
            # -Encoding UTF8 is required: Set-Content on PowerShell 5.1 defaults to the
            # ANSI codepage, while the node side reads and writes deployed-agents.json as
            # UTF-8 (readJsonFile / writeJsonFile). A targetDir under a non-ASCII user
            # profile would round-trip as mojibake. 5.1 has no utf8NoBOM, so this writes a
            # BOM -- readJsonFile strips a leading BOM for exactly this reason. Without
            # that strip JSON.parse throws, readJsonFile swallows it and returns null, and
            # the whole deployment state silently resets to empty.
            $pruned | ConvertTo-Json -Depth 20 | Set-Content $tmp -Encoding UTF8
            Move-Item -Force $tmp $stateFile
        }
        Write-Host "   Removed Hermes plugin not supported by rollback target: $pluginDir"
    } catch {
        Write-Warning "Failed to clean Hermes plugin during rollback: $pluginDir"
    }
}

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

    Remove-HermesPluginForRollback $prevPath

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
# CMD: deploy (one-shot hook/plugin deployment, for image builds)
# ============================================================
function Cmd-Deploy {
    $versionDir = Resolve-CurrentVersion
    if (-not $versionDir) {
        Write-Error "Current loongsuite-pilot version not found"
        exit 1
    }

    $entry = Join-Path $versionDir "dist\index.js"
    if (-not (Test-Path $entry -PathType Leaf)) {
        Write-Error "Deploy CLI entrypoint missing"
        exit 1
    }

    $nodeBin = Resolve-Node
    if (-not $nodeBin) {
        Write-Error "node runtime not found"
        exit 1
    }

    $env:LOONGSUITE_PILOT_DATA_DIR = $DATA_DIR
    $env:LOONGSUITE_PILOT_CACHE_DIR = $CACHE_DIR
    $env:AGENT_DATA_COLLECTION_CONFIG = $CONFIG_FILE
    # No collector restart afterwards -- see the shell cmd_deploy for why.
    & $nodeBin $entry "deploy" @SubArgs
    exit $LASTEXITCODE
}

# ============================================================
# CMD: token-usage (foreground token usage CLI)
# ============================================================
function Cmd-TokenUsage {
    $versionDir = Resolve-CurrentVersion
    if (-not $versionDir) {
        Write-Error "Current loongsuite-pilot version not found"
        exit 1
    }

    $entry = Join-Path $versionDir "dist\index.js"
    if (-not (Test-Path $entry -PathType Leaf)) {
        Write-Error "Token usage CLI entrypoint missing"
        exit 1
    }

    $nodeBin = Resolve-Node
    if (-not $nodeBin) {
        Write-Error "node runtime not found"
        exit 1
    }

    $env:LOONGSUITE_PILOT_DATA_DIR = $DATA_DIR
    $env:LOONGSUITE_PILOT_CACHE_DIR = $CACHE_DIR
    $env:AGENT_DATA_COLLECTION_CONFIG = $CONFIG_FILE
    & $nodeBin $entry "token-usage" @SubArgs
    exit $LASTEXITCODE
}

# ============================================================
# CMD: worker (foreground local Worker management CLI)
# ============================================================
function Cmd-Worker {
    $versionDir = Resolve-CurrentVersion
    if (-not $versionDir) {
        Write-Error "Current loongsuite-pilot version not found"
        exit 1
    }

    $entry = Join-Path $versionDir "dist\index.js"
    if (-not (Test-Path $entry -PathType Leaf)) {
        Write-Error "Worker CLI entrypoint missing"
        exit 1
    }

    $nodeBin = Resolve-Node
    if (-not $nodeBin) {
        Write-Error "node runtime not found"
        exit 1
    }

    $env:LOONGSUITE_PILOT_DATA_DIR = $DATA_DIR
    $env:LOONGSUITE_PILOT_CACHE_DIR = $CACHE_DIR
    & $nodeBin $entry "worker" @SubArgs
    exit $LASTEXITCODE
}

# ============================================================
# CMD: agent (registered high-level PI SDK Agent management)
# ============================================================
function Cmd-Agent {
    $versionDir = Resolve-CurrentVersion
    if (-not $versionDir) {
        Write-Error "Current loongsuite-pilot version not found"
        exit 1
    }

    $entry = Join-Path $versionDir "dist\index.js"
    if (-not (Test-Path $entry -PathType Leaf)) {
        Write-Error "Agent CLI entrypoint missing"
        exit 1
    }

    $nodeBin = Resolve-Node
    if (-not $nodeBin) {
        Write-Error "node runtime not found"
        exit 1
    }

    $subcommand = if ($SubArgs.Count -ge 1) { [string]$SubArgs[0] } else { "" }
    $wasRunning = (Test-CollectorRunning) -or (Test-PidRunning $PID_FILE)
    $env:LOONGSUITE_PILOT_DATA_DIR = $DATA_DIR
    $env:LOONGSUITE_PILOT_CACHE_DIR = $CACHE_DIR
    $env:AGENT_DATA_COLLECTION_CONFIG = $CONFIG_FILE
    & $nodeBin $entry "agent" @SubArgs
    $result = $LASTEXITCODE
    if ($result -ne 0) { exit $result }

    if ($wasRunning -and $subcommand.ToLower() -in @("register", "unregister")) {
        Cmd-RestartCollector
    }
}

# ============================================================
# CMD: help
# ============================================================
# Manage span-attributes.json -- user-defined attributes injected into trace
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
function read() { try { const o = JSON.parse(fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, "")); return (o && typeof o === "object" && !Array.isArray(o)) ? o : {}; } catch { return {}; } }
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
    Write-Host "  deploy [opts]   Deploy hooks/plugins once and exit (for image builds)"
    Write-Host "                    --require <ids>  comma-separated agent ids that must deploy"
    Write-Host "                    --json           machine-readable result"
    Write-Host "  token-usage     Show token usage TUI"
    Write-Host "  tokens          Alias for token-usage"
    Write-Host "  span-attr ...   Manage custom trace span attributes (set/unset/list/clear)"
    Write-Host "  agent ...       Register/list/diagnose PI SDK Agents"
    Write-Host "  rollback        Roll back to the previous version"
    Write-Host "  worker          Manage local Workers:"
    Write-Host "                    worker connect/list/status/disconnect/delete"
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
    "deploy"             { Cmd-Deploy }
    "token-usage"        { Cmd-TokenUsage }
    "tokens"             { Cmd-TokenUsage }
    "rollback"           { Cmd-Rollback }
    "worker"             { Cmd-Worker }
    "agent"              { Cmd-Agent }
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
