# ZCode hook entrypoint (Windows) -- delegates to zcode-hook-processor.mjs.
#
# Usage (registered in ~/.zcode/cli/config.json by pilot HookStrategy):
#   powershell -NoProfile -ExecutionPolicy Bypass -File $PILOT_DATA\hooks\zcode-loongsuite-pilot-hook.ps1 <subcommand>
#
# Subcommand:
#   stop  -> read stdin, emit ENTRY/AGENT envelope (no messages)
#
# Fail-open: any error outputs "{}" and exits 0, never blocks zcode.
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 parses a BOM-less
# script using the system ANSI code page; any non-ASCII byte here can corrupt
# parsing and abort the whole script.

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
$env:LOONGSUITE_PILOT_DATA_DIR = Split-Path -Parent $ScriptDir
$Common = Join-Path $ScriptDir "shared\common.ps1"

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
        Add-Content -Path $LogFile -Value $Line -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {
        # Swallow logging errors per fail-open contract
    }
}

# Verify processor exists
if (-not (Test-Path -LiteralPath $Processor)) {
    Write-ErrorLog -Stage "missing_processor" -Message "hook processor not found: $Processor"
    Write-Output $EmptyResult
    exit 0
}

if (-not (Test-Path -LiteralPath $Common)) {
    Write-ErrorLog -Stage "missing_runtime_resolver" -Message "hook runtime resolver not found: $Common"
    Write-Output $EmptyResult
    exit 0
}

. $Common
$NodeBin = Resolve-NodeBin
if (-not $NodeBin) {
    Write-ErrorLog -Stage "missing_node" -Message "no supported Node.js runtime found"
    Write-Output $EmptyResult
    exit 0
}

# CLM/WDAC-safe stdin check: [Console]::IsInputRedirected is a property get
# (allowed under Constrained Language Mode). If stdin is not redirected (no
# piped data), return empty result immediately.
if (-not [Console]::IsInputRedirected) {
    Write-Output $EmptyResult
    exit 0
}

# Execute processor -- CLM/WDAC-safe passthrough: node inherits this
# process's stdin (fd0) and reads it directly; PowerShell never touches the
# bytes.
try {
    $result = & $NodeBin $Processor $Subcommand 2>$null
    if ($result) { Write-Output $result } else { Write-Output $EmptyResult }
} catch {
    Write-ErrorLog -Stage "processor_exception" -Message "hook processor threw exception: $_"
    Write-Output $EmptyResult
}

exit 0
