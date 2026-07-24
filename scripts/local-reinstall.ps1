[CmdletBinding()]
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$projectRoot = Split-Path -Parent $PSScriptRoot
$defaultPilotDir = Join-Path $env:USERPROFILE ".loongsuite-pilot"
$installedLayoutPath = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot-layout.json"
$installedLayout = $null
if (Test-Path -LiteralPath $installedLayoutPath) {
    try { $installedLayout = Get-Content -LiteralPath $installedLayoutPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
}
$dataDir = if ($env:LOONGSUITE_PILOT_DATA_DIR) {
    $env:LOONGSUITE_PILOT_DATA_DIR
} elseif ($installedLayout -and $installedLayout.dataDir) {
    [string]$installedLayout.dataDir
} else {
    $defaultPilotDir
}
$cacheDir = if ($env:LOONGSUITE_PILOT_CACHE_DIR) {
    $env:LOONGSUITE_PILOT_CACHE_DIR
} elseif ($installedLayout -and $installedLayout.cacheDir) {
    [string]$installedLayout.cacheDir
} else {
    $defaultPilotDir
}
$configPath = Join-Path $dataDir "config.json"
$windowsCli = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot.ps1"
$installer = Join-Path $projectRoot "deploy\installer-opensource.ps1"
$packageScript = Join-Path $projectRoot "deploy\package-opensource.sh"
$zipPath = Join-Path $projectRoot "loongsuite-pilot.zip"
$backupPath = Join-Path $env:TEMP "loongsuite-pilot-config-local-reinstall.json"

function Find-Executable {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Names,
        [string[]]$Fallbacks = @()
    )

    foreach ($name in $Names) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command) { return $command.Source }
    }
    foreach ($fallback in $Fallbacks) {
        if (Test-Path -LiteralPath $fallback) { return $fallback }
    }
    throw "Required executable not found: $($Names -join ', ')"
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [string[]]$Arguments = @()
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $FilePath $($Arguments -join ' ')"
    }
}

function Resolve-InstalledServiceScript {
    if (Test-Path -LiteralPath $windowsCli) { return $windowsCli }

    $currentFile = Join-Path $cacheDir "current"
    if (Test-Path -LiteralPath $currentFile) {
        $current = (Get-Content -LiteralPath $currentFile -Raw).Trim()
        if ($current) {
            $candidate = Join-Path $cacheDir "versions\$current\scripts\loongsuite-pilot.ps1"
            if (Test-Path -LiteralPath $candidate) { return $candidate }
        }
    }
    return $null
}

function Restore-CollectorLauncher {
    param([Parameter(Mandatory = $true)][string]$NodeDirectory)

    $vbsPath = Join-Path $cacheDir "bin\collector-launch.vbs"
    $nodePath = Join-Path $NodeDirectory "node.exe"
    $entryPath = Join-Path $cacheDir "bin\collector-daemon.js"
    $configEscaped = $configPath -replace '"', '""'
    $cacheDirEscaped = $cacheDir -replace '"', '""'
    $dataDirEscaped = $dataDir -replace '"', '""'
    $nodeEscaped = $nodePath -replace '"', '""'
    $entryEscaped = $entryPath -replace '"', '""'
    $vbs = @"
Set sh = CreateObject("WScript.Shell")
sh.Environment("PROCESS").Item("AGENT_DATA_COLLECTION_CONFIG") = "$configEscaped"
sh.Environment("PROCESS").Item("LOONGSUITE_PILOT_DATA_DIR") = "$dataDirEscaped"
sh.Environment("PROCESS").Item("LOONGSUITE_PILOT_CACHE_DIR") = "$cacheDirEscaped"
sh.CurrentDirectory = "$cacheDirEscaped"
sh.Run """$nodeEscaped"" ""$entryEscaped""", 0, True
"@
    Set-Content -LiteralPath $vbsPath -Value $vbs -Encoding Unicode
}

$npm = Find-Executable -Names @("npm.cmd") -Fallbacks @("C:\Program Files\nodejs\npm.cmd")
$bash = Find-Executable -Names @("bash.exe", "bash") -Fallbacks @("C:\Program Files\Git\bin\bash.exe")
$nodeDir = Split-Path -Parent $npm
if (($env:Path -split ';') -notcontains $nodeDir) {
    $env:Path = "$nodeDir;$env:Path"
}

Push-Location $projectRoot
try {
    Write-Host "==> Step 1: Back up config"
    $hadConfig = Test-Path -LiteralPath $configPath
    if ($hadConfig) {
        Copy-Item -LiteralPath $configPath -Destination $backupPath -Force
        Write-Host "    Backed up to $backupPath"
    } else {
        Write-Host "    No config found"
    }

    Write-Host ""
    Write-Host "==> Step 2: Stop existing Windows service"
    $serviceScript = Resolve-InstalledServiceScript
    if ($serviceScript) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $serviceScript stop
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to stop the existing collector. Run this script from an elevated PowerShell if a Session 0 process is holding files."
        }
    } else {
        Write-Host "    No installed service command found"
    }

    Write-Host ""
    Write-Host "==> Step 3: Build"
    if (-not $SkipBuild) {
        Invoke-Checked -FilePath $npm -Arguments @("run", "build")
    } else {
        Write-Host "    Skipped (-SkipBuild)"
    }

    Write-Host ""
    Write-Host "==> Step 4: Package a Windows ZIP"
    $env:LOONGSUITE_PILOT_BUILD_ID = "localwin-" + (Get-Date -Format "yyyyMMddHHmmss")
    try {
        Invoke-Checked -FilePath $bash -Arguments @($packageScript, "--skip-build")
    } finally {
        Remove-Item Env:LOONGSUITE_PILOT_BUILD_ID -ErrorAction SilentlyContinue
    }

    $stream = [System.IO.File]::OpenRead($zipPath)
    try {
        $signature = New-Object byte[] 4
        [void]$stream.Read($signature, 0, 4)
    } finally {
        $stream.Dispose()
    }
    if ($signature[0] -ne 0x50 -or $signature[1] -ne 0x4B) {
        throw "Generated package is not a valid ZIP: $zipPath"
    }

    Write-Host ""
    Write-Host "==> Step 5: Install with the Windows installer"
    Invoke-Checked -FilePath "powershell.exe" -Arguments @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $installer,
        "install",
        "-PackageUrl", $zipPath,
        "-Agents", "codex",
        "-UserId", $env:USERNAME
    )

    Write-Host ""
    Write-Host "==> Step 6: Restore config and restart"
    if ($hadConfig -and (Test-Path -LiteralPath $backupPath)) {
        Copy-Item -LiteralPath $backupPath -Destination $configPath -Force
        Write-Host "    Config restored"
    }

    if (-not (Test-Path -LiteralPath $windowsCli)) {
        throw "Windows service command was not installed: $windowsCli"
    }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $windowsCli restart
    if ($LASTEXITCODE -ne 0) {
        # A task created by an earlier elevated install can be startable by the
        # current user even when it cannot be replaced. It still points at the
        # stable bootstrap, which resolves the newly written `current` version.
        $existingTask = Get-ScheduledTask -TaskPath "\LoongsuitePilot\" -ErrorAction SilentlyContinue |
            Where-Object { $_.TaskName -like "LoongsuitePilot-*" } |
            Select-Object -First 1
        if (-not $existingTask) {
            throw "Collector restart failed and no existing LoongsuitePilot scheduled task is available."
        }
        Restore-CollectorLauncher -NodeDirectory $nodeDir
        Start-ScheduledTask -InputObject $existingTask
        Start-Sleep -Seconds 3
        Write-Host "    Reused existing scheduled task: $($existingTask.TaskName)"
    }
    Invoke-Checked -FilePath "powershell.exe" -Arguments @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $windowsCli,
        "status"
    )

    $runtimePath = Join-Path $dataDir "logs\runtime.json"
    $runtimeHealthy = $false
    $stablePid = $null
    $stableChecks = 0
    $healthDeadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $healthDeadline -and -not $runtimeHealthy) {
        Start-Sleep -Seconds 2
        if (-not (Test-Path -LiteralPath $runtimePath)) { continue }
        try {
            $runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
            $runtimeUpdated = [DateTimeOffset]::Parse([string]$runtime.updatedAt)
            $runtimeAge = [DateTimeOffset]::Now - $runtimeUpdated
            $runtimePid = [int]$runtime.pid
            $runtimeProcess = Get-Process -Id $runtimePid -ErrorAction SilentlyContinue
            if (
                $runtime.status -eq "active" -and
                $runtimeAge.TotalSeconds -lt 90 -and
                $null -ne $runtimeProcess
            ) {
                if ($stablePid -eq $runtimePid) {
                    $stableChecks++
                } else {
                    $stablePid = $runtimePid
                    $stableChecks = 1
                }
                $runtimeHealthy = $stableChecks -ge 3
            } else {
                $stablePid = $null
                $stableChecks = 0
            }
        } catch {
            $stablePid = $null
            $stableChecks = 0
        }
    }
    if (-not $runtimeHealthy) {
        throw "Collector task did not produce a fresh runtime heartbeat. An inaccessible stale scheduled task may need to be removed from an elevated PowerShell."
    }

    Write-Host ""
    Write-Host "Local Windows reinstall complete."
    Write-Host "Codex output: $dataDir\logs\output\codex-YYYY-MM-DD.jsonl"
} catch {
    if ((Test-Path -LiteralPath $backupPath) -and (Test-Path -LiteralPath $dataDir)) {
        Copy-Item -LiteralPath $backupPath -Destination $configPath -Force
    }
    throw
} finally {
    Pop-Location
}
