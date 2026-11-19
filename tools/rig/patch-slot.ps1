<#
.SYNOPSIS
  Patch (or unpatch) a rig slot copy of T3 Code with the REAL installer, run ON rig.
.DESCRIPTION
  1. Stops the slot (by path).
  2. Copies packages/installer/dist/standalone/t3p.cjs and packages/main-runtime/dist/ (plain file copies over Q:,
     no junctions) to G:\rig-run\t3patcher\tools-s<N>\ on rig.
  3. Runs `node t3p.cjs install --path G:\rig-run\t3patcher\app-s<N> --runtime ...` ON rig with
     T3P_HOME=G:\rig-run\t3patcher\p-s<N> (never the rig user's real ~/.t3-patcher).
  -Unpatch runs `t3p uninstall --purge` instead and prints the restored app.asar sha256.
  -Plugins also copies packages/main-runtime/test-fixtures (test plugins + state.json) into p-s<N>\.t3-patcher\ and
     creates p-s<N>\fsread-root\hello.txt and p-s<N>\outside.txt for the fs.read evidence.
  -RuntimeOnly only refreshes p-s<N>\.t3-patcher\runtime from the local dist (fast loop while iterating).
  Build first on FOX: pnpm --filter @t3p/installer --filter @t3p/main-runtime... build
.EXAMPLE
  pwsh -NoProfile -File tools/rig/patch-slot.ps1 -Slot 1 -Plugins
  pwsh -NoProfile -File tools/rig/patch-slot.ps1 -Slot 1 -Unpatch
#>
[CmdletBinding()]
param(
  [int]    $Slot = 1,
  [switch] $Unpatch,
  [switch] $Plugins,
  [switch] $RuntimeOnly,
  [switch] $NoPlugins,
  [switch] $Force   # t3p install --force (version outside SUPPORTED_VERSIONS, e.g. a nightly)
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')
$s = Get-SlotInfo $Slot
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$cli = Join-Path $repo 'packages\installer\dist\standalone\t3p.cjs'
$runtime = Join-Path $repo 'packages\main-runtime\dist'
$fixtures = Join-Path $repo 'packages\main-runtime\test-fixtures'
foreach ($f in $cli, (Join-Path $runtime 'main.cjs'), (Join-Path $runtime 'preload.cjs'), (Join-Path $runtime 'renderer.js'), (Join-Path $runtime 'repair-worker.cjs'), (Join-Path $runtime 'sqlite-worker.cjs')) {
  if (-not (Test-Path $f)) { throw "missing $f; build first (pnpm --filter @t3p/installer --filter @t3p/main-runtime... build)" }
}
if (-not (Test-Path "$($s.AppShare)\$ExeName")) { throw "slot $Slot has no app copy; run tools/rig/install.ps1 -Slot $Slot first" }

& (Join-Path $PSScriptRoot 'stop.ps1') -Slot $Slot | Out-Null

# tools-s<N> = the installer + runtime source on rig; p-s<N> = T3P_HOME
$toolsShare = "$RigShare\tools-s$Slot"
$toolsRig = "$RigRoot\tools-s$Slot"
$pShare = "$RigShare\p-s$Slot"
$pRig = "$RigRoot\p-s$Slot"
if (Test-Path $toolsShare) { Remove-Item -LiteralPath $toolsShare -Recurse -Force }
New-Item -ItemType Directory -Force "$toolsShare\runtime" | Out-Null
Copy-Item $cli "$toolsShare\t3p.cjs"
Get-ChildItem $runtime -File | Where-Object { $_.Extension -ne '.map' } | Copy-Item -Destination "$toolsShare\runtime"

if ($RuntimeOnly) {
  $r = Invoke-Rig @"
`$dst = '$pRig\.t3-patcher\runtime'
if (-not (Test-Path `$dst)) { throw 'slot is not patched (no runtime dir)' }
Copy-Item '$toolsRig\runtime\*' `$dst -Force
'runtime refreshed: ' + ((Get-ChildItem `$dst -File | ForEach-Object Name) -join ', ')
"@
  $r | ForEach-Object { Write-Host $_ }
  return
}

$cmd = if ($Unpatch) { "uninstall --path '$($s.AppDir)' --purge --json" } else { "install --path '$($s.AppDir)' --runtime '$toolsRig\runtime' --json$(if ($Force) { ' --force' })" }
$out = Invoke-Rig @"
`$env:T3P_HOME = '$pRig'
`$env:T3P_TASK_NAME = 't3patcher-repair-s$Slot'
New-Item -ItemType Directory -Force '$pRig' | Out-Null
`$o = & node '$toolsRig\t3p.cjs' $cmd 2>&1
'EXIT ' + `$LASTEXITCODE
`$o
'ASAR ' + (Get-FileHash -Algorithm SHA256 '$($s.AppDir)\resources\app.asar').Hash.ToLower()
if (Test-Path '$($s.AppDir)\resources\_app.asar') { 'ORIG ' + (Get-FileHash -Algorithm SHA256 '$($s.AppDir)\resources\_app.asar').Hash.ToLower() }
"@
$out | ForEach-Object { Write-Host $_ }
if (-not (@($out) -contains 'EXIT 0')) { Write-Error "t3p $(if ($Unpatch) { 'uninstall' } else { 'install' }) failed on rig"; exit 1 }

if ($Plugins -and -not $Unpatch) {
  $base = "$pShare\.t3-patcher"
  if (Test-Path "$base\plugins") { Remove-Item -LiteralPath "$base\plugins" -Recurse -Force }
  Copy-Item -Recurse "$fixtures\plugins" "$base\plugins"
  Copy-Item "$fixtures\state.json" "$base\state.json" -Force
  New-Item -ItemType Directory -Force "$pShare\fsread-root" | Out-Null
  Set-Content -Path "$pShare\fsread-root\hello.txt" -Value 'inside the granted root' -NoNewline -Encoding ascii
  Set-Content -Path "$pShare\outside.txt" -Value 'outside the granted root' -NoNewline -Encoding ascii
  Write-Host "plugins: test fixtures copied to $pRig\.t3-patcher (state.json pre-grants them)"
}
if ($NoPlugins -and -not $Unpatch) {
  $base = "$pShare\.t3-patcher"
  foreach ($p in "$base\plugins", "$base\state.json") { if (Test-Path $p) { Remove-Item -LiteralPath $p -Recurse -Force } }
  Write-Host 'plugins: removed'
}
Write-Host "patch-slot: slot $Slot $(if ($Unpatch) { 'unpatched' } else { 'patched' }). T3P_HOME=$pRig (launch.ps1 sets it)."
