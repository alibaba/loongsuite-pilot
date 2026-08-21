# installer-opensource.ps1 — Open-source installer for loongsuite-pilot (Windows)
#
# Install (first time):
#   irm https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.ps1 | iex
#   .\installer-opensource.ps1 install `
#     -SlsEndpoint "https://cn-hangzhou.log.aliyuncs.com" `
#     -SlsProject "my-project" `
#     -SlsLogstore "my-logstore" `
#     -SlsAkId "your-ak-id" `
#     -SlsAkSecret "your-ak-secret"
#   .\installer-opensource.ps1 install `
#     -SlsEndpoint "https://cn-hangzhou.log.aliyuncs.com" `
#     -SlsProject "my-project" `
#     -SlsLogstore "my-logstore" `
#     -SlsApiKey "your-api-key"
#
# Install a specific version:
#   .\installer-opensource.ps1 install -Version 1.2.0
#
# Upgrade (preserve config, auto-rollback on failure):
#   .\installer-opensource.ps1 upgrade
#
# Uninstall:
#   .\installer-opensource.ps1 uninstall
#   .\installer-opensource.ps1 uninstall -Purge

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
    [string]$SlsApiKey,
    [string]$PackageUrl,
    [string]$DataDir,
    [string]$LogLevel,
    [Alias("user.id")]
    [string]$UserId,
    [string]$Lang,
    [string]$Version,
    [string]$CollectLog,
    [string]$CollectTrace,
    [string]$CmsLicenseKey,
    [string]$CmsEndpoint,
    [string]$CmsWorkspace,
    [string]$ServiceNamePrefix,
    [string]$Agents,
    [string]$MaskMode,
    [string]$MaskTypes,
    [switch]$Purge,
    [switch]$PreferSystemNode
)

$ErrorActionPreference = "Stop"
# Wrap in try/catch: setting a static property on [Console] throws under Constrained
# Language Mode (WDAC), and with $ErrorActionPreference=Stop that would abort the whole
# script at load. Console encoding is cosmetic, so degrade silently.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# ============================================================
# Constants
# ============================================================
$PACKAGE_NAME = "loongsuite-pilot"
$DEFAULT_PILOT_DIR = Join-Path $env:USERPROFILE ".loongsuite-pilot"
$CACHE_DIR = if ($env:LOONGSUITE_PILOT_CACHE_DIR) {
    $env:LOONGSUITE_PILOT_CACHE_DIR
} else {
    $DEFAULT_PILOT_DIR
}
$PERMANENT_DIR = Join-Path $CACHE_DIR "package"

$_OSS_BASE_URL = "https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot"
# Managed Node.js runtime + prebuilt node_modules (downloaded from OSS at install time)
if ($env:LOONGSUITE_PILOT_NODE_VERSION) { $script:NODE_VERSION = $env:LOONGSUITE_PILOT_NODE_VERSION } else { $script:NODE_VERSION = "22.22.2" }
if ($env:LOONGSUITE_PILOT_NODE_DEPS_URL) { $script:NODE_DEPS_BASE = $env:LOONGSUITE_PILOT_NODE_DEPS_URL } else { $script:NODE_DEPS_BASE = "https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/deps/node" }
if ($env:LOONGSUITE_PILOT_NODE_MODULES_URL) { $script:NODE_MODULES_BASE = $env:LOONGSUITE_PILOT_NODE_MODULES_URL } else { $script:NODE_MODULES_BASE = "https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/deps/node-modules" }


# ============================================================
# Defaults
# ============================================================
if (-not $DataDir) {
    $DataDir = if ($env:LOONGSUITE_PILOT_DATA_DIR) {
        $env:LOONGSUITE_PILOT_DATA_DIR
    } else {
        $DEFAULT_PILOT_DIR
    }
}
$env:LOONGSUITE_PILOT_DATA_DIR = $DataDir
$env:LOONGSUITE_PILOT_CACHE_DIR = $CACHE_DIR
$env:AGENT_DATA_COLLECTION_CONFIG = Join-Path $DataDir "config.json"
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
if ($SlsApiKey -and ($SlsAkId -or $SlsAkSecret)) {
    Write-Error "-SlsApiKey cannot be used with -SlsAkId or -SlsAkSecret"
    exit 1
}

# ============================================================
# Resolve package URL
# ============================================================
if (-not $PackageUrl) {
    if ($Version) {
        $PackageUrl = "$_OSS_BASE_URL/$Version/$PACKAGE_NAME.zip"
    } else {
        $PackageUrl = "$_OSS_BASE_URL/latest/$PACKAGE_NAME.zip"
    }
}

# ============================================================
# Language detection
# ============================================================
function Detect-Lang {
    if ($Lang) { return $Lang }
    if ($env:LOONGSUITE_PILOT_LANG) { return $env:LOONGSUITE_PILOT_LANG }
    # $PSUICulture is an automatic variable (no .NET static call), so it works under
    # Constrained Language Mode where [CultureInfo]::CurrentUICulture would throw.
    if ($PSUICulture -match "zh") { return "zh" }
    return "en"
}

$LANG_MODE = Detect-Lang

function Msg {
    param([string]$zh, [string]$en)
    if ($LANG_MODE -eq "zh") { Write-Host $zh } else { Write-Host $en }
}

function Test-CanPrompt {
    # Each .NET call below throws under Constrained Language Mode (WDAC); guard every one
    # and default to non-interactive (the safe degrade — irm|iex installs are non-interactive).
    try {
        $processArgs = [Environment]::GetCommandLineArgs()
        if ($processArgs -contains "-NonInteractive") { return $false }
    } catch {}
    try {
        if ([Console]::IsInputRedirected) { return $false }
    } catch {}
    try {
        return [Environment]::UserInteractive -and $null -ne $Host.UI.RawUI
    } catch { return $false }
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
    foreach ($pinFile in @(
        (Join-Path $DataDir "node-bin"),
        (Join-Path $CACHE_DIR "node-bin")
    )) {
        if (-not (Test-Path -LiteralPath $pinFile)) { continue }
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
function Get-ManagedNodePlatform {
    $archRaw = $env:PROCESSOR_ARCHITEW6432
    if (-not $archRaw) { $archRaw = $env:PROCESSOR_ARCHITECTURE }
    switch ($archRaw) {
        "AMD64" { return [pscustomobject]@{ Os = "win"; Arch = "x64" } }
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
        foreach ($line in (Get-Content $ShasumsFile)) {
            if ($line -match ("^([0-9a-fA-F]{64})\s+\*?" + [regex]::Escape($Name) + "\s*$")) {
                $expected = $Matches[1].ToLower()
                break
            }
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
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("pilot-managed-node-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
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
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("pilot-node-modules-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
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

    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $nodeMajor = & $script:NODE_BIN -e "process.stdout.write(String(process.versions.node.split('.')[0]))"
    $ErrorActionPreference = $prevEAP
    if ([int]$nodeMajor -lt 18) {
        $nodeVer = & $script:NODE_BIN --version
        Msg "❌ 需要 Node.js >= 18，当前版本: $nodeVer" "❌ Requires Node.js >= 18, current: $nodeVer"
        exit 1
    }

    # Pin node binary path
    if (-not (Test-Path $CACHE_DIR)) { New-Item -ItemType Directory -Path $CACHE_DIR -Force | Out-Null }
    Set-Content -Path (Join-Path $CACHE_DIR "node-bin") -Value $script:NODE_BIN
    # Hook entrypoints can always derive DataDir from their deployed location,
    # while GUI agents do not necessarily inherit the installer's CacheDir.
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

    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $nodeVer = & $script:NODE_BIN --version
    $npmVer = & $script:NPM_BIN --version
    $ErrorActionPreference = $prevEAP
    Msg "    ✅ node $nodeVer  npm $npmVer" "    ✅ node $nodeVer  npm $npmVer"
    Msg "    node pinned: $($script:NODE_BIN)" "    node pinned: $($script:NODE_BIN)"
    Write-Host ""
}

# ============================================================
# Download and extract package
# ============================================================
$script:INSTALL_SRC = ""

function Download-AndExtract {
    $tmpDir = Join-Path $env:TEMP "loongsuite-pilot-install-$(Get-Random)"
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    $script:TMP_DIR = $tmpDir

    $archivePath = Join-Path $tmpDir "package.zip"

    Msg "==> 下载安装包: $PackageUrl" "==> Downloading: $PackageUrl"

    try {
        if (Test-Path -LiteralPath $PackageUrl) {
            Copy-Item -LiteralPath $PackageUrl -Destination $archivePath -Force
        } elseif ($PackageUrl -match '^file://') {
            # Strip the file:// scheme with string ops instead of casting to [Uri], which is
            # forbidden under Constrained Language Mode (WDAC). Handles file:///C:/x and
            # file://C:/x; forward slashes are normalized to backslashes.
            $localPackagePath = ($PackageUrl -replace '^file:/{2,3}', '') -replace '/', '\'
            Copy-Item -LiteralPath $localPackagePath -Destination $archivePath -Force
        } else {
            # Best-effort TLS1.2 bump; setting this static property throws under Constrained
            # Language Mode (WDAC), so swallow it (modern Windows defaults to TLS1.2 anyway).
            try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
            Invoke-WebRequest -Uri $PackageUrl -OutFile $archivePath -UseBasicParsing
        }
    } catch {
        Msg "❌ 下载失败: $_" "❌ Download failed: $_"
        exit 1
    }
    Msg "    ✅ 下载完成" "    ✅ Downloaded"
    Write-Host ""

    Msg "==> 解压安装包..." "==> Extracting..."

    try {
        Expand-Archive -Path $archivePath -DestinationPath $tmpDir -Force
    } catch {
        Msg "❌ 解压失败: $_" "❌ Extraction failed: $_"
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
    Msg "==> 探测 AI Agent..." "==> Probing AI Agents..."
    $probeScript = Join-Path $script:INSTALL_SRC "dist\cli-probe.cjs"
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
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
    $count = $script:PROBE_RESULT | & $script:NODE_BIN -e "const r=JSON.parse(require('fs').readFileSync(0,'utf-8'));process.stdout.write(String(r.length))" 2>$null
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
    if ($script:SELECTED_AGENTS) {
        Msg "    使用指定的 Agent: $($script:SELECTED_AGENTS)" "    Using specified agents: $($script:SELECTED_AGENTS)"
        Write-Host ""
        return
    }

    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $agentCount = $script:PROBE_RESULT | & $script:NODE_BIN -e "const r=JSON.parse(require('fs').readFileSync(0,'utf-8'));process.stdout.write(String(r.length))" 2>$null
    $ErrorActionPreference = $prevEAP
    if (-not $agentCount -or $agentCount -eq "0") { return }

    # Non-interactive detection
    $isInteractive = Test-CanPrompt
    if (-not $isInteractive) {
        $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
        $script:SELECTED_AGENTS = $script:PROBE_RESULT | & $script:NODE_BIN -e @'
const r = JSON.parse(require('fs').readFileSync(0,'utf-8'));
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
const r = JSON.parse(require('fs').readFileSync(0,'utf-8'));
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

    $rawSelection = Read-Host "    >"
    $selectInput = if ($null -eq $rawSelection) { "" } else { $rawSelection.Trim() }
    $selectInput = $selectInput -replace '[，、；]', ','

    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $script:SELECTED_AGENTS = $script:PROBE_RESULT | & $script:NODE_BIN -e @'
const r = JSON.parse(require('fs').readFileSync(0,'utf-8'));
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
    $configFile = Join-Path $DataDir "config.json"
    $existingUid = ""
    if (Test-Path $configFile) {
        try {
            $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
            $existingUid = & $script:NODE_BIN -e @'
try { const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf-8')); process.stdout.write(c.userId||''); } catch {}
'@ $configFile 2>$null
            $ErrorActionPreference = $prevEAP
        } catch {}
    }

    # Reinstall preserves the existing identity without prompting. To change it,
    # callers must pass -UserId explicitly; this keeps scripted installs fully
    # non-interactive and avoids Read-Host failures in Windows PowerShell 5.1.
    if ($existingUid) {
        $script:UserId = $existingUid
        return
    }

    $isInteractive = Test-CanPrompt
    if (-not $isInteractive) {
        return
    }

    Write-Host ""
    if ($existingUid) {
        Msg "    当前 userId: $existingUid" "    Current userId: $existingUid"
        Msg "    直接回车保留，或输入新值:" "    Press Enter to keep, or type a new value:"
    } else {
        Msg "    请输入你的 userId（用于数据归属，可直接回车跳过）:" `
            "    Enter your userId (for data attribution, press Enter to skip):"
    }
    $rawInput = Read-Host "    >"
    $input = if ($null -eq $rawInput) { "" } else { $rawInput.Trim() }
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

    $slsModeForDiff = ""
    if ($SlsApiKey) {
        $slsModeForDiff = "apiKey"
    } elseif ($SlsAkId -and $SlsAkSecret) {
        $slsModeForDiff = "ak"
    }
    $jsonArg = @{
        slsEndpoint = $SlsEndpoint
        slsProject = $SlsProject
        slsLogstore = $SlsLogstore
        slsMode = $slsModeForDiff
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
try { old = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8')); } catch { process.exit(0); }
const newVals = JSON.parse(process.argv[2]);
const normalizeCsv = value => String(value || '').split(',').map(v => v.trim()).filter(Boolean).join(',');
const slsModeOf = sls => {
  if (!sls) return '';
  if (sls.mode) return sls.mode;
  if (sls.apiKey) return 'apiKey';
  if (sls.accessKeyId || sls.accessKeySecret) return 'ak';
  return '';
};
const checks = [
  { label: 'sls.endpoint',      oldVal: (old.sls||{}).endpoint||'',      newVal: newVals.slsEndpoint },
  { label: 'sls.project',       oldVal: (old.sls||{}).project||'',       newVal: newVals.slsProject },
  { label: 'sls.logstore',      oldVal: (old.sls||{}).logstore||'',      newVal: newVals.slsLogstore },
  { label: 'sls.mode',          oldVal: slsModeOf(old.sls),              newVal: newVals.slsMode },
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

    $isInteractive = Test-CanPrompt
    if ($isInteractive) {
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
    $bootDir = Join-Path $CACHE_DIR "bin"
    if (-not (Test-Path $bootDir)) { New-Item -ItemType Directory -Path $bootDir -Force | Out-Null }
    Copy-Item (Join-Path $srcDir "collector-daemon.js") $bootDir -Force
}

# ============================================================
# Deploy package to versions/ directory
# ============================================================
function Deploy-Package {
    param([string]$src)

    $cacheDir = $CACHE_DIR
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

    $deployedDirName = ""
    $oldDir = ""
    if ($ver -and $commit) {
        if (Test-Path $currentFile) {
            $oldDir = (Get-Content $currentFile -ErrorAction SilentlyContinue).Trim()
        }

        $baseDirName = "${ver}_${commit}"
        $deployedDirName = $baseDirName
        $target = Join-Path $versionsDir $deployedDirName
        if (Test-Path -LiteralPath $target) {
            # Never overwrite a version directory in place. A collector may still
            # have native modules loaded from it, especially when replacing an old
            # S4U task that the current shell cannot terminate.
            $suffix = "$(Get-Date -Format 'yyyyMMddHHmmss')_$(Get-Random -Minimum 1000 -Maximum 9999)"
            $deployedDirName = "${baseDirName}_${suffix}"
            $target = Join-Path $versionsDir $deployedDirName
        }

        Msg "==> 部署到 $target ..." "==> Deploying to $target ..."
        if (-not (Test-Path $versionsDir)) { New-Item -ItemType Directory -Path $versionsDir -Force | Out-Null }
        Copy-Item $src $target -Recurse

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

    Msg "==> 安装依赖..." "==> Installing dependencies..."
    $modulesVer = $ver
    if (-not $modulesVer) { if ($Version) { $modulesVer = $Version } else { $modulesVer = "latest" } }
    $modulesFromOss = Ensure-NodeModules $modulesVer
    if (-not $modulesFromOss) {
        Msg "    ⚠️ 预编译 node_modules 不可用，回退 npm install" "    ⚠️ Prebuilt node_modules unavailable, falling back to npm install"
        $nodeDir = Split-Path $script:NODE_BIN
        $savedPath = $env:PATH
        if ($env:PATH -notlike "*$nodeDir*") { $env:PATH = "$nodeDir;$env:PATH" }
        Push-Location $script:PERMANENT_DIR
        try {
            $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
            & $script:NPM_BIN install --omit=dev --omit=optional 2>&1 | Select-Object -Last 1
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
    }

    # Only publish current/previous after the candidate is complete. This keeps
    # the old version recoverable when dependency installation fails.
    if ($deployedDirName) {
        if ($oldDir -and $oldDir -ne $deployedDirName) {
            Set-Content -Path $previousFile -Value $oldDir
        }
        Set-Content -Path $currentFile -Value $deployedDirName
    }

    Deploy-BootstrapScripts
    if ($modulesFromOss) {
        Msg "    ✅ 依赖安装完成（预编译 node_modules）" "    ✅ Dependencies installed (prebuilt node_modules)"
    } else {
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
    $cacheDir = $CACHE_DIR
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
    $cfgArgs = [ordered]@{
        configPath        = $configFile
        dataDir           = $DataDir
        slsEndpoint       = "$SlsEndpoint"
        slsProject        = "$SlsProject"
        slsLogstore       = "$SlsLogstore"
        slsAkId           = "$SlsAkId"
        slsAkSecret       = "$SlsAkSecret"
        slsApiKey         = "$SlsApiKey"
        logLevel          = "$LogLevel"
        userId            = "$($script:UserId)"
        collectLog        = "$CollectLog"
        collectTrace      = "$CollectTrace"
        cmsLicenseKey     = "$CmsLicenseKey"
        cmsEndpoint       = "$CmsEndpoint"
        cmsWorkspace      = "$CmsWorkspace"
        serviceNamePrefix = "$ServiceNamePrefix"
        selectedAgents    = "$($script:SELECTED_AGENTS)"
        maskMode          = "$MaskMode"
        maskTypes         = "$MaskTypes"
        probeResult       = "$($script:PROBE_RESULT)"
    }
    $cfgJson = $cfgArgs | ConvertTo-Json -Compress

    # Stage the JSON through a temp file rather than piping it to node's stdin. Under Windows
    # PowerShell 5.1 a string piped to a native command is encoded with $OutputEncoding (default
    # ASCII), so any non-ASCII value (Chinese serviceNamePrefix/userId, a Chinese username in the
    # path, custom mask types...) would be mangled to "?" before node ever sees it. Set-Content
    # -Encoding UTF8 is CLM-safe (no forbidden .NET calls) and encodes UTF-8 correctly regardless
    # of $OutputEncoding; it prepends a BOM in PS5.1, which node strips below before JSON.parse.
    $cfgTmp = Join-Path $env:TEMP ("lp-config-" + (Get-Random) + ".json")
    Set-Content -LiteralPath $cfgTmp -Value $cfgJson -Encoding UTF8 -NoNewline
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    & $script:NODE_BIN -e @'
const fs = require('fs');
let raw = fs.readFileSync(process.argv[1], 'utf-8');
if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
const opts = JSON.parse(raw);

let existing = {};
try { existing = JSON.parse(fs.readFileSync(opts.configPath, 'utf-8')); } catch {}

const config = {
  ...existing,
  enabled: true,
  dataDir: opts.dataDir,
};
if (!config.dashboard || typeof config.dashboard !== 'object' || Array.isArray(config.dashboard)) {
  config.dashboard = {};
}
if (config.dashboard.port === undefined) config.dashboard.port = 8765;
delete config.internal;
if (config.userId === undefined && config['user.id'] !== undefined) {
  config.userId = config['user.id'];
}
delete config['user.id'];

if (opts.slsEndpoint || opts.slsProject || opts.slsLogstore || opts.slsApiKey) {
  config.sls = config.sls || {};
  delete config.sls.destinationOverride;
  if (opts.slsEndpoint) config.sls.endpoint = opts.slsEndpoint;
  if (opts.slsApiKey) {
    config.sls.mode = 'apiKey';
    config.sls.apiKey = opts.slsApiKey;
    delete config.sls.accessKeyId;
    delete config.sls.accessKeySecret;
  } else if (opts.slsAkId && opts.slsAkSecret) {
    config.sls.mode = 'ak';
    config.sls.accessKeyId = opts.slsAkId;
    config.sls.accessKeySecret = opts.slsAkSecret;
    delete config.sls.apiKey;
  } else if (opts.slsEndpoint || opts.slsProject || opts.slsLogstore) {
    config.sls.mode = 'webtracking';
    delete config.sls.apiKey;
    delete config.sls.accessKeyId;
    delete config.sls.accessKeySecret;
  }
  if (opts.slsProject && opts.slsLogstore) {
    config.sls.project = opts.slsProject;
    config.sls.logstore = opts.slsLogstore;
    delete config.sls.endpoints;
  }
}
if (opts.logLevel) config.logLevel = opts.logLevel;
if (opts.userId) { config.userId = opts.userId; delete config.identity; }
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
if (opts.selectedAgents) {
  config.agents = config.agents || {};
  const selected = opts.selectedAgents.split(',').map(s => s.trim()).filter(Boolean);
  const allAgents = JSON.parse(opts.probeResult || '[]');
  for (const agent of allAgents) {
    config.agents[agent.id] = config.agents[agent.id] || {};
    config.agents[agent.id].enabled = selected.includes(agent.id);
  }
}

fs.writeFileSync(opts.configPath, JSON.stringify(config, null, 2) + '\n');
'@ $cfgTmp
    $ErrorActionPreference = $prevEAP
    Remove-Item -LiteralPath $cfgTmp -Force -ErrorAction SilentlyContinue

    Msg "    ✅ 配置已写入" "    ✅ Config written"
    Write-Host ""
}

# ============================================================
# QoderWork-family runtime wrapper: persist the dedicated User-level overrides
# in HKCU\Environment. reg.exe is the CLM-safe source of truth; the guarded
# .NET call broadcasts WM_SETTINGCHANGE so Explorer-spawned apps see updates.
# ============================================================
function Get-PilotRuntimeOverride {
    param([string]$Name)
    $prevEAP = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $regOut = reg.exe query "HKCU\Environment" /v $Name 2>$null
        $regExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEAP
    }
    if ($regExitCode -ne 0) { return "" }
    foreach ($line in $regOut) {
        if (($line -match '^\s*(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$') -and $Matches[1] -ieq $Name) {
            return $Matches[2].Trim()
        }
    }
    return ""
}

function Test-AgentCollectionEnabled {
    param([string]$AgentId)
    $configFile = Join-Path $DataDir "config.json"
    if (-not (Test-Path $configFile)) { return $false }

    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $enabled = & $script:NODE_BIN -e @'
try {
  const config = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8').replace(/^\uFEFF/, ''));
  const agentId = process.argv[2];
  process.stdout.write(config?.agents?.[agentId]?.enabled === false ? 'false' : 'true');
} catch {
  process.stdout.write('false');
}
'@ $configFile $AgentId 2>$null
    $ErrorActionPreference = $prevEAP
    return "$enabled".Trim() -eq "true"
}

function Set-PilotRuntimeOverride {
    param([string]$Name, [string]$Value)
    reg.exe add "HKCU\Environment" /v $Name /t REG_SZ /d "$Value" /f | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to set $Name" }
    try {
        [Environment]::SetEnvironmentVariable($Name, $Value, 'User')
        return $true
    } catch {
        return $false
    }
}

function Remove-PilotRuntimeOverride {
    param([string]$Name)
    reg.exe delete "HKCU\Environment" /v $Name /f 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to remove $Name" }
    try {
        [Environment]::SetEnvironmentVariable($Name, $null, 'User')
        return $true
    } catch {
        return $false
    }
}

function Sync-PilotRuntimeOverride {
    param(
        [string]$Name,
        [bool]$ShouldEnable,
        [string]$WrapperPath,
        [string]$ProductName
    )
    $current = Get-PilotRuntimeOverride -Name $Name
    if (-not (Test-Path $WrapperPath)) {
        $script:RUNTIME_WRAPPER_MISSING = $true
        if ($current -and $current -ieq $WrapperPath) {
            $broadcasted = Remove-PilotRuntimeOverride -Name $Name
            if (-not $broadcasted) { $script:RUNTIME_ENV_BROADCAST_FAILED = $true }
            Msg "    ⚠️  wrapper 缺失，已清理 $Name" "    ⚠️  Wrapper missing; cleaned $Name"
        } else {
            Msg "    ⚠️  wrapper 缺失，未设置 $Name" "    ⚠️  Wrapper missing; did not set $Name"
        }
        return
    }

    if ($ShouldEnable) {
        if ($current -ine $WrapperPath) {
            $broadcasted = Set-PilotRuntimeOverride -Name $Name -Value $WrapperPath
            if (-not $broadcasted) { $script:RUNTIME_ENV_BROADCAST_FAILED = $true }
            Msg "    ✅ $Name ($ProductName)" "    ✅ $Name ($ProductName)"
        }
    } elseif ($current -and $current -ieq $WrapperPath) {
        $broadcasted = Remove-PilotRuntimeOverride -Name $Name
        if (-not $broadcasted) { $script:RUNTIME_ENV_BROADCAST_FAILED = $true }
        Msg "    ✅ 已清理 $Name" "    ✅ Cleaned $Name"
    }
}

function Inject-QoderworkRuntimeWrapper {
    $wrapperPath = Join-Path $DataDir "hooks\qoderwork-runtime-wrapper.mjs"
    $localAppData = $env:LOCALAPPDATA
    if (-not $localAppData) { $localAppData = Join-Path $env:USERPROFILE "AppData\Local" }

    $qwenInstalled = Test-Path (Join-Path $localAppData "Programs\QwenWorkCN")
    $qoderInstalled = Test-Path (Join-Path $localAppData "Programs\QoderWork")
    $qoderCNInstalled = (Test-Path (Join-Path $localAppData "Programs\QoderWorkCN")) -or `
                        (Test-Path (Join-Path $localAppData "Programs\QoderWork CN"))
    $qwenShouldEnable = $qwenInstalled -and (Test-AgentCollectionEnabled -AgentId 'qwen-work-cn')
    $qoderShouldEnable = ($qoderInstalled -and (Test-AgentCollectionEnabled -AgentId 'qoder-work')) -or `
                         ($qoderCNInstalled -and (Test-AgentCollectionEnabled -AgentId 'qoder-work-cn'))

    $script:RUNTIME_ENV_BROADCAST_FAILED = $false
    $script:RUNTIME_WRAPPER_MISSING = $false
    Sync-PilotRuntimeOverride -Name 'QW_QODER_WORKER_RUNTIME_PATH' `
        -ShouldEnable $qwenShouldEnable -WrapperPath $wrapperPath -ProductName 'QwenWorkCN'
    Sync-PilotRuntimeOverride -Name 'QODER_WORKER_RUNTIME_PATH' `
        -ShouldEnable $qoderShouldEnable -WrapperPath $wrapperPath -ProductName 'QoderWork'

    if ($script:RUNTIME_WRAPPER_MISSING) {
        Msg "    ⚠️  runtime wrapper 未完整部署，已跳过 token 拦截以避免影响应用" `
            "    ⚠️  Runtime wrapper is missing; token interception was skipped to protect the apps"
    } elseif ($script:RUNTIME_ENV_BROADCAST_FAILED) {
        Msg "    ⚠️  环境变量已持久化，但无法通知 Explorer；请注销并重新登录 Windows" `
            "    ⚠️  Environment persisted but Explorer could not be notified; sign out and back in"
    } else {
        Msg "    ⚠️  请完全退出并重新打开对应应用以生效" `
            "    ⚠️  Fully quit and restart the corresponding apps for changes to take effect"
    }
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
    $layoutFile = Join-Path $binDir "loongsuite-pilot-layout.json"
    $layout = [ordered]@{
        dataDir = $DataDir
        cacheDir = $CACHE_DIR
    } | ConvertTo-Json
    # loongsuite-pilot.ps1 reads this back with Get-Content -Encoding UTF8 | ConvertFrom-Json,
    # which tolerates a BOM, so Set-Content is fine here (and CLM-safe, unlike WriteAllText).
    Set-Content -LiteralPath $layoutFile -Value $layout -Encoding UTF8

    # Create a .cmd shim that forwards to the PowerShell script
    $cmdFile = Join-Path $binDir "loongsuite-pilot.cmd"
    $cmdContent = @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0loongsuite-pilot-service.ps1" %*
'@
    Set-Content -Path $cmdFile -Value $cmdContent -Encoding ASCII
    Msg "    ✅ 已安装: $cmdFile" "    ✅ Installed: $cmdFile"

    # Add to user PATH if not already there. The persistent write uses reg.exe (a native command,
    # CLM-safe) rather than [Environment]::SetEnvironmentVariable (a .NET static call WDAC forbids)
    # or Set-ItemProperty. Two hazards this avoids:
    #   1. Set-ItemProperty writes plain REG_SZ by default, DOWNGRADING a REG_EXPAND_SZ Path.
    #   2. Get-ItemProperty returns Path already EXPANDED; writing that back FREEZES
    #      %USERPROFILE%/%SystemRoot% tokens into literal paths.
    # So we read the RAW (unexpanded) value and its type via `reg query`, then write it back with
    # `reg add /t <type>` to preserve REG_EXPAND_SZ and the tokens. The presence check still uses
    # the EXPANDED value so a bin dir already present via a %VAR% token is not added twice.
    $expandedPath = (Get-ItemProperty -Path 'HKCU:\Environment' -Name Path -ErrorAction SilentlyContinue).Path
    if ($expandedPath -notlike "*$binDir*") {
        $pathType = 'REG_EXPAND_SZ'
        $rawUserPath = ''
        $regOut = reg query "HKCU\Environment" /v Path 2>$null
        if ($LASTEXITCODE -eq 0) {
            foreach ($line in $regOut) {
                if ($line -match '^\s*Path\s+(REG_(?:EXPAND_)?SZ)\s+(.*)$') {
                    $pathType = $Matches[1]
                    $rawUserPath = $Matches[2]
                    break
                }
            }
        }
        # Never drop the existing PATH: if reg query yielded nothing usable, fall back to the
        # expanded value (worst case re-freezes tokens, but preserves all entries).
        if (-not $rawUserPath -and $expandedPath) { $rawUserPath = $expandedPath }
        $newPath = if ($rawUserPath) { "$binDir;$rawUserPath" } else { $binDir }
        reg add "HKCU\Environment" /v Path /t $pathType /d "$newPath" /f | Out-Null
        # Best-effort broadcast so already-open Explorer-spawned terminals refresh their PATH
        # without a re-login: [Environment]::SetEnvironmentVariable persists AND sends
        # WM_SETTINGCHANGE. It is a .NET static call CLM forbids, so swallow failures — the reg add
        # above already persisted the typed value. $newPath still carries raw %VAR% tokens, so on
        # non-CLM hosts .NET also writes REG_EXPAND_SZ (no downgrade).
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
    $cacheDir = $CACHE_DIR
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
    $cacheDir = $CACHE_DIR
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
        (Join-Path $env:USERPROFILE ".qoder-cn\settings.json"),
        (Join-Path $env:USERPROFILE ".qoderwork\settings.json"),
        (Join-Path $env:USERPROFILE ".qoderworkcn\settings.json"),
        (Join-Path $env:USERPROFILE ".qwenworkcn\settings.json"),
        (Join-Path $env:USERPROFILE ".claude\settings.json"),
        (Join-Path $env:USERPROFILE ".kiro\agents\pilot-kiro.json"),
        (Join-Path $env:USERPROFILE ".qwen\settings.json"),
        (Join-Path $env:USERPROFILE ".workbuddy\settings.json")
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
  const data = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
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
  if (Object.keys(hooks).length === 0) {
    delete data.hooks;
    changed = true;
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
# Remove plugin-inject specs (OpenCode)
# ============================================================
# OpenCode uses deployMode "plugin-inject": a spec is written into its own
# config file's plugin array, not a shared settings.json. Remove-HookConfigs
# does not cover it, so clean it here to avoid a dangling spec.
function Remove-OpenCodePlugin {
    $configs = @(
        (Join-Path $env:USERPROFILE ".config\opencode\opencode.jsonc"),
        (Join-Path $env:USERPROFILE ".config\opencode\opencode.json"),
        (Join-Path $env:USERPROFILE ".config\opencode\config.json")
    )

    foreach ($cfg in $configs) {
        if (-not (Test-Path $cfg)) { continue }
        $short = $cfg.Replace($env:USERPROFILE, "~")

        if (-not $script:NODE_BIN) {
            Msg "    ⚠️  跳过: $short (无 node,需手动清理)" "    ⚠️  Skipped: $short (node unavailable, manual cleanup needed)"
            continue
        }

        $result = & $script:NODE_BIN -e @'
const fs = require('fs');
const f = process.argv[1];
const isOurs = s => typeof s === 'string' && (s.includes('loongsuite-pilot-opencode') || s.includes('plugins/opencode/plugin.mjs'));
const entryStr = e => typeof e === 'string' ? e : (Array.isArray(e) ? String(e[0]) : '');
const stripJsonc = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/[ \t]+\/\/.*$/gm, '');
try {
  const raw = fs.readFileSync(f, 'utf-8');
  let data, hadComments = false;
  try { data = JSON.parse(raw); }
  catch { data = JSON.parse(stripJsonc(raw)); hadComments = true; }
  const key = Array.isArray(data.plugins) ? 'plugins' : (Array.isArray(data.plugin) ? 'plugin' : null);
  if (!key) { process.stdout.write('nochange'); process.exit(0); }
  const before = data[key].length;
  data[key] = data[key].filter(e => !isOurs(entryStr(e)));
  if (data[key].length === before) { process.stdout.write('nochange'); process.exit(0); }
  if (hadComments) fs.writeFileSync(f + '.bak', raw, 'utf-8');
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  process.stdout.write(hadComments ? 'cleaned-bak' : 'cleaned');
} catch (e) { process.stderr.write(e.message); process.exit(1); }
'@ $cfg 2>$null

        switch ($result) {
            "cleaned"     { Msg "    ✅ 已清理: $short" "    ✅ Cleaned: $short" }
            "cleaned-bak" { Msg "    ✅ 已清理: $short (含注释,原文件备份为 $short.bak)" "    ✅ Cleaned: $short (had comments, original backed up to $short.bak)" }
            "nochange"    { }
            default       { Msg "    ⚠️  跳过: $short (需手动清理)" "    ⚠️  Skipped: $short (manual cleanup needed)" }
        }
    }
}

function Remove-HermesPlugin {
    $hermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:USERPROFILE ".hermes" }
    $pluginDir = Join-Path $hermesHome "plugins\loongsuite-pilot"
    $stateFile = Join-Path $DataDir "deployed-agents.json"
    if (Test-Path $stateFile) {
        try {
            $state = Get-Content $stateFile -Raw | ConvertFrom-Json
            $recorded = $state.'hermes-agent'.targetDir
            if ($recorded -and [System.IO.Path]::IsPathRooted([string]$recorded)) {
                $pluginDir = [string]$recorded
            }
        } catch {
            # Fall back to the current HERMES_HOME-derived path.
        }
    }
    $marker = Join-Path $pluginDir ".loongsuite-pilot-managed.json"
    if (-not (Test-Path $marker)) { return }

    try {
        $meta = Get-Content $marker -Raw | ConvertFrom-Json
        if ($meta.owner -ne "loongsuite-pilot" -or $meta.agentId -ne "hermes-agent") {
            Msg "    ⚠️  保留未受 Pilot 管理的 Hermes 插件: $pluginDir" `
                "    ⚠️  Preserved unmanaged Hermes plugin: $pluginDir"
            return
        }
        $hermesCli = if ($env:HERMES_CLI) {
            $env:HERMES_CLI
        } else {
            Join-Path $hermesHome "hermes-agent\venv\Scripts\hermes.exe"
        }
        if (-not (Test-Path $hermesCli)) {
            $hermesCommand = Get-Command hermes -ErrorAction SilentlyContinue
            if ($hermesCommand) { $hermesCli = $hermesCommand.Source }
        }
        if (Test-Path $hermesCli) {
            & $hermesCli plugins disable loongsuite-pilot *> $null
        }
        Remove-Item $pluginDir -Recurse -Force
        Msg "    ✅ 已清理: $pluginDir" "    ✅ Cleaned: $pluginDir"
    } catch {
        Msg "    ⚠️  跳过: $pluginDir (需手动清理)" `
            "    ⚠️  Skipped: $pluginDir (manual cleanup needed)"
    }
}

# ============================================================
# Remove Pi Coding Agent extension injection
# ============================================================
function Remove-PiCodingAgentExtension {
    $cfg = Join-Path $env:USERPROFILE ".pi\agent\settings.json"
    $short = $cfg.Replace($env:USERPROFILE, "~")

    if (-not $script:NODE_BIN) {
        Msg "    ⚠️  跳过: $short (无 node,需手动清理)" "    ⚠️  Skipped: $short (node unavailable, manual cleanup needed)"
        return
    }

    $result = & $script:NODE_BIN -e @'
const fs = require('fs');
const path = require('path');
const defaultConfig = process.argv[1];
const dataDir = process.argv[2];
const targets = [{ configPath: defaultConfig, markers: ['loongsuite-pilot-pi-coding-agent', 'plugins/pi-coding-agent/index.mjs'] }];
const resolveValue = value => typeof value === 'string'
  ? value.replace(/^~(?=[\\/])/, process.env.USERPROFILE || '').replaceAll('$PILOT_DATA', dataDir)
  : value;
const stripJsoncComments = text => {
  let result = '';
  let index = 0;
  let inString = false;
  let escape = false;
  while (index < text.length) {
    const ch = text[index];
    if (inString) {
      result += ch;
      if (escape) escape = false;
      else if (ch.charCodeAt(0) === 92) escape = true;
      else if (ch === '"') inString = false;
      index++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      index++;
      continue;
    }
    if (ch === '/' && text[index + 1] === '/') {
      index += 2;
      while (index < text.length && text[index] !== '\n') index++;
      continue;
    }
    if (ch === '/' && text[index + 1] === '*') {
      index += 2;
      while (index + 1 < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++;
      index += 2;
      continue;
    }
    result += ch;
    index++;
  }
  return result;
};
const comparable = value => typeof value === 'string'
  ? value.split(String.fromCharCode(92)).join('/')
  : '';
const localDir = path.join(dataDir, 'agents.d.local');
try {
  for (const name of fs.existsSync(localDir) ? fs.readdirSync(localDir) : []) {
    if (!name.endsWith('.json')) continue;
    let def;
    try { def = JSON.parse(fs.readFileSync(path.join(localDir, name), 'utf8')); } catch { continue; }
    if (def?.piSdk?.schemaVersion !== 1 || !def?.pluginInject?.pluginId?.startsWith('loongsuite-pilot-pi-sdk-')) continue;
    const spec = resolveValue(def.pluginInject.pluginSpec);
    for (const configPath of def.pluginInject.configPaths || []) {
      targets.push({
        configPath: resolveValue(configPath),
        markers: [def.pluginInject.pluginId, spec, 'plugins/pi-coding-agent/agents/'].filter(Boolean),
      });
    }
  }
  let cleaned = 0;
  let skipped = 0;
  for (const target of targets) {
    if (!target.configPath || !fs.existsSync(target.configPath)) continue;
    try {
      const raw = fs.readFileSync(target.configPath, 'utf-8');
      const data = JSON.parse(stripJsoncComments(raw));
      if (!Array.isArray(data.extensions)) continue;
      const before = data.extensions.length;
      data.extensions = data.extensions.filter(entry => {
        const value = comparable(entry);
        return !target.markers.some(marker => value === comparable(marker) || value.includes(comparable(marker)));
      });
      if (data.extensions.length === before) continue;
      if (raw !== JSON.stringify(data, null, 2) + '\n') {
        try {
          fs.copyFileSync(target.configPath, target.configPath + '.bak', fs.constants.COPYFILE_EXCL);
        } catch (e) {
          if (e?.code !== 'EEXIST') throw e;
        }
      }
      fs.writeFileSync(target.configPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
      cleaned++;
    } catch {
      skipped++;
    }
  }
  process.stdout.write(cleaned > 0 ? (skipped > 0 ? 'partial' : 'cleaned') : (skipped > 0 ? 'skipped' : 'nochange'));
} catch (e) { process.stderr.write(e.message); process.exit(1); }
'@ $cfg $DATA_DIR 2>$null

    switch ($result) {
        "cleaned"  { Msg "    ✅ 已清理 Pi / PI SDK Agent 扩展配置" "    ✅ Cleaned Pi / PI SDK Agent extension configs" }
        "partial"  { Msg "    ⚠️  已清理可读取的 Pi 配置，部分损坏配置需手动清理" `
                         "    ⚠️  Cleaned readable Pi configs; some invalid configs need manual cleanup" }
        "skipped"  { Msg "    ⚠️  Pi 配置损坏，需手动清理" "    ⚠️  Invalid Pi configs skipped (manual cleanup needed)" }
        "nochange" { }
        default    { Msg "    ⚠️  跳过: $short (需手动清理)" "    ⚠️  Skipped: $short (manual cleanup needed)" }
    }
}

# ============================================================
# Remove plugin-inject specs (MiMo Code)
# ============================================================
# MiMo Code uses deployMode "plugin-inject": a spec is written into its own
# config file's plugin array. Same shape as Remove-OpenCodePlugin but for
# ~/.config/mimocode/mimocode.json[c]. Without this, the spec survives
# uninstall and points at a (possibly purged) plugin.mjs.
function Remove-MimoCodePlugin {
    $configs = @(
        (Join-Path $env:USERPROFILE ".config\mimocode\mimocode.jsonc"),
        (Join-Path $env:USERPROFILE ".config\mimocode\mimocode.json")
    )

    foreach ($cfg in $configs) {
        if (-not (Test-Path $cfg)) { continue }
        $short = $cfg.Replace($env:USERPROFILE, "~")

        if (-not $script:NODE_BIN) {
            Msg "    ⚠️  跳过: $short (无 node,需手动清理)" "    ⚠️  Skipped: $short (node unavailable, manual cleanup needed)"
            continue
        }

        $result = & $script:NODE_BIN -e @'
const fs = require('fs');
const f = process.argv[1];
const isOurs = s => typeof s === 'string' && (s.includes('loongsuite-pilot-mimo-code') || s.includes('plugins/mimo-code/plugin.mjs'));
const entryStr = e => typeof e === 'string' ? e : (Array.isArray(e) ? String(e[0]) : '');
const stripJsonc = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/[ \t]+\/\/.*$/gm, '');
try {
  const raw = fs.readFileSync(f, 'utf-8');
  let data, hadComments = false;
  try { data = JSON.parse(raw); }
  catch { data = JSON.parse(stripJsonc(raw)); hadComments = true; }
  const key = Array.isArray(data.plugins) ? 'plugins' : (Array.isArray(data.plugin) ? 'plugin' : null);
  if (!key) { process.stdout.write('nochange'); process.exit(0); }
  const before = data[key].length;
  data[key] = data[key].filter(e => !isOurs(entryStr(e)));
  if (data[key].length === before) { process.stdout.write('nochange'); process.exit(0); }
  if (hadComments) fs.writeFileSync(f + '.bak', raw, 'utf-8');
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  process.stdout.write(hadComments ? 'cleaned-bak' : 'cleaned');
} catch (e) { process.stderr.write(e.message); process.exit(1); }
'@ $cfg 2>$null

        switch ($result) {
            "cleaned"     { Msg "    ✅ 已清理: $short" "    ✅ Cleaned: $short" }
            "cleaned-bak" { Msg "    ✅ 已清理: $short (含注释,原文件备份为 $short.bak)" "    ✅ Cleaned: $short (had comments, original backed up to $short.bak)" }
            "nochange"    { }
            default       { Msg "    ⚠️  跳过: $short (需手动清理)" "    ⚠️  Skipped: $short (manual cleanup needed)" }
        }
    }
}

# ============================================================
# Remove OpenClaw's nested plugin entry and load path.
# ============================================================
function Remove-OpenClawPlugin {
    $stateDir = if ($env:OPENCLAW_STATE_DIR) {
        $env:OPENCLAW_STATE_DIR
    } else {
        Join-Path $env:USERPROFILE ".openclaw"
    }
    $configs = @()
    if ($env:OPENCLAW_CONFIG_PATH) { $configs += $env:OPENCLAW_CONFIG_PATH }
    $configs += @(
        (Join-Path $stateDir "openclaw.json"),
        (Join-Path $stateDir "config.json"),
        (Join-Path $env:USERPROFILE ".openclaw\openclaw.json"),
        (Join-Path $env:USERPROFILE ".openclaw\config.json")
    )
    $managedPath = Join-Path $DataDir "plugins\openclaw"
    $cleanupScript = @'
const fs = require('fs');
const f = process.env.PILOT_OC_CONFIG;
const managed = process.env.PILOT_OC_MANAGED.replaceAll('\\', '/');
const entryStr = value => typeof value === 'string'
  ? value
  : (Array.isArray(value) && typeof value[0] === 'string' ? value[0] : '');
const isOurs = value => {
  const normalized = entryStr(value).replaceAll('\\', '/');
  const plain = normalized.startsWith('file://') ? normalized.slice('file://'.length) : normalized;
  return plain === managed ||
    plain === managed + '/plugin.mjs' ||
    normalized.includes('loongsuite-pilot-openclaw') ||
    normalized.includes('plugins/openclaw/plugin.mjs') && plain.includes('.loongsuite-pilot/');
};
try {
  const data = JSON.parse(fs.readFileSync(f, 'utf-8'));
  let changed = false;
  for (const key of ['plugin', 'plugins']) {
    if (!Array.isArray(data[key])) continue;
    const filtered = data[key].filter(value => !isOurs(value));
    if (filtered.length !== data[key].length) { data[key] = filtered; changed = true; }
  }
  const plugins = data.plugins && typeof data.plugins === 'object' && !Array.isArray(data.plugins)
    ? data.plugins
    : null;
  if (plugins) {
    if (plugins.load && typeof plugins.load === 'object' && Array.isArray(plugins.load.paths)) {
      const filtered = plugins.load.paths.filter(value => !isOurs(value));
      if (filtered.length !== plugins.load.paths.length) { plugins.load.paths = filtered; changed = true; }
    }
    if (plugins.entries && typeof plugins.entries === 'object' && !Array.isArray(plugins.entries) &&
        Object.prototype.hasOwnProperty.call(plugins.entries, 'loongsuite-pilot-openclaw')) {
      delete plugins.entries['loongsuite-pilot-openclaw'];
      changed = true;
    }
  }
  if (!changed) { process.stdout.write('nochange'); process.exit(0); }
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  process.stdout.write('cleaned');
} catch (e) { process.stderr.write(e.message); process.exit(1); }
'@

    foreach ($cfg in ($configs | Select-Object -Unique)) {
        if (-not (Test-Path $cfg)) { continue }
        $short = $cfg.Replace($env:USERPROFILE, "~")
        if (-not $script:NODE_BIN) {
            Msg "    ⚠️  跳过: $short (无 node,需手动清理)" "    ⚠️  Skipped: $short (node unavailable, manual cleanup needed)"
            continue
        }

        $hadConfigEnv = Test-Path Env:PILOT_OC_CONFIG
        $hadManagedEnv = Test-Path Env:PILOT_OC_MANAGED
        $previousConfigEnv = $env:PILOT_OC_CONFIG
        $previousManagedEnv = $env:PILOT_OC_MANAGED
        try {
            $env:PILOT_OC_CONFIG = $cfg
            $env:PILOT_OC_MANAGED = $managedPath
            $result = $cleanupScript | & $script:NODE_BIN 2>$null
            if ($LASTEXITCODE -ne 0) { $result = "error" }
        } finally {
            if ($hadConfigEnv) { $env:PILOT_OC_CONFIG = $previousConfigEnv }
            else { Remove-Item Env:PILOT_OC_CONFIG -ErrorAction SilentlyContinue }
            if ($hadManagedEnv) { $env:PILOT_OC_MANAGED = $previousManagedEnv }
            else { Remove-Item Env:PILOT_OC_MANAGED -ErrorAction SilentlyContinue }
        }

        switch ($result) {
            "cleaned"  { Msg "    ✅ 已清理: $short" "    ✅ Cleaned: $short" }
            "nochange" { }
            default    { Msg "    ⚠️  跳过: $short (需手动清理)" "    ⚠️  Skipped: $short (manual cleanup needed)" }
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
        $content = Get-Content $claudeSettings -Raw -ErrorAction SilentlyContinue
        if ($content -match "otel-claude-hook|hook-entry") {
            $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
            & $script:NODE_BIN -e @'
const fs = require('fs');
const f = process.argv[1];
const isOurs = c => c.includes('otel-claude-hook') || c.includes('hook-entry.sh');
try {
  const d = JSON.parse(fs.readFileSync(f, 'utf-8'));
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

function Start-PilotAndWait {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,
        [int]$TimeoutSeconds = 30
    )

    if (-not (Test-Path -LiteralPath $ScriptPath)) { return $false }

    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $startOutput = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ScriptPath start 2>&1
    $startExit = $LASTEXITCODE
    $startOutput | ForEach-Object { Write-Host $_ }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $statusOutput = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ScriptPath status 2>$null
        if ($statusOutput -match "is running") {
            $ErrorActionPreference = $prevEAP
            return $true
        }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)

    $ErrorActionPreference = $prevEAP
    if ($startExit -ne 0) {
        Write-Host "   start command exited with code $startExit" -ForegroundColor Yellow
    }
    return $false
}

# ============================================================
# CMD: install
# ============================================================
function Cmd-Install {
    Msg "==> 开始安装 $PACKAGE_NAME ..." "==> Installing $PACKAGE_NAME ..."
    Write-Host ""

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
        Inject-QoderworkRuntimeWrapper

        Msg "==> 启动服务..." "==> Starting service..."
        $ps1Path = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot-service.ps1"
        $started = Start-PilotAndWait -ScriptPath $ps1Path
        if (-not $started) {
            if ($curVer -and (Test-Path (Join-Path $CACHE_DIR "previous"))) {
                Msg "⚠️  新安装未产生运行心跳，正在恢复 previous 版本..." `
                    "⚠️  The new installation produced no runtime heartbeat; restoring the previous version..."
                $prevEAP = $ErrorActionPreference
                $ErrorActionPreference = "Continue"
                & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ps1Path rollback 2>$null
                $ErrorActionPreference = $prevEAP
            }
            throw "Collector failed to produce a runtime heartbeat after installation."
        }
        Msg "    ✅ 服务已启动" "    ✅ Service started"
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
        Inject-QoderworkRuntimeWrapper

        Msg "==> 启动新版本..." "==> Starting new version..."
        $ps1Path = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot-service.ps1"
        $started = Start-PilotAndWait -ScriptPath $ps1Path
        if ($started) {
            Msg "    ✅ 新版本启动成功" "    ✅ New version started successfully"
            Write-Host ""
            GC-OldVersions
            Print-Summary "upgrade"
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

# Write UTF-8 *without BOM* in a way that works under Constrained Language Mode (WDAC),
# where [System.IO.File]::WriteAllText / New-Object UTF8Encoding are forbidden. We stage the
# content through a temp file (Set-Content prepends a BOM) and let node rewrite it BOM-free,
# because these files (.codex/hooks.json, config.toml) are read by node/Codex, which choke
# on a BOM. Falls back to Set-Content (with BOM) only if node is somehow unavailable.
function Write-FileUtf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )
    if (-not $script:NODE_BIN) {
        Set-Content -LiteralPath $Path -Value $Content -Encoding UTF8 -NoNewline
        return
    }
    $tmp = Join-Path $env:TEMP ("lp-write-" + (Get-Random) + ".tmp")
    Set-Content -LiteralPath $tmp -Value $Content -Encoding UTF8 -NoNewline
    # Windows PowerShell 5.1 strips nested double quotes while marshalling a
    # single-quoted -e argument to a native executable. Keep the JavaScript in a
    # here-string and use JS single-quoted literals so node receives the quotes.
    $rewriteScript = @'
const fs = require('fs');
let content = fs.readFileSync(process.argv[1], 'utf-8');
if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
fs.writeFileSync(process.argv[2], content);
'@
    $rewriteExit = 1
    $prevEAP = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & $script:NODE_BIN -e $rewriteScript $tmp $Path
        $rewriteExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEAP
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
    if ($rewriteExit -ne 0) { throw "Failed to write UTF-8 file: $Path" }
}

function Remove-CodexTrustState {
    $configPath = Join-Path $env:USERPROFILE ".codex\config.toml"
    if (-not (Test-Path -LiteralPath $configPath)) { return }

    $content = Get-Content -LiteralPath $configPath -Raw
    $pattern = '(?ms)^[ \t]*# BEGIN otel-codex-hook trust[ \t]*\r?\n.*?^[ \t]*# END otel-codex-hook trust[ \t]*(?:\r?\n)?'
    $updated = $content -replace $pattern, ""
    if ($updated -eq $content) { return }

    $updated = $updated -replace '(\r?\n){3,}', "`r`n`r`n"
    Write-FileUtf8NoBom -Path $configPath -Content $updated
    Msg "    ✅ Codex trust 状态已清理" "    ✅ Codex trust state cleaned"
}

function Test-IsPilotCodexHookCommand {
    param([object]$Command)
    if ($null -eq $Command) { return $false }
    return ([string]$Command) -match '(?i)(?:\.loongsuite-pilot|codex-loongsuite-pilot-hook|otel-codex-hook)'
}

function Remove-CodexHookConfig {
    $configPath = Join-Path $env:USERPROFILE ".codex\hooks.json"
    if (-not (Test-Path -LiteralPath $configPath)) { return }

    try {
        # Get-Content -Encoding UTF8 handles both BOM and no-BOM files and is CLM-safe,
        # unlike [System.IO.File]::ReadAllText.
        $raw = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
        $data = $raw | ConvertFrom-Json
        if (-not $data.hooks -or
            $null -eq $data.hooks.PSObject -or
            $null -eq $data.hooks.PSObject.Properties) {
            return
        }

        $changed = $false
        $eventProperties = @(
            $data.hooks.PSObject.Properties |
                Where-Object { $null -ne $_ -and -not [string]::IsNullOrWhiteSpace($_.Name) }
        )
        if ($eventProperties.Count -eq 0) { return }

        foreach ($eventProperty in $eventProperties) {
            $eventName = $eventProperty.Name
            $entries = @($eventProperty.Value)
            $keptEntries = @()

            foreach ($entry in $entries) {
                # Preserve malformed or extension-owned null/scalar entries. They
                # are not Pilot commands and uninstall must not fail on them.
                if ($null -eq $entry -or $null -eq $entry.PSObject) {
                    $keptEntries += ,$entry
                    continue
                }

                $commandProperty = $entry.PSObject.Properties["command"]
                $directCommand = if ($commandProperty) { $commandProperty.Value } else { $null }
                if (Test-IsPilotCodexHookCommand $directCommand) {
                    $changed = $true
                    continue
                }

                $nestedProperty = $entry.PSObject.Properties["hooks"]
                if ($nestedProperty -and $null -ne $nestedProperty.Value) {
                    $nestedHooks = @($nestedProperty.Value)
                    $keptNestedHooks = @(
                        $nestedHooks | Where-Object {
                            if ($null -eq $_ -or $null -eq $_.PSObject) {
                                return $true
                            }
                            $nestedCommandProperty = $_.PSObject.Properties["command"]
                            $nestedCommand = if ($nestedCommandProperty) {
                                $nestedCommandProperty.Value
                            } else {
                                $null
                            }
                            -not (Test-IsPilotCodexHookCommand $nestedCommand)
                        }
                    )
                    if ($keptNestedHooks.Count -ne $nestedHooks.Count) {
                        $changed = $true
                        $entry.hooks = @($keptNestedHooks)
                    }
                    if ($nestedHooks.Count -gt 0 -and $keptNestedHooks.Count -eq 0) {
                        continue
                    }
                }

                $keptEntries += ,$entry
            }

            if ($keptEntries.Count -eq 0) {
                $data.hooks.PSObject.Properties.Remove($eventName)
            } else {
                $data.hooks.$eventName = @($keptEntries)
            }
        }

        if ($changed) {
            $updated = ($data | ConvertTo-Json -Depth 100) + "`r`n"
            Write-FileUtf8NoBom -Path $configPath -Content $updated
        }

        # Do not report success until the resulting config is independently
        # checked for both direct and nested Pilot commands.
        $verifyData = (
            Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 |
                ConvertFrom-Json
        )
        if ($verifyData.hooks) {
            $verifyEventProperties = @(
                $verifyData.hooks.PSObject.Properties |
                    Where-Object { $null -ne $_ -and -not [string]::IsNullOrWhiteSpace($_.Name) }
            )
            foreach ($eventProperty in $verifyEventProperties) {
                foreach ($entry in @($eventProperty.Value)) {
                    if ($null -eq $entry -or $null -eq $entry.PSObject) { continue }

                    $commandProperty = $entry.PSObject.Properties["command"]
                    $directCommand = if ($commandProperty) { $commandProperty.Value } else { $null }
                    if (Test-IsPilotCodexHookCommand $directCommand) {
                        throw "Pilot Codex hook command is still present"
                    }

                    $nestedProperty = $entry.PSObject.Properties["hooks"]
                    $nestedHooks = if ($nestedProperty) { @($nestedProperty.Value) } else { @() }
                    foreach ($nestedHook in $nestedHooks) {
                        if ($null -eq $nestedHook -or $null -eq $nestedHook.PSObject) { continue }
                        $nestedCommandProperty = $nestedHook.PSObject.Properties["command"]
                        $nestedCommand = if ($nestedCommandProperty) {
                            $nestedCommandProperty.Value
                        } else {
                            $null
                        }
                        if (Test-IsPilotCodexHookCommand $nestedCommand) {
                            throw "Pilot Codex nested hook command is still present"
                        }
                    }
                }
            }
        }

        if ($changed) {
            Msg "    ✅ 已清理: ~\.codex\hooks.json" `
                "    ✅ Cleaned: ~\.codex\hooks.json"
        }
    } catch {
        throw "Failed to clean Pilot hooks from $configPath`: $($_.Exception.Message)"
    }
}

function Remove-OnePilotScheduledTask {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TaskName,
        [Parameter(Mandatory = $true)]
        [string]$TaskPath
    )

    $task = Get-ScheduledTask `
        -TaskName $TaskName `
        -TaskPath $TaskPath `
        -ErrorAction SilentlyContinue
    if (-not $task) { return }

    if ($task.State -eq "Running") {
        Stop-ScheduledTask `
            -TaskName $TaskName `
            -TaskPath $TaskPath `
            -ErrorAction SilentlyContinue
    }

    $unregisterError = $null
    try {
        Unregister-ScheduledTask `
            -TaskName $TaskName `
            -TaskPath $TaskPath `
            -Confirm:$false `
            -ErrorAction Stop
    } catch {
        $unregisterError = $_.Exception.Message
        $fullTaskName = "$($TaskPath.TrimEnd('\'))\$TaskName"
        & schtasks.exe /Delete /TN $fullTaskName /F 2>$null | Out-Null
        $schtasksExit = $LASTEXITCODE
        if ($schtasksExit -ne 0) {
            throw "Failed to remove scheduled task $fullTaskName (Unregister-ScheduledTask: $unregisterError; schtasks exit: $schtasksExit). Run uninstall from an elevated PowerShell."
        }
    }

    $remaining = Get-ScheduledTask `
        -TaskName $TaskName `
        -TaskPath $TaskPath `
        -ErrorAction SilentlyContinue
    if ($remaining) {
        $fullTaskName = "$($TaskPath.TrimEnd('\'))\$TaskName"
        throw "Scheduled task still exists after deletion: $fullTaskName"
    }
}

function Remove-PilotScheduledTasks {
    $taskFolder = "\LoongsuitePilot"
    $currentIdentity = (whoami).Trim()
    $currentUser = $env:USERNAME
    $userTag = ($currentIdentity -replace '[^A-Za-z0-9._-]', '_')
    $currentUserTasks = @(
        "LoongsuitePilot-$userTag",
        "LoongsuitePilotUpdater-$userTag"
    )
    $legacyTasks = @("LoongsuitePilot", "LoongsuitePilotUpdater")

    foreach ($taskName in @($currentUserTasks + $legacyTasks)) {
        $isLegacy = $taskName -in $legacyTasks
        $task = Get-ScheduledTask `
            -TaskName $taskName `
            -TaskPath "$taskFolder\" `
            -ErrorAction SilentlyContinue
        if ($isLegacy) {
            if (-not $task) { continue }
            $taskOwner = [string]$task.Principal.UserId
            $isCurrentOwner = (
                -not $taskOwner -or
                $taskOwner -ieq $currentIdentity -or
                $taskOwner -ieq $currentUser -or
                $taskOwner.ToLower().EndsWith("\$currentUser".ToLower())
            )
            if (-not $isCurrentOwner) { continue }
        }

        Remove-OnePilotScheduledTask `
            -TaskName $taskName `
            -TaskPath "$taskFolder\"
    }
}

function Assert-SafePilotDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Purpose
    )

    # CLM-safe path normalization: Convert-Path resolves the absolute path without the
    # forbidden [System.IO.Path]::GetFullPath; fall back to the raw path if it can't be
    # resolved (e.g. it no longer exists). Split-Path -Qualifier gives the drive root ("C:").
    $fullPath = $Path
    try { $fullPath = (Convert-Path -LiteralPath $Path -ErrorAction Stop) } catch { $fullPath = $Path }
    $fullPath = $fullPath.TrimEnd('\')
    $rootPath = (Split-Path -Qualifier $fullPath -ErrorAction SilentlyContinue)
    $profilePath = $env:USERPROFILE.TrimEnd('\')
    if (-not $fullPath -or $fullPath -ieq $rootPath -or $fullPath -ieq "$rootPath\" -or $fullPath -ieq $profilePath) {
        throw "Refusing to use unsafe $Purpose directory: $Path"
    }
    return $fullPath
}

function ConvertTo-ExtendedLengthPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $fullPath = $Path
    try { $fullPath = (Convert-Path -LiteralPath $Path -ErrorAction Stop) } catch { $fullPath = $Path }
    if ($fullPath.StartsWith("\\?\")) { return $fullPath }
    if ($fullPath.StartsWith("\\")) {
        return "\\?\UNC\$($fullPath.Substring(2))"
    }
    return "\\?\$fullPath"
}

function Remove-PilotPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) { return }
    $extendedPath = ConvertTo-ExtendedLengthPath -Path $Path
    $lastError = $null
    $isFullLanguage = $ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage'
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            if ($isFullLanguage) {
                # Fast path: .NET calls handle the \\?\ extended-length path (deep node_modules
                # trees that exceed MAX_PATH). Available only under Full Language Mode.
                if ([System.IO.Directory]::Exists($extendedPath)) {
                    [System.IO.Directory]::Delete($extendedPath, $true)
                } elseif ([System.IO.File]::Exists($extendedPath)) {
                    [System.IO.File]::SetAttributes($extendedPath, [System.IO.FileAttributes]::Normal)
                    [System.IO.File]::Delete($extendedPath)
                }
            } else {
                # Constrained Language Mode (WDAC): the .NET calls above are forbidden. Fall
                # back to Remove-Item on the original path — covers all but pathological >260-char
                # paths, which are rare and can be cleaned manually if they ever surface.
                Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
            }
            return
        } catch {
            $lastError = $_
            if ($attempt -lt 3) { Start-Sleep -Milliseconds (100 * $attempt) }
        }
    }
    throw $lastError
}

function Remove-PilotInstallationFiles {
    $cachePath = Assert-SafePilotDirectory -Path $CACHE_DIR -Purpose "cache"
    $dataPath = Assert-SafePilotDirectory -Path $DataDir -Purpose "data"
    $cachePrefix = $cachePath + '\'
    $cacheContainsData = $dataPath.ToLower().StartsWith($cachePrefix.ToLower())

    if ($cachePath -ine $dataPath -and -not $cacheContainsData) {
        if (Test-Path -LiteralPath $cachePath) {
            Remove-PilotPath -Path $cachePath
        }
    } else {
        foreach ($relativePath in @(
            "versions",
            "bin",
            "package",
            "current",
            "previous",
            "node-bin"
        )) {
            $target = Join-Path $cachePath $relativePath
            if (Test-Path -LiteralPath $target) {
                Remove-PilotPath -Path $target
            }
        }
    }

    foreach ($relativePath in @("hooks", "skills", "plugins")) {
        $target = Join-Path $dataPath $relativePath
        if (Test-Path -LiteralPath $target) {
            Remove-PilotPath -Path $target
        }
    }
}

# ============================================================
# Remove the Pilot-owned DeepSeek Harness YAML patch before plugin assets.
# Unix and Windows both execute assets/plugins/dsh/cleanup.mjs.
# ============================================================
function Remove-DshYamlPatch {
    $pluginDir = Join-Path $DataDir "plugins\dsh"
    $cleanupScript = Join-Path $pluginDir "cleanup.mjs"
    $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
    $patchPath = Join-Path $dshHome "cordis.patch.yml"

    # DSH_HOME may differ between install and uninstall. Prefer the exact path
    # persisted by DeploymentManager, with the current environment as a legacy fallback.
    $stateFile = Join-Path $DataDir "deployed-agents.json"
    if (Test-Path -LiteralPath $stateFile) {
        try {
            $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
            $persistedPatch = $state.dsh.dshPatchPath
            if ($persistedPatch -and ([string]$persistedPatch -match '^(?:[A-Za-z]:[\\/]|\\\\)')) {
                $patchPath = [string]$persistedPatch
            }
        } catch {
            # Preserve compatibility with missing or legacy state and use the fallback above.
        }
    }

    if (-not (Test-Path -LiteralPath $cleanupScript)) {
        if ((Test-Path -LiteralPath $patchPath) -and
            (Select-String -LiteralPath $patchPath -SimpleMatch "# BEGIN PILOT-OBSERVABILITY-MANAGED" -Quiet)) {
            throw "DSH cleanup helper is missing; refusing to remove plugin assets still referenced by $patchPath"
        }
        return
    }
    if (-not $script:NODE_BIN) {
        throw "No usable Node.js; cannot safely remove the DSH YAML patch"
    }

    & $script:NODE_BIN $cleanupScript --patch $patchPath --plugin-dir $pluginDir
    if ($LASTEXITCODE -ne 0) {
        throw "DSH YAML patch cleanup failed; Pilot assets were preserved"
    }
    Msg "    ✅ 已清理 DSH YAML patch" "    ✅ Cleaned DSH YAML patch"
}

# ============================================================
# CMD: uninstall
# ============================================================
function Cmd-Uninstall {
    Msg "🗑️  开始卸载 $PACKAGE_NAME ..." "🗑️  Uninstalling $PACKAGE_NAME ..."
    Write-Host ""

    Msg "==> 停止服务..." "==> Stopping service..."
    Stop-PilotService
    Msg "    ✅ 服务已停止" "    ✅ Service stopped"
    Write-Host ""

    Remove-PilotScheduledTasks
    Msg "    ✅ 已移除计划任务" "    ✅ Removed scheduled tasks"

    # Resolve the pinned runtime before installation files (including node-bin)
    # are removed. JSON config cleanup must also work when Node is absent from PATH.
    $script:NODE_BIN = Resolve-Node

    Msg "==> 清理 DSH YAML patch..." "==> Cleaning up DSH YAML patch..."
    Remove-DshYamlPatch
    Write-Host ""

    # Read the persisted target before the default data/install directory is removed.
    Msg "==> 清理 Hermes 插件..." "==> Cleaning up Hermes plugin..."
    Remove-HermesPlugin
    Write-Host ""

    Msg "==> 清理 OpenClaw 插件配置..." "==> Cleaning up OpenClaw plugin config..."
    Remove-OpenClawPlugin
    Write-Host ""

    Msg "==> 清理 hook 配置..." "==> Cleaning up hook configs..."
    Remove-HookConfigs
    try {
        Remove-CodexHookConfig
    } catch {
        Msg "    ⚠️  Codex hook 清理失败，继续卸载: $($_.Exception.Message)" `
            "    ⚠️  Codex hook cleanup failed; continuing uninstall: $($_.Exception.Message)"
    }
    try {
        Remove-CodexTrustState
    } catch {
        Msg "    ⚠️  Codex trust 清理失败，继续卸载: $($_.Exception.Message)" `
            "    ⚠️  Codex trust cleanup failed; continuing uninstall: $($_.Exception.Message)"
    }
    Write-Host ""

    Msg "==> 清理 QoderWork 系列环境变量..." "==> Cleaning up QoderWork-family env vars..."
    $wrapperPath = Join-Path $DataDir "hooks\qoderwork-runtime-wrapper.mjs"
    $script:RUNTIME_ENV_BROADCAST_FAILED = $false
    foreach ($envName in @('QW_QODER_WORKER_RUNTIME_PATH', 'QODER_WORKER_RUNTIME_PATH')) {
        $currentRuntime = Get-PilotRuntimeOverride -Name $envName
        if ($currentRuntime -and $currentRuntime -ieq $wrapperPath) {
            $broadcasted = Remove-PilotRuntimeOverride -Name $envName
            if (-not $broadcasted) { $script:RUNTIME_ENV_BROADCAST_FAILED = $true }
            Msg "    ✅ 已移除 $envName" "    ✅ Removed $envName"
        }
    }
    if ($script:RUNTIME_ENV_BROADCAST_FAILED) {
        Msg "    ⚠️  请注销并重新登录 Windows 以刷新 Explorer 环境" `
            "    ⚠️  Sign out and back in to refresh the Explorer environment"
    }
    Write-Host ""

    Msg "==> 清理 Claude/Codex 插件..." "==> Cleaning up Claude/Codex plugins..."
    Remove-OtelPlugin
    Write-Host ""

    Msg "==> 清理 OpenCode 插件配置..." "==> Cleaning up OpenCode plugin config..."
    Remove-OpenCodePlugin
    Write-Host ""

    Msg "==> 清理 Pi Coding Agent Extension 配置..." "==> Cleaning up Pi Coding Agent extension config..."
    Remove-PiCodingAgentExtension
    Write-Host ""

    Msg "==> 清理 MiMo Code 插件配置..." "==> Cleaning up MiMo Code plugin config..."
    Remove-MimoCodePlugin
    Write-Host ""

    # Keep the pinned node runtime and deployed helper assets available until
    # every external config and runtime override has been cleaned. In
    # particular, never leave a User env var pointing at a deleted wrapper.
    Msg "==> 删除安装目录..." "==> Removing installation..."
    Remove-PilotInstallationFiles
    Msg "    ✅ 已删除安装文件" "    ✅ Removed installation files"

    Msg "==> 删除 loongsuite-pilot 命令..." "==> Removing loongsuite-pilot command..."
    $cmdFile = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot.cmd"
    $ps1File = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot-service.ps1"
    $legacyPs1File = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot.ps1"
    $layoutFile = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot-layout.json"
    if (Test-Path $cmdFile) { Remove-Item $cmdFile -Force }
    if (Test-Path $ps1File) { Remove-Item $ps1File -Force }
    if (Test-Path $legacyPs1File) { Remove-Item $legacyPs1File -Force }
    if (Test-Path $layoutFile) { Remove-Item $layoutFile -Force }
    Msg "    ✅ loongsuite-pilot 命令已删除" "    ✅ loongsuite-pilot command removed"
    Write-Host ""

    if ($Purge) {
        Msg "==> 删除数据目录 (-Purge)..." "==> Removing data directory (-Purge)..."
        $safeDataDir = Assert-SafePilotDirectory -Path $DataDir -Purpose "data"
        if (Test-Path -LiteralPath $safeDataDir) {
            Remove-PilotPath -Path $safeDataDir
        }
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
        Write-Host "Usage: .\installer-opensource.ps1 {install|upgrade|uninstall} [options]"
        exit 1
    }
}
