$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Processor = Join-Path $ScriptDir "qwen-work-cn-hook-processor.mjs"
$PilotDataDir = Split-Path -Parent $ScriptDir
$env:LOONGSUITE_PILOT_DATA_DIR = $PilotDataDir
$Common = Join-Path $ScriptDir "shared\common.ps1"
if (-not [Console]::IsInputRedirected) { exit 0 }
if (-not (Test-Path $Processor)) { exit 0 }
if (-not (Test-Path $Common)) { exit 0 }
. $Common
$NodeBin = Resolve-NodeBin
if (-not $NodeBin) { exit 0 }
try { & $NodeBin $Processor --agent-id qwen-work-cn --log-prefix qwen-work-cn 2>$null | Out-Null } catch {}
exit 0
