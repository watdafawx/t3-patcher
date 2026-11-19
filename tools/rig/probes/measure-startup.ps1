<#
.SYNOPSIS  Startup timing of a rig slot: ms from the main process CreationDate (rig clock) to the main page's
           navigation start, DOMContentLoaded, first-contentful-paint and load (CDP). Run 0 is a warm-up and is not counted.
.EXAMPLE   pwsh -NoProfile -File tools/rig/probes/measure-startup.ps1 -Slot 1 -Runs 5 -Label patched
#>
param([int] $Slot = 1, [int] $Runs = 5, [string] $Label = 'run')
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
. (Join-Path $repo 'tools\rig\lib.ps1')
$js = @'
new Promise((r) => { const t0 = Date.now(); const f = () => {
  const p = performance.getEntriesByName('first-contentful-paint')[0];
  const n = performance.getEntriesByType('navigation')[0];
  if (p && n && n.loadEventEnd > 0) r({ origin: performance.timeOrigin, fcp: p.startTime, dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd });
  else if (Date.now() - t0 > 30000) r({ error: 'timeout' }); else setTimeout(f, 100); }; f(); })
'@ -replace "`r?`n", ' '
$prefix = "$RigRoot\app-s$Slot\"
$rows = @()
for ($i = 0; $i -le $Runs; $i++) {
  pwsh -NoProfile -File (Join-Path $repo 'tools\rig\launch.ps1') -Slot $Slot | Out-Null
  $page = node (Join-Path $repo 'tools\rig\cdp-eval.mjs') --slot $Slot $js | ConvertFrom-Json
  $created = Invoke-Rig "`$p = Get-CimInstance Win32_Process | Where-Object { `$_.ExecutablePath -and `$_.ExecutablePath.StartsWith('$prefix', [StringComparison]::OrdinalIgnoreCase) -and `$_.CommandLine -notlike '*--type=*' } | Sort-Object CreationDate | Select-Object -First 1; [DateTimeOffset]::new(`$p.CreationDate).ToUnixTimeMilliseconds()"
  $c = [double](@($created)[-1])
  $row = [pscustomobject]@{ label = $Label; run = $i; warmup = ($i -eq 0); navStart = [math]::Round($page.origin - $c); dcl = [math]::Round($page.origin + $page.dcl - $c); fcp = [math]::Round($page.origin + $page.fcp - $c); load = [math]::Round($page.origin + $page.load - $c) }
  $rows += $row
  Write-Host ($row | ConvertTo-Json -Compress)
}
& (Join-Path $repo 'tools\rig\stop.ps1') -Slot $Slot | Out-Null
$m = $rows | Where-Object { -not $_.warmup }
foreach ($k in 'navStart', 'dcl', 'fcp', 'load') {
  $v = @($m | ForEach-Object $k | Sort-Object)
  $median = $v[[int][math]::Floor($v.Count / 2)]
  Write-Host ("{0} {1}: median {2} ms, min {3}, max {4} (n={5})" -f $Label, $k, $median, $v[0], $v[-1], $v.Count)
}
