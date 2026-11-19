<#
.SYNOPSIS  Stop the slot, wipe its throwaway T3CODE_HOME, APPDATA, T3P_HOME (p-s<N>) and tools-s<N> (only under G:\rig-run\t3patcher\), optionally restore the install dir from base.
.EXAMPLE   pwsh -NoProfile -File tools/rig/reset.ps1 -Slot 1 [-Restore]
#>
[CmdletBinding()]
param([int] $Slot = 1, [switch] $Restore)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')
$s = Get-SlotInfo $Slot

& (Join-Path $PSScriptRoot 'stop.ps1') -Slot $Slot
if ($LASTEXITCODE) { throw "stop failed; not wiping" }

$r = Invoke-Rig @"
`$root = '$RigRoot\'
foreach (`$d in '$($s.HomeDir)', '$($s.DataDir)', '$($s.PatcherHome)', '$($s.ToolsDir)') {
  `$full = [IO.Path]::GetFullPath(`$d)
  if (-not `$full.StartsWith(`$root, [StringComparison]::OrdinalIgnoreCase) -or `$full -eq `$root.TrimEnd('\')) { throw "refusing to delete `$full" }
  if (Test-Path -LiteralPath `$full) { Remove-Item -LiteralPath `$full -Recurse -Force; "wiped `$full" }
}
Remove-Item -LiteralPath '$($s.Log)' -Force -ErrorAction SilentlyContinue
"@
$r | ForEach-Object { Write-Host $_ }
if ($Restore) { & (Join-Path $PSScriptRoot 'install.ps1') -Slot $Slot -Force }
Write-Host "reset: slot $Slot done$(if ($Restore) { ' (install dir restored from base)' })."
