# Grab the primary screen to a PNG (desktop proof of the real app, nothing else touched).
#   powershell -File dev/screen-grab.ps1 out.png [x y w h]
param([string]$Out, [int]$X = 0, [int]$Y = 0, [int]$W = 0, [int]$H = 0)
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($W -eq 0) { $X = $b.X; $Y = $b.Y; $W = $b.Width; $H = $b.Height }
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($X, $Y, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
