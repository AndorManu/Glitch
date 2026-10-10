# List the top-level windows of a process with the styles that decide whether
# they show in the taskbar / Alt+Tab / take focus.
#   powershell -File dev/window-audit.ps1 <pid>
param([int]$ProcId)
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  public static string Dump(uint pid) {
    var rows = new List<string>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid) {
        var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
        int s = GetWindowLong(h, -16), e = GetWindowLong(h, -20);
        RECT r; GetWindowRect(h, out r);
        rows.Add(string.Format("{{\"title\":\"{0}\",\"visible\":{1},\"caption\":{2},\"thickframe\":{3},\"toolwindow\":{4},\"appwindow\":{5},\"noactivate\":{6},\"clickthrough\":{7},\"rect\":\"{8},{9} {10}x{11}\"}}",
          sb.ToString().Replace("\"", ""), IsWindowVisible(h).ToString().ToLower(), ((s & 0xC00000) == 0xC00000).ToString().ToLower(), ((s & 0x40000) != 0).ToString().ToLower(),
          ((e & 0x80) != 0).ToString().ToLower(), ((e & 0x40000) != 0).ToString().ToLower(), ((e & 0x08000000) != 0).ToString().ToLower(), ((e & 0x20) != 0).ToString().ToLower(),
          r.L, r.T, r.R - r.L, r.B - r.T));
      }
      return true;
    }, IntPtr.Zero);
    return "[" + string.Join(",", rows) + "]";
  }
}
"@
[W]::Dump([uint32]$ProcId)
