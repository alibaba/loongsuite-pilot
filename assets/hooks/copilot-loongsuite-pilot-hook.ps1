$ErrorActionPreference = 'Stop'
$EmptyResult = '{}'
# Resolve signed built-in modules by their exact PSHOME manifests. Short-name
# autoload can stall in isolated Windows PowerShell 5.1 environments.
try {
    Import-Module -Name ($PSHOME + '\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
    Import-Module -Name ($PSHOME + '\Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1') -ErrorAction Stop
} catch {
    try { Microsoft.PowerShell.Utility\Write-Error '[loongsuite-pilot] built-in PowerShell modules unavailable' -ErrorAction Continue } catch {}
    if ($EmptyResult) { $EmptyResult }
    exit 0
}
$NativeArgs = @('hook-process', 'copilot')
$Event = if ($args.Count -gt 0) { $args[0] } else { 'unknown' }
if ($Event -notin @('session-start', 'user-prompt-submit', 'user-prompt-submitted', 'pre-tool-use', 'post-tool-use', 'post-tool-use-failure', 'session-end', 'stop', 'agent-stop')) { Write-Output $EmptyResult; exit 0 }
$NativeArgs += $Event
try {
    . (Join-Path $PSScriptRoot 'shared\native.ps1')
    Invoke-PilotNative -HookDir $PSScriptRoot -Arguments $NativeArgs -EmptyResult $EmptyResult
} catch {
    Write-Error '[loongsuite-pilot] native hook bootstrap failed' -ErrorAction Continue
    if ($EmptyResult) { Write-Output $EmptyResult }
}
exit 0
