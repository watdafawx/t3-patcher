# Shared helpers for tools/rig/*.ps1 (dot-source). Runs on FOX, drives rig over ssh.
$script:RigRoot  = 'G:\rig-run\t3patcher'          # path as seen ON rig
$script:RigShare = 'Q:\rig-run\t3patcher'         # same dir seen from FOX (Q: = \\Rig\g). Do NOT use the \\Rig\g UNC form in pwsh: it resolved to a local C:\Rig\g here
$script:ExeName  = if ($env:T3P_RIG_EXE) { $env:T3P_RIG_EXE } else { 'T3 Code (Beta).exe' }   # T3P_RIG_EXE: e.g. 'T3 Code (Nightly).exe' for a slot installed from a nightly NSIS installer

function Get-SlotInfo([int] $Slot) {
  if ($Slot -lt 1 -or $Slot -gt 9) { throw "Slot must be 1..9" }
  [pscustomobject]@{
    Slot      = $Slot
    AppDir    = "$RigRoot\app-s$Slot"
    AppShare  = "$RigShare\app-s$Slot"
    HomeDir   = "$RigRoot\home-s$Slot"        # T3CODE_HOME
    DataDir   = "$RigRoot\appdata-s$Slot"     # APPDATA override -> Electron userData + single-instance lock
    PatcherHome = "$RigRoot\p-s$Slot"      # T3P_HOME of a patched slot (patch-slot.ps1)
    ToolsDir  = "$RigRoot\tools-s$Slot"      # installer + runtime source copied by patch-slot.ps1
    CdpPort   = 9333 + $Slot - 1
    T3Port    = 3873 + $Slot - 1
    Task      = "t3patcher-s$Slot"
    Cmd       = "$RigRoot\_launch-s$Slot.cmd"
    CmdShare  = "$RigShare\_launch-s$Slot.cmd"
    Log       = "$RigRoot\_launch-s$Slot.log"
  }
}

# Run a PowerShell script block text on rig (ssh, EncodedCommand => no quoting problems). Returns stdout lines.
function Invoke-Rig([string] $Script) {
  $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("`$ProgressPreference='SilentlyContinue'; $Script`n; exit 0"))
  $out = ssh -o BatchMode=yes rig "powershell -NoProfile -NonInteractive -EncodedCommand $enc" 2>$null
  if ($LASTEXITCODE -ne 0) { throw "ssh rig failed ($LASTEXITCODE): $($out -join ' ')" }
  $out
}

# Rig-side snippet: processes whose EXECUTABLE PATH is under the t3patcher root (optionally one slot), plus that slot's launcher cmd.
function Get-RigProcSnippet([int] $Slot = 0) {
  $prefix = if ($Slot -gt 0) { "$RigRoot\app-s$Slot\" } else { "$RigRoot\" }
  $cmdMatch = if ($Slot -gt 0) { "*t3patcher\_launch-s$Slot.cmd*" } else { "*t3patcher\_launch-s*.cmd*" }
  "`$procs = @(Get-CimInstance Win32_Process | Where-Object { `$_.ProcessId -ne `$PID -and ((`$_.ExecutablePath -and `$_.ExecutablePath.StartsWith('$prefix', [StringComparison]::OrdinalIgnoreCase)) -or (`$_.Name -eq 'cmd.exe' -and `$_.CommandLine -like '$cmdMatch')) });"
}
