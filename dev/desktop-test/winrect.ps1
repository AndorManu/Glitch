# Prints "left top right bottom state" of the main window of a process (physical px).
# Used by dev/desktop-check.mjs on its own DraftPad test window.
param([int]$ProcessId)
Add-Type @"
using System; using System.Runtime.InteropServices;
public class WR {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int l, t, r, b; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
}
"@
[WR]::SetProcessDPIAware() | Out-Null
$p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
if (-not $p) { Write-Output "gone"; exit }
$h = $p.MainWindowHandle
$r = New-Object WR+RECT
[WR]::GetWindowRect($h, [ref]$r) | Out-Null
$state = if ([WR]::IsIconic($h)) { "minimized" } elseif ([WR]::IsZoomed($h)) { "maximized" } else { "normal" }
Write-Output "$($r.l) $($r.t) $($r.r) $($r.b) $state"
