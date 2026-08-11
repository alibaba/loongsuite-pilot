# ZCode hook entrypoint (Windows) — delegates to zcode-hook-processor.mjs.
#
# Usage (registered in ~/.zcode/cli/config.json by pilot HookStrategy):
#   powershell -NoProfile -ExecutionPolicy Bypass -File $PILOT_DATA\hooks\zcode-loongsuite-pilot-hook.ps1 <subcommand>
#
# Subcommand:
#   stop  -> read stdin, emit ENTRY/AGENT envelope (no messages)
#
# Fail-open: any error outputs "{}" and exits 0, never blocks zcode.

param(
    [Parameter(Position=0)]
    [string]$Subcommand = "unknown"
)

$ErrorActionPreference = "Continue"
$EmptyResult = "{}"

# Only handle known subcommands
switch ($Subcommand) {
    "stop" { }
    default {
        Write-Output $EmptyResult
        exit 0
    }
}

# Resolve script directory and processor path
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Processor = Join-Path $ScriptDir "zcode-hook-processor.mjs"

function Write-ErrorLog {
    param([string]$Stage, [string]$Message)
    try {
        $DataDir = if ($env:LOONGSUITE_PILOT_DATA_DIR) { $env:LOONGSUITE_PILOT_DATA_DIR } else { Join-Path $env:USERPROFILE ".loongsuite-pilot" }
        $Day = (Get-Date -Format "yyyy-MM-dd")
        $LogDir = Join-Path $DataDir "logs\zcode\errors"
        if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
        $LogFile = Join-Path $LogDir "zcode-error-$Day.jsonl"
        $Timestamp = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
        $EscapedMsg = $Message.Replace('\', '\\').Replace('"', '\"')
        $Line = "{`"time`":`"$Timestamp`",`"gen_ai.agent.type`":`"zcode`",`"stage`":`"$Stage`",`"error.type`":`"shell_$Stage`",`"error.message`":`"$EscapedMsg`"}"
        Add-Content -Path $LogFile -Value $Line -ErrorAction SilentlyContinue
    } catch {
        # Swallow logging errors per fail-open contract
    }
}

# Fail-open: stdin check — if no stdin data, return empty result
try {
    $stdin = [System.Console]::In
    if ($stdin.Peek() -lt 0) {
        Write-Output $EmptyResult
        exit 0
    }
} catch {
    Write-Output $EmptyResult
    exit 0
}

# Verify processor exists
if (-not (Test-Path $Processor)) {
    Write-Host "[zcode-hook] processor not found: $Processor" -ForegroundColor Red
    Write-ErrorLog -Stage "missing_processor" -Message "hook processor not found: $Processor"
    Write-Output $EmptyResult
    exit 0
}

# Find node binary — prefer pinned, then common locations
$MinNodeMajor = 18

function Test-NodeSuitable {
    param([string]$Bin)
    if (-not (Test-Path $Bin)) { return $false }
    try {
        $ver = & $Bin --version 2>$null
        $major = [int]($ver -replace '^v', '' -replace '\..*', '')
        return ($major -ge $MinNodeMajor)
    } catch {
        return $false
    }
}

$NodeBin = $null

# Check pinned node
$NodePinFile = Join-Path $env:USERPROFILE ".loongsuite-pilot\node-bin"
if (Test-Path $NodePinFile) {
    $pinned = (Get-Content $NodePinFile -Raw).Trim()
    if ($pinned -and (Test-NodeSuitable $pinned)) {
        $NodeBin = $pinned
    }
}

# Search common locations
if (-not $NodeBin) {
    $candidates = @()
    # volta
    $voltaNode = Join-Path $env:LOCALAPPDATA "volta\bin\node.exe"
    if (Test-Path $voltaNode) { $candidates += $voltaNode }
    # fnm
    $fnmDefault = Join-Path $env:LOCALAPPDATA "fnm\aliases\default\node.exe"
    if (Test-Path $fnmDefault) { $candidates += $fnmDefault }
    # nvm-windows
    $nvmDir = Join-Path $env:APPDATA "nvm"
    if (Test-Path $nvmDir) {
        $nvmVersions = Get-ChildItem $nvmDir -Directory | Sort-Object Name -Descending
        foreach ($v in $nvmVersions) {
            $nodeExe = Join-Path $v.FullName "node.exe"
            if (Test-Path $nodeExe) { $candidates += $nodeExe; break }
        }
    }
    # Program Files
    $pfNode = "C:\Program Files\nodejs\node.exe"
    if (Test-Path $pfNode) { $candidates += $pfNode }
    # PATH
    $pathNode = Get-Command node -ErrorAction SilentlyContinue
    if ($pathNode) { $candidates += $pathNode.Source }

    foreach ($candidate in $candidates) {
        if (Test-NodeSuitable $candidate) {
            $NodeBin = $candidate
            break
        }
    }
}

if (-not $NodeBin) {
    Write-Host "[zcode-hook] node >= $MinNodeMajor not found" -ForegroundColor Red
    Write-ErrorLog -Stage "missing_node" -Message "node >= $MinNodeMajor not found"
    Write-Output $EmptyResult
    exit 0
}

# Execute processor — pipe stdin through
try {
    $result = & $NodeBin $Processor $Subcommand 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[zcode-hook] processor failed (subcommand=$Subcommand)" -ForegroundColor Red
        Write-ErrorLog -Stage "processor_failed" -Message "hook processor exited non-zero (subcommand=$Subcommand)"
        Write-Output $EmptyResult
    } else {
        Write-Output $result
    }
} catch {
    Write-Host "[zcode-hook] processor exception: $_" -ForegroundColor Red
    Write-ErrorLog -Stage "processor_exception" -Message "hook processor threw exception: $_"
    Write-Output $EmptyResult
}

exit 0
