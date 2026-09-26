# Independent interceptor hook (Windows). Fail-open on infrastructure errors.
# Must keep stdout for the host verdict JSON; do not pipe to Out-Null.

$ErrorActionPreference = "Continue"

if (-not [Console]::IsInputRedirected) { exit 0 }

# Hooks are installed under <data-dir>/hooks. The CLI and current pointer live
# in the cache dir, which stays ~/.loongsuite-pilot unless the cache env is set.
$DataDir = Split-Path -Parent $PSScriptRoot
if (-not $env:LOONGSUITE_PILOT_DATA_DIR) {
    $env:LOONGSUITE_PILOT_DATA_DIR = $DataDir
}
if ($env:LOONGSUITE_PILOT_CACHE_DIR) {
    $CacheDir = $env:LOONGSUITE_PILOT_CACHE_DIR
} elseif (Test-Path -LiteralPath (Join-Path $DataDir "current")) {
    $CacheDir = $DataDir
} else {
    $CacheDir = Join-Path $env:USERPROFILE ".loongsuite-pilot"
}
$MIN_NODE_MAJOR = 18

function Test-NodeSuitable {
    param([string]$bin)
    if (-not (Test-Path $bin)) { return $false }
    try {
        $ver = & $bin --version 2>$null
        if (-not $ver) { return $false }
        $major = [int]($ver -replace '^v','').Split('.')[0]
        return $major -ge $MIN_NODE_MAJOR
    } catch { return $false }
}

$nodeBin = $null
$pinFile = Join-Path $CacheDir "node-bin"
if (Test-Path $pinFile) {
    $pinned = ([string](Get-Content -LiteralPath $pinFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)).Trim([char]0xFEFF).Trim()
    if ($pinned -and (Test-NodeSuitable $pinned)) { $nodeBin = $pinned }
}
if (-not $nodeBin) {
    $pathNode = Get-Command node -ErrorAction SilentlyContinue
    if ($pathNode -and (Test-NodeSuitable $pathNode.Source)) { $nodeBin = $pathNode.Source }
}
if (-not $nodeBin) { exit 0 }

$cli = $env:INTERCEPTOR_CLI
if (-not $cli) {
    $currentFile = Join-Path $CacheDir "current"
    if (Test-Path $currentFile) {
        $versionName = ([string](Get-Content -LiteralPath $currentFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)).Trim([char]0xFEFF).Trim()
        if ($versionName) {
            $cli = Join-Path $CacheDir "versions\$versionName\dist\interceptor\cli.cjs"
        }
    }
}
if (-not $cli -or -not (Test-Path $cli)) { exit 0 }

try {
    & $nodeBin $cli hook --agent qoder-auto @args
} catch {
    exit 0
}
exit 0
