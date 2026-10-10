"""Frames for dev/hands-check.mjs (QA of "Let Glitch control apps").

  python dev/hands-frames.py grab <out-dir> <x> <y> <w> <h>
      Grab that screen region every ~0.35 s into <out-dir>/d_<ms>.png until
      <out-dir>/stop exists. Only the region (the test's own Notepad stand-in
      and Glitch's banner) is captured, never the whole screen.
  python dev/hands-frames.py gif <out-dir> <out.gif>
      Put each desktop frame next to the newest bubble shot (b_<ms>.png)
      and write an animated GIF.
"""

import ctypes
import os
import sys
import time

from PIL import Image, ImageDraw, ImageGrab

ctypes.windll.user32.SetProcessDPIAware()


def grab(out, x, y, w, h):
    os.makedirs(out, exist_ok=True)
    stop = os.path.join(out, "stop")
    while not os.path.exists(stop):
        t = int(time.time() * 1000)
        ImageGrab.grab(bbox=(x, y, x + w, y + h), all_screens=True).save(os.path.join(out, f"d_{t}.png"))
        time.sleep(float(os.environ.get("FRAME_GAP", "0.35")))


def frames(out, prefix):
    names = sorted((int(n[2:-4]), n) for n in os.listdir(out) if n.startswith(prefix) and n.endswith(".png"))
    return [(t, os.path.join(out, n)) for t, n in names]


def gif(out, path):
    desk = frames(out, "d_")
    bub = frames(out, "b_")
    if not desk:
        sys.exit("no frames")
    scale = 0.6
    pics = []
    for t, d in desk:
        left = Image.open(d).convert("RGB")
        left = left.resize((int(left.width * scale), int(left.height * scale)))
        shot = [p for bt, p in bub if bt <= t]
        right = Image.open(shot[-1]).convert("RGB") if shot else None
        rw = right.width if right else 0
        H = max(left.height, right.height if right else 0)
        frame = Image.new("RGB", (left.width + rw + 24, H + 8), (30, 22, 44))
        frame.paste(left, (4, 4))
        if right:
            frame.paste(right, (left.width + 16, 4))
        ImageDraw.Draw(frame)
        pics.append(frame.quantize(colors=128))
    pics[0].save(path, save_all=True, append_images=pics[1:], duration=350, loop=0, optimize=True)
    print(f"{path}: {len(pics)} frames")


if __name__ == "__main__":
    if sys.argv[1] == "grab":
        grab(sys.argv[2], *map(int, sys.argv[3:7]))
    else:
        gif(sys.argv[2], sys.argv[3])
