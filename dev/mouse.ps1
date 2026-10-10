param([string]$Plan)
# Plan: "x,y,act,ms;..." act = move|down|up ; physical screen px
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class M {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
}
"@
[void][M]::SetProcessDpiAwarenessContext([IntPtr](-4))
foreach ($step in $Plan.Split(';')) {
  if (-not $step) { continue }
  $p = $step.Split(',')
  [void][M]::SetCursorPos([int]$p[0], [int]$p[1])
  if ($p[2] -eq 'down') { [M]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero) }
  if ($p[2] -eq 'up') { [M]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero) }
  Start-Sleep -Milliseconds ([int]$p[3])
}
