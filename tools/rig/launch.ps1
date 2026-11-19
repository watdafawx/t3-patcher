<#
.SYNOPSIS
  Start the isolated stock T3 Code on rig's desktop (interactive session via scheduled task, same pattern as
  X:\Dev\tools\run-on-rig.ps1). Nothing opens on FOX. Waits until the CDP endpoint answers on rig.
.DESCRIPTION
  Per slot N: app dir G:\rig-run\t3patcher\app-s<N>, T3CODE_HOME home-s<N>, APPDATA appdata-s<N> (so Electron userData and the
  single-instance lock are per slot and separate from any real T3 Code on rig), T3CODE_PORT 3873+N-1, CDP 127.0.0.1:9333+N-1.
  Env: T3CODE_DISABLE_AUTO_UPDATE=1, T3P_HOME=G:\rig-run\t3patcher\p-s<N> (the patcher home of a slot patched with
  patch-slot.ps1; harmless on a stock slot). Extra env: -Env 'A=1;B=2' (split on ';': under `pwsh -File` a
  comma list arrives as ONE string, so 'A=1','B=2' would set A to "1,B=2"). -EnvList is an alias.
  Extra app args: -AppArgs '--foo','bar'.
.EXAMPLE
  pwsh -NoProfile -File tools/rig/launch.ps1 -Slot 1
#>
[CmdletBinding()]
param(
  [int]      $Slot = 1,
  [Alias('EnvList')]
  [string[]] $Env = @(),
  [string[]] $AppArgs = @(),
  [int]      $TimeoutSec = 120
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')
$s = Get-SlotInfo $Slot
$envPairs = @($Env | ForEach-Object { $_ -split ';' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
foreach ($pair in $envPairs) { if ($pair -notmatch '^[A-Za-z_][A-Za-z0-9_]*=') { throw "-Env entry '$pair' is not NAME=value" } }

# 1. slot install present? (copy from base; run install.ps1 first if base is missing)
if (-not (Test-Path "$($s.AppShare)\$ExeName")) { & (Join-Path $PSScriptRoot 'install.ps1') -Slot $Slot }

# 2. clean slate for THIS slot only (own processes by path, own task)
& (Join-Path $PSScriptRoot 'stop.ps1') -Slot $Slot | Out-Null

# 3. port check on rig: nothing else may listen on our ports
$busy = Invoke-Rig "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { `$_.LocalPort -in $($s.CdpPort),$($s.T3Port) } | ForEach-Object { `"`$(`$_.LocalPort) pid `$(`$_.OwningProcess)`" }"
if ($busy) { throw "rig port(s) already in use: $($busy -join ', ')" }

# 4. launcher script (rig runs it in the interactive session)
$cmd = @(
  '@echo off'
  "set `"T3CODE_HOME=$($s.HomeDir)`""
  "set `"APPDATA=$($s.DataDir)`""
  "set `"T3CODE_PORT=$($s.T3Port)`""
  'set "T3CODE_DISABLE_AUTO_UPDATE=1"'
  'set "T3CODE_NO_BROWSER=1"'
  "set `"T3P_HOME=$($s.PatcherHome)`""
) + @($envPairs | ForEach-Object { "set `"$_`"" }) + @(
  "if not exist `"$($s.HomeDir)`" mkdir `"$($s.HomeDir)`""
  "if not exist `"$($s.DataDir)`" mkdir `"$($s.DataDir)`""
  "cd /d `"$($s.AppDir)`""
  "`"$ExeName`" --remote-debugging-port=$($s.CdpPort) --remote-debugging-address=127.0.0.1 $($AppArgs -join ' ') > `"$($s.Log)`" 2>&1"
)
Set-Content -Path $s.CmdShare -Value $cmd -Encoding ascii
Invoke-Rig "schtasks /Create /TN '$($s.Task)' /TR '$($s.Cmd)' /SC ONCE /ST 00:00 /IT /RL LIMITED /F | Out-Null; schtasks /Run /TN '$($s.Task)' | Out-Null" | Out-Null

# 5. wait for CDP on rig
$ok = Invoke-Rig @"
`$deadline = (Get-Date).AddSeconds($TimeoutSec); `$v = `$null
while ((Get-Date) -lt `$deadline -and -not `$v) {
  try { `$v = Invoke-RestMethod -Uri 'http://127.0.0.1:$($s.CdpPort)/json/version' -TimeoutSec 2 } catch { Start-Sleep -Milliseconds 700 }
}
if (`$v) { 'READY ' + `$v.Browser } else { 'TIMEOUT' }
"@
$ok = @($ok)[-1]
$pids = Invoke-Rig ((Get-RigProcSnippet $Slot) + " (`$procs | Where-Object { `$_.ExecutablePath } | ForEach-Object { `"`$(`$_.ProcessId)`" }) -join ','")
Write-Host "slot ${Slot}: $ok"
Write-Host "  pids (rig): $(@($pids)[-1])"
Write-Host "  CDP (rig localhost only): 127.0.0.1:$($s.CdpPort)   -> from FOX: node tools/rig/cdp-eval.mjs --slot $Slot `"document.title`""
Write-Host "  T3 server port: $($s.T3Port)   home: $($s.HomeDir)   app: $($s.AppDir)"
if ($ok -notlike 'READY*') { Write-Error "CDP did not answer within ${TimeoutSec}s. Log: $($s.Log)"; exit 1 }
