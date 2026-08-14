# MiniMax Code hook entrypoint (Windows) - delegates to minimax-code-hook-processor.mjs.
#
# Usage (registered in %APPDATA%\MiniMax\settings.json by pilot HookStrategy):
#   powershell -File $PILOT_DATA/hooks/minimax-code-loongsuite-pilot-hook.ps1 <subcommand>
#
# Subcommand (kebab-case, mirroring the .sh):
#   session-start / user-prompt-submit / pre-tool-use / post-tool-use / stop
#
# Fail-open: any error outputs "{}" and exits 0.

$ErrorActionPreference = "Continue"
$EMPTY_RESULT = '{}'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Processor = Join-Path $ScriptDir "minimax-code-hook-processor.mjs"
$Subcommand = if ($args.Count -gt 0) { $args[0] } else { "unknown" }

# Only process registered subcommands; early-return for legacy/unregistered ones.
if ($Subcommand -notin @("session-start", "user-prompt-submit", "pre-tool-use", "post-tool-use", "stop")) {
    Write-Output $EMPTY_RESULT
    exit 0
}

function Log-Error {
    param([string]$Stage, [string]$Message)
    try {
        $dataDir = if ($env:LOONGSUITE_PILOT_DATA_DIR) { $env:LOONGSUITE_PILOT_DATA_DIR }
                   else { Join-Path $env:USERPROFILE ".loongsuite-pilot" }
        $day = (Get-Date -Format "yyyy-MM-dd")
        $dir = Join-Path $dataDir "logs\minimax-code\errors"
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $file = Join-Path $dir "minimax-code-error-$day.jsonl"
        # Round 18 fix (PR #233, copilot suppressed comment): the
        # previous implementation had three bugs in the JSONL it
        # produced:
        #   1. `(Get-Date -Format "...Z")` uses local time but
        #      appends a literal "Z" (UTC designator) -- the
        #      resulting timestamp is local-clock time mislabeled
        #      as UTC. Use `.ToUniversalTime()` to actually
        #      convert to UTC before formatting.
        #   2. Manual `-replace` escaping only handled backslashes
        #      and double-quotes -- newlines, tabs, control chars,
        #      and unicode characters in $Message would produce
        #      invalid JSON. Use `ConvertTo-Json -Compress` which
        #      handles all JSON escaping properly.
        #   3. `-NoNewline` on Add-Content suppressed the trailing
        #      newline that separates JSONL records. Multiple
        #      errors would concatenate into one giant line.
        #      Drop -NoNewline so Add-Content writes a
        #      trailing newline (the JSONL line separator) and
        #      the test in #247 (which only checks for
        #      `-Encoding UTF8`) still passes.
        $record = @{
            time                = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
            'gen_ai.agent.type' = 'minimax-code'
            stage               = $Stage
            'error.type'        = "ps1_$Stage"
            'error.message'     = $Message
        } | ConvertTo-Json -Compress
        # Explicit -Encoding UTF8 (Round 15): Add-Content defaults
        # to the system ANSI codepage on Windows PowerShell 5.1,
        # which mangles non-ASCII (e.g. Chinese user names in
        # $Message). Pinned to UTF-8 to keep the JSONL file
        # byte-exact readable by the Node processor. The
        # ps1-json-encoding.test.mjs (added in upstream #247)
        # enforces this on every .ps1 hook asset.
        Add-Content -Path $file -Value $record -Encoding UTF8
    } catch {}
}

if (-not (Test-Path $Processor)) {
    Write-Error "[minimax-code-hook] processor not found: $Processor"
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
    # Round 19 fix (PR #233, copilot suppressed comment): the
    # previous implementation hard-coded the pin file path to
    # "$env:USERPROFILE\.loongsuite-pilot\node-bin" and ignored
    # $env:LOONGSUITE_PILOT_DATA_DIR. If Pilot is installed/used
    # with a non-default data dir, the hook would fail to find
    # the pinned Node binary even though one exists under the
    # configured data dir (and every other part of the script
    # already honors LOONGSUITE_PILOT_DATA_DIR -- the dataDir
    # resolution at line 27 uses it). Fall back to the default
    # only when $env:LOONGSUITE_PILOT_DATA_DIR is unset,
    # matching the dataDir resolution pattern.
    $pilotDataDir = if ($env:LOONGSUITE_PILOT_DATA_DIR) { $env:LOONGSUITE_PILOT_DATA_DIR }
                    else { Join-Path $env:USERPROFILE ".loongsuite-pilot" }
    $pinFile = Join-Path $pilotDataDir "node-bin"
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

$nodeBin = Resolve-NodeBin
if (-not $nodeBin) {
    Write-Error "[minimax-code-hook] node >= $MIN_NODE_MAJOR not found"
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
    Write-Error "[minimax-code-hook] processor failed (subcommand=$Subcommand)"
    Log-Error "processor_failed" "hook processor exited non-zero (subcommand=$Subcommand)"
    Write-Output $EMPTY_RESULT
}

exit 0
