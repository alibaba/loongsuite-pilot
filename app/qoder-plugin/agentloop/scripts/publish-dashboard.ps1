# Publish a dashboard JSON to SLS by calling the Python publisher.
# Native stderr must not become a terminating error while EAP is Stop.
$ErrorActionPreference = "Stop"

$python = ""
foreach ($candidate in @("python3", "python")) {
    $found = Get-Command -Name $candidate -ErrorAction SilentlyContinue
    if ($found -and $found.Source) {
        $python = [string]$found.Source
        break
    }
}
if (-not $python) {
    Write-Error "python3 or python is required to publish a dashboard." -ErrorAction Continue
    exit 1
}

$publisher = Join-Path $PSScriptRoot "publish_dashboard.py"
$rc = 1
$prevEAP = $ErrorActionPreference
try {
    $ErrorActionPreference = "Continue"
    & $python $publisher @args
    if ($null -ne $LASTEXITCODE) { $rc = $LASTEXITCODE }
} finally {
    $ErrorActionPreference = $prevEAP
}
exit $rc
