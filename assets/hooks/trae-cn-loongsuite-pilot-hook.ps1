# TRAE-CN hook entrypoint (Windows) - delegates to trae-cn-hook-processor.mjs.
#
# Usage (registered in %userprofile%\.trae-cn\hooks.json by pilot HookStrategy):
#   powershell -File $PILOT_DATA/hooks/trae-cn-loongsuite-pilot-hook.ps1 <subcommand>
#
# Subcommand: session-start | user-prompt-submit | pre-tool-use | post-tool-use | stop | notification
#
# Fail-open: any error outputs "{}" and exits 0.

$ErrorActionPreference = "Continue"
$EMPTY_RESULT = '{}'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Processor = Join-Path $ScriptDir "trae-cn-hook-processor.mjs"
$NodeRuntime = Join-Path $ScriptDir "shared\common.ps1"
if (-not $env:LOONGSUITE_PILOT_DATA_DIR) {
    $env:LOONGSUITE_PILOT_DATA_DIR = Split-Path $ScriptDir -Parent
}
$Subcommand = if ($args.Count -gt 0) { $args[0] } else { "unknown" }

if ($Subcommand -notin @("session-start", "user-prompt-submit", "pre-tool-use", "post-tool-use", "stop", "notification")) {
    Write-Output $EMPTY_RESULT
    exit 0
}

function Log-Error {
    param([string]$Stage, [string]$Message)
    try {
        $dataDir = if ($env:LOONGSUITE_PILOT_DATA_DIR) { $env:LOONGSUITE_PILOT_DATA_DIR }
                   else { Join-Path $env:USERPROFILE ".loongsuite-pilot" }
        $day = (Get-Date -Format "yyyy-MM-dd")
        $dir = Join-Path $dataDir "logs\trae-cn\errors"
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $file = Join-Path $dir "trae-cn-error-$day.jsonl"
        $time = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
        $escapedMsg = $Message -replace '\\', '\\\\' -replace '"', '\"'
        $line = "{`"time`":`"$time`",`"gen_ai.agent.type`":`"trae-cn`",`"stage`":`"$Stage`",`"error.type`":`"ps1_$Stage`",`"error.message`":`"$escapedMsg`"}"
        Add-Content -LiteralPath $file -Value $line -Encoding UTF8
    } catch {}
}

if (-not (Test-Path -LiteralPath $Processor)) {
    Write-Error "[trae-cn-hook] processor not found: $Processor"
    Log-Error "missing_processor" "hook processor not found: $Processor"
    Write-Output $EMPTY_RESULT
    exit 0
}

$nodeBin = $null
if (Test-Path -LiteralPath $NodeRuntime) {
    . $NodeRuntime
    $nodeBin = Resolve-NodeBin
}
if (-not $nodeBin) {
    Write-Error "[trae-cn-hook] node >= 18 not found"
    Log-Error "missing_node" "node >= 18 not found"
    Write-Output $EMPTY_RESULT
    exit 0
}

if (-not [Console]::IsInputRedirected) {
    Write-Output $EMPTY_RESULT
    exit 0
}

try {
    # CLM/WDAC-safe passthrough: node inherits this process's stdin (fd0) and
    # reads it directly; PowerShell never touches the bytes. Keep this file
    # ASCII-only -- Windows PowerShell 5.1 parses a BOM-less script using the
    # system ANSI code page (GBK/936 on Chinese Windows); any non-ASCII byte
    # here corrupts parsing and aborts the whole script.
    $result = & $nodeBin $Processor $Subcommand 2>$null
    if ($result) { Write-Output $result } else { Write-Output $EMPTY_RESULT }
} catch {
    Write-Error "[trae-cn-hook] processor failed (subcommand=$Subcommand)"
    Log-Error "processor_failed" "hook processor exited non-zero (subcommand=$Subcommand)"
    Write-Output $EMPTY_RESULT
}

exit 0
