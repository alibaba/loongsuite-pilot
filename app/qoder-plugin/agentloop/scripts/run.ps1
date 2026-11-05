# install, audit, and auth entry on Windows. A non-auth exit 3 runs auth, then retries.
$ErrorActionPreference = "Stop"
$script:AUDIT_CHILD_STATUS = 1

function Invoke-AuditChild([string]$Script, [string[]]$ChildArgs, [bool]$SuppressOutput = $false) {
    $ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    if (-not (Test-Path -LiteralPath $ps)) { $ps = "powershell.exe" }
    $prev = $ErrorActionPreference
    $rc = 1
    try {
        $ErrorActionPreference = "Continue"
        if ($SuppressOutput) {
            & $ps -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $Script @ChildArgs | Out-Null
        } else {
            & $ps -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $Script @ChildArgs
        }
        $rc = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    if ($null -eq $rc) { $rc = 1 }
    $script:AUDIT_CHILD_STATUS = $rc
}

if ($args.Count -lt 1) {
    Write-Error "Usage: run.ps1 install|audit|auth [arguments...]" -ErrorAction Continue
    exit 1
}
$command = [string]$args[0]
$rest = @()
if ($args.Count -gt 1) { $rest = @($args[1..($args.Count - 1)]) }
$scripts = @{
    install = (Join-Path $PSScriptRoot "install.ps1")
    audit = (Join-Path $PSScriptRoot "query.ps1")
    auth = (Join-Path $PSScriptRoot "ensure-oauth.ps1")
}
if (-not ($scripts.Keys -contains $command)) {
    Write-Error ("Unknown command: " + $command + ". Use install, audit, or auth") -ErrorAction Continue
    exit 1
}
Invoke-AuditChild $scripts[$command] $rest
$status = $script:AUDIT_CHILD_STATUS
if ($command -ne "auth" -and $status -eq 3) {
    Invoke-AuditChild $scripts["auth"] @() $true
    $status = $script:AUDIT_CHILD_STATUS
    if ($status -eq 0) {
        Invoke-AuditChild $scripts[$command] $rest
        $status = $script:AUDIT_CHILD_STATUS
    }
}
exit $status
