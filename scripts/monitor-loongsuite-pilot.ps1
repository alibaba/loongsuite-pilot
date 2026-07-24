[CmdletBinding()]
param(
    [int]$IntervalSeconds = $(if ($env:INTERVAL_SECONDS) { [int]$env:INTERVAL_SECONDS } else { 5 }),
    [string]$OutDir,
    [int]$TargetPid = 0,
    [string]$ProcessPattern = $(if ($env:LOONGSUITE_PILOT_PROCESS_PATTERN) {
        $env:LOONGSUITE_PILOT_PROCESS_PATTERN
    } else {
        "collector-daemon\.js|loongsuite-pilot.*run|loongsuite-pilot run"
    })
)

$ErrorActionPreference = "Stop"
$dataDir = if ($env:LOONGSUITE_PILOT_DATA_DIR) {
    $env:LOONGSUITE_PILOT_DATA_DIR
} else {
    Join-Path $env:USERPROFILE ".loongsuite-pilot"
}
$pidFile = if ($env:LOONGSUITE_PILOT_PID_FILE) {
    $env:LOONGSUITE_PILOT_PID_FILE
} else {
    Join-Path $dataDir "loongsuite-pilot.pid"
}
if (-not $OutDir) {
    $OutDir = if ($env:LOONGSUITE_PILOT_MONITOR_DIR) {
        $env:LOONGSUITE_PILOT_MONITOR_DIR
    } else {
        Join-Path $dataDir "logs\process-monitor"
    }
}
$retentionHours = if ($env:LOONGSUITE_PILOT_MONITOR_RETENTION_HOURS) {
    [int]$env:LOONGSUITE_PILOT_MONITOR_RETENTION_HOURS
} else {
    6
}
$cleanupIntervalSeconds = if ($env:LOONGSUITE_PILOT_MONITOR_CLEANUP_INTERVAL_SECONDS) {
    [int]$env:LOONGSUITE_PILOT_MONITOR_CLEANUP_INTERVAL_SECONDS
} else {
    300
}
$csvHeader = "timestamp,pid,ppid,command,cpu_percent,mem_percent,rss_kb,vsz_kb,elapsed,threads,open_files,inet_connections,tcp_established,tcp_listen,udp_connections"
$statusLog = Join-Path $OutDir "loongsuite-pilot-monitor.log"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$lastCleanup = [DateTimeOffset]::MinValue
$previousCpu = @{}
$logicalProcessors = [Math]::Max(1, [Environment]::ProcessorCount)
$totalMemoryBytes = try {
    [double](Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize * 1024
} catch {
    0
}

if ($IntervalSeconds -lt 1) { throw "IntervalSeconds must be at least 1" }
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

function Write-Status {
    param([string]$Message)
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message$([Environment]::NewLine)"
    [System.IO.File]::AppendAllText($statusLog, $line, $utf8NoBom)
}

function Get-TargetProcessIds {
    if ($TargetPid -gt 0) {
        if (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue) { return @($TargetPid) }
        return @()
    }

    if (Test-Path -LiteralPath $pidFile) {
        $configuredPid = 0
        if ([int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$configuredPid)) {
            if (Get-Process -Id $configuredPid -ErrorAction SilentlyContinue) {
                return @($configuredPid)
            }
        }
    }

    $processIds = @()
    foreach ($process in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) {
        $commandLine = [string]$process.CommandLine
        if (
            $commandLine -match $ProcessPattern -and
            $commandLine -notmatch "monitor-loongsuite-pilot"
        ) {
            $processIds += [int]$process.ProcessId
        }
    }
    return @($processIds | Select-Object -Unique)
}

function Get-ConnectionCounts {
    param([int]$ProcessId)
    $tcp = @(Get-NetTCPConnection -OwningProcess $ProcessId -ErrorAction SilentlyContinue)
    $udp = @(Get-NetUDPEndpoint -OwningProcess $ProcessId -ErrorAction SilentlyContinue)
    return @{
        inet = $tcp.Count + $udp.Count
        established = @($tcp | Where-Object State -eq "Established").Count
        listen = @($tcp | Where-Object State -eq "Listen").Count
        udp = $udp.Count
    }
}

function Write-Sample {
    param([int]$ProcessId)
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $process) { return }
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if (-not $cim) { return }

    $now = Get-Date
    $cpuPercent = 0
    if ($previousCpu.ContainsKey($ProcessId)) {
        $previous = $previousCpu[$ProcessId]
        $elapsedSeconds = ($now - $previous.at).TotalSeconds
        if ($elapsedSeconds -gt 0) {
            $cpuPercent = (($process.TotalProcessorTime.TotalSeconds - $previous.cpu) /
                $elapsedSeconds / $logicalProcessors) * 100
        }
    }
    $previousCpu[$ProcessId] = @{ at = $now; cpu = $process.TotalProcessorTime.TotalSeconds }

    $connections = Get-ConnectionCounts $ProcessId
    $memoryPercent = if ($totalMemoryBytes -gt 0) {
        ($process.WorkingSet64 / $totalMemoryBytes) * 100
    } else {
        0
    }
    $elapsed = try { ($now - $process.StartTime).ToString() } catch { "" }
    $command = if ($cim.CommandLine) { [string]$cim.CommandLine } else { [string]$process.ProcessName }
    $row = [ordered]@{
        timestamp = $now.ToString("yyyy-MM-dd HH:mm:ss")
        pid = $ProcessId
        ppid = [int]$cim.ParentProcessId
        command = $command
        cpu_percent = [Math]::Round([Math]::Max(0, $cpuPercent), 2)
        mem_percent = [Math]::Round([Math]::Max(0, $memoryPercent), 2)
        rss_kb = [Math]::Round($process.WorkingSet64 / 1KB)
        vsz_kb = [Math]::Round($process.VirtualMemorySize64 / 1KB)
        elapsed = $elapsed
        threads = $process.Threads.Count
        open_files = $process.HandleCount
        inet_connections = $connections.inet
        tcp_established = $connections.established
        tcp_listen = $connections.listen
        udp_connections = $connections.udp
    }

    $csvFile = Join-Path $OutDir "loongsuite-pilot-process-$($now.ToString('yyyy-MM-dd-HH')).csv"
    if (-not (Test-Path -LiteralPath $csvFile)) {
        [System.IO.File]::WriteAllText($csvFile, "$csvHeader$([Environment]::NewLine)", $utf8NoBom)
    }
    $csvLine = ($row | ForEach-Object { [pscustomobject]$_ } | ConvertTo-Csv -NoTypeInformation)[1]
    [System.IO.File]::AppendAllText($csvFile, "$csvLine$([Environment]::NewLine)", $utf8NoBom)
}

function Remove-ExpiredMetrics {
    $now = [DateTimeOffset]::Now
    if (($now - $lastCleanup).TotalSeconds -lt $cleanupIntervalSeconds) { return }
    $script:lastCleanup = $now
    if ($retentionHours -le 0) { return }

    $cutoff = (Get-Date).AddHours(-$retentionHours)
    Get-ChildItem -LiteralPath $OutDir -Filter "loongsuite-pilot-process-*.csv" -File -ErrorAction SilentlyContinue |
        Where-Object LastWriteTime -lt $cutoff |
        ForEach-Object {
            Remove-Item -LiteralPath $_.FullName -Force
            Write-Status "removed old process metrics csv: $($_.FullName)"
        }
}

Write-Status "started interval=${IntervalSeconds}s out_dir=$OutDir pid_file=$pidFile pattern=$ProcessPattern retention_hours=$retentionHours"
Write-Output "Writing hourly samples to: $OutDir\loongsuite-pilot-process-YYYY-MM-DD-HH.csv"
Write-Output "Writing monitor status to: $statusLog"

while ($true) {
    $pids = @(Get-TargetProcessIds)
    if ($pids.Count -eq 0) {
        Write-Status "no matching process found"
    } else {
        foreach ($processId in $pids) {
            try {
                Write-Sample $processId
            } catch {
                Write-Status "failed to sample pid=${processId}: $($_.Exception.Message)"
            }
        }
    }
    Remove-ExpiredMetrics
    Start-Sleep -Seconds $IntervalSeconds
}
