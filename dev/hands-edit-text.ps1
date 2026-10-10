# Prints the text of the Edit control of the Notepad stand-in with this process id
# (WM_GETTEXT). Used by dev/hands-check.mjs.
param([int]$ProcessId)
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, StringBuilder l);
  public static string Find(uint pid) {
    string result = "";
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      EnumChildWindows(h, (c, l2) => {
        var cls = new StringBuilder(64); GetClassName(c, cls, 64);
        if (cls.ToString() == "Edit") { var sb = new StringBuilder(4096); SendMessage(c, 0x000D, (IntPtr)4096, sb); result = sb.ToString(); return false; }
        return true;
      }, IntPtr.Zero);
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
"@
[Console]::Out.Write([W]::Find([uint32]$ProcessId))
