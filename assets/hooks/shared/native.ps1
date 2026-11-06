# Resolve signed built-in modules by their exact PSHOME manifests. Short-name
# autoload can stall in isolated Windows PowerShell 5.1 environments.
Import-Module -Name ($PSHOME + '\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
Import-Module -Name ($PSHOME + '\Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1') -ErrorAction Stop

function Test-PilotBinary {
    param([string]$Binary)
    if (-not $Binary -or $Binary -notmatch '^(?:[A-Za-z]:[\\/]|\\\\)') { return $false }
    if ($Binary -notmatch '(?i)\.exe$') { return $false }
    if (-not (Test-Path -LiteralPath $Binary -PathType Leaf)) { return $false }
    $item = Get-Item -LiteralPath $Binary -Force -ErrorAction Stop
    return -not ($item.Attributes -band 1024)
}

function Resolve-PilotBinary {
    param([string]$HookDir)
    if ($env:LOONGSUITE_PILOT_BIN) {
        if (Test-PilotBinary $env:LOONGSUITE_PILOT_BIN) { return $env:LOONGSUITE_PILOT_BIN }
        throw 'invalid LOONGSUITE_PILOT_BIN'
    }
    $parent = Split-Path -Parent $HookDir
    $package = Split-Path -Parent $parent
    if ((Split-Path -Leaf $parent) -eq 'assets' -and (Test-Path -LiteralPath (Join-Path $package 'runtime-manifest.json'))) {
        $binary = Join-Path $package 'bin\loongsuite-pilot.exe'
        if (Test-PilotBinary $binary) { return $binary }
        throw 'candidate binary missing'
    }
    $pin = Join-Path $HookDir 'pilot-bin'
    if (Test-Path -LiteralPath $pin) {
        $binary = ([string](Get-Content -LiteralPath $pin -Raw -Encoding UTF8 -ErrorAction Stop)).Trim([char]0xFEFF).Trim()
        if (Test-PilotBinary $binary) { return $binary }
        throw 'invalid native binary pin'
    }
    $data = $env:LOONGSUITE_PILOT_DATA_DIR
    if (-not $data) { $data = $parent }
    $cache = $env:LOONGSUITE_PILOT_CACHE_DIR
    if (-not $cache) { $cache = $data }
    $current = Join-Path $cache 'current'
    if (Test-Path -LiteralPath $current) {
        $version = ([string](Get-Content -LiteralPath $current -Raw -Encoding UTF8 -ErrorAction Stop)).Trim([char]0xFEFF).Trim()
        if ($version -notmatch '^[A-Za-z0-9._-]+$' -or $version -in @('.', '..')) { throw 'invalid current pointer' }
        $versionDir = Join-Path $cache "versions\$version"
        foreach ($directory in @((Join-Path $cache 'versions'), $versionDir, (Join-Path $versionDir 'bin'))) {
            if ((Get-Item -LiteralPath $directory -Force -ErrorAction Stop).Attributes -band 1024) { throw 'linked runtime directory' }
        }
        $binary = Join-Path $versionDir 'bin\loongsuite-pilot.exe'
        if (Test-PilotBinary $binary) { return $binary }
        throw 'current binary missing'
    }
    $binary = Join-Path $data 'bin\loongsuite-pilot.exe'
    if (Test-PilotBinary $binary) { return $binary }
    throw 'native binary missing'
}

function ConvertTo-PilotNativeArgument {
    param([string]$Value)
    # Quote every argument for PowerShell's Legacy native binder, including
    # empty values and trailing backslashes. No command shell is involved.
    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

function Invoke-PilotNative {
    param([string]$HookDir, [string[]]$Arguments, [string]$EmptyResult = '{}')
    if (-not [Console]::IsInputRedirected) {
        if ($EmptyResult) { Write-Output $EmptyResult }
        return
    }
    if (-not $env:LOONGSUITE_PILOT_DATA_DIR) {
        $parent = Split-Path -Parent $HookDir
        if ((Split-Path -Leaf $parent) -ne 'assets') { $env:LOONGSUITE_PILOT_DATA_DIR = $parent }
    }
    try {
        $binary = Resolve-PilotBinary -HookDir $HookDir
        $quoted = @($Arguments | ForEach-Object { ConvertTo-PilotNativeArgument $_ })
        # A standalone native invocation inherits the original byte handles.
        # Do not capture its output or put it in a PowerShell text pipeline.
        # Pin Legacy in this function's scope so PS5.1 and PS7 use the same CRT
        # quoting. Native execution waits for this process, not retry descendants,
        # and obtains its actual exit code without reopening an already-exited PID.
        $PSNativeCommandArgumentPassing = 'Legacy'
        $global:LASTEXITCODE = 9009
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            # Native stderr is diagnostic data; read the actual exit code before
            # restoring the wrapper's Stop policy for PowerShell operations.
            $ErrorActionPreference = 'Continue'
            & $binary @quoted
            $nativeExit = $global:LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($null -eq $nativeExit -or $nativeExit -ne 0) { throw 'native hook failed' }
    } catch {
        Write-Error '[loongsuite-pilot] native hook unavailable' -ErrorAction Continue
        if ($EmptyResult) { Write-Output $EmptyResult }
    }
}
