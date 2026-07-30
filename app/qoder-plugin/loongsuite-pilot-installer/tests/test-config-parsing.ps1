# 验证 ensure-pilot.ps1 的配置解析与 kebab→Pascal 参数映射（可在任意平台用 pwsh 跑）
$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$script = Join-Path $pluginRoot 'scripts\ensure-pilot.ps1'
if (-not (Test-Path $script)) { $script = Join-Path $pluginRoot 'scripts/ensure-pilot.ps1' }

# 提取 Read-AdminConfig 函数体并在隔离作用域内执行（不触发真实安装）
$src = Get-Content -Raw $script
$fnMatch = [regex]::Match($src, '(?ms)^function Read-AdminConfig \{.*?^\}')
if (-not $fnMatch.Success) { throw 'Read-AdminConfig not found' }

$NodeVersion = ''; $NodeDistBaseUrl = ''; $InstallerUrl = ''; $InstallArgs = @()
$PluginRoot = $pluginRoot
Invoke-Expression $fnMatch.Value
Read-AdminConfig

Write-Host "NodeVersion      : $NodeVersion"
Write-Host "NodeDistBaseUrl  : $NodeDistBaseUrl"
Write-Host "InstallerUrl     : $InstallerUrl"
Write-Host "InstallArgs      : $($InstallArgs -join ' ')"

$failures = @()
if ($NodeVersion -ne '22.22.2') { $failures += "NodeVersion 解析错误: $NodeVersion" }
if ($NodeDistBaseUrl -notlike 'https://*sensen-test') { $failures += "NodeDistBaseUrl 解析错误: $NodeDistBaseUrl" }
if ($InstallerUrl -ne '') { $failures += "installer.sh 地址不应被采用: $InstallerUrl" }

# 参数应成对且 flag 为 PascalCase
$expected = @(
    '-CollectLog', 'true', '-CollectTrace', 'true',
    '-SlsProject', 'agentloop-268e5339faebe7ceb5f5de62983e9e9c',
    '-SlsLogstore', 'agent-event-webtracking',
    '-SlsEndpoint', 'cn-hongkong.log.aliyuncs.com',
    '-CmsLicenseKey', 'gaddp9ap8q@eba4332910dd4ac',
    '-CmsEndpoint', 'https://proj-xtrace-1d3dc285e44fcb12fa8cbcb1dd13551-cn-hongkong.cn-hongkong.log.aliyuncs.com/apm/trace/opentelemetry',
    '-CmsWorkspace', 'taiye-loongsuite-test',
    '-ServiceNamePrefix', 'ai-coding-agent',
    '-MaskMode', 'all'
)
if ($InstallArgs.Count -ne $expected.Count) {
    $failures += "参数个数不符: 期望 $($expected.Count)，实际 $($InstallArgs.Count)"
} else {
    for ($i = 0; $i -lt $expected.Count; $i++) {
        if ($InstallArgs[$i] -ne $expected[$i]) {
            $failures += "参数[$i] 不符: 期望 '$($expected[$i])'，实际 '$($InstallArgs[$i])'"
        }
    }
}

if ($failures) {
    Write-Host "`n❌ FAIL"
    $failures | ForEach-Object { Write-Host "  - $_" }
    exit 1
}
Write-Host "`n✅ PASS: 配置解析与参数映射均正确"
