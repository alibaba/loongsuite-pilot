# Qwen Code CLI hook entrypoint (Windows) - delegates to qwen-code-cli-hook-processor.mjs.
#
# Usage (registered in ~/.qwen/settings.json by pilot HookStrategy):
#   powershell -File $PILOT_DATA/hooks/qwen-code-cli-loongsuite-pilot-hook.ps1 <subcommand>
#
# Subcommand: stop / subagent-start / subagent-stop
#
# Fail-open: any error outputs "{}" and exits 0.

$ErrorActionPreference = "Continue"
$EMPTY_RESULT = '{}'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Processor = Join-Path $ScriptDir "qwen-code-cli-hook-processor.mjs"
$Subcommand = if ($args.Count -gt 0) { $args[0] } else { "unknown" }

# Only process registered subcommands
if ($Subcommand -notin @("stop", "subagent-start", "subagent-stop")) {
    Write-Output $EMPTY_RESULT
    exit 0
}

function Log-Error {
    param([string]$Stage, [string]$Message)
    try {
        $dataDir = if ($env:LOONGSUITE_PILOT_DATA_DIR) { $env:LOONGSUITE_PILOT_DATA_DIR }
                   else { Join-Path $env:USERPROFILE ".loongsuite-pilot" }
        $day = (Get-Date -Format "yyyy-MM-dd")
        $dir = Join-Path $dataDir "logs\qwen-code-cli\errors"
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $file = Join-Path $dir "qwen-code-cli-error-$day.jsonl"
        $time = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
        $escapedMsg = $Message -replace '\\', '\\\\' -replace '"', '\"'
        $line = "{`"time`":`"$time`",`"gen_ai.agent.type`":`"qwen-code-cli`",`"stage`":`"$Stage`",`"error.type`":`"ps1_$Stage`",`"error.message`":`"$escapedMsg`"}"
        # Explicit UTF8 and -LiteralPath: Add-Content defaults to the ANSI codepage, so a
        # Chinese username in a path or message lands as mojibake -- and node's
        # shared/error-logger.mjs appends UTF-8 to this very file, making it mixed-encoding.
        # A BOM on the first line is harmless here: nothing machine-parses this log (the
        # retention service only deletes it by age). Matches codex-loongsuite-pilot-hook.ps1.
        Add-Content -LiteralPath $file -Value $line -Encoding UTF8
    } catch {}
}

if (-not (Test-Path $Processor)) {
    Write-Error "[qwen-code-cli-hook] processor not found: $Processor"
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
    Write-Error "[qwen-code-cli-hook] node >= $MIN_NODE_MAJOR not found"
    Log-Error "missing_node" "node >= $MIN_NODE_MAJOR not found"
    Write-Output $EMPTY_RESULT
    exit 0
}

if (-not [Console]::IsInputRedirected) {
    Write-Output $EMPTY_RESULT
    exit 0
}

try {
    # CLM/WDAC-safe passthrough: node inherits this process's stdin (fd0) and
    # reads it directly; PowerShell never touches the bytes. The old code used
    # [Console]::OpenStandardInput / MemoryStream / ProcessStartInfo, whose .NET
    # calls throw under Constrained Language Mode (WDAC/Device Guard) and silently
    # drop telemetry. BOM stripping and the Chinese UTF-8->GBK fixup now live in
    # node (shared/decode-payload.mjs).
    # NOTE: keep this file ASCII-only. Windows PowerShell 5.1 parses a BOM-less
    # script using the system ANSI code page (GBK/936 on Chinese Windows); any
    # non-ASCII byte here can corrupt parsing and abort the whole script.
    $result = & $nodeBin $Processor $Subcommand 2>$null
    if ($result) { Write-Output $result } else { Write-Output $EMPTY_RESULT }
} catch {
    Write-Error "[qwen-code-cli-hook] processor failed (subcommand=$Subcommand)"
    Log-Error "processor_failed" "hook processor exited non-zero (subcommand=$Subcommand)"
    Write-Output $EMPTY_RESULT
}

exit 0
