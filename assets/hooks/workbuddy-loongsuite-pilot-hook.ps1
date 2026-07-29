param([string]$Subcommand = "unknown")

$processor = Join-Path $PSScriptRoot "workbuddy-hook-event-writer.mjs"
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node -and (Test-Path $processor)) {
  try { & $node.Source $processor $Subcommand } catch { Write-Output "{}" }
} else {
  Write-Output "{}"
}
exit 0
