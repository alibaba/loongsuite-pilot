param([string]$EventName = "unknown")
$ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$stdin = ""
if ([Console]::IsInputRedirected) {
    try { $stdin = [Console]::In.ReadToEnd() } catch {}
}
$line = "[$ts] $EventName stdin=$($stdin.Substring(0, [Math]::Min($stdin.Length, 500)))"
Add-Content -Path C:\Users\Administrator\hook-events-test.log -Value $line
