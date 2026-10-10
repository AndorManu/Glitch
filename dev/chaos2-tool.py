"""Helpers for the real-app check of chaos mode 2 (dev/chaos2-check.mjs). Windows only.

    python dev/chaos2-tool.py snapshot <out.json> [--skip-pid N ...]
    python dev/chaos2-tool.py trace <out.json> --pids N,M [--ms 12000] [--hz 250] [--hwnd H ...]
                              [--trigger moved:40] [--sim move:30,0 | button | esc | hotkey | restore:<hwnd>]
                              [--delay 300]
    python dev/chaos2-tool.py shot <out.png> x y w h

`trace` samples the cursor (and the given windows' rectangles) at --hz and writes
[{t, x, y, windows: {hwnd: [l, t, r, b, iconic]}}...]. With --sim it plays "the user" once, after the
cursor has been pulled away from where it started by --trigger moved:N px, +--delay ms: a real mouse
move (mouse_event, which counts as input), a button press, Esc, the panic hotkey, or restoring a
minimised test window (a click on its taskbar button). It sends a click / key ONLY if the window under
the cursor / in front belongs to the --pids (our own test windows), otherwise it skips and says so.
"""

import ctypes
import ctypes.wintypes as wt
import json
import sys
import time

user32 = ctypes.windll.user32
user32.SetProcessDPIAware()
kernel32 = ctypes.windll.kernel32


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


def pid_of(hwnd):
    pid = wt.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def title_of(hwnd):
    n = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def cursor():
    p = POINT()
    user32.GetCursorPos(ctypes.byref(p))
    return p.x, p.y


def snapshot(out, skip):
    wins = []
    fg = user32.GetForegroundWindow()

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
    def visit(h, _):
        if user32.IsWindowVisible(h) or user32.IsIconic(h):
            pid = pid_of(h)
            if pid in skip:
                return True
            r = wt.RECT()
            user32.GetWindowRect(h, ctypes.byref(r))
            wins.append({"hwnd": int(h), "pid": pid, "title": title_of(h), "rect": [r.left, r.top, r.right, r.bottom], "iconic": bool(user32.IsIconic(h)), "zoomed": bool(user32.IsZoomed(h)), "visible": bool(user32.IsWindowVisible(h)), "fg": h == fg})
        return True

    user32.EnumWindows(visit, 0)
    json.dump(wins, open(out, "w"))
    print(len(wins), "windows")


def mouse_event(flags, dx=0, dy=0):
    user32.mouse_event(flags, dx, dy, 0, 0)


def key(vk, down):
    user32.keybd_event(vk, 0, 0 if down else 2, 0)


def trace(out, pids, ms, hz, hwnds, trigger, sim, delay):
    start_pos = cursor()
    t0 = time.perf_counter()
    rows = []
    fired = None
    trig_at = None
    note = ""
    rect = wt.RECT()
    while True:
        t = (time.perf_counter() - t0) * 1000
        if t > ms:
            break
        x, y = cursor()
        w = {}
        for h in hwnds:
            user32.GetWindowRect(h, ctypes.byref(rect))
            w[str(h)] = [rect.left, rect.top, rect.right, rect.bottom, int(bool(user32.IsIconic(h)))]
        rows.append({"t": round(t, 2), "x": x, "y": y, "w": w})
        if sim and fired is None:
            if trigger and trig_at is None and ((x - start_pos[0]) ** 2 + (y - start_pos[1]) ** 2) ** 0.5 >= trigger:
                trig_at = t
            if (trigger is None and t >= delay) or (trig_at is not None and t - trig_at >= delay):
                fired = round(t, 2)
                kind, _, arg = sim.partition(":")
                if kind == "move":
                    dx, dy = (int(v) for v in arg.split(","))
                    mouse_event(0x0001, dx, dy)
                elif kind in ("button", "esc", "hotkey"):
                    if kind == "button":
                        hit = user32.WindowFromPoint(POINT(x, y))
                        root = user32.GetAncestor(hit, 2)
                        if pid_of(root) in pids:
                            mouse_event(0x0002)
                            time.sleep(0.03)
                            mouse_event(0x0004)
                        else:
                            note = "skipped: not our window under the cursor"
                    else:
                        fg = user32.GetForegroundWindow()
                        if pid_of(fg) in pids:
                            if kind == "esc":
                                key(0x1B, True)
                                time.sleep(0.05)
                                key(0x1B, False)
                            else:
                                for vk in (0x11, 0x12, 0x10, 0x78):
                                    key(vk, True)
                                time.sleep(0.08)
                                for vk in (0x78, 0x10, 0x12, 0x11):
                                    key(vk, False)
                        else:
                            note = "skipped: the focus is not on our window"
                elif kind == "restore":
                    h = int(arg)
                    if pid_of(h) in pids:
                        user32.ShowWindow(h, 9)  # SW_RESTORE: what a click on its taskbar button does
                else:
                    note = f"unknown sim {sim}"
        time.sleep(max(0, 1 / hz - 0.0002))
    json.dump({"fired_ms": fired, "note": note, "start": start_pos, "rows": rows}, open(out, "w"))
    print("fired", fired, note, len(rows), "samples")


def shot(out, x, y, w, h):
    from PIL import ImageGrab

    ImageGrab.grab(bbox=(x, y, x + w, y + h), all_screens=True).save(out)


def main(argv):
    cmd = argv[1]
    if cmd == "snapshot":
        skip = {int(argv[i + 1]) for i, a in enumerate(argv) if a == "--skip-pid"}
        snapshot(argv[2], skip)
    elif cmd == "trace":
        opt = lambda f, d=None: argv[argv.index(f) + 1] if f in argv else d
        hwnds = [int(argv[i + 1]) for i, a in enumerate(argv) if a == "--hwnd"]
        trig = opt("--trigger")
        trigger = float(trig.split(":")[1]) if trig and trig != "none" else None
        trace(argv[2], {int(p) for p in opt("--pids", "0").split(",")}, float(opt("--ms", 12000)), float(opt("--hz", 250)), hwnds, trigger, opt("--sim"), float(opt("--delay", 300)))
    elif cmd == "shot":
        shot(argv[2], *map(int, argv[3:7]))
    elif cmd == "styles":
        want_pid = int(argv[2])

        @ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
        def visit2(h, _):
            if pid_of(h) == want_pid and user32.IsWindowVisible(h):
                st = user32.GetWindowLongW(h, -16) & 0xFFFFFFFF
                ex = user32.GetWindowLongW(h, -20) & 0xFFFFFFFF
                print(hex(int(h)), repr(title_of(h)), "style", hex(st), "ex", hex(ex), "CAPTION" if st & 0xC00000 == 0xC00000 else "")
            return True

        user32.EnumWindows(visit2, 0)
    elif cmd == "stagecheck":
        # Is the QA stage really covering the work area? (So a film never shows anybody's real desktop.)
        from PIL import ImageGrab

        x, y, w, h = map(int, argv[2:6])
        im = ImageGrab.grab(bbox=(x, y, x + w, y + h), all_screens=True).convert("RGB")
        bad = total = 0
        for gy in range(12):
            for gx in range(20):
                px = im.getpixel((int((gx + 0.5) * w / 20), int((gy + 0.5) * h / 12)))
                t = (gy + 0.5) / 12
                grad = tuple(a + (b - a) * t for a, b in zip((28, 34, 64), (86, 52, 98)))
                ok = all(abs(c - g) <= 22 for c, g in zip(px, grad)) or all(abs(c - v) <= 14 for c, v in zip(px, (244, 241, 234)))
                total += 1
                bad += 0 if ok else 1
        print("stage ok" if bad <= total * 0.1 else f"stage NOT covering: {bad}/{total}")
        sys.exit(0 if bad <= total * 0.1 else 3)
    elif cmd == "wiggle":
        # Our own "user" moving the pointer in slow circles over the QA stage (SetCursorPos is not input).
        import math

        cx, cy = cursor()
        t0 = time.perf_counter()
        while time.perf_counter() - t0 < 6.5:
            a = (time.perf_counter() - t0) * 2.2
            user32.SetCursorPos(int(cx + 220 * math.cos(a)), int(cy + 120 * math.sin(a)))
            time.sleep(0.01)
    elif cmd == "setpos":
        user32.SetCursorPos(int(argv[2]), int(argv[3]))
    elif cmd == "restore":
        h = int(argv[2])
        if pid_of(h) in {int(p) for p in argv[3].split(",")}:
            user32.ShowWindow(h, 9)
    elif cmd == "idle":
        class LII(ctypes.Structure):
            _fields_ = [("cbSize", wt.UINT), ("dwTime", wt.DWORD)]

        i = LII()
        i.cbSize = 8
        user32.GetLastInputInfo(ctypes.byref(i))
        print(kernel32.GetTickCount() - i.dwTime)


main(sys.argv)
