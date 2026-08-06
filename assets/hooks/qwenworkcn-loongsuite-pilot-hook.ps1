$ErrorActionPreference = "Continue"
$Processor = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "qwen-work-cn-hook-processor.mjs"
if (-not [Console]::IsInputRedirected) { exit 0 }
if (-not (Test-Path $Processor)) { exit 0 }
$NodeBin = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodeBin) { exit 0 }
try { & $NodeBin $Processor --agent-id qwen-work-cn --log-prefix qwen-work-cn 2>$null | Out-Null } catch {}
exit 0
