<#
.SYNOPSIS
  Idempotent: put a stock T3 Code (Windows x64 NSIS installer, extracted, never installed) into
  G:\rig-run\t3patcher\base on rig, then copy it to the requested slot dir(s) app-s<N>.
.DESCRIPTION
  1. gh downloads T3-Code-<ver>-x64.exe from pingdotgg/t3code (cached in G:\rig-run\t3patcher\dl\), sha256 checked against the GitHub asset digest.
  2. 7z (FOX) unpacks the installer -> $PLUGINSDIR\app-64.7z -> app files. No NSIS run, so Michael's own T3 Code install on rig is never touched.
  3. App files mirrored to rig base\. Slot dirs are robocopied from base on rig (local NVMe).
.EXAMPLE
  pwsh -NoProfile -File tools/rig/install.ps1                 # base + slot 1
  pwsh -NoProfile -File tools/rig/install.ps1 -Slot 1,2,3
  pwsh -NoProfile -File tools/rig/install.ps1 -Slot 1 -Force  # re-copy slot from base (discards edits in app-s1)
#>
[CmdletBinding()]
param(
  [string]  $Version = '0.1.10',
  [int[]]   $Slot = @(1),
  [switch]  $Force,
  [switch]  $Reinstall        # redo download/extract even if base is current
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

$asset  = "T3-Code-$Version-x64.exe"
$tag    = "v$Version"
$marker = "$RigShare\base\.t3patcher-installed.json"

function Get-BaseInfo { if (Test-Path $marker) { Get-Content $marker -Raw | ConvertFrom-Json } }

$info = Get-BaseInfo
if ($Reinstall -or -not $info -or $info.version -ne $Version -or -not (Test-Path "$RigShare\base\$ExeName")) {
  New-Item -ItemType Directory -Force "$RigShare\dl" | Out-Null
  $digest = (gh release view $tag -R pingdotgg/t3code --json assets --jq ".assets[] | select(.name==`"$asset`") | .digest") -replace '^sha256:', ''
  if (-not $digest) { throw "asset $asset not found in $tag" }
  $inst = "$RigShare\dl\$asset"
  $have = if (Test-Path $inst) { (Get-FileHash $inst -Algorithm SHA256).Hash.ToLower() }
  if ($have -ne $digest) {
    $tmp = Join-Path $env:TEMP "t3p-dl-$PID"; New-Item -ItemType Directory -Force $tmp | Out-Null
    try {
      Write-Host "download $asset ..."
      gh release download $tag -R pingdotgg/t3code -p $asset -D $tmp --clobber
      if ($LASTEXITCODE) { throw "gh download failed" }
      Copy-Item "$tmp\$asset" $inst -Force
    } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    $have = (Get-FileHash $inst -Algorithm SHA256).Hash.ToLower()
  }
  if ($have -ne $digest) { throw "sha256 mismatch: $have != $digest" }
  Write-Host "installer ok sha256=$have"

  $seven = (Get-Command 7z -ErrorAction SilentlyContinue)?.Source
  if (-not $seven) { $seven = 'C:\Program Files\7-Zip\7z.exe' }
  if (-not (Test-Path $seven)) { throw "7z not found on FOX" }
  $work = Join-Path $env:TEMP "t3p-ex-$PID"; New-Item -ItemType Directory -Force "$work\a", "$work\b" | Out-Null
  try {
    & $seven x -y -bso0 -bsp0 "-o$work\a" $inst
    $inner = Get-ChildItem "$work\a" -Recurse -Filter 'app-64.7z' | Select-Object -First 1
    if (-not $inner) { throw "app-64.7z not found inside installer" }
    & $seven x -y -bso0 -bsp0 "-o$work\b" $inner.FullName
    if (-not (Test-Path "$work\b\$ExeName")) { throw "$ExeName missing after extract" }
    robocopy "$work\b" "$RigShare\base" /MIR /MT:16 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy to base failed ($LASTEXITCODE)" }
    $global:LASTEXITCODE = 0
  } finally { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
  @{ version = $Version; asset = $asset; sha256 = $have; url = "https://github.com/pingdotgg/t3code/releases/download/$tag/$asset"; installedAt = (Get-Date).ToString('o') } |
    ConvertTo-Json | Set-Content $marker -Encoding utf8
  Write-Host "base installed: $RigRoot\base"
} else { Write-Host "base already at $($info.version) (sha256 $($info.sha256))" }

foreach ($n in $Slot) {
  $s = Get-SlotInfo $n
  $r = Invoke-Rig @"
`$dst = '$($s.AppDir)'
if (-not (Test-Path "`$dst\$ExeName") -or `$$($Force.IsPresent)) {
  robocopy '$RigRoot\base' `$dst /MIR /MT:16 /NFL /NDL /NJH /NJS /NP | Out-Null
  if (`$LASTEXITCODE -ge 8) { throw "robocopy failed" }
  'copied base -> ' + `$dst
} else { 'slot present: ' + `$dst }
"@
  Write-Host ($r -join ' ')
}
