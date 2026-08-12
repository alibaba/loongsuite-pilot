# installer.ps1 -- Unified installer for loongsuite-pilot (Windows)
#
# Install (first time):
#   irm <URL>/installer.ps1 | iex
#   .\installer.ps1 install `
#     -SlsEndpoint "https://cn-hangzhou.log.aliyuncs.com" `
#     -SlsProject "my-project" `
#     -SlsLogstore "my-logstore" `
#     -SlsAkId "your-ak-id" `
#     -SlsAkSecret "your-ak-secret"
#   .\installer.ps1 install -MaskMode all
#   .\installer.ps1 install -MaskMode custom -MaskTypes "cloudAccessKey,apiKey"
#
# Install from test channel:
#   .\installer.ps1 install -Channel test
#
# Upgrade (preserve config, auto-rollback on failure):
#   .\installer.ps1 upgrade
#   .\installer.ps1 upgrade -PackageUrl <url>
#
# Uninstall:
#   .\installer.ps1 uninstall
#   .\installer.ps1 uninstall -Purge
#
# ============================================================
# MANDATORY: every line of this file must run under Constrained Language Mode (CLM)
# ============================================================
# On a machine with a WDAC / AppLocker application-control policy, any script the
# policy does not allow runs in ConstrainedLanguage mode (see about_Language_Modes).
# In that mode only types on the "allowed types" list may be cast to, have their
# properties read, or have their methods invoked; static member access and method
# calls on any other .NET type throw. This file sets $ErrorActionPreference =
# "Stop", so an unguarded call becomes a terminating error -- the install aborts on
# a locked-down machine instead of taking the designed fallback path. Any change
# to this file must follow:
#
#   1) Do not use .NET types that are off the list. Common traps -> CLM-safe form:
#        [System.IO.Path]::GetTempPath()        -> $env:TEMP (see Get-PilotTempRoot)
#        [System.IO.Path]::GetFileName()        -> Split-Path -Leaf
#        [System.IO.File]::ReadAllText/WriteAll -> Get-Content / Set-Content
#        [Environment]::UserName                -> $env:USERNAME
#        [Environment]::SetEnvironmentVariable  -> Set-ItemProperty HKCU:\Environment
#        [Convert] / [Math] / [Console] / [Net.*] -> none are on the list; with no
#                                                  substitute, follow rule 2
#        New-Object / Add-Type / Invoke-Expression / class / enum / [ref] -> never
#   2) Where there is genuinely no substitute and failure can degrade, wrap the
#      whole thing in try { ... } catch { ... } and return a CLM-safe default from
#      the catch. The three legal exceptions already in this file: Test-Interactive, the TLS1.2 bump
#      (Download-AndExtract), and the PATH-change broadcast (Install-Command).
#      Any new exception must state its fallback semantics.
#   3) Safe to use: [string] [int] [bool] [double] [switch] [array] [hashtable]
#      [regex] [datetime] [timespan] [version] [uri] [xml]. Model structured data
#      as [hashtable], never as the "accelerator + @{} literal" shape --
#      [pscustomobject] and [ordered] are both banned here (rule 4 explains why).
#   4) WARNING: the allowed-types list in about_Language_Modes is NOT the real
#      CoreTypes whitelist of Windows PowerShell 5.1, so never treat it as the only
#      source of truth. Learned the hard way: the docs list [pscustomobject] as an
#      allowed type, yet on 5.1 under WDAC/CLM, [pscustomobject]@{...} throws
#      ConversionSupportedOnlyToCoreTypes -- the accelerator's real conversion
#      target is the internal type LanguagePrimitives+InternalPSCustomObject, which
#      is not in 5.1's CoreTypes. Lesson: an accelerator can point at an internal
#      type that is off the list. Before introducing any new type from the list,
#      run it for real in a 5.1 session with
#      $ExecutionContext.SessionState.LanguageMode = "ConstrainedLanguage"; and
#      whatever can be expressed with automatic variables / cmdlets / language
#      operators should not introduce a type at all. For the same reason every
#      [ordered]@{...} was downgraded to @{...}: the docs allow it under "Special
#      cases" (while forbidding calls to its methods), but that is the same
#      accelerator-converts-an-@{}-literal shape the docs already got wrong once
#      for [pscustomobject]. $cfgArgs here is only ConvertTo-Json'd and read back
#      by key name in node, so key order changes no behaviour -- keeping [ordered]
#      buys nothing, and losing the bet means crashing in Write-Config, i.e. after
#      deployment already happened. Any type dependency of that shape -- zero
#      upside, non-zero risk -- gets deleted.
#
# Full list: https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_language_modes
# Self-check: after editing, run
#   grep -nE '\[[A-Za-z_][A-Za-z0-9_.]*\]::|New-Object|Add-Type'
# and confirm every hit is inside a try block with a working fallback.

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("install", "upgrade", "uninstall")]
    [string]$Command = "install",

    [string]$SlsEndpoint,
    [string]$SlsProject,
    [string]$SlsLogstore,
    [string]$SlsAkId,
    [string]$SlsAkSecret,
    [string]$PackageUrl,
    [string]$DataDir,
    [string]$LogLevel,
    [Alias("user.id")]
    [string]$UserId,
    [string]$Lang,
    [string]$Version,
    [string]$Channel,
    [string]$CollectLog,
    [string]$CollectTrace,
    [string]$CmsLicenseKey,
    [string]$CmsEndpoint,
    [string]$CmsWorkspace,
    [string]$ServiceNamePrefix,
    [string]$Agents,
    [switch]$AllAgents,
    [string]$MaskMode,
    [string]$MaskTypes,
    [switch]$Purge,
    [switch]$PreferSystemNode
)

$ErrorActionPreference = "Stop"

$script:SLS_REQUESTED = $PSBoundParameters.Keys -contains "SlsEndpoint" -or
    $PSBoundParameters.Keys -contains "SlsProject" -or
    $PSBoundParameters.Keys -contains "SlsLogstore" -or
    $PSBoundParameters.Keys -contains "SlsAkId" -or
    $PSBoundParameters.Keys -contains "SlsAkSecret"
$script:CMS_REQUESTED = $PSBoundParameters.Keys -contains "CmsLicenseKey" -or
    $PSBoundParameters.Keys -contains "CmsEndpoint" -or
    $PSBoundParameters.Keys -contains "CmsWorkspace"
$script:CMS_LICENSE_KEY_SET = $PSBoundParameters.Keys -contains "CmsLicenseKey"
$script:CMS_ENDPOINT_SET = $PSBoundParameters.Keys -contains "CmsEndpoint"
$script:CMS_WORKSPACE_SET = $PSBoundParameters.Keys -contains "CmsWorkspace"
$script:COLLECT_LOG_SET = $PSBoundParameters.Keys -contains "CollectLog"
$script:COLLECT_TRACE_SET = $PSBoundParameters.Keys -contains "CollectTrace"
$script:SERVICE_NAME_PREFIX_SET = $PSBoundParameters.Keys -contains "ServiceNamePrefix"
$script:PACKAGE_SELECTOR_EXPLICIT = $PSBoundParameters.Keys -contains "PackageUrl" -or
    $PSBoundParameters.Keys -contains "Version" -or
    $PSBoundParameters.Keys -contains "Channel"

# ============================================================
# Constants
# ============================================================
$PACKAGE_NAME = "loongsuite-pilot"
$DEFAULT_DATA_DIR = Join-Path $env:USERPROFILE ".loongsuite-pilot"
$PERMANENT_DIR = Join-Path $DEFAULT_DATA_DIR "package"

$_RELEASE_BASE_URL = "https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot"
$_TEST_BASE_URL = "https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot-dev"

# Managed Node.js runtime + prebuilt node_modules (downloaded from OSS at install time)
if ($env:LOONGSUITE_PILOT_NODE_VERSION) { $script:NODE_VERSION = $env:LOONGSUITE_PILOT_NODE_VERSION } else { $script:NODE_VERSION = "22.22.2" }
if ($env:LOONGSUITE_PILOT_NODE_DEPS_URL) { $script:NODE_DEPS_BASE = $env:LOONGSUITE_PILOT_NODE_DEPS_URL } else { $script:NODE_DEPS_BASE = "https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/deps/node" }
if ($env:LOONGSUITE_PILOT_NODE_MODULES_URL) { $script:NODE_MODULES_BASE = $env:LOONGSUITE_PILOT_NODE_MODULES_URL } else { $script:NODE_MODULES_BASE = "https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/deps/node-modules" }

# ============================================================
# Defaults
# ============================================================
if (-not $DataDir) { $DataDir = $DEFAULT_DATA_DIR }
if (-not $Channel) {
    $Channel = if ($env:LOONGSUITE_PILOT_CHANNEL) { $env:LOONGSUITE_PILOT_CHANNEL }
               elseif ($env:LOONGSUITE_PILOT_DEFAULT_CHANNEL) { $env:LOONGSUITE_PILOT_DEFAULT_CHANNEL }
               else { "release" }
}
if (-not $PackageUrl -and $env:LOONGSUITE_PILOT_PACKAGE_URL) {
    $PackageUrl = $env:LOONGSUITE_PILOT_PACKAGE_URL
}

# ============================================================
# Validate mask options
# ============================================================
if ($MaskMode) {
    if ($MaskMode -notin @("all", "none", "custom")) {
        Write-Error "Unknown mask mode: $MaskMode (use 'all', 'custom', or 'none')"
        exit 1
    }
}
if ($MaskMode -eq "custom" -and -not $MaskTypes) {
    Write-Error "--MaskTypes is required when -MaskMode custom"
    exit 1
}
if ($MaskTypes -and $MaskMode -ne "custom") {
    Write-Error "-MaskTypes can only be used with -MaskMode custom"
    exit 1
}

# ============================================================
# Resolve package URL from channel + version
# ============================================================
$UPDATE_PACKAGE_URL = ""
if (-not $PackageUrl) {
    $channelBase = switch -Regex ($Channel) {
        "^(release|prod)$" { $_RELEASE_BASE_URL }
        "^(test|pre)$"     { $_TEST_BASE_URL }
        "^test-[a-zA-Z0-9]+$" { "$_TEST_BASE_URL/$Channel" }
        default {
            Write-Error "Unknown channel: $Channel (use 'release' or 'test')"
            exit 1
        }
    }
    if ($Version) {
        $PackageUrl = "$channelBase/$Version/$PACKAGE_NAME.tar.gz"
    } else {
        $PackageUrl = "$channelBase/latest/$PACKAGE_NAME.tar.gz"
    }
    $UPDATE_PACKAGE_URL = "$channelBase/latest/$PACKAGE_NAME.tar.gz"
} else {
    $UPDATE_PACKAGE_URL = $PackageUrl
}

# ============================================================
# Language detection
# ============================================================
function Detect-Lang {
    if ($Lang) { return $Lang }
    if ($env:LOONGSUITE_PILOT_LANG) { return $env:LOONGSUITE_PILOT_LANG }
    # $PSUICulture is an automatic variable, so language detection needs no .NET member
    # access at all -- trivially safe under Constrained Language Mode (WDAC/AppLocker).
    if ($PSUICulture -match "zh") { return "zh" }
    return "en"
}

$LANG_MODE = Detect-Lang

function Msg {
    param([string]$zh, [string]$en)
    if ($LANG_MODE -eq "zh") { Write-Host $zh } else { Write-Host $en }
}

# ============================================================
# Interactive-terminal detection
# ============================================================
# [Environment]::UserInteractive on its own is not a reliable signal: inside a
# SessionStart hook or a detached background process it is still $true, and a plain
# powershell.exe host keeps $Host.UI.RawUI non-null even when stdin is redirected.
# Read-Host then returns $null (empty stdin / EOF), the following .Trim() throws
# InvokeMethodOnNull, and the overwrite prompt reads $null as "no", silently
# cancelling the reinstall. So "interactive" now means: a real interactive user AND
# neither stdin nor stdout redirected. The plugin-side ensure-pilot runs this
# installer with `*>> $LogFile`, i.e. stdout redirected -> non-interactive (the
# detached hidden window still owns a console, so checking stdin alone would hang on
# Read-Host). Under ConstrainedLanguage these .NET static calls throw -> catch ->
# non-interactive, which is the right default for locked-down and unattended hosts.
function Test-Interactive {
    try {
        if (-not [Environment]::UserInteractive) { return $false }
        if ([Console]::IsInputRedirected) { return $false }
        if ([Console]::IsOutputRedirected) { return $false }
        return $true
    } catch {
        return $false
    }
}

# ============================================================
# Node.js resolution
# ============================================================
function Test-NodeSuitable {
    param([string]$bin)
    if (-not (Test-Path $bin)) { return $false }
    try {
        $ver = & $bin --version 2>$null
        if (-not $ver) { return $false }
        $major = [int]($ver -replace '^v','').Split('.')[0]
        return $major -ge 18
    } catch { return $false }
}

function Resolve-Node {
    $candidates = @()

    # Existing installations pin the exact Node binary used for deployment.
    # Read it first so uninstall works even when no system node is on PATH
    # (e.g. installs that used the managed Node runtime).
    $pinFile = Join-Path $DataDir "node-bin"
    if (Test-Path -LiteralPath $pinFile) {
        $pinned = ([string](Get-Content -LiteralPath $pinFile -Raw -ErrorAction SilentlyContinue)).Trim()
        if ($pinned) { $candidates += $pinned }
    }

    # nvm-windows
    $nvmHome = $env:NVM_HOME
    if ($nvmHome -and (Test-Path $nvmHome)) {
        $nvmDirs = Get-ChildItem $nvmHome -Directory -ErrorAction SilentlyContinue |
                   Sort-Object Name -Descending
        foreach ($d in $nvmDirs) {
            $candidates += Join-Path $d.FullName "node.exe"
        }
    }

    # fnm
    $fnmDir = Join-Path $env:USERPROFILE ".fnm\node-versions"
    if (Test-Path $fnmDir) {
        $fnmDirs = Get-ChildItem $fnmDir -Directory -ErrorAction SilentlyContinue |
                   Sort-Object Name -Descending
        foreach ($d in $fnmDirs) {
            $candidates += Join-Path $d.FullName "installation\node.exe"
        }
    }

    # Volta
    $voltaNode = Join-Path $env:USERPROFILE ".volta\bin\node.exe"
    $candidates += $voltaNode

    # Common install paths
    $candidates += "C:\Program Files\nodejs\node.exe"
    $candidates += "C:\Program Files (x86)\nodejs\node.exe"

    # PATH lookup
    $pathNode = Get-Command node -ErrorAction SilentlyContinue
    if ($pathNode) { $candidates += $pathNode.Source }

    foreach ($c in $candidates) {
        if (Test-NodeSuitable $c) {
            return $c
        }
    }
    return $null
}

# >>> managed-node-runtime >>>
# Managed Node.js runtime + prebuilt node_modules, downloaded from OSS.
# Returns a bare [hashtable]; do NOT use [pscustomobject]@{...}. about_Language_Modes
# lists [pscustomobject] as an allowed type, but Windows PowerShell 5.1 under
# WDAC/CLM was observed to throw "Cannot convert value to type
# System.Management.Automation.LanguagePrimitives+InternalPSCustomObject. Only core
# types are supported in this language mode." (ConversionSupportedOnlyToCoreTypes):
# the accelerator's real conversion target is that internal type, which is not in
# 5.1's CoreTypes whitelist. A hashtable is a genuine core type, and $platform.Os /
# $platform.Arch read exactly the same way.
function Get-ManagedNodePlatform {
    $archRaw = $env:PROCESSOR_ARCHITEW6432
    if (-not $archRaw) { $archRaw = $env:PROCESSOR_ARCHITECTURE }
    switch ($archRaw) {
        "AMD64" { return @{ Os = "win"; Arch = "x64" } }
        "ARM64" {
            Msg "    ⚠️ 托管 Node.js 无 win-arm64 产物，回退系统 node + npm install" `
                "    ⚠️ No win-arm64 managed Node.js artifact, falling back to system node + npm install"
            return $null
        }
        default {
            Msg "    ⚠️ 托管 Node.js 不支持架构 $archRaw，回退系统 node + npm install" `
                "    ⚠️ Managed Node.js does not support arch $archRaw, falling back to system node + npm install"
            return $null
        }
    }
}

# CLM-safe temp root. [System.IO.Path]::GetTempPath() is a static call on an
# off-list type and throws under ConstrainedLanguage; both call sites used to sit
# outside their try block, so with $ErrorActionPreference = "Stop" it terminated
# Check-Deps / Install outright instead of falling back to system node + npm
# install. Reading environment variables always works under CLM, and
# Download-AndExtract already relied on $env:TEMP.
function Get-PilotTempRoot {
    if ($env:TEMP) { return $env:TEMP }
    if ($env:TMP) { return $env:TMP }
    if ($env:SystemRoot) { return (Join-Path $env:SystemRoot "Temp") }
    return "C:\Windows\Temp"
}

function Invoke-ManagedNodeDownload {
    param([string]$Url, [string]$Dest)
    try {
        $prevProgress = $ProgressPreference
        $ProgressPreference = "SilentlyContinue"
        Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing -TimeoutSec 600
        $ProgressPreference = $prevProgress
        return $true
    } catch {
        return $false
    }
}

function Test-ManagedNodeChecksum {
    param([string]$Archive, [string]$ShasumsFile, [string]$Name)
    try {
        $expected = $null
        # -split / -eq / -match are language operators and depend on no type
        # whitelist at all; the former [regex]::Escape() rested on exactly the doc
        # list that rule 4 in the header calls unreliable. This is also stricter
        # than the old regex: the filename is compared exactly, so metacharacters
        # such as . cannot widen the match.
        foreach ($line in (Get-Content $ShasumsFile)) {
            $fields = $line.Trim() -split '\s+'
            if ($fields.Count -ne 2) { continue }
            $hash = $fields[0]
            if ($fields[1].TrimStart('*') -ne $Name) { continue }
            if ($hash.Length -ne 64 -or $hash -notmatch '^[0-9a-fA-F]+$') { continue }
            $expected = $hash.ToLower()
            break
        }
        if (-not $expected) {
            Msg "    ❌ SHASUMS256.txt 中缺少 $Name 的校验和" "    ❌ SHASUMS256.txt has no entry for $Name"
            return $false
        }
        $actual = (Get-FileHash -Algorithm SHA256 -Path $Archive).Hash.ToLower()
        if ($actual -ne $expected) {
            Msg "    ❌ $Name sha256 校验失败 (expected $expected, got $actual)" "    ❌ sha256 mismatch for $Name (expected $expected, got $actual)"
            return $false
        }
        return $true
    } catch {
        return $false
    }
}

function Resolve-ManagedNodeBin {
    param([string]$NodeDir)
    # Prefer the bin/ layout; official Node.js win zips put node.exe at the root.
    $binLayout = Join-Path $NodeDir "bin\node.exe"
    if (Test-Path $binLayout) { return $binLayout }
    $officialLayout = Join-Path $NodeDir "node.exe"
    if (Test-Path $officialLayout) { return $officialLayout }
    return $null
}

function Ensure-ManagedNode {
    $platform = Get-ManagedNodePlatform
    if (-not $platform) { return $null }
    $runtimeDir = Join-Path $DataDir "runtime"
    $archive = "node-v$($script:NODE_VERSION)-$($platform.Os)-$($platform.Arch).zip"
    $nodeDir = Join-Path $runtimeDir "node-v$($script:NODE_VERSION)-$($platform.Os)-$($platform.Arch)"
    $nodeBin = Resolve-ManagedNodeBin $nodeDir

    if ($nodeBin) {
        try {
            $v = (& $nodeBin --version 2>$null)
            if ($v -eq "v$($script:NODE_VERSION)") { return $nodeBin }
        } catch { }
    }

    $base = $script:NODE_DEPS_BASE.TrimEnd('/') + "/$($script:NODE_VERSION)"
    # $PID + Get-Random instead of [guid]::NewGuid(): an automatic variable plus a
    # cmdlet, depending on no type whitelist (Download-AndExtract already does the
    # same). Per rule 4 in the header, the docs permitting a type is not sufficient
    # evidence for 5.1.
    $tmp = Join-Path (Get-PilotTempRoot) "pilot-managed-node-$PID-$(Get-Random)"
    try {
        # New-Item must stay inside the try: only then does an unwritable temp root
        # reach the catch, return $null and fall back to system node. Outside the
        # try, $ErrorActionPreference = "Stop" turns it into a terminating error
        # that aborts the install.
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        Msg "==> 下载托管 Node.js v$($script:NODE_VERSION) (win-x64)..." "==> Downloading managed Node.js v$($script:NODE_VERSION) (win-x64)..."
        $archivePath = Join-Path $tmp $archive
        $shasumsPath = Join-Path $tmp "SHASUMS256.txt"
        if (-not (Invoke-ManagedNodeDownload "$base/$archive" $archivePath)) { return $null }
        if (-not (Invoke-ManagedNodeDownload "$base/SHASUMS256.txt" $shasumsPath)) { return $null }
        if (-not (Test-ManagedNodeChecksum $archivePath $shasumsPath $archive)) { return $null }

        if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
        if (-not (Test-Path $runtimeDir)) { New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null }
        Expand-Archive -Path $archivePath -DestinationPath $runtimeDir -Force
        $nodeBin = Resolve-ManagedNodeBin $nodeDir
        if (-not $nodeBin) {
            Msg "    ❌ 解压产物中未找到 node.exe（bin\ 或根目录布局）" "    ❌ No node.exe found in extracted archive (bin\ or root layout)"
            Remove-Item $nodeDir -Recurse -Force -ErrorAction SilentlyContinue
            return $null
        }
        return $nodeBin
    } catch {
        Remove-Item $nodeDir -Recurse -Force -ErrorAction SilentlyContinue
        return $null
    } finally {
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Ensure-NodeModules {
    param([string]$AppVersion = "latest")
    $platform = Get-ManagedNodePlatform
    if (-not $platform) { return $false }

    $modulesDir = Join-Path $script:PERMANENT_DIR "node_modules"
    $marker = Join-Path $modulesDir ".pilot-modules-version"
    $stamp = "$AppVersion $($platform.Os) $($platform.Arch)"
    if ((Test-Path $modulesDir) -and (Test-Path $marker)) {
        $existing = (Get-Content $marker -ErrorAction SilentlyContinue | Out-String).Trim()
        if ($existing -eq $stamp) { return $true }
    }

    $archive = "node-modules-$($platform.Os)-$($platform.Arch).tar.gz"
    $base = $script:NODE_MODULES_BASE.TrimEnd('/') + "/$AppVersion"
    $tmp = Join-Path (Get-PilotTempRoot) "pilot-node-modules-$PID-$(Get-Random)"
    try {
        # New-Item must stay inside the try: this runs after Deploy-Package, so an
        # unwritable temp root amplified into a terminating error by
        # $ErrorActionPreference = "Stop" would leave the package deployed with no
        # dependencies. Inside the try, the catch returns $false and falls back to
        # npm install.
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        Msg "==> 下载预编译 node_modules (win-x64, app v$AppVersion)..." "==> Downloading prebuilt node_modules (win-x64, app v$AppVersion)..."
        $archivePath = Join-Path $tmp $archive
        $shasumsPath = Join-Path $tmp "SHASUMS256.txt"
        if (-not (Invoke-ManagedNodeDownload "$base/$archive" $archivePath)) { return $false }
        if (-not (Invoke-ManagedNodeDownload "$base/SHASUMS256.txt" $shasumsPath)) { return $false }
        if (-not (Test-ManagedNodeChecksum $archivePath $shasumsPath $archive)) { return $false }

        $tarCmd = Get-Command tar -ErrorAction SilentlyContinue
        if (-not $tarCmd) { return $false }
        $stage = Join-Path $tmp "stage"
        New-Item -ItemType Directory -Path $stage -Force | Out-Null
        & tar -xzf $archivePath -C $stage
        if ($LASTEXITCODE -ne 0) { return $false }
        $stagedModules = Join-Path $stage "node_modules"
        if (-not (Test-Path $stagedModules)) { return $false }

        Set-Content -Path (Join-Path $stagedModules ".pilot-modules-version") -Value $stamp
        if (Test-Path $modulesDir) { Remove-Item $modulesDir -Recurse -Force }
        Move-Item $stagedModules $modulesDir
        return $true
    } catch {
        return $false
    } finally {
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}
# <<< managed-node-runtime <<<

# ============================================================
# Check dependencies
# ============================================================
$script:NODE_BIN = ""
$script:NPM_BIN = ""

function Check-Deps {
    Msg "==> 检查依赖..." "==> Checking dependencies..."

    $script:NODE_BIN = ""
    if ($PreferSystemNode) {
        $script:NODE_BIN = Resolve-Node
        if (-not $script:NODE_BIN) { $script:NODE_BIN = Ensure-ManagedNode }
    } else {
        $script:NODE_BIN = Ensure-ManagedNode
        if (-not $script:NODE_BIN) {
            Msg "    ⚠️ 托管 Node.js 不可用（平台不支持或下载失败），回退系统 node" `
                "    ⚠️ Managed Node.js unavailable (unsupported platform or download failed), falling back to system node"
            $script:NODE_BIN = Resolve-Node
        }
    }
    if (-not $script:NODE_BIN) {
        Msg "❌ 缺少依赖: node，请先安装后重试" "❌ Missing dependency: node — please install it first"
        exit 1
    }

    $nodeMajor = & $script:NODE_BIN -e "process.stdout.write(String(process.versions.node.split('.')[0]))"
    if ([int]$nodeMajor -lt 18) {
        $nodeVer = & $script:NODE_BIN --version
        Msg "❌ 需要 Node.js >= 18，当前版本: $nodeVer" "❌ Requires Node.js >= 18, current: $nodeVer"
        exit 1
    }

    # Pin node binary path
    if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
    Set-Content -Path (Join-Path $DataDir "node-bin") -Value $script:NODE_BIN

    # Derive npm
    $npmPath = Join-Path (Split-Path $script:NODE_BIN) "npm.cmd"
    if (Test-Path $npmPath) {
        $script:NPM_BIN = $npmPath
    } else {
        $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
        if ($npmCmd) {
            $script:NPM_BIN = $npmCmd.Source
        } else {
            Msg "❌ 缺少依赖: npm，请先安装后重试" "❌ Missing dependency: npm — please install it first"
            exit 1
        }
    }

    $nodeVer = & $script:NODE_BIN --version
    $npmVer = & $script:NPM_BIN --version
    Msg "    ✅ node $nodeVer  npm $npmVer" "    ✅ node $nodeVer  npm $npmVer"
    Msg "    node pinned: $($script:NODE_BIN)" "    node pinned: $($script:NODE_BIN)"
    Write-Host ""
}

# ============================================================
# Existing install: update reporting config only, then restart
# ============================================================
$script:PILOT_COMMAND = ""
$script:PILOT_LAST_OUTPUT = ""
$script:PILOT_LAST_EXIT_CODE = 0

function Resolve-PilotManagementCommand {
    $pathCommand = Get-Command loongsuite-pilot -CommandType Application, ExternalScript -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($pathCommand) {
        if ($pathCommand.Source) { return $pathCommand.Source }
        if ($pathCommand.Path) { return $pathCommand.Path }
    }

    $defaultBin = Join-Path $env:USERPROFILE ".local\bin"
    foreach ($candidate in @(
        (Join-Path $defaultBin "loongsuite-pilot.cmd"),
        (Join-Path $defaultBin "loongsuite-pilot.ps1")
    )) {
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

function Invoke-PilotManagement {
    param([string]$Argument)

    $script:PILOT_LAST_OUTPUT = ""
    $script:PILOT_LAST_EXIT_CODE = 1
    $previousEAP = $ErrorActionPreference
    $hadDataDirEnv = Test-Path Env:LOONGSUITE_PILOT_DATA_DIR
    $previousDataDirEnv = if ($hadDataDirEnv) {
        (Get-Item Env:LOONGSUITE_PILOT_DATA_DIR).Value
    } else { $null }
    $hadCacheDirEnv = Test-Path Env:LOONGSUITE_PILOT_CACHE_DIR
    $previousCacheDirEnv = if ($hadCacheDirEnv) {
        (Get-Item Env:LOONGSUITE_PILOT_CACHE_DIR).Value
    } else { $null }
    $ErrorActionPreference = "Continue"
    try {
        $env:LOONGSUITE_PILOT_DATA_DIR = $DataDir
        $env:LOONGSUITE_PILOT_CACHE_DIR = $DataDir
        if ($script:PILOT_COMMAND -match '(?i)\.ps1$') {
            $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script:PILOT_COMMAND $Argument 2>&1
        } else {
            $output = & $script:PILOT_COMMAND $Argument 2>&1
        }
        $script:PILOT_LAST_OUTPUT = ($output | Out-String).Trim()
        $script:PILOT_LAST_EXIT_CODE = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
    } catch {
        $script:PILOT_LAST_OUTPUT = $_.Exception.Message
        $script:PILOT_LAST_EXIT_CODE = 1
    } finally {
        if ($hadDataDirEnv) {
            Set-Item Env:LOONGSUITE_PILOT_DATA_DIR -Value $previousDataDirEnv
        } else {
            Remove-Item Env:LOONGSUITE_PILOT_DATA_DIR -ErrorAction SilentlyContinue
        }
        if ($hadCacheDirEnv) {
            Set-Item Env:LOONGSUITE_PILOT_CACHE_DIR -Value $previousCacheDirEnv
        } else {
            Remove-Item Env:LOONGSUITE_PILOT_CACHE_DIR -ErrorAction SilentlyContinue
        }
        $ErrorActionPreference = $previousEAP
    }
}

function Get-ExistingPilotState {
    $script:PILOT_COMMAND = Resolve-PilotManagementCommand
    if (-not $script:PILOT_COMMAND) { return "missing" }

    Invoke-PilotManagement "status"
    if ($script:PILOT_LAST_OUTPUT -match "is running" -or
        $script:PILOT_LAST_OUTPUT -match "is not running") {
        return "installed"
    }

    Msg "❌ loongsuite-pilot status 返回了无法识别的结果，已停止配置" `
        "❌ loongsuite-pilot status returned an unrecognized result; configuration stopped"
    if ($script:PILOT_LAST_OUTPUT) { Write-Host $script:PILOT_LAST_OUTPUT }
    return "unknown"
}

function Test-AgentShellCurrent {
    $currentFile = Join-Path $DataDir "current"
    if (-not (Test-Path -LiteralPath $currentFile -PathType Leaf)) { return $false }
    try {
        $currentText = Get-Content -LiteralPath $currentFile -Raw -ErrorAction Stop
    } catch {
        return $false
    }
    return $currentText -match '(?i)-agentshell'
}

function Resolve-ReconfigureNode {
    $pinnedFile = Join-Path $DataDir "node-bin"
    if (Test-Path $pinnedFile) {
        $pinnedNode = (Get-Content $pinnedFile -Raw).Trim()
        if (Test-NodeSuitable $pinnedNode) { return $pinnedNode }
    }
    return (Resolve-Node)
}

function Restore-ReportingConfig {
    param(
        [string]$ConfigFile,
        [string]$BackupFile,
        [bool]$HadConfig
    )
    if ($HadConfig) {
        Copy-Item $BackupFile $ConfigFile -Force
    } elseif (Test-Path $ConfigFile) {
        Remove-Item $ConfigFile -Force
    }
}

function Write-ExistingReportingConfig {
    $configFile = Join-Path $DataDir "config.json"
    if (-not (Test-Path $DataDir)) {
        New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
    }

    $script:REPORTING_CONFIG_HAD_FILE = Test-Path $configFile
    $script:REPORTING_CONFIG_BACKUP = ""
    if ($script:REPORTING_CONFIG_HAD_FILE) {
        $script:REPORTING_CONFIG_BACKUP = "$configFile.reconfigure-backup.$PID.$(Get-Random)"
        Copy-Item $configFile $script:REPORTING_CONFIG_BACKUP -Force
    }

    $script:NODE_BIN = Resolve-ReconfigureNode
    if (-not $script:NODE_BIN) {
        if ($script:REPORTING_CONFIG_BACKUP) {
            Remove-Item $script:REPORTING_CONFIG_BACKUP -Force -ErrorAction SilentlyContinue
        }
        Msg "❌ 无法找到已安装实例可用的 Node.js，配置未修改" `
            "❌ No usable Node.js was found for the existing installation; config unchanged"
        return $false
    }

    $cfgArgs = @{
        configPath          = $configFile
        slsRequested        = [bool]$script:SLS_REQUESTED
        slsEndpoint         = "$SlsEndpoint"
        slsProject          = "$SlsProject"
        slsLogstore         = "$SlsLogstore"
        slsAkId             = "$SlsAkId"
        slsAkSecret         = "$SlsAkSecret"
        cmsRequested        = [bool]$script:CMS_REQUESTED
        cmsLicenseKeySet    = [bool]$script:CMS_LICENSE_KEY_SET
        cmsEndpointSet      = [bool]$script:CMS_ENDPOINT_SET
        cmsWorkspaceSet     = [bool]$script:CMS_WORKSPACE_SET
        cmsLicenseKey       = "$CmsLicenseKey"
        cmsEndpoint         = "$CmsEndpoint"
        cmsWorkspace        = "$CmsWorkspace"
        collectLogSet       = [bool]$script:COLLECT_LOG_SET
        collectTraceSet     = [bool]$script:COLLECT_TRACE_SET
        serviceNamePrefixSet = [bool]$script:SERVICE_NAME_PREFIX_SET
        collectLog          = "$CollectLog"
        collectTrace        = "$CollectTrace"
        serviceNamePrefix   = "$ServiceNamePrefix"
    }
    $cfgJson = $cfgArgs | ConvertTo-Json -Compress

    $previousEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    # Pipe JSON through stdin to avoid CLM/WDAC-blocked .NET file APIs and BOM issues.
    $nodeOutput = $cfgJson | & $script:NODE_BIN -e @'
const fs = require('fs');
const opts = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
const isPlainObject = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const required = (value, label) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`SLS ${label} is required`);
  }
  return value;
};

let config = {};
if (fs.existsSync(opts.configPath)) {
  config = JSON.parse(fs.readFileSync(opts.configPath, 'utf8').replace(/^\uFEFF/, ''));
  if (!isPlainObject(config)) throw new Error('config.json root must be an object');
}

if (opts.slsRequested) {
  const endpoint = required(opts.slsEndpoint, 'endpoint');
  const project = required(opts.slsProject, 'project');
  const logstore = required(opts.slsLogstore, 'logstore');
  const accessKeyId = opts.slsAkId || '';
  const accessKeySecret = opts.slsAkSecret || '';
  if (!!accessKeyId !== !!accessKeySecret) {
    throw new Error('SLS access key id and secret must be provided together');
  }
  const userSls = {
    name: 'user-sls',
    endpoint,
    project,
    logstore,
    mode: accessKeyId ? 'ak' : 'webtracking',
  };
  if (accessKeyId) {
    userSls.accessKeyId = accessKeyId;
    userSls.accessKeySecret = accessKeySecret;
  }

  if (config.sls === undefined) {
    config.sls = [userSls];
  } else if (Array.isArray(config.sls)) {
    if (!config.sls.every(isPlainObject)) {
      throw new Error('config.sls array entries must be objects');
    }
    let replaced = false;
    const merged = [];
    for (const entry of config.sls) {
      if (entry.name !== 'user-sls') {
        merged.push(entry);
      } else if (!replaced) {
        merged.push(userSls);
        replaced = true;
      }
    }
    if (!replaced) merged.push(userSls);
    config.sls = merged;
  } else if (isPlainObject(config.sls)) {
    const legacy = { ...config.sls };
    delete legacy.destinationOverride;
    delete legacy.endpoints;
    legacy.endpoint = endpoint;
    legacy.project = project;
    legacy.logstore = logstore;
    legacy.mode = accessKeyId ? 'ak' : 'webtracking';
    if (accessKeyId) {
      legacy.accessKeyId = accessKeyId;
      legacy.accessKeySecret = accessKeySecret;
    } else {
      delete legacy.accessKeyId;
      delete legacy.accessKeySecret;
    }
    config.sls = legacy;
  } else {
    throw new Error('config.sls must be an object or array');
  }
}

if (opts.cmsRequested) {
  if (config.cms !== undefined && !isPlainObject(config.cms)) {
    throw new Error('config.cms must be an object');
  }
  const cms = { ...(config.cms || {}) };
  if (opts.cmsLicenseKeySet) cms.licenseKey = opts.cmsLicenseKey || '';
  if (opts.cmsEndpointSet) cms.endpoint = opts.cmsEndpoint || '';
  if (opts.cmsWorkspaceSet) cms.workspace = opts.cmsWorkspace || '';
  if (typeof cms.licenseKey !== 'string' || cms.licenseKey.trim() === '') {
    throw new Error('CMS license key is required');
  }
  if (typeof cms.endpoint !== 'string' || cms.endpoint.trim() === '') {
    throw new Error('CMS endpoint is required');
  }
  config.cms = cms;
}

if (opts.collectLogSet) config.collectLog = opts.collectLog === 'true';
if (opts.collectTraceSet) config.collectTrace = opts.collectTrace === 'true';
if (opts.serviceNamePrefixSet) config.serviceNamePrefix = opts.serviceNamePrefix || '';

const tempPath = `${opts.configPath}.tmp-${process.pid}-${Date.now()}`;
try {
  fs.writeFileSync(tempPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  if (fs.existsSync(opts.configPath)) {
    fs.chmodSync(tempPath, fs.statSync(opts.configPath).mode);
  }
  fs.renameSync(tempPath, opts.configPath);
} finally {
  if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
}
'@
    $nodeExit = $LASTEXITCODE
    $ErrorActionPreference = $previousEAP

    if ($nodeExit -ne 0) {
        if ($nodeOutput) { Write-Host ($nodeOutput | Out-String).Trim() }
        if ($script:REPORTING_CONFIG_BACKUP) {
            Remove-Item $script:REPORTING_CONFIG_BACKUP -Force -ErrorAction SilentlyContinue
        }
        Msg "❌ config.json 合并失败，原配置已保留" `
            "❌ Failed to merge config.json; original config preserved"
        return $false
    }
    return $true
}

function Test-PilotRunning {
    $retries = if ($env:LOONGSUITE_PILOT_STATUS_RETRIES) {
        [int]$env:LOONGSUITE_PILOT_STATUS_RETRIES
    } else { 5 }
    $delaySeconds = if ($env:LOONGSUITE_PILOT_STATUS_RETRY_DELAY) {
        [double]$env:LOONGSUITE_PILOT_STATUS_RETRY_DELAY
    } else { 1 }

    for ($attempt = 1; $attempt -le $retries; $attempt++) {
        Invoke-PilotManagement "status"
        if ($script:PILOT_LAST_OUTPUT -match "is running") { return $true }
        if ($attempt -lt $retries -and $delaySeconds -gt 0) {
            Start-Sleep -Milliseconds ([int]($delaySeconds * 1000))
        }
    }
    return $false
}

function Reconfigure-ExistingReporting {
    Msg "==> 检测到已安装实例，仅更新用户上报配置..." `
        "==> Existing installation detected; updating user reporting config only..."
    if ($script:PACKAGE_SELECTOR_EXPLICIT) {
        Msg "⚠️  本次不会应用 channel/version/package-url，当前版本保持不变；升级请单独执行 upgrade" `
            "⚠️  channel/version/package-url are ignored here; the installed version is unchanged. Run upgrade separately."
    }

    if (-not (Write-ExistingReportingConfig)) { return $false }

    Msg "==> 重启 loongsuite-pilot ..." "==> Restarting loongsuite-pilot ..."
    Invoke-PilotManagement "restart"
    if ($script:PILOT_LAST_EXIT_CODE -eq 0 -and (Test-PilotRunning)) {
        if ($script:REPORTING_CONFIG_BACKUP) {
            Remove-Item $script:REPORTING_CONFIG_BACKUP -Force -ErrorAction SilentlyContinue
        }
        Msg "✅ 上报配置已更新，loongsuite-pilot 正在运行" `
            "✅ Reporting config updated and loongsuite-pilot is running"
        return $true
    }

    Msg "❌ 重启或状态验证失败，正在恢复旧 config.json ..." `
        "❌ Restart or status verification failed; restoring the previous config.json ..."
    Restore-ReportingConfig `
        (Join-Path $DataDir "config.json") `
        $script:REPORTING_CONFIG_BACKUP `
        $script:REPORTING_CONFIG_HAD_FILE
    Invoke-PilotManagement "restart"
    if ($script:REPORTING_CONFIG_BACKUP) {
        Remove-Item $script:REPORTING_CONFIG_BACKUP -Force -ErrorAction SilentlyContinue
    }
    return $false
}

# ============================================================
# Download and extract package
# ============================================================
$script:INSTALL_SRC = ""

function Download-AndExtract {
    # Go through Get-PilotTempRoot like everywhere else: an empty $env:TEMP makes
    # Join-Path throw, and there is no fallback path here.
    $tmpDir = Join-Path (Get-PilotTempRoot) "loongsuite-pilot-install-$(Get-Random)"
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    $script:TMP_DIR = $tmpDir

    $archivePath = Join-Path $tmpDir "package.tar.gz"

    Msg "==> 下载安装包: $PackageUrl" "==> Downloading: $PackageUrl"

    # Best-effort TLS1.2 bump. Under Constrained Language Mode (WDAC/Device Guard)
    # setting a static property on ServicePointManager throws; swallow it so the
    # download below still runs (modern Windows defaults to TLS1.2 anyway).
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
    try {
        Invoke-WebRequest -Uri $PackageUrl -OutFile $archivePath -UseBasicParsing
    } catch {
        Msg "❌ 下载失败: $_" "❌ Download failed: $_"
        exit 1
    }
    Msg "    ✅ 下载完成" "    ✅ Downloaded"
    Write-Host ""

    Msg "==> 解压安装包..." "==> Extracting..."

    # Windows ships bsdtar (%SystemRoot%\System32\tar.exe, Win10 1803+ /
    # Server 2019+), which parses drive-letter paths such as C:\ correctly. A bare
    # `tar` on a machine with Git installed often resolves to Git's bundled GNU tar
    # (MSYS) instead, and GNU tar reads the colon in `-f C:\...\package.tar.gz` as an
    # rsh remote host (host:path syntax), then tries to connect to a host named "C"
    # -- which hangs. Hence: (1) prefer System32's bsdtar; (2) when falling back to
    # whatever tar is on PATH, add --force-local (GNU tar only; it forces the colon
    # to be read as part of a local filename. bsdtar rejects the flag and exits
    # immediately rather than hanging, so we drop through to the 7-Zip fallback).
    # Always check $LASTEXITCODE and keep tar's output, so a failure is never
    # reported as success and then surfaced only as a vague missing package.json.
    $extracted = $false
    $lastTarErr = ""

    $tarAttempts = @()
    $sysTar = Join-Path $env:SystemRoot "System32\tar.exe"
    if (Test-Path $sysTar) {
        $tarAttempts += , @($sysTar, @('-xzf', $archivePath, '-C', $tmpDir))
    }
    $pathTar = Get-Command tar -ErrorAction SilentlyContinue
    if ($pathTar -and $pathTar.Source -ne $sysTar) {
        # tar on PATH may be Git's GNU tar; --force-local prevents the colon hang
        $tarAttempts += , @($pathTar.Source, @('--force-local', '-xzf', $archivePath, '-C', $tmpDir))
    }

    foreach ($attempt in $tarAttempts) {
        $tarExe = $attempt[0]; $tarArgs = $attempt[1]
        Msg "    tar: $tarExe" "    tar: $tarExe"
        $tarOut = & $tarExe @tarArgs 2>&1
        if ($LASTEXITCODE -eq 0) { $extracted = $true; break }
        $lastTarErr = "$tarExe (exit $LASTEXITCODE): $(($tarOut | Out-String).Trim())"
        Msg "    ⚠️  tar 解包失败,尝试下一种方式: $lastTarErr" `
            "    ⚠️  tar failed, trying next method: $lastTarErr"
    }

    if (-not $extracted) {
        # Fallback: use 7-Zip if available
        $sevenZip = Get-Command 7z -ErrorAction SilentlyContinue
        if ($sevenZip) {
            & 7z x $archivePath -o"$tmpDir" -y | Out-Null
            $tarFile = Get-ChildItem $tmpDir -Filter "*.tar" | Select-Object -First 1
            if ($tarFile) {
                & 7z x $tarFile.FullName -o"$tmpDir" -y | Out-Null
                Remove-Item $tarFile.FullName -Force
            }
            $extracted = $true
        }
    }

    if (-not $extracted) {
        Msg "❌ 无法解压: 需要 tar (Windows 10+) 或 7-Zip" "❌ Cannot extract: requires tar (Windows 10+) or 7-Zip"
        if ($lastTarErr) { Msg "   最后一次 tar 错误: $lastTarErr" "   Last tar error: $lastTarErr" }
        exit 1
    }

    $pkgDir = Join-Path $tmpDir $PACKAGE_NAME
    if (Test-Path $pkgDir) {
        $script:INSTALL_SRC = $pkgDir
    } elseif (Test-Path (Join-Path $tmpDir "package.json")) {
        $script:INSTALL_SRC = $tmpDir
    } else {
        $found = Get-ChildItem $tmpDir -Recurse -Depth 2 -Filter "package.json" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) {
            $script:INSTALL_SRC = $found.DirectoryName
        } else {
            Msg "❌ 解压后未找到 package.json，安装包结构异常" "❌ package.json not found — unexpected package structure"
            exit 1
        }
    }
    Msg "    ✅ 解压完成" "    ✅ Extracted"
    Write-Host ""
}

# ============================================================
# Agent probe
# ============================================================
$script:PROBE_RESULT = "[]"

function Probe-Agents {
    # -AllAgents: no per-agent gate is written (Write-Config clears config.agents),
    # so the agent list is never needed -- skip probing entirely.
    if ($AllAgents) { return }

    $probeScript = Join-Path $script:INSTALL_SRC "dist\cli-probe.cjs"
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"

    # -Agents specified: the user has chosen exactly which agents to enable, so
    # on-disk detection is irrelevant. We still enumerate agent definitions with
    # --list (no existence checks) to learn every id for the enable/disable gate.
    if ($script:SELECTED_AGENTS) {
        Msg "==> 枚举 Agent 定义 (已指定 -Agents，跳过探测)..." "==> Listing agent definitions (-Agents given; skipping detection)..."
        if (Test-Path $probeScript) {
            try {
                $raw = & $script:NODE_BIN $probeScript --list 2>$null
                if ($raw) {
                    $script:PROBE_RESULT = if ($raw -is [array]) { $raw -join "" } else { $raw }
                }
            } catch {
                $script:PROBE_RESULT = "[]"
            }
        }
        $ErrorActionPreference = $prevEAP
        Write-Host ""
        return
    }

    Msg "==> 探测 AI Agent..." "==> Probing AI Agents..."
    if (Test-Path $probeScript) {
        try {
            $raw = & $script:NODE_BIN $probeScript 2>$null
            if ($raw) {
                $script:PROBE_RESULT = if ($raw -is [array]) { $raw -join "" } else { $raw }
            }
        } catch {
            Msg "    ⚠️  Agent 探测失败，将跳过选择" "    ⚠️  Agent probe failed, skipping selection"
            $script:PROBE_RESULT = "[]"
        }
    }
    $count = $script:PROBE_RESULT | & $script:NODE_BIN -e "const r=JSON.parse(require('fs').readFileSync(0,'utf-8').replace(/^\uFEFF/,''));process.stdout.write(String(r.length))" 2>$null
    $ErrorActionPreference = $prevEAP
    if (-not $count) { $count = "0" }
    Msg "    ✅ 探测到 ${count} 个 Agent 定义" "    ✅ Found ${count} agent definitions"
    Write-Host ""
}

# ============================================================
# Agent selection
# ============================================================
$script:SELECTED_AGENTS = $Agents

function Select-Agents {
    # -AllAgents: collect every agent. Skip selection entirely and leave no gate
    # in config (Write-Config clears config.agents), so pilot auto-detects all
    # agents at runtime -- including ones installed after this run.
    if ($AllAgents) {
        if ($script:SELECTED_AGENTS) {
            Msg "    ⚠️  -AllAgents 已启用，忽略 -Agents 指定的列表" `
                "    ⚠️  -AllAgents is set; ignoring the -Agents list"
            $script:SELECTED_AGENTS = ""
        }
        Msg "    采集全部 Agent (不写入选择，由 pilot 运行时自动探测)" `
            "    Collecting all agents (no selection written; pilot auto-detects at runtime)"
        Write-Host ""
        return
    }

    if ($script:SELECTED_AGENTS) {
        Msg "    使用指定的 Agent: $($script:SELECTED_AGENTS)" "    Using specified agents: $($script:SELECTED_AGENTS)"
        Write-Host ""
        return
    }

    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $agentCount = $script:PROBE_RESULT | & $script:NODE_BIN -e "const r=JSON.parse(require('fs').readFileSync(0,'utf-8').replace(/^\uFEFF/,''));process.stdout.write(String(r.length))" 2>$null
    $ErrorActionPreference = $prevEAP
    if (-not $agentCount -or $agentCount -eq "0") { return }

    # Non-interactive detection (hook / detached / stdin or stdout redirected ->
    # auto-select whatever was detected)
    if (-not (Test-Interactive)) {
        $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
        $script:SELECTED_AGENTS = $script:PROBE_RESULT | & $script:NODE_BIN -e @'
const r = JSON.parse(require('fs').readFileSync(0,'utf-8').replace(/^\uFEFF/,''));
const detected = r.filter(a => a.detected).map(a => a.id);
process.stdout.write(detected.join(','));
'@ 2>$null
        $ErrorActionPreference = $prevEAP
        Msg "    (非交互模式) 自动选择已检测到的 Agent: $($script:SELECTED_AGENTS)" `
            "    (non-interactive) Auto-selected detected agents: $($script:SELECTED_AGENTS)"
        Write-Host ""
        return
    }

    # Interactive menu
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $script:PROBE_RESULT | & $script:NODE_BIN -e @'
const r = JSON.parse(require('fs').readFileSync(0,'utf-8').replace(/^\uFEFF/,''));
const lang = process.argv[1];
const defaults = [];
for (let i = 0; i < r.length; i++) {
  const a = r[i];
  const status = lang === 'zh'
    ? (a.detected ? '已检测到: ' + a.reason : '未检测到')
    : (a.detected ? 'detected: ' + a.reason : 'not detected');
  console.log('    [' + (i+1) + '] ' + a.displayName.padEnd(16) + '(' + status + ')');
  if (a.detected) defaults.push(i+1);
}
console.log('');
if (lang === 'zh') {
  console.log('    默认选择已检测到的 Agent: ' + defaults.join(','));
  console.log('    输入要启用的编号 (逗号分隔)，直接回车使用默认:');
} else {
  console.log('    Default selection (detected): ' + defaults.join(','));
  console.log('    Enter numbers to enable (comma-separated), press Enter for default:');
}
'@ $LANG_MODE
    $ErrorActionPreference = $prevEAP

    # [string] guard: Read-Host returns $null at stdin EOF, and calling .Trim() on
    # $null throws InvokeMethodOnNull
    $selectInput = ([string](Read-Host "    >")).Trim() -replace '[，、；]', ','

    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $script:SELECTED_AGENTS = $script:PROBE_RESULT | & $script:NODE_BIN -e @'
const r = JSON.parse(require('fs').readFileSync(0,'utf-8').replace(/^\uFEFF/,''));
const input = (process.argv[1] || '').replace(/[，、；]/g, ',');
let indices;
if (!input.trim()) {
  indices = r.map((a, i) => a.detected ? i : -1).filter(i => i >= 0);
} else {
  indices = [...new Set(input.trim().split(/[\s,]+/).map(Number).filter(n => n >= 1 && n <= r.length))].map(n => n - 1);
}
const ids = indices.sort((a,b) => a-b).map(i => r[i].id);
process.stdout.write(ids.join(','));
'@ $selectInput 2>$null
    $ErrorActionPreference = $prevEAP

    if ($script:SELECTED_AGENTS) {
        Msg "    已选择: $($script:SELECTED_AGENTS)" "    Selected: $($script:SELECTED_AGENTS)"
    } else {
        Msg "    未选择任何 Agent" "    No agents selected"
    }
    Write-Host ""
}

# ============================================================
# Prompt for userId
# ============================================================
function Prompt-UserId {
    if ($UserId) { return }
    if (-not (Test-Interactive)) { return }

    $configFile = Join-Path $DataDir "config.json"
    $existingUid = ""
    if (Test-Path $configFile) {
        try {
            $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
            $existingUid = & $script:NODE_BIN -e @'
try { const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf-8').replace(/^\uFEFF/,'')); process.stdout.write(c.userId||''); } catch {}
'@ $configFile 2>$null
            $ErrorActionPreference = $prevEAP
        } catch {}
    }

    Write-Host ""
    if ($existingUid) {
        Msg "    当前 userId: $existingUid" "    Current userId: $existingUid"
        Msg "    直接回车保留，或输入新值:" "    Press Enter to keep, or type a new value:"
    } else {
        Msg "    请输入你的 userId（用于数据归属，可直接回车跳过）:" `
            "    Enter your userId (for data attribution, press Enter to skip):"
    }
    $input = ([string](Read-Host "    >")).Trim()
    if ($input) {
        $script:UserId = $input
    } elseif ($existingUid) {
        $script:UserId = $existingUid
    }
}

# ============================================================
# Confirm config overwrite
# ============================================================
function Confirm-ConfigOverwrite {
    $configFile = Join-Path $DataDir "config.json"
    if (-not (Test-Path $configFile)) { return }

    $jsonArg = @{
        slsEndpoint = $SlsEndpoint
        slsProject = $SlsProject
        slsLogstore = $SlsLogstore
        cmsLicenseKey = $CmsLicenseKey
        cmsEndpoint = $CmsEndpoint
        cmsWorkspace = $CmsWorkspace
        serviceNamePrefix = $ServiceNamePrefix
        maskMode = $MaskMode
        maskTypes = $MaskTypes
    } | ConvertTo-Json -Compress

    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $diffs = & $script:NODE_BIN -e @'
const fs = require('fs');
let old = {};
try { old = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8').replace(/^\uFEFF/,'')); } catch { process.exit(0); }
const newVals = JSON.parse(process.argv[2]);
const normalizeCsv = value => String(value || '').split(',').map(v => v.trim()).filter(Boolean).join(',');
const checks = [
  { label: 'sls.endpoint',      oldVal: (old.sls||{}).endpoint||'',      newVal: newVals.slsEndpoint },
  { label: 'sls.project',       oldVal: (old.sls||{}).project||'',       newVal: newVals.slsProject },
  { label: 'sls.logstore',      oldVal: (old.sls||{}).logstore||'',      newVal: newVals.slsLogstore },
  { label: 'cms.licenseKey',    oldVal: (old.cms||{}).licenseKey||'',    newVal: newVals.cmsLicenseKey },
  { label: 'cms.endpoint',      oldVal: (old.cms||{}).endpoint||'',      newVal: newVals.cmsEndpoint },
  { label: 'cms.workspace',     oldVal: (old.cms||{}).workspace||'',     newVal: newVals.cmsWorkspace },
  { label: 'serviceNamePrefix', oldVal: old.serviceNamePrefix||'',       newVal: newVals.serviceNamePrefix },
  { label: 'mask.mode',         oldVal: (old.mask||{}).mode||'',         newVal: newVals.maskMode },
  { label: 'mask.types',        oldVal: Array.isArray((old.mask||{}).types) ? normalizeCsv(old.mask.types.join(',')) : '', newVal: normalizeCsv(newVals.maskTypes) },
];
const changed = checks.filter(c => c.newVal && c.oldVal && c.newVal !== c.oldVal);
if (!changed.length) process.exit(0);
for (const c of changed) { console.log(c.label + ': ' + c.oldVal + ' -> ' + c.newVal); }
'@ $configFile $jsonArg 2>$null
    $ErrorActionPreference = $prevEAP

    if (-not $diffs) { return }

    Write-Host ""
    Msg "⚠️  以下配置将被覆盖:" "⚠️  The following config will be overwritten:"
    $diffs | ForEach-Object { Write-Host "    $_" }

    if (Test-Interactive) {
        Write-Host ""
        Msg "    确认覆盖? (y/N):" "    Confirm overwrite? (y/N):"
        $answer = Read-Host "    >"
        if ($answer -notin @("y", "Y", "yes", "YES")) {
            Msg "已取消安装" "Installation cancelled"
            exit 0
        }
    } else {
        Msg "    (非交互模式) 继续覆盖" "    (non-interactive) Proceeding with overwrite"
    }
}

# ============================================================
# Deploy bootstrap scripts
# ============================================================
function Deploy-BootstrapScripts {
    $srcDir = Join-Path $script:PERMANENT_DIR "scripts"
    $bootDir = Join-Path $env:USERPROFILE ".loongsuite-pilot\bin"
    if (-not (Test-Path $bootDir)) { New-Item -ItemType Directory -Path $bootDir -Force | Out-Null }
    Copy-Item (Join-Path $srcDir "collector-daemon.js") $bootDir -Force
    Copy-Item (Join-Path $srcDir "updater-daemon.js") $bootDir -Force
}

# ============================================================
# Deploy package to versions/ directory
# ============================================================
function Deploy-Package {
    param([string]$src)
    $cacheDir = Join-Path $env:USERPROFILE ".loongsuite-pilot"
    $versionsDir = Join-Path $cacheDir "versions"
    $currentFile = Join-Path $cacheDir "current"
    $previousFile = Join-Path $cacheDir "previous"

    $ver = ""; $commit = ""
    $versionFile = Join-Path $src "VERSION"
    if (Test-Path $versionFile) {
        $content = Get-Content $versionFile
        foreach ($line in $content) {
            if ($line -match "^version=(.+)") { $ver = $Matches[1] }
            if ($line -match "^git_commit=(.+)") { $commit = $Matches[1] }
        }
    }

    if ($ver -and $commit) {
        $dirName = "${ver}_${commit}"
        $target = Join-Path $versionsDir $dirName

        if (Test-Path $currentFile) {
            $oldDir = (Get-Content $currentFile -ErrorAction SilentlyContinue).Trim()
            if ($oldDir -and $oldDir -ne $dirName) {
                Set-Content -Path $previousFile -Value $oldDir
            }
        }

        Msg "==> 部署到 $target ..." "==> Deploying to $target ..."
        if (-not (Test-Path $versionsDir)) { New-Item -ItemType Directory -Path $versionsDir -Force | Out-Null }
        if (Test-Path $target) { Remove-Item $target -Recurse -Force }
        Copy-Item $src $target -Recurse

        Set-Content -Path $currentFile -Value $dirName
        $script:PERMANENT_DIR = $target
    } else {
        Msg "==> 部署到 $($script:PERMANENT_DIR) ..." "==> Deploying to $($script:PERMANENT_DIR) ..."
        $parentDir = Split-Path $script:PERMANENT_DIR
        if (-not (Test-Path $parentDir)) { New-Item -ItemType Directory -Path $parentDir -Force | Out-Null }
        if (Test-Path $script:PERMANENT_DIR) { Remove-Item $script:PERMANENT_DIR -Recurse -Force }
        Copy-Item $src $script:PERMANENT_DIR -Recurse
    }
    Msg "    ✅ 部署完成" "    ✅ Deployed"
    Write-Host ""

    Deploy-BootstrapScripts

    Msg "==> 安装依赖..." "==> Installing dependencies..."
    $modulesVer = $ver
    if (-not $modulesVer) { if ($Version) { $modulesVer = $Version } else { $modulesVer = "latest" } }
    $modulesFromOss = Ensure-NodeModules $modulesVer
    if ($modulesFromOss) {
        Msg "    ✅ 依赖安装完成（预编译 node_modules）" "    ✅ Dependencies installed (prebuilt node_modules)"
    } else {
        Msg "    ⚠️ 预编译 node_modules 不可用，回退 npm install" "    ⚠️ Prebuilt node_modules unavailable, falling back to npm install"
        $nodeDir = Split-Path $script:NODE_BIN
        $savedPath = $env:PATH
        if ($env:PATH -notlike "*$nodeDir*") { $env:PATH = "$nodeDir;$env:PATH" }
        Push-Location $script:PERMANENT_DIR
        try {
            $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
            & $script:NPM_BIN install --omit=dev --no-optional 2>&1 | Select-Object -Last 1
            $npmExit = $LASTEXITCODE
            $ErrorActionPreference = $prevEAP
        } finally {
            Pop-Location
            $env:PATH = $savedPath
        }
        if ($npmExit -ne 0) {
            Msg "❌ 依赖安装失败 (exit=$npmExit)，请检查 npm 日志" "❌ Dependencies installation failed (exit=$npmExit), check npm logs"
            exit 1
        }
        Msg "    ✅ 依赖安装完成" "    ✅ Dependencies installed"
    }
    Write-Host ""

    Msg "==> 部署 hook 脚本..." "==> Deploying hook scripts..."
    $postinstallScript = Join-Path $script:PERMANENT_DIR "scripts\postinstall.js"
    if (Test-Path $postinstallScript) {
        $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
        & $script:NODE_BIN $postinstallScript
        $ErrorActionPreference = $prevEAP
    }
    Msg "    ✅ Hook 脚本已部署" "    ✅ Hook scripts deployed"
    Write-Host ""
}

# ============================================================
# Migrate legacy layout
# ============================================================
function Migrate-LegacyLayout {
    $cacheDir = Join-Path $env:USERPROFILE ".loongsuite-pilot"
    $currentFile = Join-Path $cacheDir "current"
    $legacyDir = Join-Path $cacheDir "package"
    $versionsDir = Join-Path $cacheDir "versions"

    if (Test-Path $currentFile) { return }
    if (-not (Test-Path (Join-Path $legacyDir "dist\index.js"))) { return }

    Msg "==> 迁移旧版本目录结构..." "==> Migrating legacy directory layout..."

    $ver = "0.0.0"; $commit = "legacy"
    $versionFile = Join-Path $legacyDir "VERSION"
    if (Test-Path $versionFile) {
        $content = Get-Content $versionFile
        foreach ($line in $content) {
            if ($line -match "^version=(.+)") { $ver = $Matches[1] }
            if ($line -match "^git_commit=(.+)") { $commit = $Matches[1] }
        }
    }

    $dirName = "${ver}_${commit}"
    $target = Join-Path $versionsDir $dirName

    if (-not (Test-Path $versionsDir)) { New-Item -ItemType Directory -Path $versionsDir -Force | Out-Null }
    Copy-Item $legacyDir $target -Recurse
    Set-Content -Path $currentFile -Value $dirName

    $script:PERMANENT_DIR = $target
    Msg "    ✅ 已迁移到 $target" "    ✅ Migrated to $target"
    Write-Host ""
}

# ============================================================
# Write config.json
# ============================================================
function Write-Config {
    $configFile = Join-Path $DataDir "config.json"
    Msg "==> 写入配置文件 $configFile ..." "==> Writing config to $configFile ..."
    if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }

    # Bundle all params as JSON to avoid PowerShell dropping empty-string args to native commands
    $cfgArgs = @{
        configPath        = $configFile
        dataDir           = $DataDir
        slsEndpoint       = "$SlsEndpoint"
        slsProject        = "$SlsProject"
        slsLogstore       = "$SlsLogstore"
        slsAkId           = "$SlsAkId"
        slsAkSecret       = "$SlsAkSecret"
        logLevel          = "$LogLevel"
        userId            = "$($script:UserId)"
        updateUrl         = "$UPDATE_PACKAGE_URL"
        collectLog        = "$CollectLog"
        collectTrace      = "$CollectTrace"
        cmsLicenseKey     = "$CmsLicenseKey"
        cmsEndpoint       = "$CmsEndpoint"
        cmsWorkspace      = "$CmsWorkspace"
        serviceNamePrefix = "$ServiceNamePrefix"
        selectedAgents    = "$($script:SELECTED_AGENTS)"
        allAgentsMode     = $(if ($AllAgents) { "1" } else { "" })
        maskMode          = "$MaskMode"
        maskTypes         = "$MaskTypes"
        probeResult       = "$($script:PROBE_RESULT)"
    }
    $cfgJson = $cfgArgs | ConvertTo-Json -Compress

    # Pipe the JSON through stdin instead of a temp file: writing UTF-8 *without BOM*
    # requires .NET calls that Constrained Language Mode (WDAC) forbids, and a BOM would
    # break node's JSON.parse. node reads fd 0, so no file -- and no CLM-blocked APIs.
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $cfgJson | & $script:NODE_BIN -e @'
const fs = require('fs');
const opts = JSON.parse(fs.readFileSync(0, 'utf-8').replace(/^\uFEFF/,''));

let existing = {};
try { existing = JSON.parse(fs.readFileSync(opts.configPath, 'utf-8').replace(/^\uFEFF/,'')); } catch {}

const config = {
  ...existing,
  enabled: true,
  dataDir: opts.dataDir,
};
delete config.internal;
if (config.userId === undefined && config['user.id'] !== undefined) {
  config.userId = config['user.id'];
}
delete config['user.id'];

if (opts.slsEndpoint || opts.slsProject || opts.slsLogstore) {
  config.sls = config.sls || {};
  delete config.sls.destinationOverride;
  if (opts.slsEndpoint) config.sls.endpoint = opts.slsEndpoint;
  if (opts.slsAkId && opts.slsAkSecret) {
    config.sls.mode = 'ak';
    config.sls.accessKeyId = opts.slsAkId;
    config.sls.accessKeySecret = opts.slsAkSecret;
  }
  if (opts.slsProject && opts.slsLogstore) {
    config.sls.project = opts.slsProject;
    config.sls.logstore = opts.slsLogstore;
    delete config.sls.endpoints;
  }
}
if (opts.logLevel) config.logLevel = opts.logLevel;
if (opts.userId) { config.userId = opts.userId; delete config.identity; }
if (opts.updateUrl) {
  config.autoUpdate = config.autoUpdate || {};
  config.autoUpdate.packageUrl = opts.updateUrl;
}
if (opts.collectLog) config.collectLog = opts.collectLog === 'true';
if (opts.collectTrace) config.collectTrace = opts.collectTrace === 'true';
if (opts.cmsLicenseKey || opts.cmsEndpoint || opts.cmsWorkspace) {
  config.cms = config.cms || {};
  if (opts.cmsLicenseKey) config.cms.licenseKey = opts.cmsLicenseKey;
  if (opts.cmsEndpoint) config.cms.endpoint = opts.cmsEndpoint;
  if (opts.cmsWorkspace) config.cms.workspace = opts.cmsWorkspace;
}
if (opts.serviceNamePrefix) config.serviceNamePrefix = opts.serviceNamePrefix;
if (opts.maskMode) {
  config.mask = config.mask || {};
  config.mask.mode = opts.maskMode;
  if (opts.maskMode === 'custom') {
    config.mask.types = opts.maskTypes.split(',').map(t => t.trim()).filter(Boolean);
  } else { delete config.mask.types; }
}
if (opts.allAgentsMode === '1') {
  // Collect all agents: drop any per-agent gate so the opt-out default (an
  // agent not listed is enabled) applies to every agent, now and in future.
  delete config.agents;
} else if (opts.selectedAgents) {
  config.agents = config.agents || {};
  const selected = opts.selectedAgents.split(',').map(s => s.trim()).filter(Boolean);
  const allAgents = JSON.parse(opts.probeResult || '[]');
  for (const agent of allAgents) {
    config.agents[agent.id] = config.agents[agent.id] || {};
    config.agents[agent.id].enabled = selected.includes(agent.id);
  }
}

fs.writeFileSync(opts.configPath, JSON.stringify(config, null, 2) + '\n');
'@
    $writeExit = $LASTEXITCODE
    $ErrorActionPreference = $prevEAP

    # node prints its stack to stderr and exits non-zero on failure; without this check
    # the installer would print a "Config written" success line over a config that
    # was never updated.
    if ($writeExit -ne 0 -or -not (Test-Path $configFile)) {
        Msg "    ❌ 配置写入失败 (node 退出码 $writeExit)" "    ❌ Config write failed (node exit $writeExit)"
        exit 1
    }
    Msg "    ✅ 配置已写入" "    ✅ Config written"
    Write-Host ""
}

# ============================================================
# Install loongsuite-pilot command (batch wrapper)
# ============================================================
function Install-Command {
    Msg "==> 安装服务管理脚本..." "==> Installing service management script..."
    $binDir = Join-Path $env:USERPROFILE ".local\bin"
    if (-not (Test-Path $binDir)) { New-Item -ItemType Directory -Path $binDir -Force | Out-Null }

    # Copy the PowerShell service management script. Deploy it as loongsuite-pilot-service.ps1,
    # NOT loongsuite-pilot.ps1: in PowerShell a bare `loongsuite-pilot` resolves an on-PATH .ps1
    # (ExternalScript) BEFORE the .cmd shim, and a directly-run .ps1 obeys the session
    # ExecutionPolicy (often Restricted) instead of the shim's -ExecutionPolicy Bypass. A
    # non-colliding name keeps the .cmd the only match for the bare command name.
    $ps1File = Join-Path $binDir "loongsuite-pilot-service.ps1"
    $ps1Src = Join-Path $script:PERMANENT_DIR "scripts\loongsuite-pilot.ps1"
    if (Test-Path $ps1Src) {
        Copy-Item $ps1Src $ps1File -Force
    }
    # Remove any stale same-name script from older installs that would shadow the .cmd shim.
    $legacyPs1 = Join-Path $binDir "loongsuite-pilot.ps1"
    if (Test-Path $legacyPs1) { Remove-Item $legacyPs1 -Force -ErrorAction SilentlyContinue }

    # Create a .cmd shim that forwards to the PowerShell script
    $cmdFile = Join-Path $binDir "loongsuite-pilot.cmd"
    $cmdContent = @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0loongsuite-pilot-service.ps1" %*
'@
    Set-Content -Path $cmdFile -Value $cmdContent -Encoding ASCII
    Msg "    ✅ 已安装: $cmdFile" "    ✅ Installed: $cmdFile"

    # Add to user PATH if not already there. Use the HKCU:\Environment registry key via
    # cmdlets instead of [Environment]::Get/SetEnvironmentVariable, which are .NET static
    # calls that Constrained Language Mode (WDAC) forbids.
    $userPath = (Get-ItemProperty -Path 'HKCU:\Environment' -Name Path -ErrorAction SilentlyContinue).Path
    if ($userPath -notlike "*$binDir*") {
        $newPath = if ($userPath) { "$binDir;$userPath" } else { $binDir }
        Set-ItemProperty -Path 'HKCU:\Environment' -Name Path -Value $newPath
        # Best-effort broadcast so already-open Explorer-spawned terminals refresh their PATH
        # without a re-login. [Environment]::SetEnvironmentVariable persists AND sends
        # WM_SETTINGCHANGE, but is a .NET static call that Constrained Language Mode (WDAC)
        # forbids -- the registry write above already persisted the value, so we just swallow
        # the failure there (a new logon picks it up regardless). Get-ItemProperty returned the
        # value already expanded, so this never re-introduces %VAR% tokens as a plain REG_SZ.
        try { [Environment]::SetEnvironmentVariable('Path', $newPath, 'User') } catch {}
        Msg "    已将 $binDir 添加到用户 PATH" "    Added $binDir to user PATH"
        $env:Path = "$binDir;$env:Path"
    }
    Write-Host ""
}

# ============================================================
# Version helpers
# ============================================================
function Get-InstalledVersion {
    $cacheDir = Join-Path $env:USERPROFILE ".loongsuite-pilot"
    $currentFile = Join-Path $cacheDir "current"
    $versionsDir = Join-Path $cacheDir "versions"

    if (Test-Path $currentFile) {
        $dir = (Get-Content $currentFile -ErrorAction SilentlyContinue).Trim()
        $vf = Join-Path $versionsDir "$dir\VERSION"
        if ($dir -and (Test-Path $vf)) {
            $content = Get-Content $vf
            foreach ($line in $content) {
                if ($line -match "^version=(.+)") { return $Matches[1] }
            }
        }
    }

    $vf = Join-Path $script:PERMANENT_DIR "VERSION"
    if (Test-Path $vf) {
        $content = Get-Content $vf
        foreach ($line in $content) {
            if ($line -match "^version=(.+)") { return $Matches[1] }
        }
    }
    return ""
}

function Get-VersionFromDir {
    param([string]$dir)
    $vf = Join-Path $dir "VERSION"
    if (Test-Path $vf) {
        $content = Get-Content $vf
        foreach ($line in $content) {
            if ($line -match "^version=(.+)") { return $Matches[1] }
        }
    }
    return ""
}

function Get-CommitFromDir {
    param([string]$dir)
    $vf = Join-Path $dir "VERSION"
    if (Test-Path $vf) {
        $content = Get-Content $vf
        foreach ($line in $content) {
            if ($line -match "^git_commit=(.+)") { return $Matches[1] }
        }
    }
    return ""
}

function Show-VersionInfo {
    param([string]$dir)
    $vf = Join-Path $dir "VERSION"
    if (Test-Path $vf) {
        $v = ""; $c = ""; $t = ""
        $content = Get-Content $vf
        foreach ($line in $content) {
            if ($line -match "^version=(.+)") { $v = $Matches[1] }
            if ($line -match "^git_commit=(.+)") { $c = $Matches[1] }
            if ($line -match "^build_time=(.+)") { $t = $Matches[1] }
        }
        return "v${v} (${c}, ${t})"
    }
    return "unknown"
}

# ============================================================
# Print summary
# ============================================================
function Print-Summary {
    param([string]$action)
    $configFile = Join-Path $DataDir "config.json"
    Write-Host "============================================================"
    $ver = Show-VersionInfo $script:PERMANENT_DIR
    switch ($action) {
        "install" { Msg "✅ 安装完成！版本: $ver" "✅ Installation complete! Version: $ver" }
        "upgrade" { Msg "✅ 升级完成！版本: $ver" "✅ Upgrade complete! Version: $ver" }
    }
    Write-Host ""
    Msg "配置文件: $configFile" "Config file: $configFile"
    Msg "数据目录: $DataDir" "Data directory: $DataDir"
    Msg "Hook 目录: $DataDir\hooks" "Hooks directory: $DataDir\hooks"
    Write-Host ""

    if ($SlsEndpoint) {
        Msg "SLS 后端: $SlsEndpoint" "SLS backend: $SlsEndpoint"
        if ($SlsProject)  { Msg "   项目: $SlsProject" "   Project: $SlsProject" }
        if ($SlsLogstore) { Msg "   日志库: $SlsLogstore" "   Logstore: $SlsLogstore" }
        Write-Host ""
    }

    Msg "命令:" "Commands:"
    Write-Host "   loongsuite-pilot          # 查看状态 / Status"
    Write-Host "   loongsuite-pilot info     # 版本与配置 / Version & config"
    Write-Host ""
    Msg "提示: 请新开一个终端后再使用 loongsuite-pilot 命令 (WDAC/受限环境可能需注销重登)。" `
        "Tip: open a NEW terminal before using the loongsuite-pilot command (a WDAC/locked-down environment may require signing out and back in)."
    Write-Host "============================================================"
}

# ============================================================
# Stop service by PID file
# ============================================================
function Stop-PilotService {
    $pidFile = Join-Path $DataDir "loongsuite-pilot.pid"
    if (Test-Path $pidFile) {
        $oldPid = (Get-Content $pidFile -ErrorAction SilentlyContinue).Trim()
        if ($oldPid) {
            $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
            if ($proc) {
                Msg "==> 停止运行中的服务 (PID $oldPid)..." "==> Stopping running service (PID $oldPid)..."
                Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
                $count = 0
                while ($count -lt 10) {
                    $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
                    if (-not $proc) { break }
                    Start-Sleep -Seconds 1
                    $count++
                }
                Msg "    ✅ 已停止" "    ✅ Stopped"
                Write-Host ""
            }
        }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }

    # Also try the loongsuite-pilot command (use .ps1 directly to avoid cmd.exe popup)
    $ps1Path = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot-service.ps1"
    if (Test-Path $ps1Path) {
        $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ps1Path stop 2>$null
        $ErrorActionPreference = $prevEAP
    }
}

# ============================================================
# GC old versions
# ============================================================
function GC-OldVersions {
    $cacheDir = Join-Path $env:USERPROFILE ".loongsuite-pilot"
    $versionsDir = Join-Path $cacheDir "versions"
    $currentFile = Join-Path $cacheDir "current"
    $previousFile = Join-Path $cacheDir "previous"

    if (-not (Test-Path $versionsDir)) { return }

    $keepCurrent = ""; $keepPrevious = ""
    if (Test-Path $currentFile) { $keepCurrent = (Get-Content $currentFile -ErrorAction SilentlyContinue).Trim() }
    if (Test-Path $previousFile) { $keepPrevious = (Get-Content $previousFile -ErrorAction SilentlyContinue).Trim() }

    Get-ChildItem $versionsDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.Name -ne $keepCurrent -and $_.Name -ne $keepPrevious) {
            Remove-Item $_.FullName -Recurse -Force
        }
    }
}

# ============================================================
# Remove hook configs
# ============================================================
function Remove-HookConfigs {
    $HOOK_MARKER = ".loongsuite-pilot"
    $configs = @(
        (Join-Path $env:USERPROFILE ".cursor\hooks.json"),
        (Join-Path $env:USERPROFILE ".qoder\settings.json"),
        (Join-Path $env:USERPROFILE ".qoderwork\settings.json"),
        (Join-Path $env:USERPROFILE ".claude\settings.json"),
        (Join-Path $env:USERPROFILE ".codex\hooks.json")
    )

    foreach ($cfg in $configs) {
        if (-not (Test-Path $cfg)) { continue }
        $short = $cfg.Replace($env:USERPROFILE, "~")

        try {
            $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
            & $script:NODE_BIN -e @'
const fs = require('fs');
const cfg = process.argv[1];
const marker = process.argv[2];
try {
  const data = JSON.parse(fs.readFileSync(cfg, 'utf-8').replace(/^\uFEFF/,''));
  const hooks = data.hooks;
  if (!hooks || typeof hooks !== 'object') process.exit(0);
  let changed = false;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const filtered = entries.filter(e => {
      const cmd = e.command || '';
      const nested = Array.isArray(e.hooks) ? e.hooks : [];
      const hasMarker = cmd.includes(marker) || nested.some(h => (h.command || '').includes(marker));
      if (hasMarker) changed = true;
      return !hasMarker;
    });
    if (filtered.length === 0) { delete hooks[event]; changed = true; }
    else hooks[event] = filtered;
  }
  if (changed) {
    fs.writeFileSync(cfg, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }
} catch(e) { process.stderr.write(e.message); process.exit(1); }
'@ $cfg $HOOK_MARKER 2>$null
            $ErrorActionPreference = $prevEAP
            Msg "    ✅ 已清理: $short" "    ✅ Cleaned: $short"
        } catch {
            Msg "    ⚠️  跳过: $short (需手动清理)" "    ⚠️  Skipped: $short (manual cleanup needed)"
        }
    }
}

# ============================================================
# Remove OTel plugin (Claude/Codex)
# ============================================================
function Remove-OtelPlugin {
    $OTEL_CLAUDE_DIR = Join-Path $env:USERPROFILE ".cache\opentelemetry.instrumentation.claude"
    $OTEL_CODEX_DIR = Join-Path $env:USERPROFILE ".cache\opentelemetry.instrumentation.codex"

    # Clean Claude settings.json hooks
    $claudeSettings = Join-Path $env:USERPROFILE ".claude\settings.json"
    if ((Test-Path $claudeSettings) -and $script:NODE_BIN) {
        $content = Get-Content $claudeSettings -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
        if ($content -match "otel-claude-hook|hook-entry") {
            $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
            & $script:NODE_BIN -e @'
const fs = require('fs');
const f = process.argv[1];
const isOurs = c => c.includes('otel-claude-hook') || c.includes('hook-entry.sh');
try {
  const d = JSON.parse(fs.readFileSync(f, 'utf-8').replace(/^\uFEFF/,''));
  if (d && d.hooks) {
    for (const ev of Object.keys(d.hooks)) {
      if (!Array.isArray(d.hooks[ev])) continue;
      d.hooks[ev] = d.hooks[ev].map(m => {
        if (!Array.isArray(m.hooks)) return m;
        m.hooks = m.hooks.filter(h => !(h.command && isOurs(h.command)));
        return m.hooks.length > 0 ? m : null;
      }).filter(Boolean);
      if (d.hooks[ev].length === 0) delete d.hooks[ev];
    }
    if (Object.keys(d.hooks).length === 0) delete d.hooks;
    fs.writeFileSync(f, JSON.stringify(d, null, 2) + '\n');
  }
} catch {}
'@ $claudeSettings 2>$null
            $ErrorActionPreference = $prevEAP
            Msg "    ✅ settings.json hooks 已清理" "    ✅ settings.json hooks cleaned"
        }
    }

    # Remove plugin directories
    foreach ($dir in @($OTEL_CLAUDE_DIR, $OTEL_CODEX_DIR)) {
        if (Test-Path $dir) {
            if ($Purge) {
                Remove-Item $dir -Recurse -Force
                Msg "    ✅ 插件目录已完全删除 (--Purge): $dir" "    ✅ Plugin directory fully removed (-Purge): $dir"
            } else {
                Get-ChildItem $dir -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -ne "sessions" } |
                    ForEach-Object { Remove-Item $_.FullName -Recurse -Force }
                Msg "    ✅ 插件文件已删除（sessions/ 已保留）" "    ✅ Plugin files removed (sessions/ preserved)"
            }
        }
    }
}

# ============================================================
# CMD: install
# ============================================================
function Cmd-Install {
    Msg "==> 开始安装 $PACKAGE_NAME ..." "==> Installing $PACKAGE_NAME ..."
    Write-Host ""

    if ($script:SLS_REQUESTED -or $script:CMS_REQUESTED) {
        $existingState = Get-ExistingPilotState
        if ($existingState -eq "installed" -and (Test-AgentShellCurrent)) {
            if (-not (Reconfigure-ExistingReporting)) { exit 1 }
            return
        }
        if ($existingState -eq "unknown") { exit 1 }
    }

    Check-Deps
    Migrate-LegacyLayout

    $curVer = Get-InstalledVersion
    if ($curVer) {
        Msg "⚠️  检测到已安装版本 v${curVer}，将执行重新安装" "⚠️  Existing installation v${curVer} detected, re-installing"
        Write-Host ""
    }

    Stop-PilotService

    try {
        Download-AndExtract
        Probe-Agents
        Select-Agents
        Prompt-UserId
        Confirm-ConfigOverwrite
        Deploy-Package $script:INSTALL_SRC
        Write-Config
        Install-Command

        Msg "==> 启动服务..." "==> Starting service..."
        $ps1Path = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot-service.ps1"
        if (Test-Path $ps1Path) {
            $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ps1Path start 2>$null
            Start-Sleep -Seconds 2
            $statusOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ps1Path status 2>$null
            $ErrorActionPreference = $prevEAP
            if ($statusOut -match "is running") {
                Msg "    ✅ 服务已启动" "    ✅ Service started"
            } else {
                Msg "    ⚠️  服务可能尚未就绪，请检查: loongsuite-pilot status" `
                    "    ⚠️  Service may not be ready. Check: loongsuite-pilot status"
            }
        }
        Write-Host ""
        Print-Summary "install"
    } finally {
        if ($script:TMP_DIR -and (Test-Path $script:TMP_DIR)) {
            Remove-Item $script:TMP_DIR -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

# ============================================================
# CMD: upgrade
# ============================================================
function Cmd-Upgrade {
    Msg "==> 开始升级 $PACKAGE_NAME ..." "==> Upgrading $PACKAGE_NAME ..."
    Write-Host ""

    Migrate-LegacyLayout

    $oldVer = Get-InstalledVersion
    if (-not $oldVer) {
        Msg "❌ 未检测到已安装的 loongsuite-pilot，请先执行 install" `
            "❌ No existing installation found. Please run install first."
        exit 1
    }

    Msg "   当前版本: $oldVer" "   Current version: $oldVer"
    Write-Host ""

    Check-Deps

    try {
        Download-AndExtract

        $newVer = Get-VersionFromDir $script:INSTALL_SRC
        $newCommit = Get-CommitFromDir $script:INSTALL_SRC
        $oldCommit = Get-CommitFromDir $script:PERMANENT_DIR

        if ($newVer -and $newVer -eq $oldVer -and $newCommit -eq $oldCommit) {
            Msg "✅ 已是最新版本 v${newVer} (${newCommit})，无需升级" `
                "✅ Already at latest version v${newVer} (${newCommit}), nothing to do"
            exit 0
        }

        Msg "   新版本: ${newVer} (${newCommit})" "   New version: ${newVer} (${newCommit})"
        Write-Host ""

        Msg "==> 停止服务..." "==> Stopping service..."
        Stop-PilotService
        Write-Host ""

        Deploy-Package $script:INSTALL_SRC
        Install-Command

        Msg "==> 启动新版本..." "==> Starting new version..."
        $ps1Path = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot-service.ps1"
        $started = $false
        if (Test-Path $ps1Path) {
            $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ps1Path start 2>$null
            Start-Sleep -Seconds 2
            $statusOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ps1Path status 2>$null
            $ErrorActionPreference = $prevEAP
            if ($statusOut -match "is running") {
                Msg "    ✅ 新版本启动成功" "    ✅ New version started successfully"
                Write-Host ""
                GC-OldVersions
                Print-Summary "upgrade"
                $started = $true
            }
        }

        if (-not $started) {
            Write-Host ""
            Msg "⚠️  新版本启动失败，正在回滚..." "⚠️  New version failed to start, rolling back..."
            if (Test-Path $ps1Path) {
                $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
                & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ps1Path stop 2>$null
                & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ps1Path rollback 2>$null
                $ErrorActionPreference = $prevEAP
            }
            Msg "❌ 升级失败，已回滚到 v${oldVer}" "❌ Upgrade failed, rolled back to v${oldVer}"
            Msg "   请检查日志: loongsuite-pilot log" "   Check logs: loongsuite-pilot log"
            exit 1
        }
    } finally {
        if ($script:TMP_DIR -and (Test-Path $script:TMP_DIR)) {
            Remove-Item $script:TMP_DIR -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

# ============================================================
# CMD: uninstall
# ============================================================

# Remove one scheduled task: stop it, unregister it (falling back to schtasks.exe),
# and confirm it is truly gone -- throwing if not, so callers never delete the
# launcher files a surviving task still points at.
function Remove-OnePilotScheduledTask {
    param(
        [Parameter(Mandatory = $true)] [string]$TaskName,
        [Parameter(Mandatory = $true)] [string]$TaskPath
    )
    $task = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
    if (-not $task) { return }
    if ($task.State -eq "Running") {
        Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
    }
    try {
        Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false -ErrorAction Stop
    } catch {
        $unregisterError = $_.Exception.Message
        $fullTaskName = "$($TaskPath.TrimEnd('\'))\$TaskName"
        & schtasks.exe /Delete /TN $fullTaskName /F 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to remove scheduled task $fullTaskName (Unregister-ScheduledTask: $unregisterError; schtasks exit: $LASTEXITCODE). Run uninstall from an elevated PowerShell."
        }
    }
    $remaining = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
    if ($remaining) {
        throw "Scheduled task still exists after deletion: $($TaskPath.TrimEnd('\'))\$TaskName"
    }
}

# Remove this user's scheduled tasks. Tasks are registered with a per-user suffix
# (LoongsuitePilot-<host>_<user>) so multiple Windows users can coexist -- the old
# hardcoded global names never matched them, which is exactly why uninstall left
# tasks running against a deleted bin\*.vbs. Reconstruct the suffixed names the same
# way the service script does; also clean up the legacy global names, but only when
# they are owned by the current user so another account's task is never touched.
function Remove-PilotScheduledTasks {
    $taskFolder = "\LoongsuitePilot\"
    $currentIdentity = (whoami).Trim()
    # $env:USERNAME instead of [Environment]::UserName: the latter is .NET static
    # member access, which CLM (WDAC / Device Guard) forbids, so on a locked-down
    # host uninstall would throw the moment it entered this function -- precisely the
    # CLM-safe-uninstall goal. The environment variable is equivalent and CLM-safe.
    $currentUser = $env:USERNAME
    $userTag = ($currentIdentity -replace '[^A-Za-z0-9._-]', '_')
    $currentUserTasks = @("LoongsuitePilot-$userTag", "LoongsuitePilotUpdater-$userTag")
    $legacyTasks = @("LoongsuitePilot", "LoongsuitePilotUpdater")

    foreach ($taskName in @($currentUserTasks + $legacyTasks)) {
        if ($taskName -in $legacyTasks) {
            $task = Get-ScheduledTask -TaskName $taskName -TaskPath $taskFolder -ErrorAction SilentlyContinue
            if (-not $task) { continue }
            $taskOwner = [string]$task.Principal.UserId
            $isCurrentOwner = (
                -not $taskOwner -or
                $taskOwner -ieq $currentIdentity -or
                $taskOwner -ieq $currentUser -or
                $taskOwner -ilike "*\$currentUser"
            )
            if (-not $isCurrentOwner) { continue }
        }
        Remove-OnePilotScheduledTask -TaskName $taskName -TaskPath $taskFolder
    }
}

function Cmd-Uninstall {
    Msg "🗑️  开始卸载 $PACKAGE_NAME ..." "🗑️  Uninstalling $PACKAGE_NAME ..."
    Write-Host ""

    Msg "==> 停止服务..." "==> Stopping service..."
    Stop-PilotService
    Msg "    ✅ 服务已停止" "    ✅ Service stopped"
    Write-Host ""

    # Remove Task Scheduler tasks. Must fully succeed before we delete the launcher
    # files below: a surviving task keeps firing wscript against a deleted
    # bin\*.vbs every 5 minutes ("cannot find script file" popups).
    Msg "==> 移除计划任务..." "==> Removing scheduled tasks..."
    $taskRemovalOk = $true
    try {
        Remove-PilotScheduledTasks
        Msg "    ✅ 已移除计划任务" "    ✅ Removed scheduled tasks"
    } catch {
        $taskRemovalOk = $false
        Msg "    ⚠️  计划任务未完全移除: $($_.Exception.Message)" `
            "    ⚠️  Scheduled tasks not fully removed: $($_.Exception.Message)"
    }
    Write-Host ""

    # Resolve node BEFORE removing install dir (node-bin pin lives there)
    if (-not $script:NODE_BIN) { $script:NODE_BIN = Resolve-Node }

    Msg "==> 清理 hook 配置..." "==> Cleaning up hook configs..."
    Remove-HookConfigs
    Write-Host ""

    Msg "==> 清理 Claude/Codex 插件..." "==> Cleaning up Claude/Codex plugins..."
    Remove-OtelPlugin
    Write-Host ""

    Msg "==> 删除安装目录..." "==> Removing installation..."
    $installDir = Join-Path $env:USERPROFILE ".loongsuite-pilot"
    if (-not $taskRemovalOk) {
        Msg "    ⏭️  跳过删除 $installDir(计划任务未完全移除,避免残留任务空跑弹窗)" `
            "    ⏭️  Skipped removing $installDir (scheduled tasks remain; avoids orphaned-task popups)"
    } else {
        if (Test-Path $installDir) {
            Remove-Item $installDir -Recurse -Force
        }
        Msg "    ✅ 已删除 $installDir" "    ✅ Removed $installDir"
    }

    Msg "==> 删除 loongsuite-pilot 命令..." "==> Removing loongsuite-pilot command..."
    $cmdFile = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot.cmd"
    $ps1File = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot-service.ps1"
    $legacyPs1File = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot.ps1"
    if (Test-Path $cmdFile) { Remove-Item $cmdFile -Force }
    if (Test-Path $ps1File) { Remove-Item $ps1File -Force }
    if (Test-Path $legacyPs1File) { Remove-Item $legacyPs1File -Force }
    Msg "    ✅ loongsuite-pilot 命令已删除" "    ✅ loongsuite-pilot command removed"
    Write-Host ""

    if ($Purge) {
        Msg "==> 删除数据目录 (-Purge)..." "==> Removing data directory (-Purge)..."
        if (Test-Path $DataDir) { Remove-Item $DataDir -Recurse -Force }
        Msg "    ✅ 已删除 $DataDir" "    ✅ Removed $DataDir"
    } else {
        Msg "📁 数据目录已保留: $DataDir" "📁 Data directory preserved: $DataDir"
        Msg "   (包含配置和日志，如需彻底删除请加 -Purge)" `
            "   (contains config and logs, add -Purge to remove)"
    }
    Write-Host ""

    Write-Host "============================================================"
    Msg "✅ 卸载完成！" "✅ Uninstallation complete!"
    Write-Host "============================================================"
}

# ============================================================
# Main dispatcher
# ============================================================
switch ($Command) {
    "install"   { Cmd-Install }
    "upgrade"   { Cmd-Upgrade }
    "uninstall" { Cmd-Uninstall }
    default {
        Write-Host "Usage: .\installer.ps1 {install|upgrade|uninstall} [options]"
        exit 1
    }
}
