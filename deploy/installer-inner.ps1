# installer-inner.ps1 — Internal installer for loongsuite-pilot (Windows)
#
# Install (first time):
#   irm <URL>/installer.ps1 | iex
#   .\installer-inner.ps1 install `
#     -SlsEndpoint "https://cn-hangzhou.log.aliyuncs.com" `
#     -SlsProject "my-project" `
#     -SlsLogstore "my-logstore" `
#     -SlsAkId "your-ak-id" `
#     -SlsAkSecret "your-ak-secret"
#
# Install from test channel:
#   .\installer-inner.ps1 install -Channel test
#
# Upgrade (preserve config, auto-rollback on failure):
#   .\installer-inner.ps1 upgrade
#   .\installer-inner.ps1 upgrade -PackageUrl <url>
#
# Uninstall:
#   .\installer-inner.ps1 uninstall
#   .\installer-inner.ps1 uninstall -Purge

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
    [switch]$Purge,
    [switch]$PreferSystemNode
)

$ErrorActionPreference = "Stop"

# ============================================================
# Constants
# ============================================================
$PACKAGE_NAME = "loongsuite-pilot"
$DEFAULT_DATA_DIR = Join-Path $env:USERPROFILE ".loongsuite-pilot"
$PERMANENT_DIR = Join-Path $DEFAULT_DATA_DIR "package"

$OTEL_CLAUDE_DIR = Join-Path $env:USERPROFILE ".cache\opentelemetry.instrumentation.claude"
$OTEL_CODEX_DIR = Join-Path $env:USERPROFILE ".cache\opentelemetry.instrumentation.codex"

$_RELEASE_BASE_URL = "https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite/loongsuite-pilot"
$_TEST_BASE_URL = "https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-dev/loongsuite-pilot"

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
# Resolve package URL from channel + version
# ============================================================
$UPDATE_PACKAGE_URL = ""
if (-not $PackageUrl) {
    $channelBase = switch -Regex ($Channel) {
        "^(release|prod)$" { $_RELEASE_BASE_URL }
        "^(test|pre)$"     { $_TEST_BASE_URL }
        "^test-[a-zA-Z0-9]+$" {
            $base = $_TEST_BASE_URL -replace '/loongsuite-pilot$', ''
            "$base/$Channel/loongsuite-pilot"
        }
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
# Download and extract package
# ============================================================
$script:INSTALL_SRC = ""

function Download-AndExtract {
    $tmpDir = Join-Path $env:TEMP "loongsuite-pilot-install-$(Get-Random)"
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

    # Try tar (available on Windows 10+)
    $extracted = $false
    if (Get-Command tar -ErrorAction SilentlyContinue) {
        try {
            & tar -xzf $archivePath -C $tmpDir 2>$null
            $extracted = $true
        } catch {}
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
        & $script:NODE_BIN $postinstallScript
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
# Write config.json (inner version: SLS array format + data_config.json)
# ============================================================
function Write-Config {
    $configFile = Join-Path $DataDir "config.json"
    $innerDataConfigDir = Join-Path $DataDir "configs\inner"
    $innerDataConfigFile = Join-Path $innerDataConfigDir "data_config.json"

    Msg "==> 写入配置文件 $configFile ..." "==> Writing config to $configFile ..."
    if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
    if (-not (Test-Path $innerDataConfigDir)) { New-Item -ItemType Directory -Path $innerDataConfigDir -Force | Out-Null }

    # Bundle all params as JSON to avoid PowerShell dropping empty-string args to native commands
    $cfgArgs = [ordered]@{
        configPath          = $configFile
        innerDataConfigPath = $innerDataConfigFile
        dataDir             = $DataDir
        slsEndpoint         = "$SlsEndpoint"
        slsProject          = "$SlsProject"
        slsLogstore         = "$SlsLogstore"
        slsAkId             = "$SlsAkId"
        slsAkSecret         = "$SlsAkSecret"
        logLevel            = "$LogLevel"
        userId              = "$($script:UserId)"
        updateUrl           = "$UPDATE_PACKAGE_URL"
    }
    $cfgJson = $cfgArgs | ConvertTo-Json -Compress

    # Pipe the JSON through stdin instead of a temp file: writing UTF-8 *without BOM*
    # requires .NET calls that Constrained Language Mode (WDAC) forbids, and a BOM would
    # break node's JSON.parse. node reads fd 0, so no file — and no CLM-blocked APIs.
    $cfgJson | & $script:NODE_BIN -e @'
const fs = require('fs');
const opts = JSON.parse(fs.readFileSync(0, 'utf-8'));

let existing = {};
try { existing = JSON.parse(fs.readFileSync(opts.configPath, 'utf-8')); } catch {}

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

const INTERNAL_SLS = {
  name: 'internal-sls',
  endpoint: 'https://cn-heyuan.log.aliyuncs.com',
  project: 'ai-coding-devops',
  logstore: 'loongsuite_pilot_for_ai_coding',
  mode: 'webtracking',
};

if (opts.slsProject && opts.slsLogstore) {
  const userEp = {
    name: 'user-sls',
    endpoint: opts.slsEndpoint || INTERNAL_SLS.endpoint,
    project: opts.slsProject,
    logstore: opts.slsLogstore,
    mode: (opts.slsAkId && opts.slsAkSecret) ? 'ak' : 'webtracking',
  };
  if (opts.slsAkId && opts.slsAkSecret) {
    userEp.accessKeyId = opts.slsAkId;
    userEp.accessKeySecret = opts.slsAkSecret;
  }
  config.sls = [userEp];
} else {
  delete config.sls;
}

if (opts.logLevel) config.logLevel = opts.logLevel;
if (opts.userId) { config.userId = opts.userId; delete config.identity; }
if (opts.updateUrl) {
  config.autoUpdate = config.autoUpdate || {};
  config.autoUpdate.packageUrl = opts.updateUrl;
}

fs.writeFileSync(opts.configPath, JSON.stringify(config, null, 2) + '\n');

const innerDataConfig = { sls: [INTERNAL_SLS] };
fs.writeFileSync(opts.innerDataConfigPath, JSON.stringify(innerDataConfig, null, 2) + '\n');
'@

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
        # forbids — the registry write above already persisted the value, so we just swallow
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

    if (Test-Path (Join-Path $OTEL_CLAUDE_DIR "package\src\cli.js")) {
        Write-Host ""
        Msg "💡 Claude Code 插件已安装" "💡 Claude Code plugin installed"
    }

    if (Test-Path (Join-Path $OTEL_CODEX_DIR "package\dist\index.js")) {
        Msg "💡 Codex 插件已安装" "💡 Codex plugin installed"
        Msg "   如果正在使用 Codex 桌面版，请重启 App 以使 hooks 生效。" `
            "   If using Codex Desktop, restart the app for hooks to take effect."
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

    # Also try the loongsuite-pilot command
    $cmdPath = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot.cmd"
    if (Test-Path $cmdPath) {
        $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
        & $cmdPath stop 2>$null
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
  if (changed) {
    fs.writeFileSync(cfg, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }
} catch(e) { process.stderr.write(e.message); process.exit(1); }
'@ $cfg $HOOK_MARKER 2>$null
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
    # Clean Claude settings.json hooks
    $claudeSettings = Join-Path $env:USERPROFILE ".claude\settings.json"
    if ((Test-Path $claudeSettings) -and $script:NODE_BIN) {
        $content = Get-Content $claudeSettings -Raw -ErrorAction SilentlyContinue
        if ($content -match "otel-claude-hook|hook-entry") {
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
            Msg "    ✅ settings.json hooks 已清理" "    ✅ settings.json hooks cleaned"
        }
    }

    # Clean Codex config.toml trust block
    $codexConfig = Join-Path $env:USERPROFILE ".codex\config.toml"
    if (Test-Path $codexConfig) {
        $content = Get-Content $codexConfig -Raw -ErrorAction SilentlyContinue
        if ($content -match "# BEGIN otel-codex-hook trust") {
            & $script:NODE_BIN -e @'
const fs = require('fs');
const f = process.argv[1];
try {
  const lines = fs.readFileSync(f, 'utf-8').split('\n');
  let skip = false;
  const out = lines.filter(l => {
    if (l.includes('# BEGIN otel-codex-hook trust')) { skip = true; return false; }
    if (l.includes('# END otel-codex-hook trust')) { skip = false; return false; }
    return !skip;
  });
  fs.writeFileSync(f, out.join('\n'));
} catch {}
'@ $codexConfig 2>$null
            Msg "    ✅ config.toml trust block 已清理" "    ✅ config.toml trust block cleaned"
        }

        # Remove remaining otel-codex-hook lines
        $content = Get-Content $codexConfig -Raw -ErrorAction SilentlyContinue
        if ($content -match "otel-codex-hook") {
            $lines = Get-Content $codexConfig | Where-Object { $_ -notmatch "otel-codex-hook" }
            Set-Content -Path $codexConfig -Value ($lines -join "`n")
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
        Deploy-Package $script:INSTALL_SRC
        Write-Config
        Install-Command

        Msg "==> 启动服务..." "==> Starting service..."
        $cmdPath = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot.cmd"
        if (Test-Path $cmdPath) {
            $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
            & $cmdPath start 2>$null
            Start-Sleep -Seconds 2
            $statusOut = & $cmdPath status 2>$null
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
        $cmdPath = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot.cmd"
        $started = $false
        if (Test-Path $cmdPath) {
            $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
            & $cmdPath start 2>$null
            Start-Sleep -Seconds 2
            $statusOut = & $cmdPath status 2>$null
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
            if (Test-Path $cmdPath) {
                $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
                & $cmdPath stop 2>$null
                & $cmdPath rollback 2>$null
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
    # $env:USERNAME 而非 [Environment]::UserName:后者是 CLM(WDAC/Device Guard)禁止的 .NET 静态成员访问,
    # 受限环境下卸载一进本函数即抛错,恰好击穿本 CR 的 CLM 卸载目标。环境变量语义等价且 CLM 安全。
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

    Msg "==> 清理 hook 配置..." "==> Cleaning up hook configs..."
    Remove-HookConfigs
    Write-Host ""

    Msg "==> 清理 Claude/Codex 插件..." "==> Cleaning up Claude/Codex plugins..."
    Remove-OtelPlugin
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
        Write-Host "Usage: .\installer-inner.ps1 {install|upgrade|uninstall} [options]"
        exit 1
    }
}
