# Windows audit entry. Same flags and exit lines as scripts/query.py.
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\config-record.ps1")
. (Join-Path $PSScriptRoot "lib\aliyun.ps1")

$script:DEFAULT_LINE = 100

function Convert-Bound([string]$Text, [string]$Label) {
    if ($Text -notmatch '^-?\d+$') { Fail ($Label + " is not a number") }
    return [long]$Text
}

function Resolve-MergedTarget($Saved, $Values) {
    # One passed field replaces that saved field. The other two stay.
    $project = $Values.project
    if (-not $project) { $project = $Saved["slsProject"] }
    $logstore = $Values.logstore
    if (-not $logstore) { $logstore = $Saved["slsLogstore"] }
    $region = $Values.region
    if (-not $region) { $region = $Saved["regionId"] }
    $missing = @()
    if (-not $project) { $missing += "project" }
    if (-not $logstore) { $missing += "logstore" }
    if (-not $region) { $missing += "region" }
    if ($missing.Count -gt 0) {
        Fail ("Query target is incomplete. Missing " + ($missing -join ", ") + ". project, logstore, and region are required.")
    }
    return (Save-AuditTarget $Saved["agentSpace"] $region $project $logstore)
}

function Resolve-QueryContext([string]$Profile, $Values) {
    $saved = Get-SavedTarget
    # A passed project, logstore, or region edits that field only.
    # Region together with --agent-space still selects the space below.
    if ($Values.project -or $Values.logstore -or ($Values.region -and -not $Values.agent_space)) {
        return (Resolve-MergedTarget $saved $Values)
    }
    $savedReady = $saved["slsProject"] -and $saved["slsLogstore"] -and $saved["regionId"]
    if ($Values.agent_space -or -not $savedReady) {
        $name = $Values.agent_space
        if (-not $name) { $name = $saved["agentSpace"] }
        $region = $Values.region
        if (-not $region -and -not $Values.agent_space) {
            $region = $saved["regionId"]
        }
        $space = Get-AgentSpace $Profile $name $region
        $resolvedRegion = [string]$space.regionId
        if (-not $resolvedRegion) { $resolvedRegion = $region }
        $project = [string]$space.slsProject
        $spaceName = [string]$space.agentSpace
        if (-not $spaceName) { $spaceName = $name }
        if (-not $project -or -not $resolvedRegion) { Fail "AgentSpace is missing slsProject or regionId" }
        return (Save-AuditTarget $spaceName $resolvedRegion $project $script:DEFAULT_LOGSTORE)
    }
    return $saved
}

function Get-QueryWindow($Values) {
    # Windows PowerShell 5.1 formats local time as UTC for -UFormat %s.
    $elapsed = (Get-Date).ToUniversalTime() - (Get-Date -Date "1970-01-01 00:00:00")
    $wholeTicks = $elapsed.Ticks - ($elapsed.Ticks % 10000000)
    $now = [long]($wholeTicks / 10000000)
    if ($Values.to) { $end = Convert-Bound $Values.to "--to" } else { $end = $now }
    if ($Values.from) { $start = Convert-Bound $Values.from "--from" } else { $start = $end - 3600 }
    if ($start -gt $end) { Fail "--from must not be later than --to" }
    return @($start, $end)
}

function Get-QueryPage($Values) {
    $line = $script:DEFAULT_LINE
    $offset = 0
    if ($Values.line) { $line = Convert-Bound $Values.line "--line" }
    if ($Values.offset) { $offset = Convert-Bound $Values.offset "--offset" }
    if ($line -lt 1) { Fail "--line must be greater than 0" }
    if ($line -gt $script:DEFAULT_LINE) { Fail ("--line must not exceed " + $script:DEFAULT_LINE) }
    if ($offset -lt 0) { Fail "--offset must not be less than 0" }
    return @($line, $offset)
}

$parsed = Get-CliMap $args @("agent-space", "region", "project", "logstore", "query", "from", "to", "line", "offset") @("list")
$values = @{
    agent_space = (Get-CliValue $parsed "agent-space")
    region = (Get-CliValue $parsed "region")
    project = (Get-CliValue $parsed "project")
    logstore = (Get-CliValue $parsed "logstore")
    query = (Get-CliValue $parsed "query")
    from = (Get-CliValue $parsed "from")
    to = (Get-CliValue $parsed "to")
    line = (Get-CliValue $parsed "line")
    offset = (Get-CliValue $parsed "offset")
    list = [bool]($parsed.Switches.Keys -contains "list")
}
$profile = Require-Profile
$context = Resolve-QueryContext $profile $values
if ($values.list -and -not $values.query) {
    $target = Get-SavedTarget
    $body = '{"context":{"agentSpace":"' + (Escape-JsonString $target["agentSpace"]) + '","regionId":"' + (Escape-JsonString $target["regionId"]) + '","slsProject":"' + (Escape-JsonString $target["slsProject"]) + '","slsLogstore":"' + (Escape-JsonString $target["slsLogstore"]) + '"}}'
    Write-Output $body
    exit 0
}
if (-not $values.query) { Fail "Missing --query. Search example: * . Stats example: * | SELECT count(*)" }
$window = Get-QueryWindow $values
$page = Get-QueryPage $values
$data = Get-PilotLogs $profile $context $values.query $window[0] $window[1] $page[0] $page[1]
Add-HistoryRow @{
    at = (Get-Stamp)
    query = $values.query
    from = $window[0]
    to = $window[1]
    slsProject = [string]$context.slsProject
    slsLogstore = [string]$context.slsLogstore
    regionId = [string]$context.regionId
}
Write-Output $data
