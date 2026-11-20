# Shared record, exit codes, and process helpers for the Windows audit scripts.
# Dot-source this file. Comments stay ASCII; user-facing strings may be Chinese.
if ($script:PilotAuditLibLoaded) { return }
$script:PilotAuditLibLoaded = $true

$ErrorActionPreference = "Stop"

$script:EXIT_NEED_AUTH = 3
$script:EXIT_CHOOSE_AGENT_SPACE = 7

$script:DATA_DIR = Join-Path $env:USERPROFILE ".loongsuite-pilot\audit"
$script:RECORD_PATH = Join-Path $script:DATA_DIR "config-record.json"
$script:HISTORY_PATH = Join-Path $script:DATA_DIR "query-history.jsonl"
$setupRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script:PLUGIN_ROOT = Split-Path -Parent (Split-Path -Parent $setupRoot)
$isPlugin = Test-Path -LiteralPath (Join-Path $script:PLUGIN_ROOT ".qoder-plugin\plugin.json") -PathType Leaf
if (-not $isPlugin) {
    $script:PLUGIN_ROOT = $setupRoot
}
$script:ALIYUN_HOME = Join-Path $script:PLUGIN_ROOT "aliyun"
if (-not $isPlugin) {
    $legacyAliyunHome = Join-Path (Split-Path -Parent $setupRoot) "agentloop-audit-query\aliyun"
    $newConfig = Join-Path $script:ALIYUN_HOME "config.json"
    $legacyConfig = Join-Path $legacyAliyunHome "config.json"
    if (-not (Test-Path -LiteralPath $newConfig -PathType Leaf) -and (Test-Path -LiteralPath $legacyConfig -PathType Leaf)) {
        $script:ALIYUN_HOME = $legacyAliyunHome
    }
}
$script:ALIYUN_BIN = Join-Path $script:ALIYUN_HOME "bin\aliyun.exe"
$script:ALIYUN_CONFIG = Join-Path $script:ALIYUN_HOME "config.json"
$script:DEFAULT_LOGSTORE = "agent-event"
$script:HISTORY_LIMIT = 50
$script:INSTALLER_NAME = "loongsuite-pilot-installer"
$script:INSTALL_SOURCE = "qoder-marketplace"
$script:ENTERPRISE_ZIP = Join-Path $script:DATA_DIR "loongsuite-pilot-installer.zip"
$script:PLUGIN_ZIP_URL = "https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/loongsuite-pilot-installer.zip"
$script:COMMAND_TIMEOUT_SECONDS = 60
$script:LONG_OPERATION_TIMEOUT_SECONDS = 600

function Fail([string]$Message) {
    Write-Error $Message -ErrorAction Continue
    exit 1
}

function Fail-Cli([string]$Message) {
    Write-Error $Message -ErrorAction Continue
    exit 2
}

function Test-Interactive {
    try {
        return -not [Console]::IsInputRedirected
    } catch {
        return $true
    }
}

function Get-CliMap([string[]]$Argv, [string[]]$ValueNames, [string[]]$SwitchNames) {
    $map = @{}
    $switches = @{}
    for ($i = 0; $i -lt $Argv.Count; $i++) {
        $token = [string]$Argv[$i]
        if ($token -notlike "--*") {
            Fail-Cli ("unexpected argument: " + $token)
        }
        $key = $token.Substring(2)
        if ($SwitchNames -contains $key) {
            $switches[$key] = $true
            continue
        }
        if ($ValueNames -notcontains $key) {
            Fail-Cli ("unknown option: " + $token)
        }
        if ($i + 1 -ge $Argv.Count -or [string]$Argv[$i + 1] -like "--*") {
            Fail-Cli ("missing value for " + $token)
        }
        $i++
        $map[$key] = [string]$Argv[$i]
    }
    return @{ Map = $map; Switches = $switches }
}

function Get-CliValue($Parsed, [string]$Name) {
    if ($Parsed.Map.Keys -contains $Name) { return [string]$Parsed.Map[$Name] }
    return ""
}

function Escape-JsonString([string]$Text) {
    if ($null -eq $Text) { return "" }
    $escaped = ""
    foreach ($ch in $Text.ToCharArray()) {
        $code = [int][char]$ch
        if ($ch -eq "\") { $escaped += "\\" }
        elseif ($ch -eq '"') { $escaped += '\"' }
        elseif ($ch -eq "`b") { $escaped += "\b" }
        elseif ($ch -eq "`f") { $escaped += "\f" }
        elseif ($ch -eq "`r") { $escaped += "\r" }
        elseif ($ch -eq "`n") { $escaped += "\n" }
        elseif ($ch -eq "`t") { $escaped += "\t" }
        elseif ($code -lt 32) { $escaped += "\u" + $code.ToString("x4") }
        else { $escaped += $ch }
    }
    return $escaped
}

function Get-JsonPropertyNames($Data) {
    $names = @()
    if ($Data -is [hashtable]) {
        foreach ($key in $Data.Keys) { $names += [string]$key }
        return $names
    }
    foreach ($member in @(Get-Member -InputObject $Data -MemberType NoteProperty)) {
        $names += [string]$member.Name
    }
    return $names
}

function Format-JsonArray([object[]]$Items, [int]$Depth = 30) {
    # The parameter type keeps a one-item array intact. An untyped parameter would
    # unwrap it before this function could see it.
    $parts = @()
    foreach ($item in $Items) {
        if ($null -eq $item) {
            $parts += "null"
            continue
        }
        $parts += (ConvertTo-Json -InputObject $item -Depth $Depth -Compress)
    }
    if ($parts.Count -eq 0) { return "[]" }
    return "[" + ($parts -join ",") + "]"
}

function Format-JsonValue($Value, [int]$Depth = 30) {
    if ($null -eq $Value) { return "null" }
    if ($Value -is [array]) { return (Format-JsonArray $Value $Depth) }
    return (ConvertTo-Json -InputObject $Value -Depth $Depth -Compress)
}

function ConvertTo-JsonObject($Data, [string]$ArrayName, [object[]]$ArrayValue, [int]$Depth = 30) {
    # Windows PowerShell 5.1 writes a one-item array property as an object.
    # Serialize that property separately and keep its brackets in the result.
    $fields = @()
    foreach ($name in (Get-JsonPropertyNames $Data)) {
        if ($name -eq $ArrayName) { continue }
        $value = $Data.$name
        if ($value -is [array]) { $encoded = Format-JsonArray $value $Depth }
        else { $encoded = Format-JsonValue $value $Depth }
        $fields += ('"' + (Escape-JsonString $name) + '":' + $encoded)
    }
    $fields += ('"' + (Escape-JsonString $ArrayName) + '":' + (Format-JsonArray $ArrayValue $Depth))
    return "{" + ($fields -join ",") + "}"
}

function Get-AuditLongPath([string]$Path) {
    if (-not $Path) { return $Path }
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($item.FullName) { return $item.FullName }
    } catch {
        try {
            $parent = Split-Path -Parent $Path
            $leaf = Split-Path -Leaf $Path
            if ($parent -and $leaf) {
                $parentItem = Get-Item -LiteralPath $parent -Force -ErrorAction Stop
                if ($parentItem.FullName) { return (Join-Path $parentItem.FullName $leaf) }
            }
        } catch {}
    }
    return $Path
}

function Remove-AuditPathQuietly([string]$Path) {
    if (-not $Path) { return }
    try {
        Remove-Item -LiteralPath (Get-AuditLongPath $Path) -Recurse -Force -ErrorAction SilentlyContinue
    } catch {}
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $tmp = Join-Path $dir (".audit-write-" + $PID + "-" + (Get-Random) + ".tmp")
    try {
        Set-Content -LiteralPath $tmp -Value $Text -Encoding UTF8 -NoNewline
        $bytes = @(Get-Content -LiteralPath $tmp -Encoding Byte)
        if ($bytes.Count -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) {
            if ($bytes.Count -eq 3) {
                $payload = [byte[]]@()
            } else {
                $payload = [byte[]]($bytes[3..($bytes.Count - 1)])
            }
            Set-Content -LiteralPath $tmp -Value $payload -Encoding Byte -NoNewline
        }
        Move-Item -LiteralPath (Get-AuditLongPath $tmp) -Destination $Path -Force
        $tmp = ""
    } finally {
        Remove-AuditPathQuietly $tmp
    }
}

function Read-Utf8Text([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return "" }
    $text = Get-Content -Raw -Encoding UTF8 -LiteralPath $Path
    if ($null -eq $text) { return "" }
    return [string]$text
}

function Read-AuditRecord {
    $text = Read-Utf8Text $script:RECORD_PATH
    if (-not $text.Trim()) { return @{} }
    try {
        $obj = $text | ConvertFrom-Json
    } catch {
        return @{}
    }
    $data = @{}
    foreach ($name in @("profile", "agentSpace", "regionId", "slsProject", "slsLogstore", "updatedAt")) {
        $value = $obj.$name
        if ($null -ne $value -and [string]$value -ne "") { $data[$name] = [string]$value }
    }
    return $data
}

function Write-AuditRecord($Data) {
    $pairs = @()
    foreach ($name in @("profile", "agentSpace", "regionId", "slsProject", "slsLogstore", "updatedAt")) {
        if ($Data.Keys -contains $name) {
            $pairs += '"' + $name + '":"' + (Escape-JsonString ([string]$Data[$name])) + '"'
        }
    }
    Write-Utf8NoBom $script:RECORD_PATH (("{" + ($pairs -join ",") + "}`n"))
}

function Get-SavedTarget {
    $data = Read-AuditRecord
    $target = @{}
    foreach ($name in @("agentSpace", "regionId", "slsProject", "slsLogstore")) {
        if ($data.Keys -contains $name) { $target[$name] = [string]$data[$name] } else { $target[$name] = "" }
    }
    return $target
}

function Get-SavedSpace {
    $target = Get-SavedTarget
    if ($target["agentSpace"] -and $target["regionId"]) {
        return @($target["agentSpace"], $target["regionId"])
    }
    return @("", "")
}

function Get-Stamp {
    $now = Get-Date
    $offset = $now.ToString("zzz").Replace(":", "")
    return $now.ToString("yyyy-MM-ddTHH:mm:ss") + $offset
}

function Save-AuditProfile([string]$Profile) {
    $data = Read-AuditRecord
    $previous = ""
    if ($data.Keys -contains "profile") { $previous = [string]$data["profile"] }
    if ($previous -cne $Profile) {
        foreach ($name in @("agentSpace", "regionId", "slsProject", "slsLogstore", "updatedAt")) {
            $data.Remove($name)
        }
    }
    $data["profile"] = $Profile
    Write-AuditRecord $data
}

function Save-AuditTarget([string]$AgentSpace, [string]$RegionId, [string]$Project, [string]$Logstore) {
    $context = @{
        agentSpace = [string]$AgentSpace
        regionId = [string]$RegionId
        slsProject = [string]$Project
        slsLogstore = $(if ($Logstore) { [string]$Logstore } else { $script:DEFAULT_LOGSTORE })
        updatedAt = Get-Stamp
    }
    $existing = Read-AuditRecord
    if ($existing.Keys -contains "profile" -and $existing["profile"]) {
        $context["profile"] = [string]$existing["profile"]
    }
    Write-AuditRecord $context
    return $context
}

function Get-AliyunConfigPath {
    return $script:ALIYUN_CONFIG
}

function Get-ProfileSummaries {
    $path = Get-AliyunConfigPath
    $text = Read-Utf8Text $path
    if (-not $text.Trim()) { return @() }
    try {
        $data = $text | ConvertFrom-Json
    } catch {
        return @()
    }
    $profiles = $data.profiles
    if (-not $profiles) { return @() }
    $profiles = @($profiles)
    $summaries = @()
    foreach ($item in $profiles) {
        $name = [string]$item.name
        if (-not $name) { continue }
        $mode = [string]$item.mode
        $akReady = [bool]($item.access_key_id -and $item.access_key_secret)
        $oauthSiteType = [string]$item.oauth_site_type
        $oauthReady = [bool]($item.oauth_refresh_token -and (@("CN", "INTL") -contains $oauthSiteType))
        $summaries += @{
            name = $name
            mode = $mode
            ak_ready = $akReady
            oauth_ready = $oauthReady
            oauth_site_type = $oauthSiteType
        }
    }
    return $summaries
}

function Test-ProfileUsable($Item) {
    if ($Item.mode -eq "OAuth") { return [bool]$Item.oauth_ready }
    return ($Item.mode -eq "AK" -and $Item.ak_ready)
}

function Get-SavedProfileName {
    $data = Read-AuditRecord
    $profile = ""
    if ($data.Keys -contains "profile") { $profile = [string]$data["profile"] }
    if (-not $profile) { return "" }
    foreach ($item in (Get-ProfileSummaries)) {
        if ($item.name -eq $profile -and (Test-ProfileUsable $item)) { return $profile }
    }
    return ""
}

function Require-Profile {
    $profile = Get-SavedProfileName
    if ($profile) { return $profile }
    Write-Error "Not authorized." -ErrorAction Continue
    exit $script:EXIT_NEED_AUTH
}

function Get-HistoryRows {
    $text = Read-Utf8Text $script:HISTORY_PATH
    $rows = @()
    if (-not $text) { return $rows }
    foreach ($line in ($text -split "`r?`n")) {
        $trimmed = $line.Trim()
        if (-not $trimmed) { continue }
        try {
            $item = $trimmed | ConvertFrom-Json
        } catch {
            continue
        }
        $rows += @{
            at = [string]$item.at
            query = [string]$item.query
            from = $item.from
            to = $item.to
            slsProject = [string]$item.slsProject
            slsLogstore = [string]$item.slsLogstore
            regionId = [string]$item.regionId
        }
    }
    if ($rows.Count -gt $script:HISTORY_LIMIT) {
        $rows = $rows[($rows.Count - $script:HISTORY_LIMIT)..($rows.Count - 1)]
    }
    return $rows
}

function Add-HistoryRow($Entry) {
    $rows = @(Get-HistoryRows)
    $rows += $Entry
    if ($rows.Count -gt $script:HISTORY_LIMIT) {
        $rows = $rows[($rows.Count - $script:HISTORY_LIMIT)..($rows.Count - 1)]
    }
    $lines = @()
    foreach ($item in $rows) {
        $fromNum = 0
        $toNum = 0
        if ($null -ne $item.from) { $fromNum = [long]$item.from }
        if ($null -ne $item.to) { $toNum = [long]$item.to }
        $lines += '{"at":"' + (Escape-JsonString ([string]$item.at)) + '","query":"' + (Escape-JsonString ([string]$item.query)) + '","from":' + $fromNum + ',"to":' + $toNum + ',"slsProject":"' + (Escape-JsonString ([string]$item.slsProject)) + '","slsLogstore":"' + (Escape-JsonString ([string]$item.slsLogstore)) + '","regionId":"' + (Escape-JsonString ([string]$item.regionId)) + '"}'
    }
    $payload = ""
    if ($lines.Count -gt 0) { $payload = ($lines -join "`n") + "`n" }
    Write-Utf8NoBom $script:HISTORY_PATH $payload
}

function Get-AsciiTempRoot {
    $candidates = @()
    if ($env:TEMP) { $candidates += $env:TEMP }
    if ($env:SystemRoot) { $candidates += (Join-Path $env:SystemRoot "Temp") }
    foreach ($candidate in $candidates) {
        if ($candidate -notmatch '^[\x20-\x7E]+$' -or -not (Test-Path -LiteralPath $candidate)) { continue }
        $probe = Join-Path $candidate (".pilot-audit-probe-" + $PID + "-" + (Get-Random) + ".tmp")
        try {
            Set-Content -LiteralPath $probe -Value "ok" -Encoding ASCII -NoNewline -ErrorAction Stop
            Remove-AuditPathQuietly $probe
            return $candidate
        } catch {
            Remove-AuditPathQuietly $probe
        }
    }
    Fail "No writable ASCII temp directory"
}

function Get-TarExe {
    $exes = @()
    if ($env:SystemRoot) {
        foreach ($dir in @("System32", "Sysnative")) {
            $candidate = Join-Path $env:SystemRoot "$dir\tar.exe"
            if (Test-Path -LiteralPath $candidate) { $exes += $candidate }
        }
    }
    $nativeCount = $exes.Count
    $pathTar = Get-Command tar -ErrorAction SilentlyContinue
    if ($pathTar -and $pathTar.Source -and ($exes -notcontains $pathTar.Source)) {
        $exes += $pathTar.Source
    }
    return @{ Exes = $exes; NativeCount = $nativeCount }
}

function Expand-ZipArchive([string]$ArchivePath, [string]$DestDir) {
    $found = Get-TarExe
    if ($found.Exes.Count -eq 0) { return $false }
    $prev = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        for ($i = 0; $i -lt $found.Exes.Count; $i++) {
            $exe = $found.Exes[$i]
            $tarArgs = @("-xf", $ArchivePath, "-C", $DestDir)
            if ($i -ge $found.NativeCount) { $tarArgs = @("--force-local") + $tarArgs }
            $rc = 1
            & $exe @tarArgs 2>$null
            $rc = $LASTEXITCODE
            if ($rc -eq 0) { return $true }
        }
    } finally {
        $ErrorActionPreference = $prev
    }
    return $false
}

function Write-NativeGrowth([string]$Path, [int]$Shown) {
    if (-not (Test-Path -LiteralPath $Path)) { return $Shown }
    $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    if (-not $text) { return $Shown }
    $text = [string]$text
    if ($text.Length -le $Shown) { return $Shown }
    Write-Error -Message $text.Substring($Shown) -ErrorAction Continue
    return $text.Length
}

function Invoke-Native([string]$FilePath, [string[]]$ArgumentList, [int]$TimeoutSeconds = $script:COMMAND_TIMEOUT_SECONDS, [string]$StandardInput, [switch]$ShowOutput) {
    if (-not (Test-Path -LiteralPath $script:DATA_DIR)) {
        New-Item -ItemType Directory -Path $script:DATA_DIR -Force | Out-Null
    }
    Get-ChildItem -LiteralPath $script:DATA_DIR -File -Filter ".native-*.txt" -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.Name -match '^\.native-(?:in|out|err)-(\d+)-' -and (([int]$Matches[1] -eq $PID) -or -not (Get-Process -Id ([int]$Matches[1]) -ErrorAction SilentlyContinue))) {
            Remove-AuditPathQuietly $_.FullName
        }
    }
    $outFile = Join-Path $script:DATA_DIR (".native-out-" + $PID + "-" + (Get-Random) + ".txt")
    $errFile = Join-Path $script:DATA_DIR (".native-err-" + $PID + "-" + (Get-Random) + ".txt")
    $inFile = $null
    $quoted = @()
    foreach ($arg in $ArgumentList) {
        $value = [string]$arg
        if (-not $value) {
            $quoted += '""'
            continue
        }
        if ($value -notmatch '[\s"]') {
            $quoted += $value
            continue
        }
        $one = '"'
        $slashes = 0
        foreach ($ch in $value.ToCharArray()) {
            if ($ch -eq "\") {
                $slashes++
            } elseif ($ch -eq '"') {
                $one += ("\" * ($slashes * 2 + 1)) + '"'
                $slashes = 0
            } else {
                if ($slashes -gt 0) { $one += "\" * $slashes; $slashes = 0 }
                $one += $ch
            }
        }
        if ($slashes -gt 0) { $one += "\" * ($slashes * 2) }
        $quoted += $one + '"'
    }
    $rc = 1
    $stdout = ""
    $stderr = ""
    $shownOut = 0
    $shownErr = 0
    try {
        if ($PSBoundParameters.Keys -contains "StandardInput") {
            $inFile = Join-Path $script:DATA_DIR (".native-in-" + $PID + "-" + (Get-Random) + ".txt")
            Write-Utf8NoBom $inFile $StandardInput
            $process = Start-Process -FilePath $FilePath -ArgumentList ($quoted -join " ") -WindowStyle Hidden -PassThru -RedirectStandardInput $inFile -RedirectStandardOutput $outFile -RedirectStandardError $errFile
        } else {
            $process = Start-Process -FilePath $FilePath -ArgumentList ($quoted -join " ") -WindowStyle Hidden -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
        }
        $null = $process.Handle
        $remaining = $TimeoutSeconds * 5
        $alive = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
        while ($alive -and $remaining -gt 0) {
            if ($ShowOutput) {
                $shownOut = Write-NativeGrowth $outFile $shownOut
                $shownErr = Write-NativeGrowth $errFile $shownErr
            }
            Start-Sleep -Milliseconds 200
            $remaining--
            $alive = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
        }
        if ($ShowOutput) {
            $shownOut = Write-NativeGrowth $outFile $shownOut
            $shownErr = Write-NativeGrowth $errFile $shownErr
        }
        if ($alive) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            Wait-Process -Id $process.Id -Timeout 5 -ErrorAction SilentlyContinue
            $rc = 124
            $stderr = "Command timed out (" + $TimeoutSeconds + " seconds)"
        } else {
            $exitCode = $process.ExitCode
            $rc = if ($null -eq $exitCode) { 1 } else { [int]$exitCode }
        }
        if (Test-Path -LiteralPath $outFile) {
            $stdout = Get-Content -Raw -Encoding UTF8 -LiteralPath $outFile
        }
        if ($rc -ne 124 -and (Test-Path -LiteralPath $errFile)) {
            $stderr = Get-Content -Raw -Encoding UTF8 -LiteralPath $errFile
        }
    } catch {
        $rc = 1
        $stderr = [string]$_
    } finally {
        Remove-AuditPathQuietly $inFile
        Remove-AuditPathQuietly $outFile
        Remove-AuditPathQuietly $errFile
    }
    if ($null -eq $stdout) { $stdout = "" }
    if ($null -eq $stderr) { $stderr = "" }
    return @{ Rc = $rc; Stdout = [string]$stdout; Stderr = [string]$stderr }
}

function Invoke-DownloadFile([string]$Url, [string]$Destination, [int]$TimeoutSeconds = $script:LONG_OPERATION_TIMEOUT_SECONDS) {
    $ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    if (-not (Test-Path -LiteralPath $ps)) { $ps = "powershell.exe" }
    $urlLiteral = "'" + $Url.Replace("'", "''") + "'"
    $destinationLiteral = "'" + $Destination.Replace("'", "''") + "'"
    $download = '$ErrorActionPreference=''Stop''; try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12 } catch {}; Invoke-WebRequest -Uri ' + $urlLiteral + ' -OutFile ' + $destinationLiteral + ' -UseBasicParsing -TimeoutSec ' + $TimeoutSeconds
    $ran = Invoke-Native $ps @("-NoProfile", "-Command", $download) $TimeoutSeconds
    if ($ran.Rc -ne 0) {
        $detail = $ran.Stderr.Trim()
        if (-not $detail) { $detail = $ran.Stdout.Trim() }
        throw $detail
    }
}
