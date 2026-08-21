# Qoder Work CN hook entrypoint (Windows) - delegates to qoderwork-hook-processor.mjs.
# Usage: powershell -File qoderworkcn-loongsuite-pilot-hook.ps1

$ErrorActionPreference = "Continue"
$AgentId = if ($args.Count -gt 0) { $args[0] } else { "qoder-work-cn" }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Processor = Join-Path $ScriptDir "qoderwork-hook-processor.mjs"

if (-not [Console]::IsInputRedirected) { exit 0 }
if (-not (Test-Path $Processor)) { exit 0 }

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
    $pinFile = Join-Path $env:USERPROFILE ".loongsuite-pilot\node-bin"
    if (Test-Path $pinFile) {
        # -Encoding UTF8 + BOM strip: the pin file can hold a non-ASCII path and 5.1
        # defaults Get-Content to ANSI, which turns it into "??".
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
    Write-Error "[loongsuite-pilot] node >= $MIN_NODE_MAJOR not found"
    exit 0
}

try {
    # CLM/WDAC-safe: let node inherit this process's stdin (fd0) and read it
    # directly; PowerShell never touches the bytes. The old implementation used
    # [Console]::OpenStandardInput / MemoryStream / ProcessStartInfo to spawn
    # node -- those .NET calls throw under Constrained Language Mode (enforced by
    # Device Guard/WDAC), crashing the hook and silently dropping telemetry. BOM
    # stripping and the Chinese UTF-8->GBK double-encoding fixup now live in node
    # (shared/decode-payload.mjs), so here we only pass through, which works in
    # both language modes.
    # NOTE: keep this file ASCII-only. Windows PowerShell 5.1 parses a BOM-less
    # script using the system ANSI code page (GBK/936 on Chinese Windows); any
    # non-ASCII byte here can corrupt parsing and abort the whole script.
    & $nodeBin $Processor --agent-id $AgentId 2>$null | Out-Null
} catch {}

exit 0
