# Capture the primary screen as numbered PNGs for N seconds (a film of the real app on the desktop).
#   powershell -File dev/screen-film.ps1 <dir> <seconds> <fps>
param([string]$Dir, [double]$Seconds = 20, [int]$Fps = 8)
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
New-Item -ItemType Directory -Force $Dir | Out-Null
$b = [System.Windows.Forms.SystemInformation]::PrimaryMonitorSize
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$sw = [Diagnostics.Stopwatch]::StartNew()
$i = 0
while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
  $t = $sw.ElapsedMilliseconds
  $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
  $bmp.Save((Join-Path $Dir ("f{0:D4}.png" -f $i)), [System.Drawing.Imaging.ImageFormat]::Png)
  $i++
  $wait = [int](1000 / $Fps - ($sw.ElapsedMilliseconds - $t))
  if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
}
$g.Dispose(); $bmp.Dispose()
