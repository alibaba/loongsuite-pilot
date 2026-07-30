# WorkBuddy hook entrypoint for Windows.
#
# Registered command:
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
#     -File "<pilot-data>\hooks\workbuddy-loongsuite-pilot-hook.ps1" <subcommand>
#
# The hook is fail-open: it always acknowledges WorkBuddy with one JSON object
# and exits zero. The processor records only structural wakeup hints.

param(
    [Parameter(Position = 0)]
    [string]$Subcommand = "unknown"
)

$ErrorActionPreference = "Stop"
$EMPTY_RESULT = '{}'
$MIN_NODE_MAJOR = 18

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Processor = Join-Path $ScriptDir "workbuddy-hook-event-writer.mjs"
$PilotDataDir = Split-Path -Parent $ScriptDir
if (-not $env:LOONGSUITE_PILOT_DATA_DIR) {
    $env:LOONGSUITE_PILOT_DATA_DIR = $PilotDataDir
}

function Write-EmptyResult {
    [Console]::Out.WriteLine($EMPTY_RESULT)
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

if (-not (Test-Path -LiteralPath $Processor)) {
    Write-EmptyResult
    exit 0
}

try {
    $nodeBin = Resolve-NodeBin
    if (-not $nodeBin) {
        Write-EmptyResult
        exit 0
    }

    $stdinStream = [Console]::OpenStandardInput()
    $memory = New-Object System.IO.MemoryStream
    $stdinStream.CopyTo($memory)
    [byte[]]$rawBytes = $memory.ToArray()
    $memory.Dispose()

    if (
        $rawBytes.Length -ge 3 -and
        $rawBytes[0] -eq 0xEF -and
        $rawBytes[1] -eq 0xBB -and
        $rawBytes[2] -eq 0xBF
    ) {
        if ($rawBytes.Length -eq 3) {
            $rawBytes = [byte[]]@()
        } else {
            $rawBytes = $rawBytes[3..($rawBytes.Length - 1)]
        }
    }

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $nodeBin
    $startInfo.Arguments = "`"$Processor`" `"$Subcommand`""
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true

    $process = [System.Diagnostics.Process]::Start($startInfo)
    if ($rawBytes.Length -gt 0) {
        $process.StandardInput.BaseStream.Write($rawBytes, 0, $rawBytes.Length)
    }
    $process.StandardInput.Close()
    $result = $process.StandardOutput.ReadToEnd()
    $process.StandardError.ReadToEnd() | Out-Null
    $process.WaitForExit()

    if ($process.ExitCode -ne 0) {
        Write-EmptyResult
        exit 0
    }

    if ($result -and $result.Trim()) {
        [Console]::Out.WriteLine($result.Trim())
    } else {
        Write-EmptyResult
    }
} catch {
    Write-EmptyResult
}

exit 0
