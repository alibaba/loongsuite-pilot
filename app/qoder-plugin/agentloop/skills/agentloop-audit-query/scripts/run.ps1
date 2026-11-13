# Compatibility entry for the former Query Skill router.
$ErrorActionPreference = "Stop"
$runner = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "agentloop-collector-setup\scripts\run.ps1"
& $runner @args
exit $LASTEXITCODE
