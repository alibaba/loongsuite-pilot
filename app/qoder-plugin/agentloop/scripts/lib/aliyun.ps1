# Aliyun CLI helpers. Same calls, retries, and API key name as util/aliyun.py.
if (-not $script:PilotAuditLibLoaded) {
    . (Join-Path $PSScriptRoot "config-record.ps1")
}

$script:ALIYUN_PLUGINS = Join-Path $script:ALIYUN_HOME "plugins"
$env:ALIBABA_CLOUD_CLI_PLUGINS_DIR = $script:ALIYUN_PLUGINS
$script:CMS_VERSION = "2024-03-30"
$script:SLS_VERSION = "2020-12-30"
$script:API_KEY_NAME = "loongsuite-pilot-log"
$script:OBSERVABILITY_RETRIES = 5

function Explain-ApiError([string]$Detail) {
    $lowered = $Detail.ToLower()
    $markers = @("forbidden", "nopermission", "no permission", "not authorized", "unauthorized", "invalidaction", "accessdenied")
    foreach ($marker in $markers) {
        if ($lowered.Contains($marker)) {
            return $Detail + "`nOAuth login finished, but the official-cli scope or this user's RAM permission does not include this API."
        }
    }
    return $Detail
}

function Get-AliyunCommandHint {
    if ($script:ResolvedAliyunCli -and (Test-Path -LiteralPath $script:ResolvedAliyunCli)) {
        return $script:ResolvedAliyunCli
    }
    return $script:ALIYUN_BIN
}

function Install-AliyunCli {
    Write-Host "Downloading Aliyun CLI ..."
    $url = "https://aliyuncli.alicdn.com/aliyun-cli-windows-latest-amd64.zip"
    $stage = Join-Path (Get-AsciiTempRoot) ("aliyun-cli-" + $PID + "-" + (Get-Random))
    $destTmp = ""
    try {
        New-Item -ItemType Directory -Path $stage -Force | Out-Null
        $zip = Join-Path $stage "aliyun-cli.zip"
        try {
            Invoke-DownloadFile $url $zip
        } catch {
            $detail = ([string]$_).Trim()
            if ($detail) {
                Fail ("Aliyun CLI download failed: " + $detail + ". Download " + $url + " and place aliyun.exe at " + $script:ALIYUN_BIN)
            }
            Fail ("Aliyun CLI download failed. Download " + $url + " and place aliyun.exe at " + $script:ALIYUN_BIN)
        }
        if (-not (Expand-ZipArchive $zip $stage)) { Fail "Failed to unzip the Aliyun CLI" }
        $exe = Get-ChildItem -Path $stage -Recurse -Filter aliyun.exe -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $exe) { Fail "The package does not contain aliyun.exe" }
        $destDir = Split-Path -Parent $script:ALIYUN_BIN
        if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
        $dest = $script:ALIYUN_BIN
        $destTmp = Join-Path $destDir (".aliyun-" + $PID + "-" + (Get-Random) + ".exe")
        Copy-Item -LiteralPath $exe.FullName -Destination $destTmp -Force
        Move-Item -LiteralPath (Get-AuditLongPath $destTmp) -Destination $dest -Force
        $destTmp = ""
        return $dest
    } finally {
        Remove-AuditPathQuietly $destTmp
        Remove-AuditPathQuietly $stage
    }
}

function Test-AliyunVersion([string]$Binary) {
    $ran = Invoke-Native $Binary @("version")
    if ($ran.Rc -ne 0) {
        $script:AliyunVersionRaw = ""
        return $false
    }
    $line = ""
    foreach ($row in ($ran.Stdout -split "`r?`n")) {
        if ($row.Trim()) { $line = $row; break }
    }
    $raw = $line.Replace(" ", "")
    $parts = @()
    $pieces = @($raw -split '\.')
    $limit = $pieces.Count
    if ($limit -gt 3) { $limit = 3 }
    for ($i = 0; $i -lt $limit; $i++) {
        $digits = ""
        foreach ($ch in $pieces[$i].ToCharArray()) {
            if ($ch -notmatch '\d') { break }
            $digits += $ch
        }
        if (-not $digits) { $digits = "0" }
        $parts += [int]$digits
    }
    while ($parts.Count -lt 3) { $parts += 0 }
    $script:AliyunVersionRaw = $raw
    $below = $parts[0] -lt 3 -or ($parts[0] -eq 3 -and $parts[1] -lt 3)
    return -not $below
}

function Install-AgentLoopPlugin([string]$Binary) {
    $manifest = Join-Path $script:ALIYUN_PLUGINS "manifest.json"
    if (Test-Path -LiteralPath $manifest) {
        $text = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
        if ($text -and ($text -match "aliyun-cli-agentloop")) { return }
    }
    Write-Host "Downloading AgentLoop CLI plugin ..."
    $ran = Invoke-Native $Binary @("plugin", "install", "--name", "agentloop") $script:LONG_OPERATION_TIMEOUT_SECONDS
    if ($ran.Rc -ne 0) {
        $detail = $ran.Stderr.Trim()
        if (-not $detail) { $detail = $ran.Stdout.Trim() }
        Fail ("AgentLoop CLI plugin download failed: " + $(if ($detail) { $detail } else { "unknown error" }))
    }
}

function Resolve-AliyunCli {
    if ($script:ResolvedAliyunCli -and (Test-Path -LiteralPath $script:ResolvedAliyunCli)) {
        Install-AgentLoopPlugin $script:ResolvedAliyunCli
        return $script:ResolvedAliyunCli
    }
    if ((Test-Path -LiteralPath $script:ALIYUN_BIN) -and (Test-AliyunVersion $script:ALIYUN_BIN)) {
        $script:ResolvedAliyunCli = $script:ALIYUN_BIN
        Install-AgentLoopPlugin $script:ALIYUN_BIN
        return $script:ALIYUN_BIN
    }
    $installed = Install-AliyunCli
    if (-not (Test-AliyunVersion $installed)) {
        $shown = $script:AliyunVersionRaw
        if (-not $shown) { $shown = "unknown" }
        Fail ("aliyun version " + $shown + " is older than 3.3.0")
    }
    $script:ResolvedAliyunCli = $installed
    Install-AgentLoopPlugin $installed
    return $installed
}

function Invoke-AliyunApi([string]$Profile, [string]$Region, [string[]]$CliArgs) {
    $exe = Resolve-AliyunCli
    $all = @() + $CliArgs + @("--profile", $Profile, "--config-path", (Get-AliyunConfigPath))
    if ($Region) { $all += @("--region", $Region) }
    $ran = Invoke-Native $exe $all
    if ($ran.Rc -ne 0) {
        $detail = $ran.Stderr.Trim()
        if (-not $detail) { $detail = $ran.Stdout.Trim() }
        if (-not $detail) { $detail = "aliyun call failed" }
        return @{ Data = $null; Err = (Explain-ApiError $detail) }
    }
    $text = $ran.Stdout.Trim()
    if (-not $text) { return @{ Data = @{}; Err = "" } }
    try {
        $data = $text | ConvertFrom-Json
        if ($text.StartsWith("[")) { $data = @($data) }
        return @{ Data = $data; Err = "" }
    } catch {
        return @{ Data = $null; Err = $text }
    }
}

function Get-AliyunPage([string]$Profile, [string]$Region, [string[]]$BaseArgs, [string]$ListKey) {
    $items = @()
    $token = ""
    $seen = @()
    while ($seen.Count -lt 20) {
        $pageArgs = @() + $BaseArgs
        if ($token) {
            if ($seen -contains $token) { break }
            $seen += $token
            $pageArgs += @("--next-token", $token)
        }
        $res = Invoke-AliyunApi $Profile $Region $pageArgs
        if ($null -eq $res.Data) { return @{ Items = $null; Err = $res.Err } }
        $batch = $res.Data.$ListKey
        if ($null -eq $batch) {
            $batch = @()
        } elseif ($batch -isnot [array]) {
            $batch = @($batch)
        }
        foreach ($one in $batch) { $items += $one }
        $token = [string]$res.Data.nextToken
        if (-not $token) { break }
    }
    return @{ Items = $items; Err = "" }
}

function Get-RegionIds([string]$Profile) {
    $page = Get-AliyunPage $Profile "cn-hangzhou" @("agentloop", "describe-regions", "--language", "zh", "--biz-language", "zh", "--max-results", "50") "regions"
    if ($null -eq $page.Items) { Fail $page.Err }
    $ids = @()
    foreach ($item in $page.Items) {
        $regionId = [string]$item.regionId
        if ($regionId) { $ids += $regionId }
    }
    if ($ids.Count -eq 0) { Fail "describe-regions returned no regions" }
    return $ids
}

function Get-AgentSpaces([string]$Profile, [string]$Region) {
    if ($Region) { $regionIds = @($Region) } else { $regionIds = @(Get-RegionIds $Profile) }
    $found = @()
    $seen = @()
    $errors = @()
    foreach ($regionId in $regionIds) {
        $page = Get-AliyunPage $Profile $regionId @("agentloop", "list-agent-spaces", "--max-results", "50") "agentSpaces"
        if ($null -eq $page.Items) {
            if ($page.Err -and $page.Err.Contains("RAM permission")) { Fail $page.Err }
            $errors += $page.Err
            continue
        }
        foreach ($item in $page.Items) {
            $name = [string]$item.agentSpace
            if (-not $name) { continue }
            $itemRegion = [string]$item.regionId
            if (-not $itemRegion) { $itemRegion = $regionId }
            $key = $name + "|" + $itemRegion
            if ($seen -contains $key) { continue }
            $seen += $key
            $found += @{ agentSpace = $name; regionId = $itemRegion; slsProject = [string]$item.slsProject; cmsWorkspace = [string]$item.cmsWorkspace }
        }
    }
    $script:AgentSpaceListErrors = @($errors)
    if ($found.Count -eq 0 -and $script:AgentSpaceListErrors.Count -gt 0) { Fail $script:AgentSpaceListErrors[0] }
    return $found
}

function Select-AgentSpace($Spaces, [string]$Region) {
    $previous = Get-SavedSpace
    $previousName = [string]$previous[0]
    $previousRegion = [string]$previous[1]
    if (-not (Test-Interactive)) {
        if ($previousName) {
            Write-Output ("previous " + $previousName + " " + $previousRegion)
        }
        foreach ($item in $Spaces) {
            $regionId = [string]$item.regionId
            if (-not $regionId) { $regionId = $Region }
            Write-Output ([string]$item.agentSpace + " " + $regionId)
        }
        exit $script:EXIT_CHOOSE_AGENT_SPACE
    }
    if (@($Spaces).Count -gt 1) {
        Write-Host "Multiple AgentSpaces found. Enter a number:"
    } else {
        Write-Host "One AgentSpace found. Enter 1 to confirm."
    }
    if ($previousName) { Write-Host ("Previous choice " + $previousName + " " + $previousRegion) }
    $index = 1
    foreach ($item in $Spaces) {
        $regionId = [string]$item.regionId
        if (-not $regionId) { $regionId = $Region }
        Write-Host ($index.ToString() + ". " + [string]$item.agentSpace + " " + $regionId)
        $index++
    }
    $line = (Read-Host ">").Trim()
    if ($line -notmatch '^\d+$') { Fail "Invalid AgentSpace number" }
    $picked = [int]$line
    if ($picked -lt 1 -or $picked -gt $Spaces.Count) { Fail "Invalid AgentSpace number" }
    return $Spaces[$picked - 1]
}

function Get-AgentSpace([string]$Profile, [string]$AgentSpace, [string]$Region) {
    if ($AgentSpace) {
        if (-not $Region) { Fail "Pass --region. Choosing an AgentSpace requires its region. Do not use a default region." }
        $res = Invoke-AliyunApi $Profile $Region @("agentloop", "get-agent-space", "--agent-space", $AgentSpace)
        if ($null -eq $res.Data) { Fail $res.Err }
        if (-not [string]$res.Data.agentSpace) { Fail "get-agent-space did not return agentSpace" }
        return @{
            agentSpace = [string]$res.Data.agentSpace
            regionId = $(if ([string]$res.Data.regionId) { [string]$res.Data.regionId } else { $Region })
            slsProject = [string]$res.Data.slsProject
            cmsWorkspace = [string]$res.Data.cmsWorkspace
        }
    }
    $script:AgentSpaceListErrors = @()
    $spaces = @(Get-AgentSpaces $Profile $Region)
    if ($spaces.Count -eq 0) { Fail "No AgentSpace found" }
    # A failed region may hide the user's real space. Do not keep the only survivor.
    $listErrors = @($script:AgentSpaceListErrors)
    if ($listErrors.Count -gt 0 -or $spaces.Count -gt 1) {
        foreach ($err in $listErrors) {
            if ($err) { Write-Error $err -ErrorAction Continue }
        }
        return (Select-AgentSpace $spaces $Region)
    }
    return $spaces[0]
}

function Get-Observability([string]$Profile, [string]$Region, [string]$Workspace) {
    $path = "/workspace/" + $Workspace + "/service-observability/apm"
    $getArgs = @("cms", "GET", $path, "--version", $script:CMS_VERSION, "--force")
    $res = Invoke-AliyunApi $Profile $Region $getArgs
    $info = $null
    if ($res.Data) { $info = $res.Data.entryPointInfo }
    if ($info -and [string]$info.authToken) { return $info }
    $created = Invoke-AliyunApi $Profile $Region @("cms", "POST", $path, "--version", $script:CMS_VERSION, "--force")
    if ($null -eq $created.Data -and $null -eq $res.Data) {
        if ($created.Err) { Fail $created.Err } else { Fail $res.Err }
    }
    for ($i = 0; $i -lt $script:OBSERVABILITY_RETRIES; $i++) {
        Start-Sleep -Seconds 2
        $res = Invoke-AliyunApi $Profile $Region $getArgs
        $info = $null
        if ($res.Data) { $info = $res.Data.entryPointInfo }
        if ($info -and [string]$info.authToken) { return $info }
    }
    if ($res.Err) { Fail $res.Err } else { Fail "GetServiceObservability has not returned authToken" }
}

function Get-PilotApiKey([string]$Profile, [string]$Region, [string]$Project) {
    $getArgs = @("sls", "GetApiKey", "--project", $Project, "--apiKeyName", $script:API_KEY_NAME)
    $res = Invoke-AliyunApi $Profile $Region $getArgs
    if ($res.Data -and [string]$res.Data.apiKey) {
        return [string]$res.Data.apiKey
    }
    if ($null -eq $res.Data -and $res.Err -notlike "*ApiKeyNotExist*") { Fail $res.Err }
    $body = '{"apiKeyName":"loongsuite-pilot-log","description":"loongsuite-pilot log ingestion","allowedStores":["' + (Escape-JsonString $script:DEFAULT_LOGSTORE) + '"]}'
    $created = Invoke-AliyunApi $Profile $Region @("sls", "CreateApiKey", "--project", $Project, "--body", $body)
    if ($null -eq $created.Data) { Fail $created.Err }
    $res = Invoke-AliyunApi $Profile $Region $getArgs
    if ($res.Data -and [string]$res.Data.apiKey) { return [string]$res.Data.apiKey }
    if ($res.Err) { Fail $res.Err } else { Fail "CreateApiKey did not return the secret" }
}

function Get-PilotLogs([string]$Profile, $Context, [string]$Query, [long]$Start, [long]$End, [long]$Line, [long]$Offset) {
    $region = [string]$Context.regionId
    if (-not $region -and $Context.Keys -contains "regionId") { $region = [string]$Context["regionId"] }
    $project = [string]$Context.slsProject
    if (-not $project -and $Context.Keys -contains "slsProject") { $project = [string]$Context["slsProject"] }
    $logstore = [string]$Context.slsLogstore
    if (-not $logstore -and $Context.Keys -contains "slsLogstore") { $logstore = [string]$Context["slsLogstore"] }
    $body = '{"from":' + $Start + ',"to":' + $End + ',"query":"' + (Escape-JsonString $Query) + '","line":' + $Line + ',"offset":' + $Offset + ',"reverse":true}'
    $res = Invoke-AliyunApi $Profile $region @(
        "sls", "GetLogsV2",
        "--version", $script:SLS_VERSION,
        "--project", $project,
        "--logstore", $logstore,
        "--body", $body
    )
    if ($null -eq $res.Data) { Fail $res.Err }
    $logs = $res.Data.data
    if ($null -eq $logs) {
        $logs = @()
    } elseif ($logs -isnot [array]) {
        $logs = @($logs)
    }
    return (ConvertTo-JsonObject $res.Data "data" $logs 100)
}
