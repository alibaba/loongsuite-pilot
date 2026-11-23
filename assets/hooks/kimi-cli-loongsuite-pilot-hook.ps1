# Kimi CLI hook entrypoint (Windows) - delegates to kimi-cli-hook-processor.mjs.
#
# Usage (registered in ~/.kimi/config.toml [[hooks]] by pilot HookStrategy):
#   powershell -File $PILOT_DATA/hooks/kimi-cli-loongsuite-pilot-hook.ps1
#
# Kimi's hook payload carries hook_event_name in stdin JSON; the mjs processor
# dispatches Stop / StopFailure internally (no subcommand arg).
#
# Fail-open: any error outputs "{}" and exits 0.

$ErrorActionPreference = "Continue"
$EMPTY_RESULT = '{}'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Processor = Join-Path $ScriptDir "kimi-cli-hook-processor.mjs"

function Log-Error {
    param([string]$Stage, [string]$Message)
    try {
        $dataDir = if ($env:LOONGSUITE_PILOT_DATA_DIR) { $env:LOONGSUITE_PILOT_DATA_DIR }
                   else { Join-Path $env:USERPROFILE ".loongsuite-pilot" }
        $day = (Get-Date -Format "yyyy-MM-dd")
        $dir = Join-Path $dataDir "logs\kimi\errors"
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $file = Join-Path $dir "kimi-error-$day.jsonl"
        $time = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
        $escapedMsg = $Message -replace '\\', '\\\\' -replace '"', '\"'
        $line = "{`"time`":`"$time`",`"gen_ai.agent.type`":`"kimi`",`"stage`":`"$Stage`",`"error.type`":`"ps1_$Stage`",`"error.message`":`"$escapedMsg`"}"
        Add-Content -LiteralPath $file -Value $line -Encoding UTF8
    } catch {}
}

if (-not [Console]::IsInputRedirected) {
    Write-Output $EMPTY_RESULT
    exit 0
}

if (-not (Test-Path $Processor)) {
    Write-Error "[kimi-hook] processor not found: $Processor"
    Log-Error "missing_processor" "hook processor not found: $Processor"
    Write-Output $EMPTY_RESULT
    exit 0
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

function Resolve-NodeBin {
    $dataDir = if ($env:LOONGSUITE_PILOT_DATA_DIR) { $env:LOONGSUITE_PILOT_DATA_DIR }
               else { Join-Path $env:USERPROFILE ".loongsuite-pilot" }
    $pinFile = Join-Path $dataDir "node-bin"
    if (Test-Path $pinFile) {
        $pinned = ([string](Get-Content -LiteralPath $pinFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)).Trim([char]0xFEFF).Trim()
        if ($pinned -and (Test-NodeSuitable $pinned)) { return $pinned }
    }
    $candidates = @()
    $nvmHome = $env:NVM_HOME
    if ($nvmHome -and (Test-Path $nvmHome)) {
        $nvmDirs = Get-ChildItem $nvmHome -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending
        foreach ($d in $nvmDirs) { $candidates += Join-Path $d.FullName "node.exe" }
    }
    $fnmDir = Join-Path $env:USERPROFILE ".fnm\node-versions"
    if (Test-Path $fnmDir) {
        $fnmDirs = Get-ChildItem $fnmDir -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending
        foreach ($d in $fnmDirs) { $candidates += Join-Path $d.FullName "installation\node.exe" }
    }
    $candidates += Join-Path $env:USERPROFILE ".volta\bin\node.exe"
    $candidates += "C:\Program Files\nodejs\node.exe"
    $candidates += "C:\Program Files (x86)\nodejs\node.exe"
    $pathNode = Get-Command node -ErrorAction SilentlyContinue
    if ($pathNode) { $candidates += $pathNode.Source }
    foreach ($c in $candidates) {
        if (Test-NodeSuitable $c) { return $c }
    }
    return $null
}

$nodeBin = Resolve-NodeBin
if (-not $nodeBin) {
    Write-Error "[kimi-hook] node >= $MIN_NODE_MAJOR not found"
    Log-Error "missing_node" "node >= $MIN_NODE_MAJOR not found"
    Write-Output $EMPTY_RESULT
    exit 0
}

try {
    # Node reads the inherited stdin bytes and decodes the payload. This also
    # works in Windows PowerShell Constrained Language Mode.
    $result = & $nodeBin $Processor 2>$null
    if ($LASTEXITCODE -ne 0) { throw "processor exited with code $LASTEXITCODE" }
    if ($result) { Write-Output $result } else { Write-Output $EMPTY_RESULT }
} catch {
    Write-Error "[kimi-hook] processor failed"
    Log-Error "processor_failed" "hook processor exited non-zero"
    Write-Output $EMPTY_RESULT
}

exit 0
