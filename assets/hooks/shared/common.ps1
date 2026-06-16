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

function Read-StdinRawBytes {
    $stdinStream = [Console]::OpenStandardInput()
    $ms = New-Object System.IO.MemoryStream
    $stdinStream.CopyTo($ms)
    $rawBytes = $ms.ToArray()
    $ms.Dispose()

    # Strip UTF-8 BOM (EF BB BF)
    if ($rawBytes.Length -ge 3 -and $rawBytes[0] -eq 0xEF -and $rawBytes[1] -eq 0xBB -and $rawBytes[2] -eq 0xBF) {
        $rawBytes = $rawBytes[3..($rawBytes.Length - 1)]
    }

    # Fix UTF-8->GBK double-encoding on Chinese Windows
    if ($rawBytes.Length -gt 2) {
        try {
            $utf8    = [System.Text.Encoding]::UTF8
            $gbk     = [System.Text.Encoding]::GetEncoding(936)
            $garbled = $utf8.GetString($rawBytes)
            $recovered = $gbk.GetBytes($garbled)

            $strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
            [void]$strictUtf8.GetString($recovered)

            $rawBytes = $recovered
        } catch {}
    }

    return ,$rawBytes
}

function Invoke-NodeProcessor {
    param(
        [string]$NodeBin,
        [string]$ProcessorPath,
        [string]$ExtraArgs,
        [byte[]]$StdinBytes
    )
    if ($StdinBytes.Length -eq 0) {
        if ($ExtraArgs) {
            return & $NodeBin $ProcessorPath $ExtraArgs.Split(' ') 2>$null
        } else {
            return & $NodeBin $ProcessorPath 2>$null
        }
    }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $NodeBin
    $psi.Arguments = if ($ExtraArgs) { "`"$ProcessorPath`" $ExtraArgs" } else { "`"$ProcessorPath`"" }
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $false
    $psi.CreateNoWindow = $true

    $proc = [System.Diagnostics.Process]::Start($psi)
    $proc.StandardInput.BaseStream.Write($StdinBytes, 0, $StdinBytes.Length)
    $proc.StandardInput.Close()
    $result = $proc.StandardOutput.ReadToEnd()
    $proc.WaitForExit()
    return $result
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
        Add-Content -Path $file -Value $line
    } catch {}
}
