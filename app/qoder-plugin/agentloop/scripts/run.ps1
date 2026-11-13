# Compatibility entry for the original plugin-root commands.
$ErrorActionPreference = "Stop"
$runner = Join-Path (Split-Path -Parent $PSScriptRoot) "skills\agentloop-audit-query\scripts\run.ps1"
& $runner @args
exit $LASTEXITCODE
