$ErrorActionPreference = 'Stop'
$root = Join-Path $env:RUNNER_TEMP 'pilot-win-p0'
$logs = Join-Path $env:RUNNER_TEMP 'pilot-win-p0-logs'
$homePath = Join-Path $root 'test user'
$cache = Join-Path $root 'cache'
$data = Join-Path $root 'data'
$env:LOONGSUITE_PILOT_CACHE_DIR = $cache
$env:LOONGSUITE_PILOT_DATA_DIR = $data
New-Item -ItemType Directory $homePath, $data, $logs | Out-Null
$env:USERPROFILE = $homePath
$env:HOME = $homePath
$installer = Join-Path $env:GITHUB_WORKSPACE 'deploy\installer-opensource.ps1'
$entry = Join-Path $homePath '.local\bin\loongsuite-pilot-service.ps1'
$oldInstaller = Join-Path $root 'official-installer.ps1'
$oldArchive = Join-Path $root 'loongsuite-pilot.zip'

function Fetch-Official($asset, $destination, $hash) {
    Invoke-WebRequest -Uri "https://github.com/alibaba/loongsuite-pilot/releases/download/v1.17.1/$asset" -OutFile $destination
    if ((Get-FileHash -Algorithm SHA256 $destination).Hash -ine $hash) { throw "Official asset SHA-256 mismatch: $asset" }
}
Fetch-Official 'installer.ps1' $oldInstaller 'cd8065116152389835428ff16edcdc962d0f27edd69197f2df4523d88f520d0e'
Fetch-Official 'loongsuite-pilot.zip' $oldArchive '48810fa5abe115f1ed0183fd17576a73ba72d956362d1a0dabad02b613c80f57'
$healthy = (Get-ChildItem "$env:RUNNER_TEMP/pilot-healthy" -Recurse -Filter '*.zip' | Select-Object -First 1).FullName
$fault = (Get-ChildItem "$env:RUNNER_TEMP/pilot-fault" -Recurse -Filter '*.zip' | Select-Object -First 1).FullName

function Run-Entry($label, [bool]$success, $script, [string[]]$arguments) {
    $PSNativeCommandUseErrorActionPreference = $false
    $log = Join-Path $logs "$label.log"
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script @arguments 2>&1 |
        ForEach-Object { "$_" } | Tee-Object -FilePath $log | Out-Host
    if (($LASTEXITCODE -eq 0) -ne $success) { throw "$label exited $LASTEXITCODE" }
    Get-Content -Raw $log
}

function Assert-Running($label, [bool]$native, $expectedPointer) {
    $pointer = (Get-Content -Raw (Join-Path $cache 'current')).Trim([char]0xFEFF).Trim()
    if ($expectedPointer -and $pointer -cne $expectedPointer) { throw "$label has incorrect installed version" }
    if ((Get-Content -Raw (Join-Path $data 'init-type')).Trim() -ne 'taskscheduler') {
        throw "$label did not start via Task Scheduler"
    }
    $status = Run-Entry "$label-status" $true $entry @('status')
    if ($status -notmatch 'is running') { throw "$label did not report running" }
    $collectorPid = [uint32](Get-Content -Raw (Join-Path $data 'loongsuite-pilot.pid')).Trim()
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $collectorPid"
    if (-not $process) { throw "$label has no live collector" }
    if ($native) {
        $versionBin = Join-Path $cache "versions\$pointer\bin"
        if ($process.ExecutablePath -ine (Join-Path $versionBin 'loongsuite-pilot.exe')) { throw "$label did not start the installed Rust collector" }
        $helper = Join-Path $versionBin 'loongsuite-pilot-sdk-hook.exe'
        $hookHash = (Get-FileHash $helper -Algorithm SHA256).Hash
        $buildHash = (Get-FileHash (Join-Path $env:GITHUB_WORKSPACE 'target\debug\loongsuite-pilot-sdk-hook.exe') -Algorithm SHA256).Hash
        if ($hookHash -ne $buildHash) { throw "Installed Hook executable differs from embedded SDK's Hook executable" }
    } elseif ($process.Name -ine 'node.exe' -or $process.CommandLine -notmatch 'collector-daemon\.js') {
        throw "$label did not start the official Node collector"
    }
    Write-Host "$label accepted: $($process.Name) PID $collectorPid ($pointer)"
    $pointer
}

$common = @('-DataDir', $data, '-Lang', 'en')
$userArgs = @('-Agents', 'qoder', '-UserId', 'pilot-windows-p0', '-EnableStatusBarApp', 'false')
try {
    Run-Entry 'install-official-node' $true $oldInstaller (@('install', '-PreferSystemNode', '-Version', '1.17.1', '-PackageUrl', $oldArchive) + $common + $userArgs) | Out-Null
    $oldPointer = Assert-Running 'node-initial' $false ''
    $failureMarker = Join-Path $data 'p0-injected-collector-failure'
    foreach ($operation in @('upgrade', 'install')) {
        Set-Content -LiteralPath $failureMarker -Value 'armed'
        $extras = if ($operation -eq 'install') { $userArgs } else { @() }
        $result = Run-Entry "startup-failure-$operation" $false $installer (@($operation, '-PackageUrl', $fault) + $common + $extras)
        if ((Get-Content -Raw $failureMarker) -ne 'scheduled native collector failed' -or $result -notmatch 'restored and started v1\.17\.1') {
            throw "No evidence of injected collector failure and verified automatic recovery for $operation"
        }
        Assert-Running "node-after-failed-$operation" $false $oldPointer | Out-Null
    }
    Remove-Item -LiteralPath $failureMarker
    Run-Entry 'upgrade-to-rust' $true $installer (@('upgrade', '-PackageUrl', $healthy) + $common) | Out-Null
    $rustPointer = Assert-Running 'rust-upgraded' $true ''
    Run-Entry 'restart-rust' $true $entry @('restart') | Out-Null
    Assert-Running 'rust-restarted' $true $rustPointer | Out-Null
    Run-Entry 'rollback-to-node' $true $entry @('rollback') | Out-Null
    Assert-Running 'node-manual-rollback' $false $oldPointer | Out-Null
} finally {
    if (Test-Path $entry) { Run-Entry 'stop-test-services' $true $entry @('stop') | Out-Null }
}
