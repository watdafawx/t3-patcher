# Media plugin helper: reads the Windows system media session (SMTC) and answers one JSON line per command.
# Protocol (stdin, one command per line):  "<id> poll" | "<id> toggle" | "<id> next" | "<id> prev" | "<id> quit"
# Reply (stdout, one JSON object per line): {"id":<id>,"ok":true,...} or {"id":<id>,"ok":false,"error":"..."}
# Exits when stdin closes. Read-only apart from the three transport commands. No network, no files written.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))
$out.AutoFlush = $true

function Send($obj) { $out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 5)) }

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  Add-Type -AssemblyName System.Drawing
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
  $asStreamForRead = ([System.IO.WindowsRuntimeStreamExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsStreamForRead' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IInputStream'
    })[0]
  function Await($op, [Type]$type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    if (-not $task.Wait(6000)) { throw 'timeout' }
    $task.Result
  }
  $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
  $mgr = Await ($mgrType::RequestAsync()) $mgrType
  # A headless long-lived process never pumps WinRT events, so the session objects it gets at
  # startup keep the snapshot from that moment (status, position and track never change).
  # Asking the manager again per request returns fresh session objects with current state.
  function Get-Manager {
    try {
      $script:mgr = Await ($mgrType::RequestAsync()) $mgrType
    } catch {
      # keep the previous manager: a transient failure must not kill a working session
    }
    if ($null -eq $script:mgr) { throw 'smtc manager unavailable' }
    return $script:mgr
  }
} catch {
  Send @{ id = 0; ok = $false; unavailable = $true; error = "smtc unavailable: $($_.Exception.Message)" }
  exit 2
}

$lastKey = ''
$lastThumb = $null

function Get-Thumb($props) {
  # Small JPEG data URL (max 96 px), or $null. Never throws.
  try {
    $ref = $props.Thumbnail
    if ($null -eq $ref) { return $null }
    $streamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType]
    $stream = Await ($ref.OpenReadAsync()) $streamType
    # Some apps report Size 0 until read: copy up to 2 MiB through a .NET stream.
    $net = $asStreamForRead.Invoke($null, @($stream))
    $buf = New-Object System.IO.MemoryStream
    $chunk = New-Object byte[] 65536
    while ($buf.Length -lt 2097152) {
      $n = $net.Read($chunk, 0, $chunk.Length)
      if ($n -le 0) { break }
      $buf.Write($chunk, 0, $n)
    }
    if ($buf.Length -le 0) { return $null }
    $bytes = $buf.ToArray()
    $ms = New-Object System.IO.MemoryStream(, $bytes)
    $img = [System.Drawing.Image]::FromStream($ms)
    $w = 96; $h = 96
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($img, 0, 0, $w, $h)
    $g.Dispose(); $img.Dispose()
    $enc = New-Object System.IO.MemoryStream
    $bmp.Save($enc, [System.Drawing.Imaging.ImageFormat]::Jpeg)
    $bmp.Dispose()
    return 'data:image/jpeg;base64,' + [Convert]::ToBase64String($enc.ToArray())
  } catch { return $null }
}

function Get-State {
  $s = (Get-Manager).GetCurrentSession()
  if ($null -eq $s) { return @{ ok = $true; session = $false } }
  $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $info = $s.GetPlaybackInfo()
  $tl = $s.GetTimelineProperties()
  $key = "$($props.Title)|$($props.Artist)|$($props.AlbumTitle)"
  $state = @{
    ok       = $true
    session  = $true
    key      = $key
    title    = [string]$props.Title
    artist   = [string]$props.Artist
    album    = [string]$props.AlbumTitle
    status   = [string]$info.PlaybackStatus
    app      = [string]$s.SourceAppUserModelId
    posSec   = [math]::Round($tl.Position.TotalSeconds, 2)
    durSec   = [math]::Round(($tl.EndTime - $tl.StartTime).TotalSeconds, 2)
    updated  = [int64]$tl.LastUpdatedTime.ToUnixTimeMilliseconds()
    canPrev  = [bool]$info.Controls.IsPreviousEnabled
    canNext  = [bool]$info.Controls.IsNextEnabled
    canToggle = [bool]($info.Controls.IsPlayPauseToggleEnabled -or $info.Controls.IsPlayEnabled -or $info.Controls.IsPauseEnabled)
  }
  if ($key -ne $script:lastKey) {
    $script:lastKey = $key
    $script:lastThumb = Get-Thumb $props
  }
  # The thumbnail is sent once per track; the caller keeps it while `key` is unchanged.
  if ($null -ne $script:lastThumb -and $script:sentThumbFor -ne $key) {
    $state.thumb = $script:lastThumb
    $script:sentThumbFor = $key
  }
  return $state
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Trim().Split(' ', 2)
  $id = 0
  if (-not [int]::TryParse($parts[0], [ref]$id)) { continue }
  $cmd = if ($parts.Count -gt 1) { $parts[1] } else { '' }
  try {
    switch ($cmd) {
      'poll' { $r = Get-State; $r.id = $id; Send $r }
      'toggle' { $s = (Get-Manager).GetCurrentSession(); $ok = $false; if ($s) { $ok = Await ($s.TryTogglePlayPauseAsync()) ([bool]) }; Send @{ id = $id; ok = $true; done = [bool]$ok } }
      'next' { $s = (Get-Manager).GetCurrentSession(); $ok = $false; if ($s) { $ok = Await ($s.TrySkipNextAsync()) ([bool]) }; Send @{ id = $id; ok = $true; done = [bool]$ok } }
      'prev' { $s = (Get-Manager).GetCurrentSession(); $ok = $false; if ($s) { $ok = Await ($s.TrySkipPreviousAsync()) ([bool]) }; Send @{ id = $id; ok = $true; done = [bool]$ok } }
      'quit' { Send @{ id = $id; ok = $true }; exit 0 }
      default { Send @{ id = $id; ok = $false; error = 'unknown command' } }
    }
  } catch {
    Send @{ id = $id; ok = $false; error = [string]$_.Exception.Message }
  }
}
