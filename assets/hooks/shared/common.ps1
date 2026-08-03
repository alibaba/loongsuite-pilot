# Shared PowerShell utilities for loongsuite-pilot hook scripts.
# Dot-source from each hook entrypoint:  . (Join-Path $ScriptDir "shared\common.ps1")

$script:MIN_NODE_MAJOR = 18

function Test-NodeSuitable {
    param([string]$bin)
    if (-not (Test-Path $bin)) { return $false }
    try {
        $ver = & $bin --version 2>$null
        if (-not $ver) { return $false }
        $major = [int]($ver -replace '^v','').Split('.')[0]
        return $major -ge $script:MIN_NODE_MAJOR
    } catch { return $false }
}

function Resolve-NodeBin {
    $pinFile = Join-Path $env:USERPROFILE ".loongsuite-pilot\node-bin"
    if (Test-Path $pinFile) {
        $pinned = (Get-Content $pinFile -ErrorAction SilentlyContinue).Trim()
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

# CLM/WDAC-safe node invocation: node inherits this process's stdin (fd0) and
# reads it directly; PowerShell never touches the bytes. The old helper pair
# (Read-StdinRawBytes + a ProcessStartInfo-based spawn) used .NET calls that throw
# under Constrained Language Mode (WDAC/Device Guard), crashing hooks and silently
# dropping telemetry. BOM stripping and the Chinese UTF-8->GBK double-encoding
# fixup now live in node (shared/decode-payload.mjs), so this helper only passes
# stdin through -- which works in both FullLanguage and ConstrainedLanguage.
function Invoke-NodeProcessor {
    param(
        [string]$NodeBin,
        [string]$ProcessorPath,
        [string]$ExtraArgs
    )
    if ($ExtraArgs) {
        return & $NodeBin $ProcessorPath $ExtraArgs.Split(' ') 2>$null
    }
    return & $NodeBin $ProcessorPath 2>$null
}

function Log-HookError {
    param(
        [string]$AgentType,
        [string]$Stage,
        [string]$Message
    )
    try {
        $dataDir = if ($env:LOONGSUITE_PILOT_DATA_DIR) { $env:LOONGSUITE_PILOT_DATA_DIR }
                   else { Join-Path $env:USERPROFILE ".loongsuite-pilot" }
        $day = (Get-Date -Format "yyyy-MM-dd")
        $dir = Join-Path $dataDir "logs\$AgentType\errors"
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $file = Join-Path $dir "$AgentType-error-$day.jsonl"
        $time = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
        $escapedMsg = $Message -replace '\\', '\\\\' -replace '"', '\"'
        $line = "{`"time`":`"$time`",`"gen_ai.agent.type`":`"$AgentType`",`"stage`":`"$Stage`",`"error.type`":`"ps1_$Stage`",`"error.message`":`"$escapedMsg`"}"
        Add-Content -Path $file -Value $line
    } catch {}
}
