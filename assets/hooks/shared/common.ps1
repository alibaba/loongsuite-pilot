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

# Numeric sort key for version dir names, equivalent to the daemon's
# compareNodeRuntimeDirs. Sort-Object Name is lexicographic and would prefer
# node-v22.9.0 over node-v22.22.2 once several versions accumulate.
function Get-NodeVersionSortKey {
    param([string]$Name)
    $key = ''
    foreach ($part in ($Name -replace '^node-v','').Split('.')) {
        $digits = $part -replace '^[^0-9]*','' -replace '[^0-9].*$',''
        if (-not $digits) { $digits = '0' }
        $key += ('{0:D10}' -f [int]$digits)
    }
    return $key
}

function Resolve-NodeBin {
    $pinFiles = @()
    if ($env:LOONGSUITE_PILOT_CACHE_DIR) {
        $pinFiles += Join-Path $env:LOONGSUITE_PILOT_CACHE_DIR "node-bin"
    }
    if ($env:LOONGSUITE_PILOT_DATA_DIR) {
        $pinFiles += Join-Path $env:LOONGSUITE_PILOT_DATA_DIR "node-bin"
    }
    if ($env:USERPROFILE) {
        $pinFiles += Join-Path $env:USERPROFILE ".loongsuite-pilot\node-bin"
    }
    foreach ($pinFile in $pinFiles) {
        if (Test-Path $pinFile) {
            # -Encoding UTF8 + BOM strip: the pin file can hold a non-ASCII path and 5.1
            # defaults Get-Content to ANSI, which turns it into "??".
            $pinned = ([string](Get-Content -LiteralPath $pinFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)).Trim([char]0xFEFF).Trim()
            if ($pinned -and (Test-NodeSuitable $pinned)) { return $pinned }
        }
    }
    $candidates = @()
    # Managed runtime node (never removed by user node-manager churn) comes
    # first, preserving the custom cache/data/default pin-file priority.
    foreach ($pinFile in $pinFiles) {
        $runtimeDir = Join-Path (Split-Path $pinFile) "runtime"
        if (Test-Path $runtimeDir) {
            $runtimeDirs = Get-ChildItem $runtimeDir -Directory -Filter "node-v*" -ErrorAction SilentlyContinue |
                Sort-Object @{Expression={ Get-NodeVersionSortKey $_.Name }} -Descending
            foreach ($d in $runtimeDirs) {
                $candidates += Join-Path $d.FullName "bin\node.exe"
                # Official Node.js win zip layout: node.exe at the root.
                $candidates += Join-Path $d.FullName "node.exe"
            }
        }
    }
    $nvmHome = $env:NVM_HOME
    if ($nvmHome -and (Test-Path $nvmHome)) {
        $nvmDirs = Get-ChildItem $nvmHome -Directory -ErrorAction SilentlyContinue |
            Sort-Object @{Expression={ Get-NodeVersionSortKey $_.Name }} -Descending
        foreach ($d in $nvmDirs) { $candidates += Join-Path $d.FullName "node.exe" }
    }
    if ($env:USERPROFILE) {
        $fnmDir = Join-Path $env:USERPROFILE ".fnm\node-versions"
        if (Test-Path $fnmDir) {
            $fnmDirs = Get-ChildItem $fnmDir -Directory -ErrorAction SilentlyContinue |
                Sort-Object @{Expression={ Get-NodeVersionSortKey $_.Name }} -Descending
            foreach ($d in $fnmDirs) { $candidates += Join-Path $d.FullName "installation\node.exe" }
        }
        $candidates += Join-Path $env:USERPROFILE ".volta\bin\node.exe"
    }
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
        # Explicit UTF8 and -LiteralPath: Add-Content defaults to the ANSI codepage, so a
        # Chinese username in a path or message lands as mojibake -- and node's
        # shared/error-logger.mjs appends UTF-8 to this very file, making it mixed-encoding.
        # A BOM on the first line is harmless here: nothing machine-parses this log (the
        # retention service only deletes it by age). Matches codex-loongsuite-pilot-hook.ps1.
        Add-Content -LiteralPath $file -Value $line -Encoding UTF8
    } catch {}
}
