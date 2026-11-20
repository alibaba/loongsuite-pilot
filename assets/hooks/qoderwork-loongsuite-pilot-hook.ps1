# Qoder Work hook entrypoint (Windows) - delegates to qoderwork-hook-processor.mjs.
# Usage: powershell -File qoderwork-loongsuite-pilot-hook.ps1

$ErrorActionPreference = "Continue"
$AgentId = if ($args.Count -gt 0) { $args[0] } else { "qoder-work" }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Processor = Join-Path $ScriptDir "qoderwork-hook-processor.mjs"
$PilotDataDir = Split-Path -Parent $ScriptDir
$env:LOONGSUITE_PILOT_DATA_DIR = $PilotDataDir
$Common = Join-Path $ScriptDir "shared\common.ps1"

if (-not [Console]::IsInputRedirected) { exit 0 }
if (-not (Test-Path $Processor)) { exit 0 }
if (-not (Test-Path $Common)) { exit 0 }
. $Common

$nodeBin = Resolve-NodeBin
if (-not $nodeBin) {
    exit 0
}

try {
    # CLM/WDAC-safe: let node inherit this process's stdin (fd0) and read it
    # directly; PowerShell never touches the bytes. The old implementation used
    # [Console]::OpenStandardInput / MemoryStream / ProcessStartInfo to spawn
    # node -- those .NET calls throw under Constrained Language Mode (enforced by
    # Device Guard/WDAC), crashing the hook and silently dropping telemetry. BOM
    # stripping and the Chinese UTF-8->GBK double-encoding fixup now live in node
    # (shared/decode-payload.mjs), so here we only pass through, which works in
    # both language modes.
    # NOTE: keep this file ASCII-only. Windows PowerShell 5.1 parses a BOM-less
    # script using the system ANSI code page (GBK/936 on Chinese Windows); any
    # non-ASCII byte here can corrupt parsing and abort the whole script.
    & $nodeBin $Processor --agent-id $AgentId 2>$null | Out-Null
} catch {}

exit 0
