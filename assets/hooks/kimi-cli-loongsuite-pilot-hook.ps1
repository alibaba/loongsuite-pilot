# Kimi CLI hook entrypoint (Windows) — delegates to kimi-cli-hook-processor.mjs.
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
        Add-Content -Path $file -Value $line
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

$nodeBin = Resolve-NodeBin
if (-not $nodeBin) {
    Write-Error "[kimi-hook] node >= $MIN_NODE_MAJOR not found"
    Log-Error "missing_node" "node >= $MIN_NODE_MAJOR not found"
    Write-Output $EMPTY_RESULT
    exit 0
}

try {
    $stdinStream = [Console]::OpenStandardInput()
    $ms = New-Object System.IO.MemoryStream
    $stdinStream.CopyTo($ms)
    $rawBytes = $ms.ToArray()
    $ms.Dispose()

    if ($rawBytes.Length -ge 3 -and $rawBytes[0] -eq 0xEF -and $rawBytes[1] -eq 0xBB -and $rawBytes[2] -eq 0xBF) {
        $rawBytes = $rawBytes[3..($rawBytes.Length - 1)]
    }

    if ($rawBytes.Length -eq 0) {
        $result = & $nodeBin $Processor 2>$null
    } else {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $nodeBin
        $psi.Arguments = "`"$Processor`""
        $psi.UseShellExecute = $false
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $false
        $psi.CreateNoWindow = $true

        $proc = [System.Diagnostics.Process]::Start($psi)
        $proc.StandardInput.BaseStream.Write($rawBytes, 0, $rawBytes.Length)
        $proc.StandardInput.Close()
        $result = $proc.StandardOutput.ReadToEnd()
        $proc.WaitForExit()
    }
    if ($result) { Write-Output $result } else { Write-Output $EMPTY_RESULT }
} catch {
    Write-Error "[kimi-hook] processor failed"
    Log-Error "processor_failed" "hook processor exited non-zero"
    Write-Output $EMPTY_RESULT
}

exit 0
