<#
.SYNOPSIS  WP-0C spike runner (FOX -> rig). Packs shim\ into a replacement app.asar on slot N, writes config, launches.
.EXAMPLE   pwsh -NoProfile -File docs/spikes/wp-0c/run.ps1 -Slot 1 -Tag v1 -Marker '/*T3P_MARKER*/'
.NOTES     Slot N must be a copy of the pristine install. First run renames app.asar -> _app.asar and junctions
           _app.asar.unpacked -> app.asar.unpacked (so native modules still resolve). reset.ps1 -Restore undoes it.
#>
param(
  [int]$Slot = 1,
  [string]$Chunk = 'index-CG-aocM4.js',
  [string]$Tag = 'v1',
  [string]$Marker = '/*T3P_MARKER*/',
  [string[]]$Ext = @(),
  [ValidateSet('registerPreloadScript', 'setPreloads')][string]$PreloadApi = 'registerPreloadScript',
  [switch]$LogAll,
  [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$repo = (Resolve-Path "$here\..\..\..").Path
$root = 'Q:\rig-run\t3patcher'
$res = "$root\app-s$Slot\resources"
$spike = "$root\spike\wp0c-s$Slot"
New-Item -ItemType Directory -Force $spike | Out-Null
# 1. replacement app.asar (original kept as _app.asar, plus a junction so _app.asar.unpacked resolves)
if (-not (Test-Path "$res\_app.asar")) {
  Rename-Item "$res\app.asar" '_app.asar'
  ssh rig "cmd /c mklink /J G:\rig-run\t3patcher\app-s$Slot\resources\_app.asar.unpacked G:\rig-run\t3patcher\app-s$Slot\resources\app.asar.unpacked" | Out-Null
}
$tmp = Join-Path $env:TEMP "t3p-wp0c-pack-$Slot"
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item "$here\shim" $tmp -Recurse
npx --yes '@electron/asar' pack $tmp "$tmp.asar"
Copy-Item "$tmp.asar" "$res\app.asar" -Force
Remove-Item $tmp, "$tmp.asar" -Recurse -Force
# 2. config + preload (config is re-read per request by the shim)
Copy-Item "$here\preload.js" "$spike\preload.js" -Force
@{ chunk = $Chunk; tag = $Tag; marker = $Marker; ext = @($Ext | ForEach-Object { $_ -split "," } | Where-Object { $_ }); preloadApi = $PreloadApi; logAll = [bool]$LogAll } | ConvertTo-Json | Set-Content "$spike\config.json" -Encoding utf8
Remove-Item "$spike\shim.log" -ErrorAction SilentlyContinue
if (-not $NoLaunch) {
  pwsh -NoProfile -File "$repo\tools\rig\launch.ps1" -Slot $Slot -Env "T3P_SPIKE_DIR=G:/rig-run/t3patcher/spike/wp0c-s$Slot"
}
