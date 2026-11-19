<#
.SYNOPSIS
  Maximizes a rig slot's T3 Code window (full 4K) so perf runs cover the whole screen.
.DESCRIPTION
  Window calls must run in rig's interactive desktop session, not in the ssh session, so this registers a one-shot
  scheduled task (/IT, same pattern as launch.ps1) that calls user32 ShowWindow(SW_MAXIMIZE) on the slot's main window.
.EXAMPLE
  pwsh -NoProfile -File tools/rig/perf/maximize.ps1 -Slot 2
#>
[CmdletBinding()]
param([int] $Slot = 2)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\lib.ps1')
$s = Get-SlotInfo $Slot
$ps1Share = "$RigShare\_maximize-s$Slot.ps1"
$ps1Rig = "$RigRoot\_maximize-s$Slot.ps1"
@"
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);'
Get-Process | Where-Object { `$_.Path -like '$($s.AppDir)\*' -and `$_.MainWindowHandle -ne 0 } | ForEach-Object { [W.U]::ShowWindow(`$_.MainWindowHandle, 3) | Out-Null; [W.U]::SetForegroundWindow(`$_.MainWindowHandle) | Out-Null }
"@ | Set-Content -Path $ps1Share -Encoding ascii
$task = "t3patcher-max-s$Slot"
Invoke-Rig "schtasks /Create /TN '$task' /TR 'powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $ps1Rig' /SC ONCE /ST 00:00 /IT /RL LIMITED /F | Out-Null; schtasks /Run /TN '$task' | Out-Null; Start-Sleep 3; schtasks /Delete /TN '$task' /F | Out-Null" | Out-Null
Remove-Item $ps1Share -ErrorAction SilentlyContinue
Write-Host "maximize: slot $Slot window maximized"
