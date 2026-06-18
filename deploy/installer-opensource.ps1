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
    [switch]$Purge
)

$ErrorActionPreference = "Stop"

# ============================================================
# Constants
# ============================================================
$PACKAGE_NAME = "loongsuite-pilot"
$DEFAULT_DATA_DIR = Join-Path $env:USERPROFILE ".loongsuite-pilot"
$PERMANENT_DIR = Join-Path $DEFAULT_DATA_DIR "package"

$_OSS_BASE_URL = "https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot"

# ============================================================
# Defaults
# ============================================================
if (-not $DataDir) { $DataDir = $DEFAULT_DATA_DIR }
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
    try {
        $culture = [System.Globalization.CultureInfo]::CurrentUICulture.Name
        if ($culture -match "zh") { return "zh" }
    } catch {}
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

# ============================================================
# Check dependencies
# ============================================================
$script:NODE_BIN = ""
$script:NPM_BIN = ""

function Check-Deps {
    Msg "==> 检查依赖..." "==> Checking dependencies..."

    $script:NODE_BIN = Resolve-Node
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

    $archivePath = Join-Path $tmpDir "package.zip"

    Msg "==> 下载安装包: $PackageUrl" "==> Downloading: $PackageUrl"

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $PackageUrl -OutFile $archivePath -UseBasicParsing
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
    if (Test-Path $probeScript) {
        try {
            $script:PROBE_RESULT = & $script:NODE_BIN $probeScript 2>$null
            if (-not $script:PROBE_RESULT) { $script:PROBE_RESULT = "[]" }
        } catch {
            Msg "    ⚠️  Agent 探测失败，将跳过选择" "    ⚠️  Agent probe failed, skipping selection"
            $script:PROBE_RESULT = "[]"
        }
    }
    $count = & $script:NODE_BIN -e "const r=JSON.parse(process.argv[1]);process.stdout.write(String(r.length))" $script:PROBE_RESULT 2>$null
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

    $agentCount = & $script:NODE_BIN -e "const r=JSON.parse(process.argv[1]);process.stdout.write(String(r.length))" $script:PROBE_RESULT 2>$null
    if (-not $agentCount -or $agentCount -eq "0") { return }

    # Non-interactive detection
    $isInteractive = [Environment]::UserInteractive -and $Host.UI.RawUI -ne $null
    if (-not $isInteractive) {
        $script:SELECTED_AGENTS = & $script:NODE_BIN -e @'
const r = JSON.parse(process.argv[1]);
const detected = r.filter(a => a.detected).map(a => a.id);
process.stdout.write(detected.join(','));
'@ $script:PROBE_RESULT 2>$null
        Msg "    (非交互模式) 自动选择已检测到的 Agent: $($script:SELECTED_AGENTS)" `
            "    (non-interactive) Auto-selected detected agents: $($script:SELECTED_AGENTS)"
        Write-Host ""
        return
    }

    # Interactive menu
    & $script:NODE_BIN -e @'
const r = JSON.parse(process.argv[1]);
const lang = process.argv[2];
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
'@ $script:PROBE_RESULT $LANG_MODE

    $selectInput = Read-Host "    >"

    $script:SELECTED_AGENTS = & $script:NODE_BIN -e @'
const r = JSON.parse(process.argv[1]);
const input = process.argv[2] || '';
let indices;
if (!input.trim()) {
  indices = r.map((a, i) => a.detected ? i : -1).filter(i => i >= 0);
} else {
  indices = [...new Set(input.trim().split(/[\s,]+/).map(Number).filter(n => n >= 1 && n <= r.length))].map(n => n - 1);
}
const ids = indices.sort((a,b) => a-b).map(i => r[i].id);
process.stdout.write(ids.join(','));
'@ $script:PROBE_RESULT $selectInput 2>$null

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
    $isInteractive = [Environment]::UserInteractive -and $Host.UI.RawUI -ne $null
    if (-not $isInteractive) { return }

    $configFile = Join-Path $DataDir "config.json"
    $existingUid = ""
    if (Test-Path $configFile) {
        try {
            $existingUid = & $script:NODE_BIN -e @'
try { const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf-8')); process.stdout.write(c.userId||''); } catch {}
'@ $configFile 2>$null
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
    $input = (Read-Host "    >").Trim()
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

    $diffs = & $script:NODE_BIN -e @'
const fs = require('fs');
let old = {};
try { old = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8')); } catch { process.exit(0); }
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

    if (-not $diffs) { return }

    Write-Host ""
    Msg "⚠️  以下配置将被覆盖:" "⚠️  The following config will be overwritten:"
    $diffs | ForEach-Object { Write-Host "    $_" }

    $isInteractive = [Environment]::UserInteractive -and $Host.UI.RawUI -ne $null
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
    $bootDir = Join-Path $env:USERPROFILE ".loongsuite-pilot\bin"
    if (-not (Test-Path $bootDir)) { New-Item -ItemType Directory -Path $bootDir -Force | Out-Null }
    Copy-Item (Join-Path $srcDir "collector-daemon.js") $bootDir -Force
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
    Push-Location $script:PERMANENT_DIR
    try {
        $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
        & $script:NPM_BIN install --omit=dev --no-optional 2>&1 | Select-Object -Last 1
        $ErrorActionPreference = $prevEAP
    } finally {
        Pop-Location
    }
    Msg "    ✅ 依赖安装完成" "    ✅ Dependencies installed"
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
    $cfgTmp = Join-Path $env:TEMP "lp-config-args.json"
    [System.IO.File]::WriteAllText($cfgTmp, $cfgJson, [System.Text.UTF8Encoding]::new($false))

    & $script:NODE_BIN -e @'
const fs = require('fs');
const opts = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));

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

    Remove-Item $cfgTmp -Force -ErrorAction SilentlyContinue

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

    # Copy the PowerShell service management script
    $ps1File = Join-Path $binDir "loongsuite-pilot.ps1"
    $ps1Src = Join-Path $script:PERMANENT_DIR "scripts\loongsuite-pilot.ps1"
    if (Test-Path $ps1Src) {
        Copy-Item $ps1Src $ps1File -Force
    }

    # Create a .cmd shim that forwards to the PowerShell script
    $cmdFile = Join-Path $binDir "loongsuite-pilot.cmd"
    $cmdContent = @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0loongsuite-pilot.ps1" %*
'@
    Set-Content -Path $cmdFile -Value $cmdContent -Encoding ASCII
    Msg "    ✅ 已安装: $cmdFile" "    ✅ Installed: $cmdFile"

    # Add to user PATH if not already there
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$binDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$binDir;$userPath", "User")
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
    $ps1Path = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot.ps1"
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
        $short = $cfg -replace [regex]::Escape($env:USERPROFILE), "~"

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
    $OTEL_CLAUDE_DIR = Join-Path $env:USERPROFILE ".cache\opentelemetry.instrumentation.claude"
    $OTEL_CODEX_DIR = Join-Path $env:USERPROFILE ".cache\opentelemetry.instrumentation.codex"

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
        Probe-Agents
        Select-Agents
        Prompt-UserId
        Confirm-ConfigOverwrite
        Deploy-Package $script:INSTALL_SRC
        Write-Config
        Install-Command

        Msg "==> 启动服务..." "==> Starting service..."
        $ps1Path = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot.ps1"
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
        $ps1Path = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot.ps1"
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
function Cmd-Uninstall {
    Msg "🗑️  开始卸载 $PACKAGE_NAME ..." "🗑️  Uninstalling $PACKAGE_NAME ..."
    Write-Host ""

    Msg "==> 停止服务..." "==> Stopping service..."
    Stop-PilotService
    Msg "    ✅ 服务已停止" "    ✅ Service stopped"
    Write-Host ""

    # Remove Task Scheduler tasks
    $taskFolder = "\LoongsuitePilot"
    foreach ($taskName in @("LoongsuitePilot")) {
        $task = Get-ScheduledTask -TaskName $taskName -TaskPath $taskFolder -ErrorAction SilentlyContinue
        if ($task) {
            if ($task.State -eq "Running") {
                Stop-ScheduledTask -TaskName $taskName -TaskPath $taskFolder -ErrorAction SilentlyContinue
            }
            Unregister-ScheduledTask -TaskName $taskName -TaskPath $taskFolder -Confirm:$false -ErrorAction SilentlyContinue
        }
    }
    Msg "    ✅ 已移除计划任务" "    ✅ Removed scheduled tasks"

    Msg "==> 删除安装目录..." "==> Removing installation..."
    $installDir = Join-Path $env:USERPROFILE ".loongsuite-pilot"
    if (Test-Path $installDir) {
        Remove-Item $installDir -Recurse -Force
    }
    Msg "    ✅ 已删除 $installDir" "    ✅ Removed $installDir"

    Msg "==> 删除 loongsuite-pilot 命令..." "==> Removing loongsuite-pilot command..."
    $cmdFile = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot.cmd"
    $ps1File = Join-Path $env:USERPROFILE ".local\bin\loongsuite-pilot.ps1"
    if (Test-Path $cmdFile) { Remove-Item $cmdFile -Force }
    if (Test-Path $ps1File) { Remove-Item $ps1File -Force }
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
        Write-Host "Usage: .\installer-opensource.ps1 {install|upgrade|uninstall} [options]"
        exit 1
    }
}
