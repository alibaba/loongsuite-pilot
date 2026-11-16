# Render a dashboard JSON to HTML by calling the Python renderer.
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
    Write-Error "python3 or python is required to render a report." -ErrorAction Continue
    exit 1
}

$renderer = Join-Path $PSScriptRoot "render_report.py"
$rc = 1
$prevEAP = $ErrorActionPreference
try {
    $ErrorActionPreference = "Continue"
    & $python $renderer @args
    if ($null -ne $LASTEXITCODE) { $rc = $LASTEXITCODE }
} finally {
    $ErrorActionPreference = $prevEAP
}
exit $rc
