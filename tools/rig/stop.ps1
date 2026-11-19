<#
.SYNOPSIS  Stop the isolated T3 Code test app on rig. Kills ONLY processes whose executable path is under G:\rig-run\t3patcher\ (by path, never by name).
.EXAMPLE   pwsh -NoProfile -File tools/rig/stop.ps1 -Slot 1
           pwsh -NoProfile -File tools/rig/stop.ps1 -All
#>
[CmdletBinding()]
param([int] $Slot = 1, [switch] $All)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

$tasks = if ($All) { "1..9 | ForEach-Object { cmd /c ('schtasks /Delete /TN t3patcher-s' + `$_ + ' /F >nul 2>&1') }" }
         else      { "cmd /c 'schtasks /Delete /TN t3patcher-s$Slot /F >nul 2>&1'" }
$snip = Get-RigProcSnippet $(if ($All) { 0 } else { $Slot })
$n = Invoke-Rig @"
$tasks
$snip
`$procs | ForEach-Object { Stop-Process -Id `$_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 1500
$snip
@(`$procs).Count
"@
# stock T3 appends <home>\bin to rig's USER Path on every launch: remove only entries under our throwaway root (raw value, keeps REG_EXPAND_SZ)
Invoke-Rig @"
`$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', `$true)
`$v = `$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
`$keep = @(`$v -split ';' | Where-Object { `$_ -and `$_ -notlike '$RigRoot\*' })
if (`$keep.Count -ne @(`$v -split ';' | Where-Object { `$_ }).Count) { `$k.SetValue('Path', (`$keep -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString) }
`$k.Close()
"@ | Out-Null
$left = [int](@($n)[-1])
$what = if ($All) { 'all slots' } else { "slot $Slot" }
if ($left -ne 0) { Write-Error "stop: $left process(es) still alive under t3patcher ($what)"; exit 1 }
Write-Host "stop: $what clean, no t3patcher process left on rig."
