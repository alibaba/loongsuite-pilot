# Windows audit entry. Same flags and exit lines as scripts/query.py.
$ErrorActionPreference = "Stop"
$setupScripts = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "agentloop-collector-setup\scripts"
. (Join-Path $setupScripts "lib\config-record.ps1")
. (Join-Path $setupScripts "lib\aliyun.ps1")

$script:DEFAULT_LINE = 100

function Convert-Bound([string]$Text, [string]$Label) {
    if ($Text -notmatch '^-?\d+$') { Fail ($Label + " is not a number") }
    return [long]$Text
}

function Resolve-MergedTarget($Saved, $Values) {
    # Only inherit fields within the same confirmed project and region.
    $savedReady = $Saved["slsProject"] -and $Saved["slsLogstore"] -and $Saved["regionId"]
    $projectChanged = $Values.project -and $Values.project -cne $Saved["slsProject"]
    $regionChanged = $Values.region -and $Values.region -cne $Saved["regionId"]
    if ((-not $savedReady -or $projectChanged -or $regionChanged) -and -not ($Values.project -and $Values.region -and $Values.logstore)) {
        $missing = @()
        foreach ($field in @("project", "region", "logstore")) {
            if (-not $Values[$field]) { $missing += "--" + $field }
        }
        Fail ("Query target changed or incomplete. Missing explicit " + ($missing -join ", ") + ". Pass --project, --region, and --logstore together.")
    }
    $project = $Values.project
    if (-not $project) { $project = $Saved["slsProject"] }
    $logstore = $Values.logstore
    if (-not $logstore) { $logstore = $Saved["slsLogstore"] }
    $region = $Values.region
    if (-not $region) { $region = $Saved["regionId"] }
    $agentSpace = $Saved["agentSpace"]
    if ($Values.project) { $agentSpace = "" }
    return (Save-AuditTarget $agentSpace $region $project $logstore)
}

function Resolve-QueryContext([string]$Profile, $Values) {
    $saved = Get-SavedTarget
    if ($Values.agent_space) {
        if ($Values.project) { Fail "Cannot combine --agent-space with --project. Choose one query target." }
        if (-not $Values.region) { Fail "Pass --region. Choosing an AgentSpace requires its region. Do not use a default region." }
        $name = $Values.agent_space
        $region = $Values.region
    } else {
        if ($Values.project -or $Values.logstore -or $Values.region) {
            return (Resolve-MergedTarget $saved $Values)
        }
        $savedReady = $saved["slsProject"] -and $saved["slsLogstore"] -and $saved["regionId"]
        if ($savedReady) { return $saved }
        $name = $saved["agentSpace"]
        $region = $saved["regionId"]
    }
    $space = Get-AgentSpace $Profile $name $region
    $resolvedRegion = [string]$space.regionId
    if (-not $resolvedRegion) { $resolvedRegion = $region }
    $project = [string]$space.slsProject
    $spaceName = [string]$space.agentSpace
    if (-not $spaceName) { $spaceName = $name }
    if (-not $project -or -not $resolvedRegion) { Fail "AgentSpace is missing slsProject or regionId" }
    $logstore = $Values.logstore
    if (-not $logstore) { $logstore = $script:DEFAULT_LOGSTORE }
    return (Save-AuditTarget $spaceName $resolvedRegion $project $logstore)
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

$parsed = Get-CliMap $args @("agent-space", "region", "project", "logstore", "query", "from", "to", "line", "offset") @("list", "list-spaces")
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
    list_spaces = [bool]($parsed.Switches.Keys -contains "list-spaces")
}
$profile = Require-Profile
if ($values.list_spaces) {
    $spaces = @(Get-AgentSpaces $profile $values.region)
    foreach ($err in @($script:AgentSpaceListErrors)) {
        if ($err) { Write-Error $err -ErrorAction Continue }
    }
    $outputSpaces = @()
    foreach ($item in $spaces) {
        $outputSpaces += @{
            agentSpace = [string]$item.agentSpace
            regionId = [string]$item.regionId
        }
    }
    Write-Output (ConvertTo-JsonObject @{} "spaces" $outputSpaces)
    exit 0
}
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
