"""A clean stand-in desktop for screen films: a plain full-screen wallpaper and two small
ordinary windows (window tops Glitch can stand on and the ball can bounce off), so a
film of the real app shows nothing of the owner's real windows.

    python dev/backdrop.py            # runs until killed (or Escape on the wallpaper)

All three windows are topmost, so start this BEFORE the app under test (its own
windows are created later and stay above).
"""
import tkinter as tk

root = tk.Tk()
root.attributes("-fullscreen", True)
root.attributes("-topmost", True)
root.title("backdrop")
W, H = root.winfo_screenwidth(), root.winfo_screenheight()
c = tk.Canvas(root, width=W, height=H, highlightthickness=0)
c.pack()
# A soft dusk gradient.
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


window("Shopping list", int(W * 0.12), int(H * 0.38), 460, 260, "- oat milk\n- coffee beans\n- batteries (AA)\n- a very small hat")
window("Notes", int(W * 0.58), int(H * 0.52), 520, 240, "Fetch rules\n\n1. Throw the ball.\n2. He brings it back.\n3. Repeat until he is bored.")
root.mainloop()
