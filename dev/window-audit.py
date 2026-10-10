"""List the top-level windows of a process with the styles that decide whether they
show in the taskbar / Alt+Tab / take focus (JSON on stdout).

    python dev/window-audit.py <pid>
"""
import ctypes
import json
import sys
from ctypes import wintypes

u = ctypes.windll.user32
pid = int(sys.argv[1])
rows = []


@ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
def each(h, _):
    p = wintypes.DWORD()
    u.GetWindowThreadProcessId(h, ctypes.byref(p))
    if p.value == pid:
        buf = ctypes.create_unicode_buffer(256)
        u.GetWindowTextW(h, buf, 256)
        s = u.GetWindowLongW(h, -16) & 0xFFFFFFFF
        e = u.GetWindowLongW(h, -20) & 0xFFFFFFFF
        r = wintypes.RECT()
        u.GetWindowRect(h, ctypes.byref(r))
        rows.append({
            "title": buf.value, "visible": bool(u.IsWindowVisible(h)),
            "caption": (s & 0xC00000) == 0xC00000, "thickframe": bool(s & 0x40000),
            "toolwindow": bool(e & 0x80), "appwindow": bool(e & 0x40000),
            "noactivate": bool(e & 0x08000000), "clickthrough": bool(e & 0x20),
            "rect": f"{r.left},{r.top} {r.right - r.left}x{r.bottom - r.top}",
        })
    return True


u.EnumWindows(each, 0)
print(json.dumps(rows))
