"""QA stage for chaos mode 2: a clean stand-in desktop with our OWN test windows, so a run of the
real app never touches (or films) anybody's real windows.

    python dev/chaos2-windows.py <info.json>      # runs until Escape on the wallpaper / killed

Writes <info.json> with this process's pid and the windows: wallpaper (no title, topmost, covers
the work area), "Chaos QA A", "Chaos QA B", an unsaved-looking "*Draft - Chaos QA" and a small
"Chaos QA focus" window that holds the keyboard focus. Everything is topmost so the wallpaper
hides whatever else is on the desktop and Glitch (started later, also topmost) stays above;
the app under test is started with GLITCH_CHAOS_ONLY_PIDS=<this pid>, which also tells it to
ignore the topmost flag, so only these windows are ever eligible.
"""

import ctypes
import json
import sys
import tkinter as tk

ctypes.windll.user32.SetProcessDPIAware()
user32 = ctypes.windll.user32

root = tk.Tk()
root.overrideredirect(True)
root.title("")
root.attributes("-topmost", True)
SW, SH = root.winfo_screenwidth(), root.winfo_screenheight()
# Work area = screen minus the taskbar (approx.): not "fullscreen" for the app's checks.
import ctypes.wintypes as wt

wa = wt.RECT()
user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(wa), 0)  # SPI_GETWORKAREA
W, H = wa.right - wa.left, wa.bottom - wa.top
root.geometry(f"{W}x{H}+{wa.left}+{wa.top}")
c = tk.Canvas(root, width=W, height=H, highlightthickness=0)
c.pack()
top, bottom = (28, 34, 64), (86, 52, 98)
for y in range(0, H, 4):
    t = y / H
    col = "#%02x%02x%02x" % tuple(int(a + (b - a) * t) for a, b in zip(top, bottom))
    c.create_rectangle(0, y, W, y + 4, outline="", fill=col)
root.bind("<Escape>", lambda e: root.destroy())


def window(title, x, y, w, h, body):
    win = tk.Toplevel(root)
    win.title(title)
    win.geometry(f"{w}x{h}+{x}+{y}")
    win.attributes("-topmost", True)
    tk.Label(win, text=body, font=("Segoe UI", 13), justify="left", bg="#f4f1ea", fg="#2a2733", padx=18, pady=14).pack(fill="both", expand=True)
    return win


wins = {
    "A": window("Chaos QA A", int(W * 0.10), int(H * 0.30), 480, 300, "Window A\n\n- oat milk\n- coffee beans\n- a very small hat"),
    "B": window("Chaos QA B", int(W * 0.50), int(H * 0.40), 520, 280, "Window B\n\nFetch rules\n1. Throw the ball.\n2. Repeat."),
    "unsaved": window("*Draft - Chaos QA", int(W * 0.28), int(H * 0.62), 420, 220, "This one looks unsaved.\nGlitch must leave it alone."),
    "focus": window("Chaos QA focus", int(W * 0.78), int(H * 0.12), 300, 160, "Holds the keyboard focus."),
}
root.update()
# All topmost: the wallpaper (covering the work area) first, our windows above it. Once is enough:
# Glitch's own windows are created later and stay above these.
root.attributes("-topmost", True)
for w in wins.values():
    w.attributes("-topmost", False)
    w.attributes("-topmost", True)
    w.lift()
root.update()


def hwnd_of(w):
    return user32.GetParent(w.winfo_id()) or w.winfo_id()


info = {"pid": ctypes.windll.kernel32.GetCurrentProcessId(), "work_area": [wa.left, wa.top, W, H], "windows": {k: hwnd_of(w) for k, w in wins.items()}}
with open(sys.argv[1], "w") as f:
    json.dump(info, f)


def refocus():
    try:
        wins["focus"].focus_force()
    except tk.TclError:
        return
    root.after(1500, refocus)


refocus()
root.mainloop()
