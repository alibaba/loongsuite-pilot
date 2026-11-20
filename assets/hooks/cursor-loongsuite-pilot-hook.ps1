# Cursor hook entrypoint (Windows) - delegates to cursor-hook-processor.mjs.
#
# Fail-open: any error outputs "{}" and exits 0.

$ErrorActionPreference = "Continue"
$EMPTY_RESULT = '{}'

$ScriptDir = $PSScriptRoot
$Processor = Join-Path $ScriptDir "cursor-hook-processor.mjs"
if (-not $env:LOONGSUITE_PILOT_DATA_DIR) {
    $env:LOONGSUITE_PILOT_DATA_DIR = Split-Path -LiteralPath $ScriptDir
}

function Log-Error {
    param([string]$Stage, [string]$Message)
    try {
        $day = (Get-Date -Format "yyyy-MM-dd")
        $dir = Join-Path $env:LOONGSUITE_PILOT_DATA_DIR "logs\cursor\errors"
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $file = Join-Path $dir "cursor-error-$day.jsonl"
        $time = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
        $escapedMsg = $Message -replace '\\', '\\\\' -replace '"', '\"'
        $line = "{`"time`":`"$time`",`"clientType`":`"CursorHook`",`"stage`":`"$Stage`",`"error.type`":`"ps1_$Stage`",`"error.message`":`"$escapedMsg`"}"
        # Explicit UTF8 and -LiteralPath: Add-Content defaults to the ANSI codepage, so a
        # Chinese username in a path or message lands as mojibake -- and node's
        # shared/error-logger.mjs appends UTF-8 to this very file, making it mixed-encoding.
        # A BOM on the first line is harmless here: nothing machine-parses this log (the
        # retention service only deletes it by age). Matches codex-loongsuite-pilot-hook.ps1.
        Add-Content -LiteralPath $file -Value $line -Encoding UTF8
    } catch {}
}

if (-not [Console]::IsInputRedirected) {
    Write-Output $EMPTY_RESULT
    exit 0
}

if (-not (Test-Path -LiteralPath $Processor -PathType Leaf -ErrorAction SilentlyContinue)) {
    Write-Error "[loongsuite-pilot] hook processor not found: $Processor"
    Log-Error "missing_processor" "hook processor not found: $Processor"
    Write-Output $EMPTY_RESULT
    exit 0
}

$Common = Join-Path $ScriptDir "shared/common.ps1"
if (-not (Test-Path -LiteralPath $Common -PathType Leaf -ErrorAction SilentlyContinue)) {
    Log-Error "missing_runtime_resolver" "hook runtime resolver not found: $Common"
    Write-Output $EMPTY_RESULT
    exit 0
}
. $Common

$nodeBin = Resolve-NodeBin
if (-not $nodeBin) {
    Write-Error "[loongsuite-pilot] node >= $MIN_NODE_MAJOR not found"
    Log-Error "missing_node" "node >= $MIN_NODE_MAJOR not found"
    Write-Output $EMPTY_RESULT
    exit 0
}

try {
    # CLM/WDAC-safe passthrough: node inherits this process's stdin (fd0) and
    # reads it directly; PowerShell never touches the bytes. The old code used
    # [Console]::OpenStandardInput / MemoryStream / ProcessStartInfo, whose .NET
    # calls throw under Constrained Language Mode (WDAC/Device Guard) and silently
    # drop telemetry. BOM stripping and the Chinese UTF-8->GBK fixup now live in
    # node (shared/decode-payload.mjs).
    # NOTE: keep this file ASCII-only. Windows PowerShell 5.1 parses a BOM-less
    # script using the system ANSI code page (GBK/936 on Chinese Windows); any
    # non-ASCII byte here can corrupt parsing and abort the whole script.
    $result = Invoke-NodeProcessor -NodeBin $nodeBin -ProcessorPath $Processor
    if ($result) { Write-Output $result } else { Write-Output $EMPTY_RESULT }
} catch {
    Write-Error "[loongsuite-pilot] hook processor failed"
    Log-Error "processor_failed" "hook processor exited with non-zero status"
    Write-Output $EMPTY_RESULT
}

exit 0
