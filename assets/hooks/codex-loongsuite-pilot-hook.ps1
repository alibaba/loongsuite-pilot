# Codex transcript discovery hook entrypoint for Windows.
#
# Registered command:
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
#     -File "<pilot-data>\hooks\codex-loongsuite-pilot-hook.ps1" <subcommand>
#
# The hook is fail-open: it always acknowledges Codex with one JSON object and
# exits zero. Telemetry is recovered only by CodexTranscriptInput.

param(
    [Parameter(Position = 0)]
    [string]$Subcommand = "unknown"
)

$ErrorActionPreference = "Stop"
$EMPTY_RESULT = '{}'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Processor = Join-Path $ScriptDir "codex-hook-processor.mjs"
$PilotDataDir = Split-Path -Parent $ScriptDir
if (-not $env:LOONGSUITE_PILOT_DATA_DIR) {
    $env:LOONGSUITE_PILOT_DATA_DIR = $PilotDataDir
}

function Log-Error {
    param([string]$Stage, [string]$Message)
    try {
        $dataDir = if ($env:LOONGSUITE_PILOT_DATA_DIR) {
            $env:LOONGSUITE_PILOT_DATA_DIR
        } else {
            Join-Path $env:USERPROFILE ".loongsuite-pilot"
        }
        $day = Get-Date -Format "yyyy-MM-dd"
        $dir = Join-Path $dataDir "logs\codex\errors"
        if (-not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
        $file = Join-Path $dir "codex-error-$day.jsonl"
        $record = [ordered]@{
            time = (Get-Date).ToUniversalTime().ToString("o")
            "gen_ai.agent.type" = "codex"
            stage = $Stage
            "error.type" = "ps1_$Stage"
            "error.message" = $Message
        }
        Add-Content -LiteralPath $file -Value ($record | ConvertTo-Json -Compress)
    } catch {}
}

function Write-EmptyResult {
    Write-Output $EMPTY_RESULT
}

function Convert-NodePath {
    param([string]$PathValue)
    if (-not $PathValue) { return $PathValue }

    $candidate = $PathValue.Trim().Trim('"')
    if ($candidate -match '^/([A-Za-z])/(.*)$') {
        $candidate = "$($Matches[1]):\$($Matches[2] -replace '/', '\')"
    }
    if (-not [System.IO.Path]::HasExtension($candidate) -and (Test-Path -LiteralPath "$candidate.exe")) {
        $candidate = "$candidate.exe"
    }
    return $candidate
}

$MIN_NODE_MAJOR = 18

function Test-NodeSuitable {
    param([string]$Bin)
    $resolved = Convert-NodePath $Bin
    if (-not $resolved -or -not (Test-Path -LiteralPath $resolved)) { return $false }
    try {
        $version = & $resolved --version 2>$null
        if (-not $version) { return $false }
        $major = [int](($version -replace '^v', '').Split('.')[0])
        return $major -ge $MIN_NODE_MAJOR
    } catch {
        return $false
    }
}

function Resolve-NodeBin {
    $dataDir = if ($env:LOONGSUITE_PILOT_DATA_DIR) {
        $env:LOONGSUITE_PILOT_DATA_DIR
    } else {
        Join-Path $env:USERPROFILE ".loongsuite-pilot"
    }
    $pinFile = Join-Path $dataDir "node-bin"
    if (Test-Path -LiteralPath $pinFile) {
        $pinContent = Get-Content -LiteralPath $pinFile -Raw -ErrorAction SilentlyContinue
        $pinned = Convert-NodePath ([string]$pinContent)
        if (Test-NodeSuitable $pinned) { return $pinned }
    }

    $candidates = @()
    if ($env:NVM_HOME -and (Test-Path -LiteralPath $env:NVM_HOME)) {
        $nvmDirs = Get-ChildItem -LiteralPath $env:NVM_HOME -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending
        foreach ($dir in $nvmDirs) {
            $candidates += Join-Path $dir.FullName "node.exe"
        }
    }

    $fnmDir = Join-Path $env:USERPROFILE ".fnm\node-versions"
    if (Test-Path -LiteralPath $fnmDir) {
        $fnmDirs = Get-ChildItem -LiteralPath $fnmDir -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending
        foreach ($dir in $fnmDirs) {
            $candidates += Join-Path $dir.FullName "installation\node.exe"
        }
    }

    $candidates += Join-Path $env:USERPROFILE ".volta\bin\node.exe"
    $candidates += "C:\Program Files\nodejs\node.exe"
    $candidates += "C:\Program Files (x86)\nodejs\node.exe"
    $pathNode = Get-Command node -ErrorAction SilentlyContinue
    if ($pathNode) { $candidates += $pathNode.Source }

    foreach ($candidate in $candidates) {
        $resolved = Convert-NodePath $candidate
        if (Test-NodeSuitable $resolved) { return $resolved }
    }
    return $null
}

if (-not [Console]::IsInputRedirected) {
    Write-EmptyResult
    exit 0
}

if (-not (Test-Path -LiteralPath $Processor)) {
    Log-Error "missing_processor" "hook processor not found: $Processor"
    Write-EmptyResult
    exit 0
}

try {
    $nodeBin = Resolve-NodeBin
    if (-not $nodeBin) {
        Log-Error "missing_node" "node >= $MIN_NODE_MAJOR not found"
        Write-EmptyResult
        exit 0
    }

    # CLM/WDAC-safe passthrough: node inherits this process's stdin (fd0) and
    # reads Codex's UTF-8 JSON directly; PowerShell never touches the bytes. The
    # old code used [Console]::OpenStandardInput / MemoryStream / ProcessStartInfo,
    # whose .NET calls throw under Constrained Language Mode (WDAC/Device Guard)
    # and silently drop telemetry. BOM stripping and the Chinese UTF-8->GBK fixup
    # now live in node (shared/decode-payload.mjs).
    # NOTE: keep this file ASCII-only. Windows PowerShell 5.1 parses a BOM-less
    # script using the system ANSI code page (GBK/936 on Chinese Windows); any
    # non-ASCII byte here can corrupt parsing and abort the whole script.
    $result = & $nodeBin $Processor $Subcommand 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "processor exited with code $LASTEXITCODE"
    }
    $result = ($result | Out-String).Trim()

    if ($result) {
        Write-Output $result
    } else {
        Write-EmptyResult
    }
} catch {
    Log-Error "processor_failed" $_.Exception.Message
    Write-EmptyResult
}

exit 0
