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
$OPEN_SOURCE_INSTALLER_URL = "https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.ps1"

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

function Get-BuildEdition {
    try {
        $versionDir = Resolve-CurrentVersion
        if (-not $versionDir) { return "" }

        $probe = Join-Path $versionDir "dist\cli-probe.cjs"
        if (-not (Test-Path -LiteralPath $probe)) { return "" }

        $nodeBin = Resolve-Node
        if (-not $nodeBin) { return "" }

        return ([string](& $nodeBin $probe --build-edition 2>$null)).Trim()
    } catch {
        return ""
    }
}

function Test-OpenSourceBuild {
    return (Get-BuildEdition) -eq "opensource"
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

# Read-only cousin of Test-PidRunning. Wait loops must not delete the pid file: a
# successor can write a new pid between the probe and the Remove-Item, and Unix
# wait_for_* is already read-only (kill -0). Stale-pid cleanup stays in Stop-PidFile.
function Test-PidAlive {
    param([string]$pidFile)
    if (-not (Test-Path $pidFile)) { return $false }
    try {
        $raw = Get-Content $pidFile -ErrorAction SilentlyContinue
        if (-not $raw) { return $false }
        $pidVal = ([string]$raw).Trim()
        if (-not $pidVal) { return $false }
        $proc = Get-Process -Id $pidVal -ErrorAction SilentlyContinue
        return $null -ne $proc
    } catch {
        return $false
    }
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

    # Delete the file only while it still names the process we just killed. Up to ten
    # seconds elapse in the wait loop above, and the collector task carries a five-minute
    # repeating trigger, so a successor may already have started and written its own pid
    # here -- unconditional removal then deleted a live daemon's pid file, after which
    # status reported it as not running and the next start raced a second instance against
    # it. Same rule the daemons themselves follow on shutdown (removeOwnPidFileSync in
    # src/utils/pid-utils.ts). Re-read rather than trusting $pidVal: the point is what is
    # on disk now, not what was there before Stop-Process.
    $currentPid = ""
    if (Test-Path -LiteralPath $pidFile) {
        $currentPid = ([string](Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue)).Trim()
    }
    if ($currentPid -eq $pidVal) {
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
}

function Stop-OrphanProcesses {
    # $Match limits which daemons are terminated; the default kills both. Callers that
    # re-register a single task (Install-CollectorTask / Install-UpdaterTask) pass a
    # narrow pattern so they only reap the daemon they are about to re-launch.
    #
    # Both conditions below are required, and the second one is the point. The daemon
    # names are shared by every installation on the machine: on a multi-account box each
    # user runs their own collector and updater out of their own %USERPROFILE%, and
    # matching on the name alone made any install / restart / stop kill all of them.
    # Get-Process only enumerates other users' processes when the caller is elevated, so
    # the blast radius was exactly the elevated sessions -- their victims' pid files were
    # left pointing at dead pids, which is where the "stale single-instance lock" reports
    # came from. $BOOTSTRAP_DIR is the directory the entry script is loaded from
    # (New-HiddenTaskAction writes "<node>" "<$BOOTSTRAP_DIR\<name>-daemon.js>", and
    # Cmd-Start builds the same pair), so it appears verbatim in the command line and
    # identifies this installation and no other. It is non-empty by construction:
    # $CACHE_DIR falls back to $DEFAULT_PILOT_DIR.
    #
    # .ToLower().Contains() rather than -match: the scope is a literal Windows path full
    # of \ and possibly regex metacharacters (a user profile can contain "["), and
    # escaping it for a regex buys nothing here. It is also a method call on [string], a
    # core type, so it stays CLM-safe.
    param([string]$Match = "collector-daemon|updater-daemon")
    $ownRoot = ([string]$BOOTSTRAP_DIR).ToLower()
    # Query Win32_Process once. The old Get-Process pipeline issued one CIM query per
    # node process, so a machine with many IDE/agent runtimes paid N WMI round trips on
    # every upgrade. CommandLine and ProcessId already come from this single result set.
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            try {
                $cmdLine = [string]$_.CommandLine
                ($cmdLine -match $Match) -and $cmdLine.ToLower().Contains($ownRoot)
            } catch { $false }
        } | ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
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

function Get-TaskQuery {
    param([string]$taskName)
    $result = @{ task = $null; exists = $false; error = "" }
    try {
        $result.task = Get-ScheduledTask -TaskName $taskName -TaskPath "$TASK_FOLDER\" -ErrorAction Stop
        $result.exists = $null -ne $result.task
    } catch {
        $message = [string]$_.Exception.Message
        $category = ""
        if ($_.CategoryInfo) { $category = [string]$_.CategoryInfo.Category }
        # "No MSFT_ScheduledTask objects found ..." is the ordinary not-registered
        # answer from the CIM-backed cmdlet; only anything else is an unknown.
        if ($category -eq "ObjectNotFound" -or $message -match "No MSFT_ScheduledTask objects found") {
            $result.error = ""
        } else {
            $result.error = $message
        }
    }
    return $result
}

# Second opinion on whether the task exists, from a completely different code path
# (schtasks.exe instead of the ScheduledTasks CIM module). Returns "yes", "no" or
# "unknown: <reason>". A "no" from Get-TaskQuery next to a "yes" here is the signature
# of a broken query rather than a missing task.
#
# The EAP dance is mandatory, not defensive: under $ErrorActionPreference = "Stop" a
# native command writing one line to stderr while a 2>&1 redirect is in effect raises a
# NativeCommandError whose message is that raw line, so every branch below would be
# skipped and the caller would see the bare schtasks text instead of a diagnosis.
# Restore in finally -- an exception thrown out of the try would otherwise leave the
# whole script running under "Continue", silently disabling every later fail-fast check.
function Test-TaskExistsViaSchtasks {
    param([string]$taskName)
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    # Preset to a non-zero value: if schtasks.exe never launches at all, $LASTEXITCODE
    # still holds whatever the previous command left there (possibly 0 = success).
    $code = 9009
    try {
        $out = & schtasks.exe /Query /TN "$TASK_FOLDER\$taskName" 2>&1
        $code = $LASTEXITCODE
        if ($code -eq 0) { return "yes" }
        # Every stderr line arrives as an ErrorRecord, and an empty one stringifies to its
        # exception type name -- measured on 5.1, the raw join reported
        # "ERROR: The system cannot find the file specified. System.Management.Automation.RemoteException".
        # No type literal here (Constrained Language Mode): read .Exception.Message if present.
        $parts = @()
        foreach ($item in $out) {
            $line = [string]$item
            if ($item.Exception -and $item.Exception.Message) { $line = [string]$item.Exception.Message }
            $line = $line.Trim()
            if (-not $line) { continue }
            if ($line -eq "System.Management.Automation.RemoteException") { continue }
            $parts += $line
        }
        $text = ($parts -join " ").Trim()
        if ($text.Length -gt 200) { $text = $text.Substring(0, 200) }
        # The message is localized on non-English Windows, so no attempt is made to
        # classify it as "no": the exit code plus the raw text is what a human needs.
        return "unknown: exit=$code $text"
    } catch {
        return "unknown: $($_.Exception.Message)"
    } finally {
        $ErrorActionPreference = $prevEAP
    }
}

# Start a task that Get-ScheduledTask could not see (CIM query failed, or schtasks
# said yes while CIM said no). Same EAP / 2>&1 / $LASTEXITCODE / finally shape as
# Test-TaskExistsViaSchtasks: under EAP=Stop a native stderr line would skip every
# branch below and surface as a bare schtasks message.
function Invoke-SchtasksRun {
    param([string]$taskName)
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $code = 9009
    $result = @{ ok = $false; error = "" }
    try {
        $out = & schtasks.exe /Run /TN "$TASK_FOLDER\$taskName" 2>&1
        $code = $LASTEXITCODE
        if ($code -eq 0) {
            $result.ok = $true
            return $result
        }
        $parts = @()
        foreach ($item in $out) {
            $line = [string]$item
            if ($item.Exception -and $item.Exception.Message) { $line = [string]$item.Exception.Message }
            $line = $line.Trim()
            if (-not $line) { continue }
            if ($line -eq "System.Management.Automation.RemoteException") { continue }
            $parts += $line
        }
        $text = ($parts -join " ").Trim()
        if ($text.Length -gt 200) { $text = $text.Substring(0, 200) }
        $result.error = "exit=$code $text"
        return $result
    } catch {
        $result.error = [string]$_.Exception.Message
        return $result
    } finally {
        $ErrorActionPreference = $prevEAP
    }
}

# CIM found the task, the query itself broke, or schtasks says yes: Start may still
# work, so do not skip it. Confirmed missing (CIM not-found AND schtasks did not say
# yes) is the only case that should re-register.
function Get-TaskStartIntent {
    param($Query, [string]$TaskName)
    $existsSchtasks = Test-TaskExistsViaSchtasks $TaskName
    $shouldStart = $false
    if ($Query.exists) { $shouldStart = $true }
    if ($Query.error) { $shouldStart = $true }
    if ($existsSchtasks -eq "yes") { $shouldStart = $true }
    $confirmedMissing = $true
    if ($Query.exists) { $confirmedMissing = $false }
    if ($Query.error) { $confirmedMissing = $false }
    if ($existsSchtasks -eq "yes") { $confirmedMissing = $false }
    return @{
        should_start = $shouldStart
        confirmed_missing = $confirmedMissing
        exists_schtasks = $existsSchtasks
    }
}

function Get-InitType {
    if (-not (Test-Path $INIT_TYPE_FILE)) { return "" }
    $value = (Get-Content $INIT_TYPE_FILE -ErrorAction SilentlyContinue)
    if (-not $value) { return "" }
    return ([string]$value).Trim()
}

function Wait-ForCollectorHeartbeat {
    param([int]$TimeoutSeconds = 15)
    $notBefore = (Get-Date).AddSeconds(-2)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if (
            (Get-CollectorRuntime -NotBefore $notBefore) -or
            (Test-PidAlive $PID_FILE)
        ) {
            return $true
        }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Wait-ForUpdaterAlive {
    param([int]$TimeoutSeconds = 15)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if ((Get-TaskRunning $TASK_NAME_UPDATER) -or (Test-PidAlive $UPDATER_PID_FILE)) {
            return $true
        }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadline)
    return $false
}

# ============================================================
# Restart failure diagnostics
#
# Every non-success exit of Cmd-RestartCollector / Cmd-RestartUpdater goes through
# Write-RestartFailure, which prints the reason and drops a breadcrumb file that the
# calling collector/updater reads (src/utils/restart-breadcrumb.ts) to enrich its alarm.
# The file channel exists because the streams are not trustworthy here: the caller uses
# execFile and only surfaces stderr in err.message, $OutputEncoding is ASCII on 5.1, and
# the installer's Restart-StaleCollector merges both streams with 2>&1.
# ============================================================
function Get-RestartFailureFile {
    param([string]$Target)
    return (Join-Path $LOG_DIR "last-restart-failure-$Target.json")
}

# Cleared at the start of every restart attempt, so a file that is present always
# describes the most recent attempt (same invariant as the startup-crash breadcrumb).
function Clear-RestartFailure {
    param([string]$Target)
    try {
        $file = Get-RestartFailureFile $Target
        if (Test-Path -LiteralPath $file) {
            Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
        }
    } catch {}
}

# Whether a failure is a permission denial, which decides between the "register-denied"
# stage (someone installed while elevated, so the task is owned by BUILTIN\Administrators
# and this unelevated session can start it but never rewrite it) and a generic
# registration failure. The HRESULT is checked first because the message is localized on
# non-English Windows -- on a Chinese box the English phrase never appears, so matching
# text alone would misfile the single most common real cause.
function Test-AccessDeniedError {
    param($ErrorRecord)
    try {
        if ($ErrorRecord.Exception -and $null -ne $ErrorRecord.Exception.HResult) {
            # 0x80070005 E_ACCESSDENIED, as an int32.
            if ([int]$ErrorRecord.Exception.HResult -eq -2147024891) { return $true }
        }
        $message = [string]$ErrorRecord.Exception.Message
        return ($message -match "(?i)access is denied|0x80070005")
    } catch {
        return $false
    }
}

# Get-Date -UFormat %s is unusable on 5.1: it formats local time as if it were UTC, so
# the value is off by the timezone offset (8h here) and the reader's freshness check
# would either reject this breadcrumb or accept a stale one.
function Get-EpochSeconds {
    return [int](((Get-Date).ToUniversalTime() - (Get-Date -Date "1970-01-01 00:00:00")).TotalSeconds)
}

# Everything worth knowing about why a restart did not take, as a flat string map
# (flat because the reader renders it into a single-line alarm message, and because a
# nested [pscustomobject] cannot be built under Constrained Language Mode).
# Read-only by contract: no Test-PidRunning here, which deletes the pid file it finds
# stale -- diagnostics must not change the state they are describing.
function Get-RestartDiagnostics {
    param(
        [string]$TaskName,
        [string]$PidFile,
        [string]$LogFile,
        [hashtable]$Extra = $null
    )
    $diag = @{}

    $query = Get-TaskQuery $TaskName
    $diag["exists_ps"] = if ($query.exists) { "yes" } else { "no" }
    if ($query.error) { $diag["query_error"] = $query.error }
    # Second opinion from schtasks.exe. "no" from the CIM cmdlet next to "yes" here is
    # the signature of a broken query rather than a task that is really gone.
    $diag["exists_schtasks"] = Test-TaskExistsViaSchtasks $TaskName

    $task = $query.task
    if ($task) {
        try {
            $diag["task_state"] = [string]$task.State
            $principal = $task.Principal
            if ($principal) {
                $diag["principal_user"] = [string]$principal.UserId
                $diag["logon_type"] = [string]$principal.LogonType
                $diag["run_level"] = [string]$principal.RunLevel
            }
            $action = $task.Actions | Select-Object -First 1
            if ($action) {
                $diag["action_exe"] = [string]$action.Execute
                $diag["action_args"] = [string]$action.Arguments
            }
        } catch {
            $diag["task_read_error"] = [string]$_.Exception.Message
        }
    }

    try {
        $info = Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
        if ($info) {
            $diag["last_run_time"] = [string]$info.LastRunTime
            $diag["last_task_result"] = ("0x{0:X8}" -f [int]$info.LastTaskResult)
            $diag["missed_runs"] = [string]$info.NumberOfMissedRuns
        }
    } catch {}

    # Owner of the on-disk task definition. An elevated install re-owns it to
    # BUILTIN\Administrators; UAC filters that group out of an unelevated token, so this
    # session can start the task but can never delete or re-register it (measured: the
    # task's own principal keeps only Read, Synchronize). That single field distinguishes
    # "denied because someone installed as admin" from every other denial.
    try {
        $taskFolderLeaf = ([string]$TASK_FOLDER).TrimStart("\")
        $definition = Join-Path (Join-Path $env:SystemRoot "System32\Tasks") (Join-Path $taskFolderLeaf $TaskName)
        # No Test-Path short-circuit: on 5.1 Test-Path returns $false for both a missing
        # file and ERROR_ACCESS_DENIED on System32\Tasks, so an admin-owned definition
        # was reported as "no definition file". Get-Acl and let catch name the reason.
        $diag["definition_owner"] = [string](Get-Acl -LiteralPath $definition).Owner
    } catch {
        $diag["definition_owner"] = "unreadable: $($_.Exception.Message)"
    }

    $pidState = "no pid file"
    try {
        if ($PidFile -and (Test-Path -LiteralPath $PidFile)) {
            $pidValue = ([string](Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue)).Trim()
            $proc = $null
            if ($pidValue) { $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue }
            $pidState = if ($proc) { "pid=$pidValue running" } else { "pid=$pidValue not running" }
        }
    } catch {
        $pidState = "unreadable: $($_.Exception.Message)"
    }
    $diag["pid_state"] = $pidState

    try {
        $node = Resolve-Node
        $diag["node_bin"] = if ($node) { $node } else { "not found" }
    } catch {
        $diag["node_bin"] = "resolve failed: $($_.Exception.Message)"
    }

    try {
        if ($LogFile -and (Test-Path -LiteralPath $LogFile)) {
            $tail = Get-Content -LiteralPath $LogFile -Tail 3 -ErrorAction SilentlyContinue
            $joined = ([string]($tail -join " / ")).Trim()
            if ($joined.Length -gt 300) { $joined = $joined.Substring(0, 300) }
            if ($joined) { $diag["log_tail"] = $joined }
        }
    } catch {}

    if ($Extra) {
        foreach ($key in $Extra.Keys) {
            $value = [string]$Extra[$key]
            if ($value) { $diag[$key] = $value }
        }
    }

    return $diag
}

# Prints the failure and persists it. MUST be called before Write-Error / exit: under
# $ErrorActionPreference = "Stop" (top of this file) Write-Error is a terminating error,
# so anything after it is unreachable -- that is exactly how the old code path ended up
# reporting "Service manager failed to restart updater" with no reason attached.
# Wrapped in try/catch throughout: diagnostics must never become a new failure source.
function Write-RestartFailure {
    param(
        [string]$Target,
        [string]$Stage,
        [string]$Detail = "",
        [hashtable]$Extra = $null
    )
    $initType = ""
    try { $initType = Get-InitType } catch {}

    $diag = @{}
    try {
        if ($Target -eq "updater") {
            $diag = Get-RestartDiagnostics `
                -TaskName $TASK_NAME_UPDATER `
                -PidFile $UPDATER_PID_FILE `
                -LogFile $UPDATER_LOG_FILE `
                -Extra $Extra
        } else {
            $diag = Get-RestartDiagnostics `
                -TaskName $TASK_NAME_COLLECTOR `
                -PidFile $PID_FILE `
                -LogFile $LOG_FILE `
                -Extra $Extra
        }
    } catch {
        $diag = @{ diag_error = [string]$_.Exception.Message }
        if ($Extra) {
            foreach ($key in $Extra.Keys) { $diag[$key] = [string]$Extra[$key] }
        }
    }

    # Console copy first: it is the only one a human running the command by hand sees,
    # and it must survive a failure of the file write below.
    Write-Host "[restart-failure] target=$Target stage=$Stage init_type=$initType"
    if ($Detail) { Write-Host "[restart-failure] reason=$Detail" }
    try {
        foreach ($key in ($diag.Keys | Sort-Object)) {
            Write-Host "[restart-failure] ${key}=$($diag[$key])"
        }
    } catch {}

    try {
        Ensure-Dirs
        $payload = @{
            schema = 1
            ts = (Get-EpochSeconds)
            target = $Target
            stage = $Stage
            init_type = $initType
            detail = $Detail
            diag = $diag
        }
        $file = Get-RestartFailureFile $Target
        $tmp = "$file.tmp"
        # -Encoding UTF8 is mandatory: Set-Content defaults to the ANSI codepage while
        # node reads this as UTF-8, and a non-ASCII account name or localized Windows
        # message in any field would come back mojibake. 5.1 always adds a BOM; the
        # reader goes through readJsonFile, which strips it.
        ($payload | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $tmp -Encoding UTF8
        Move-Item -LiteralPath $tmp -Destination $file -Force
    } catch {
        Write-Host "[restart-failure] breadcrumb write failed: $($_.Exception.Message)"
    }
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
    param([string]$nodeBin, [switch]$SkipCleanup)
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
    if (-not $SkipCleanup) {
        Stop-OrphanProcesses -Match "collector-daemon"

        # Remove existing task first (schtasks is more reliable than Unregister-ScheduledTask)
        # Use try/catch because schtasks stderr + $ErrorActionPreference=Stop can throw
        try { schtasks.exe /Delete /TN "$TASK_FOLDER\$TASK_NAME_COLLECTOR" /F 2>$null | Out-Null } catch {}
        try { schtasks.exe /Delete /TN "$TASK_NAME_COLLECTOR" /F 2>$null | Out-Null } catch {}
    }

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

function Start-BackgroundDaemon {
    param(
        [string]$DaemonName,
        [string]$NodeBin,
        [string]$Entry,
        [string]$OutputLog,
        [string]$ErrorLog
    )
    $launcherPath = Join-Path $BOOTSTRAP_DIR "$DaemonName-background.ps1"
    $escapedDataDir = ([string]$DATA_DIR).Replace("'", "''")
    $escapedCacheDir = ([string]$CACHE_DIR).Replace("'", "''")
    $escapedConfig = ([string]$CONFIG_FILE).Replace("'", "''")
    $escapedNode = ([string]$NodeBin).Replace("'", "''")
    $escapedEntry = ([string]$Entry).Replace("'", "''")
    $escapedOutput = ([string]$OutputLog).Replace("'", "''")
    $escapedError = ([string]$ErrorLog).Replace("'", "''")
    @(
        "`$env:LOONGSUITE_PILOT_DATA_DIR = '$escapedDataDir'",
        "`$env:LOONGSUITE_PILOT_CACHE_DIR = '$escapedCacheDir'",
        "`$env:AGENT_DATA_COLLECTION_CONFIG = '$escapedConfig'",
        "& '$escapedNode' '$escapedEntry' >> '$escapedOutput' 2>> '$escapedError'"
    ) | Set-Content -LiteralPath $launcherPath -Encoding Unicode

    # Use -File so paths are parsed only inside the generated script, where every
    # single quote has been escaped. Directly interpolating them into -Command breaks
    # profiles and custom data dirs such as C:\Users\O'Brien.
    $launcherArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcherPath`""
    Start-Process -FilePath "powershell.exe" `
        -ArgumentList $launcherArgs `
        -WorkingDirectory $CACHE_DIR `
        -WindowStyle Hidden
}

# Start the collector without stopping it or scanning for processes. This command is
# the updater's recovery path after restart-collector times out: the timed-out command
# may already have completed the stop half, so running another restart would extend the
# collection gap. If a partial upgrade deleted the scheduled task, recreate only that
# missing task without the destructive cleanup used by normal registration.
function Cmd-StartCollector {
    if ((Get-CollectorRuntime) -or (Test-PidRunning $PID_FILE)) {
        Write-Host "collector is already running"
        return
    }

    Ensure-Dirs
    Sync-BootstrapScripts
    $nodeBin = Resolve-Node
    if (-not $nodeBin) {
        Write-Error "node runtime not found"
        exit 1
    }

    $query = Get-TaskQuery $TASK_NAME_COLLECTOR
    $intent = Get-TaskStartIntent $query $TASK_NAME_COLLECTOR
    $shouldStart = [bool]$intent.should_start
    $confirmedMissing = [bool]$intent.confirmed_missing

    if ($shouldStart) {
        try {
            Start-ScheduledTask -TaskName $TASK_NAME_COLLECTOR -TaskPath "$TASK_FOLDER\" -ErrorAction Stop
            Write-Host "collector start requested (Task Scheduler)"
            return
        } catch {
            $run = Invoke-SchtasksRun $TASK_NAME_COLLECTOR
            if ($run.ok) {
                Write-Host "collector start requested (schtasks /Run)"
                return
            }
            Write-Host "Task Scheduler start failed: $($_.Exception.Message)" -ForegroundColor Yellow
            if ($query.exists) {
                Write-Error "Service manager failed to start collector"
                exit 1
            }
        }
    }

    if ($confirmedMissing) {
        try {
            $ok = Install-CollectorTask $nodeBin -SkipCleanup
            if ($ok) {
                Start-ScheduledTask -TaskName $TASK_NAME_COLLECTOR -TaskPath "$TASK_FOLDER\" -ErrorAction Stop
                Set-Content -Path $INIT_TYPE_FILE -Value "taskscheduler"
                Write-Host "collector task restored and start requested (Task Scheduler)"
                return
            }
        } catch {
            Write-Host "Collector task recovery failed: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }

    # A missing task can be the result of an interrupted activation. Keep collection
    # available even when task repair is denied; the updater's runtime/PID validation
    # decides whether this detached fallback really became healthy.
    $entry = Join-Path $BOOTSTRAP_DIR "collector-daemon.js"
    if (-not (Test-Path $entry)) {
        Write-Error "Bootstrap script missing"
        exit 1
    }
    $errLog = Join-Path $LOG_DIR "loongsuite-pilot-service-err.log"
    Start-BackgroundDaemon "collector" $nodeBin $entry $LOG_FILE $errLog
    Write-Host "collector start requested (background fallback)" -ForegroundColor Yellow
}

function Schedule-UpdaterRestart {
    Ensure-Dirs
    $handoffScript = Join-Path $BOOTSTRAP_DIR "restart-updater-delayed.ps1"
    $escapedBin = ([string]$LOONGSUITE_PILOT_BIN).Replace("'", "''")
    $escapedLog = ([string]$UPDATER_LOG_FILE).Replace("'", "''")
    @(
        "Start-Sleep -Seconds 10",
        "& '$escapedBin' restart-updater *>> '$escapedLog'"
    ) | Set-Content -LiteralPath $handoffScript -Encoding Unicode

    # Start-Process creates an independent process instead of a PowerShell job owned by
    # this invocation. It therefore survives long enough to stop/relaunch the updater
    # after the current health check and bookkeeping have completed.
    $handoffArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$handoffScript`""
    Start-Process -FilePath "powershell.exe" `
        -ArgumentList $handoffArgs `
        -WorkingDirectory $CACHE_DIR `
        -WindowStyle Hidden
    Write-Host "updater restart scheduled"
}

# ============================================================
# CMD: restart-collector (used by updater after deploying a new version)
# ============================================================
function Cmd-RestartCollector {
    param([string[]]$Options = @())
    Clear-RestartFailure "collector"

    $deferUpdaterRestart = $false
    foreach ($option in $Options) {
        if ($option -eq "--defer-updater-restart") {
            $deferUpdaterRestart = $true
        } else {
            Write-RestartFailure -Target "collector" -Stage "service-manager-refused" `
                -Detail "Unknown restart-collector option: $option"
            Write-Error "Unknown restart-collector option: $option"
            exit 1
        }
    }

    # Stop collector only (leave updater running)
    $task = Get-ScheduledTask -TaskName $TASK_NAME_COLLECTOR -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
    if ($task -and $task.State -eq "Running") {
        Stop-ScheduledTask -TaskName $TASK_NAME_COLLECTOR -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
    }
    Stop-PidFile $PID_FILE

    # Kill orphan collector processes. Was an inline copy of Stop-OrphanProcesses that
    # predated the -Match parameter; it also missed the installation scope the shared
    # helper now applies, and restart-collector is the command the updater runs on every
    # deploy -- i.e. the one that reached other accounts most often.
    Stop-OrphanProcesses -Match "collector-daemon"

    Start-Sleep -Seconds 1
    Ensure-Dirs
    Sync-BootstrapScripts

    $nodeBin = Resolve-Node
    if (-not $nodeBin) {
        Write-RestartFailure -Target "collector" -Stage "node-missing" `
            -Detail "Resolve-Node found no usable node runtime (needs v18+; checked the pin file, nvm, PATH and the managed runtime)"
        Write-Error "node runtime not found"
        exit 1
    }

    $initType = Get-InitType
    # See Cmd-RestartUpdater: narrowed as the ladder proceeds so the exit can name a cause.
    $stage = "service-manager-refused"
    $detail = "no restart path succeeded"
    $extra = @{}

    # Restart via Task Scheduler if registered
    $restarted = $false
    $query = Get-TaskQuery $TASK_NAME_COLLECTOR
    $intent = Get-TaskStartIntent $query $TASK_NAME_COLLECTOR
    $shouldStart = [bool]$intent.should_start
    $confirmedMissing = [bool]$intent.confirmed_missing
    $extra["exists_schtasks"] = [string]$intent.exists_schtasks
    if ($query.error) {
        $stage = "task-query-failed"
        $detail = "Get-ScheduledTask failed: $($query.error)"
        Write-Host "Task query failed for $TASK_FOLDER\$TASK_NAME_COLLECTOR : $($query.error)" -ForegroundColor Yellow
    } elseif (-not $query.exists) {
        $stage = "task-missing"
        $detail = "scheduled task $TASK_FOLDER\$TASK_NAME_COLLECTOR is not registered"
        Write-Host "Scheduled task not registered: $TASK_FOLDER\$TASK_NAME_COLLECTOR" -ForegroundColor Yellow
    }

    if ($shouldStart) {
        # Re-register with potentially updated paths -- best-effort, and only when CIM
        # actually found the task. A query-fail or schtasks-yes must not delete+recreate.
        # The Install call is in its OWN try so a failure here can no longer skip start.
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
        if ($query.exists) {
            try {
                Install-CollectorTask $nodeBin | Out-Null
            } catch {
                $extra["register_error"] = [string]$_.Exception.Message
                Write-Host "Task re-registration skipped (start still attempted): $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
        try {
            Start-ScheduledTask -TaskName $TASK_NAME_COLLECTOR -TaskPath "$TASK_FOLDER\" -ErrorAction Stop
            # Start-ScheduledTask only means Task Scheduler accepted the request. Waiting
            # for the heartbeat (the same criterion Cmd-Start uses) is what keeps a new
            # version that crashes on startup from being reported as a successful restart.
            if (Wait-ForCollectorHeartbeat 20) {
                Write-Host "collector restarted (Task Scheduler)"
                $restarted = $true
            } else {
                $stage = "not-running-after-start"
                $detail = "Start-ScheduledTask returned success but no collector heartbeat or pid appeared within 20s"
                Write-Host "Task started but no collector heartbeat: $TASK_NAME_COLLECTOR" -ForegroundColor Yellow
            }
        } catch {
            $message = [string]$_.Exception.Message
            $run = Invoke-SchtasksRun $TASK_NAME_COLLECTOR
            if ($run.ok) {
                if (Wait-ForCollectorHeartbeat 20) {
                    Write-Host "collector restarted (schtasks /Run)"
                    $restarted = $true
                } else {
                    $stage = "not-running-after-start"
                    $detail = "schtasks /Run returned success but no collector heartbeat or pid appeared within 20s"
                    Write-Host "Task started via schtasks /Run but no collector heartbeat: $TASK_NAME_COLLECTOR" -ForegroundColor Yellow
                }
            } else {
                $extra["start_error"] = $message
                $extra["schtasks_run_error"] = [string]$run.error
                $stage = if (Test-AccessDeniedError $_) { "register-denied" } else { "start-failed" }
                $detail = "Start-ScheduledTask failed: $message"
                Write-Host "Task Scheduler restart failed: $message" -ForegroundColor Yellow
            }
        }
    }

    if (-not $restarted) {
        # Self-heal, no longer gated on init_type -- see the equivalent comment in
        # Cmd-RestartUpdater: the gate left a taskscheduler install with a broken task no
        # way to repair itself. Only when the task is confirmed missing: a query-fail or
        # schtasks-yes means Start may still work, and delete+recreate would be denied.
        if ($confirmedMissing) {
            try {
                $ok = Install-CollectorTask $nodeBin
                if (-not $ok) {
                    $stage = "bootstrap-missing"
                    $detail = "Install-CollectorTask declined: collector-daemon.js missing under $BOOTSTRAP_DIR"
                    Write-Host "Self-heal skipped: $detail" -ForegroundColor Yellow
                } else {
                    Start-ScheduledTask -TaskName $TASK_NAME_COLLECTOR -TaskPath "$TASK_FOLDER\" -ErrorAction Stop
                    if (Wait-ForCollectorHeartbeat 20) {
                        Set-Content -Path $INIT_TYPE_FILE -Value "taskscheduler"
                        Write-Host "collector self-healed: registered with Task Scheduler"
                        $restarted = $true
                    } else {
                        $stage = "selfheal-not-running"
                        $detail = "task re-registered but no collector heartbeat within 20s"
                        Write-Host "Self-heal registered the task but nothing came up" -ForegroundColor Yellow
                    }
                }
            } catch {
                $message = [string]$_.Exception.Message
                $extra["selfheal_error"] = $message
                $stage = if (Test-AccessDeniedError $_) { "register-denied" } else { "selfheal-register-failed" }
                $detail = "self-heal failed: $message"
                Write-Host "Self-heal failed: $message" -ForegroundColor Yellow
            }
        } else {
            Write-Host "Self-heal skipped: task not confirmed missing (exists_schtasks=$($intent.exists_schtasks))" -ForegroundColor Yellow
        }
        if (-not $restarted) {
            # Restricted to installs that never had a task, and reported when skipped --
            # see Cmd-RestartUpdater.
            if ($initType -in @("background", "unknown", "")) {
                $entry = Join-Path $BOOTSTRAP_DIR "collector-daemon.js"
                if (-not (Test-Path $entry)) {
                    Write-RestartFailure -Target "collector" -Stage "bootstrap-missing" `
                        -Detail "collector-daemon.js not found at $entry" -Extra $extra
                    Write-Error "Bootstrap script missing"
                    exit 1
                }
                $errLog = Join-Path $LOG_DIR "loongsuite-pilot-service-err.log"
                # node publishes its own pid file on Windows (see src/index.ts); export the
                # data dir so it lands at $DATA_DIR\loongsuite-pilot.pid. No Set-Content here --
                # $proc.Id would be the wrapper pid, not node's.
                Start-BackgroundDaemon "collector" $nodeBin $entry $LOG_FILE $errLog
                if (Wait-ForCollectorHeartbeat 10) {
                    Write-Host "collector restarted (background fallback after stage=$stage : $detail)" -ForegroundColor Yellow
                } else {
                    Write-RestartFailure -Target "collector" -Stage "not-running-after-start" `
                        -Detail "background fallback started but no collector heartbeat or pid appeared within 10s" `
                        -Extra $extra
                    Write-Error "Service manager failed to restart collector (init_type=$initType stage=not-running-after-start): background fallback did not come up"
                    exit 1
                }
            } else {
                # Diagnostics before Write-Error: EAP=Stop makes it terminating, so nothing
                # after it runs (the old `exit 1` never executed either).
                Write-RestartFailure -Target "collector" -Stage $stage -Detail $detail -Extra $extra
                Write-Error "Service manager failed to restart collector (init_type=$initType stage=$stage): $detail"
                exit 1
            }
        }
    }

    if (-not $deferUpdaterRestart) {
        Schedule-UpdaterRestart
    }
}

# ============================================================
# CMD: restart-updater
# ============================================================
function Cmd-RestartUpdater {
    # Any breadcrumb still on disk describes an older attempt. Clearing it here is what
    # lets the caller treat "file present and fresh" as "this attempt failed, here is why".
    Clear-RestartFailure "updater"

    # Stop updater
    $task = Get-ScheduledTask -TaskName $TASK_NAME_UPDATER -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
    if ($task -and $task.State -eq "Running") {
        Stop-ScheduledTask -TaskName $TASK_NAME_UPDATER -TaskPath "$TASK_FOLDER\" -ErrorAction SilentlyContinue
    }
    Stop-PidFile $UPDATER_PID_FILE

    # Second inline copy, same history and same missing scope as the one in
    # Cmd-RestartCollector.
    Stop-OrphanProcesses -Match "updater-daemon"

    Start-Sleep -Seconds 1
    Ensure-Dirs
    Sync-BootstrapScripts

    $nodeBin = Resolve-Node
    if (-not $nodeBin) {
        Write-RestartFailure -Target "updater" -Stage "node-missing" `
            -Detail "Resolve-Node found no usable node runtime (needs v18+; checked the pin file, nvm, PATH and the managed runtime)"
        Write-Error "node runtime not found"
        return
    }

    $initType = Get-InitType
    # Stage/detail carry the most specific thing learned so far, so the exit at the
    # bottom can name a cause instead of just "the service manager refused". They start
    # at the generic label and are narrowed as the ladder proceeds.
    $stage = "service-manager-refused"
    $detail = "no restart path succeeded"
    $extra = @{}

    # Restart via Task Scheduler
    $restarted = $false
    $query = Get-TaskQuery $TASK_NAME_UPDATER
    $intent = Get-TaskStartIntent $query $TASK_NAME_UPDATER
    $shouldStart = [bool]$intent.should_start
    $confirmedMissing = [bool]$intent.confirmed_missing
    $extra["exists_schtasks"] = [string]$intent.exists_schtasks
    if ($query.error) {
        # Not the same thing as "not registered": the query itself broke, so re-registering
        # is the wrong reflex and the reason must be reported verbatim.
        $stage = "task-query-failed"
        $detail = "Get-ScheduledTask failed: $($query.error)"
        Write-Host "Task query failed for $TASK_FOLDER\$TASK_NAME_UPDATER : $($query.error)" -ForegroundColor Yellow
    } elseif (-not $query.exists) {
        $stage = "task-missing"
        $detail = "scheduled task $TASK_FOLDER\$TASK_NAME_UPDATER is not registered"
        Write-Host "Scheduled task not registered: $TASK_FOLDER\$TASK_NAME_UPDATER" -ForegroundColor Yellow
    }

    if ($shouldStart) {
        # Best-effort re-registration in its own try, for the same reason as in
        # Cmd-RestartCollector above (a -RunLevel Limited task cannot rewrite its own
        # definition; only starting it works). Skip Install when CIM did not actually
        # find the task: query-fail / schtasks-yes must not delete+recreate.
        if ($query.exists) {
            try {
                Install-UpdaterTask $nodeBin | Out-Null
            } catch {
                $extra["register_error"] = [string]$_.Exception.Message
                Write-Host "Task re-registration skipped (start still attempted): $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
        try {
            Start-ScheduledTask -TaskName $TASK_NAME_UPDATER -TaskPath "$TASK_FOLDER\" -ErrorAction Stop
            if (Wait-ForUpdaterAlive) {
                Write-Host "updater restarted (Task Scheduler)"
                $restarted = $true
            } else {
                $stage = "not-running-after-start"
                $detail = "Start-ScheduledTask returned success but neither the task reached Running nor an updater pid appeared within 15s"
                Write-Host "Task started but no updater came up: $TASK_NAME_UPDATER" -ForegroundColor Yellow
            }
        } catch {
            $message = [string]$_.Exception.Message
            $run = Invoke-SchtasksRun $TASK_NAME_UPDATER
            if ($run.ok) {
                if (Wait-ForUpdaterAlive) {
                    Write-Host "updater restarted (schtasks /Run)"
                    $restarted = $true
                } else {
                    $stage = "not-running-after-start"
                    $detail = "schtasks /Run returned success but neither the task reached Running nor an updater pid appeared within 15s"
                    Write-Host "Task started via schtasks /Run but no updater came up: $TASK_NAME_UPDATER" -ForegroundColor Yellow
                }
            } else {
                $extra["start_error"] = $message
                $extra["schtasks_run_error"] = [string]$run.error
                $stage = if (Test-AccessDeniedError $_) { "register-denied" } else { "start-failed" }
                $detail = "Start-ScheduledTask failed: $message"
                Write-Host "Task Scheduler restart failed: $message" -ForegroundColor Yellow
            }
        }
    }

    if (-not $restarted) {
        # Self-heal: re-register from scratch. No longer gated on init_type. The gate used
        # to read @("background","unknown","") -- so a taskscheduler install whose task was
        # missing or unusable was not allowed to repair itself and could only fall through
        # to a reasonless Write-Error, once per updater cycle, forever.
        # Only when confirmed missing: a query-fail or schtasks-yes is not a missing task.
        if ($confirmedMissing) {
            try {
                $ok = Install-UpdaterTask $nodeBin
                if (-not $ok) {
                    $stage = "bootstrap-missing"
                    $detail = "Install-UpdaterTask declined: updater-daemon.js missing under $BOOTSTRAP_DIR"
                    Write-Host "Self-heal skipped: $detail" -ForegroundColor Yellow
                } else {
                    Start-ScheduledTask -TaskName $TASK_NAME_UPDATER -TaskPath "$TASK_FOLDER\" -ErrorAction Stop
                    if (Wait-ForUpdaterAlive) {
                        Set-Content -Path $INIT_TYPE_FILE -Value "taskscheduler"
                        Write-Host "updater self-healed: registered with Task Scheduler"
                        $restarted = $true
                    } else {
                        $stage = "selfheal-not-running"
                        $detail = "task re-registered but no updater came up within 15s"
                        Write-Host "Self-heal registered the task but nothing came up" -ForegroundColor Yellow
                    }
                }
            } catch {
                $message = [string]$_.Exception.Message
                $extra["selfheal_error"] = $message
                $stage = if (Test-AccessDeniedError $_) { "register-denied" } else { "selfheal-register-failed" }
                $detail = "self-heal failed: $message"
                Write-Host "Self-heal failed: $message" -ForegroundColor Yellow
            }
        } else {
            Write-Host "Self-heal skipped: task not confirmed missing (exists_schtasks=$($intent.exists_schtasks))" -ForegroundColor Yellow
        }
        if (-not $restarted) {
            # The detached-powershell fallback stays restricted to installs that never had
            # a task: on a taskscheduler install it is not a repair but a second unmanaged
            # daemon that dies at the next logoff while hiding the real breakage. What
            # changed is that skipping it is now reported instead of falling through to a
            # Write-Error carrying nothing but init_type.
            if ($initType -in @("background", "unknown", "")) {
                $entry = Join-Path $BOOTSTRAP_DIR "updater-daemon.js"
                if (-not (Test-Path $entry)) {
                    # Used to be Write-Host + return, i.e. exit 0: the caller recorded a
                    # successful restart of an updater that was never started.
                    Write-RestartFailure -Target "updater" -Stage "bootstrap-missing" `
                        -Detail "updater-daemon.js not found at $entry" -Extra $extra
                    Write-Error "Updater bootstrap script missing"
                    return
                }
                $updaterErrLog = Join-Path $LOG_DIR "loongsuite-pilot-updater-err.log"
                # node publishes its own pid file on Windows (see src/updater/index.ts); export
                # the data dir so it lands at $DATA_DIR\loongsuite-pilot-updater.pid. No
                # Set-Content -- $proc.Id would be the wrapper pid, not node's.
                Start-BackgroundDaemon "updater" $nodeBin $entry $UPDATER_LOG_FILE $updaterErrLog
                if (Wait-ForUpdaterAlive 10) {
                    Write-Host "updater restarted (background fallback after stage=$stage : $detail)" -ForegroundColor Yellow
                } else {
                    Write-RestartFailure -Target "updater" -Stage "not-running-after-start" `
                        -Detail "background fallback started but neither the task reached Running nor an updater pid appeared within 10s" `
                        -Extra $extra
                    Write-Error "Service manager failed to restart updater (init_type=$initType stage=not-running-after-start): background fallback did not come up"
                    return
                }
            } else {
                # Order matters: under EAP=Stop (top of this file) Write-Error is a
                # terminating error, so the diagnostics have to be written BEFORE it. The
                # `return` that used to sit after it was dead code.
                Write-RestartFailure -Target "updater" -Stage $stage -Detail $detail -Extra $extra
                Write-Error "Service manager failed to restart updater (init_type=$initType stage=$stage): $detail"
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

function Show-UpgradeUsage {
    Write-Host "Usage: loongsuite-pilot upgrade [--version <version>]"
    Write-Host ""
    Write-Host "Upgrade the open-source edition to the latest release, or to a specific version."
}

function Cmd-Upgrade {
    $version = ""
    for ($i = 0; $i -lt $SubArgs.Count; $i++) {
        $arg = [string]$SubArgs[$i]
        if ($arg -in @("--version", "-Version")) {
            if ($i + 1 -ge $SubArgs.Count -or -not $SubArgs[$i + 1]) {
                Write-Error "--version requires a value"
                exit 1
            }
            $i++
            $version = [string]$SubArgs[$i]
        } elseif ($arg -match '^--version=(.*)$') {
            $version = [string]$Matches[1]
            if (-not $version) {
                Write-Error "--version requires a value"
                exit 1
            }
        } elseif ($arg -in @("help", "--help", "-h")) {
            Show-UpgradeUsage
            return
        } else {
            Write-Host "Unknown upgrade option: $arg" -ForegroundColor Red
            Show-UpgradeUsage
            exit 1
        }
    }

    if ($version -and $version -notmatch '^\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$') {
        Write-Host "Invalid version: $version (expected e.g. 1.6.0)" -ForegroundColor Red
        exit 1
    }

    $tempRoot = if ($env:TEMP) { $env:TEMP } else { $DEFAULT_PILOT_DIR }
    if (-not (Test-Path -LiteralPath $tempRoot)) {
        New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    }
    $installerFile = Join-Path $tempRoot ("loongsuite-pilot-installer-" + (Get-Random) + ".ps1")

    $installerExit = 1
    try {
        # Windows PowerShell 5.1 may still default to TLS 1.0. Match the
        # open-source installer's best-effort TLS 1.2 compatibility handling;
        # the assignment can be blocked under Constrained Language Mode.
        try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
        try {
            Invoke-WebRequest -Uri $OPEN_SOURCE_INSTALLER_URL -OutFile $installerFile -UseBasicParsing
        } catch {
            Write-Host "Failed to download the open-source installer: $_" -ForegroundColor Red
            exit 1
        }
        $installerArgs = @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", $installerFile,
            "upgrade",
            "-DataDir", $DATA_DIR
        )
        if ($version) { $installerArgs += @("-Version", $version) }

        $env:LOONGSUITE_PILOT_DATA_DIR = $DATA_DIR
        $env:LOONGSUITE_PILOT_CACHE_DIR = $CACHE_DIR
        & powershell.exe @installerArgs
        $installerExit = $LASTEXITCODE
    } finally {
        # Cleanup must not replace the installer's real success/failure result.
        # In particular, some 8.3-short %TEMP% paths make the FileSystem
        # provider throw a terminating normalization error that SilentlyContinue
        # cannot suppress.
        try {
            if (Test-Path -LiteralPath $installerFile -ErrorAction SilentlyContinue) {
                Remove-Item -LiteralPath $installerFile -Force -ErrorAction Stop
            }
        } catch {
            Write-Warning "Failed to remove temporary installer: $_"
        }
    }

    if ($installerExit -ne 0) { exit $installerExit }
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

# ============================================================
# CMD: diagnose-service
# ============================================================
# Same collection Write-RestartFailure persists, on demand and without touching
# anything: the fastest way to answer "why can this box not restart its daemons"
# without waiting for the next failed cycle.
function Cmd-DiagnoseService {
    Write-Host "init_type: $(Get-InitType)"
    Write-Host "task folder: $TASK_FOLDER"
    Write-Host ""
    foreach ($target in @("collector", "updater")) {
        if ($target -eq "updater") {
            $diag = Get-RestartDiagnostics -TaskName $TASK_NAME_UPDATER -PidFile $UPDATER_PID_FILE -LogFile $UPDATER_LOG_FILE
            Write-Host "[updater] task: $TASK_NAME_UPDATER"
        } else {
            $diag = Get-RestartDiagnostics -TaskName $TASK_NAME_COLLECTOR -PidFile $PID_FILE -LogFile $LOG_FILE
            Write-Host "[collector] task: $TASK_NAME_COLLECTOR"
        }
        foreach ($key in ($diag.Keys | Sort-Object)) {
            Write-Host "[$target] ${key}=$($diag[$key])"
        }
        $file = Get-RestartFailureFile $target
        if (Test-Path -LiteralPath $file) {
            Write-Host "[$target] last restart failure ($file):"
            Get-Content -LiteralPath $file -Encoding UTF8 -ErrorAction SilentlyContinue | ForEach-Object {
                Write-Host "[$target]   $_"
            }
        } else {
            Write-Host "[$target] no restart failure recorded"
        }
        Write-Host ""
    }
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
    if (Test-OpenSourceBuild) {
        Write-Host "  upgrade [opts]  Upgrade to latest or --version <version> (open-source only)"
    }
    Write-Host "  rollback        Roll back to the previous version"
    Write-Host "  diagnose-service  Dump why the service tasks cannot start/restart"
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
    "upgrade" {
        if (Test-OpenSourceBuild) {
            Cmd-Upgrade
        } else {
            Write-Host "Unknown command: upgrade"
            Cmd-Help
            exit 1
        }
    }
    "rollback"           { Cmd-Rollback }
    "worker"             { Cmd-Worker }
    "agent"              { Cmd-Agent }
    "start-collector"    { Cmd-StartCollector }
    "restart-collector"  { Cmd-RestartCollector -Options $SubArgs }
    "schedule-updater-restart" { Schedule-UpdaterRestart }
    "restart-updater"    { Cmd-RestartUpdater }
    "diagnose-service"   { Cmd-DiagnoseService }
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
