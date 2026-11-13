# Windows auth entry. Same flags and stdout lines as scripts/ensure_oauth.py.
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\aliyun.ps1")

# Unfinished browser login is rolled back when this limit is reached.
$script:OAUTH_WAIT_SECONDS = 600

function Quote-PsArgument([string]$Value) {
    return "'" + $Value.Replace("'", "''") + "'"
}

function Show-AkGuide([string]$Profile) {
    $hint = Get-AliyunCommandHint
    $command = "& " + (Quote-PsArgument $hint) + " configure --mode AK --profile " + (Quote-PsArgument $Profile) + " --config-path " + (Quote-PsArgument (Get-AliyunConfigPath))
    Write-Error ("AK is not configured. Ask the user to run this command in a local terminal and fill in the prompts.`n" + $command + "`nDo not run it for them, and do not ask them to paste the AccessKey into the chat. After they confirm it is configured, retry the original Skill auth entry with --auth-mode AK.") -ErrorAction Continue
    exit 1
}

function Resolve-Identity([string]$Profile, [string]$AuthMode, [string]$SiteType) {
    $summaries = @(Get-ProfileSummaries)
    $named = $null
    foreach ($item in $summaries) {
        if ($item.name -eq $Profile) { $named = $item; break }
    }
    $ready = $null
    if ($named -and (Test-ProfileUsable $named)) { $ready = $named }
    $modeMatches = $ready -and ((-not $AuthMode) -or $ready.mode -eq $AuthMode)
    $siteMatches = ($AuthMode -eq "AK") -or (-not $SiteType) -or ($ready -and $ready.mode -eq "OAuth" -and $ready.oauth_site_type -eq $SiteType)
    if ($modeMatches -and $siteMatches) { return $Profile }
    # Default is browser OAuth. Ask for AK only when the caller asked for it.
    if ($AuthMode -eq "AK") { Show-AkGuide $Profile }
    return ""
}

function Write-AliyunConfig($Data, [object[]]$Profiles) {
    # Windows PowerShell 5.1 ConvertTo-Json turns a one-item array into an object.
    # Aliyun CLI requires profiles to stay an array, so the array is written by hand.
    $fields = @()
    foreach ($name in (Get-JsonPropertyNames $Data)) {
        if ($name -eq "profiles") { continue }
        $value = $Data.$name
        if ($value -is [array]) { $encoded = Format-JsonArray $value }
        else { $encoded = Format-JsonValue $value }
        $fields += ('  "' + (Escape-JsonString $name) + '": ' + $encoded)
    }
    $fields += ('  "profiles": ' + (Format-JsonArray $Profiles))
    Write-Utf8NoBom (Get-AliyunConfigPath) ("{`n" + ($fields -join ",`n") + "`n}`n")
}

function Set-OAuthProfile([string]$Name, [string]$Site) {
    $path = Get-AliyunConfigPath
    if (-not (Test-Path -LiteralPath $path)) {
        $json = "{`n  `"current`": `"" + (Escape-JsonString $Name) + "`",`n  `"profiles`": [`n    {`n      `"name`": `"" + (Escape-JsonString $Name) + "`",`n      `"mode`": `"OAuth`",`n      `"oauth_site_type`": `"" + (Escape-JsonString $Site) + "`"`n    }`n  ]`n}`n"
        Write-Utf8NoBom $path $json
        return @{ FileExisted = $false; BackupText = "" }
    }
    $backupText = Read-Utf8Text $path
    try {
        $data = $backupText | ConvertFrom-Json
    } catch {
        Fail ("Cannot read " + $path + " (" + $_ + "). The file was not changed.")
    }
    if (-not $data) { Fail ("Cannot read " + $path + ": the content is not a JSON object. The file was not changed.") }
    $hadCurrent = [bool]([string]$data.current)
    if (-not $hadCurrent) {
        $data | Add-Member -NotePropertyName current -NotePropertyValue $Name -Force
    }
    $profiles = @()
    if ($data.profiles) { $profiles = @($data.profiles) }
    $next = @()
    $found = $false
    foreach ($item in $profiles) {
        if ([string]$item.name -eq $Name) {
            $found = $true
            $item | Add-Member -NotePropertyName mode -NotePropertyValue "OAuth" -Force
            $item | Add-Member -NotePropertyName oauth_site_type -NotePropertyValue $Site -Force
            $next += ($item | Select-Object -Property * -ExcludeProperty region_id, language)
        } else {
            $next += $item
        }
    }
    if (-not $found) {
        $stubJson = '{"name":"' + (Escape-JsonString $Name) + '","mode":"OAuth","oauth_site_type":"' + (Escape-JsonString $Site) + '"}'
        $next += ($stubJson | ConvertFrom-Json)
    }
    Write-AliyunConfig $data $next
    return @{ FileExisted = $true; BackupText = $backupText }
}

function Restore-OAuthConfig($Seed) {
    $path = Get-AliyunConfigPath
    if (-not $Seed.FileExisted) {
        Remove-Item -LiteralPath (Get-AuditLongPath $path) -Force -ErrorAction SilentlyContinue
        return
    }
    Write-Utf8NoBom $path ([string]$Seed.BackupText)
}

function Start-OAuth([string]$Binary, [string]$Profile, [string]$SiteType) {
    if (-not $SiteType) { $SiteType = "CN" }
    $seed = Set-OAuthProfile $Profile $SiteType
    Write-Host ("Opening a browser to authorize Aliyun. Site: " + $SiteType + ", profile: " + $Profile + ". For the international site, retry with --oauth-site-type INTL.")
    Write-Host ("Authorization waits up to " + $script:OAUTH_WAIT_SECONDS + " seconds. If it does not finish, this profile is removed.")
    # Site is already in the profile. Two blank lines skip the region and language prompts.
    $rc = 1
    try {
        $ran = Invoke-Native $Binary @(
            "configure", "--mode", "OAuth", "--profile", $Profile, "--config-path", (Get-AliyunConfigPath)
        ) $script:OAUTH_WAIT_SECONDS "`n`n" -ShowOutput
        $rc = $ran.Rc
    } finally {
        if ($rc -ne 0) {
            try {
                Restore-OAuthConfig $seed
            } catch {
                Write-Error ("Failed to restore the original profile: " + [string]$_ + ".") -ErrorAction Continue
            }
        }
    }
    if ($rc -ne 0) {
        $hint = Get-AliyunCommandHint
        $command = "& " + (Quote-PsArgument $hint) + " configure --mode AK --profile " + (Quote-PsArgument $Profile) + " --config-path " + (Quote-PsArgument (Get-AliyunConfigPath))
        Write-Error ("OAuth login did not finish. For the international site, retry with --oauth-site-type INTL. To use an AccessKey instead, run " + $command + " and then auth --auth-mode AK.") -ErrorAction Continue
        exit $rc
    }
}

$parsed = Get-CliMap $args @("profile", "oauth-site-type", "auth-mode") @()
$profile = Get-CliValue $parsed "profile"
if (-not $profile) {
    if ($env:LOONGSUITE_PILOT_ALIYUN_PROFILE) { $profile = $env:LOONGSUITE_PILOT_ALIYUN_PROFILE } else { $profile = "loongsuite-pilot" }
}
$siteType = Get-CliValue $parsed "oauth-site-type"
$authMode = Get-CliValue $parsed "auth-mode"
if ($siteType -and $siteType -ne "CN" -and $siteType -ne "INTL") { Fail "Invalid oauth-site-type" }
if ($authMode -and $authMode -ne "OAuth" -and $authMode -ne "AK") { Fail "Auth mode must be OAuth or AK" }
$binary = Resolve-AliyunCli
$existing = Resolve-Identity $profile $authMode $siteType
if (-not $existing) {
    Start-OAuth $binary $profile $siteType
    $existing = $profile
}
Save-AuditProfile $existing
Write-Output ("oauth_profile=" + $existing)
