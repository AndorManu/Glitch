param([int]$ProcessId)
# Lists the top-level windows of one process: "<hwnd> visible|hidden WxH <class> <3 flags: T tool window, A app window, N no-activate> <title>".
# Used by dev/panic-check.mjs to see whether Glitch's windows are really on screen.
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public static List<string> Of(uint pid) {
    var list = new List<string>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid) {
        var t = new StringBuilder(256); GetWindowText(h, t, 256);
        var c = new StringBuilder(256); GetClassName(h, c, 256);
        RECT r; GetWindowRect(h, out r);
        list.Add(h.ToInt64() + " " + (IsWindowVisible(h) ? "visible" : "hidden") + " " + (r.R - r.L) + "x" + (r.B - r.T) + " " + c + " " + (((GetWindowLong(h, -20) & 0x80) != 0) ? "T" : "-") + (((GetWindowLong(h, -20) & 0x40000) != 0) ? "A" : "-") + (((GetWindowLong(h, -20) & 0x8000000) != 0) ? "N" : "-") + " " + t);
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
[void][W]::SetProcessDpiAwarenessContext([IntPtr](-4))
[W]::Of([uint32]$ProcessId) | ForEach-Object { $_ }
