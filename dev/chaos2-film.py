"""Film a region of the screen to numbered PNGs and a GIF (QA of chaos mode 2).

    python dev/chaos2-film.py <out-dir> <name> <seconds> <fps> [x y w h] [--scale 0.5]

Run it only over the QA stage (dev/chaos2-windows.py covers the work area with its own wallpaper),
so nothing of anybody's real desktop is captured. Frames go to <out-dir>/<name>-NNN.png, the GIF to
<out-dir>/<name>.gif. Prints the time of each frame.
"""

import ctypes
import sys
import time

from PIL import Image, ImageDraw, ImageGrab
import ctypes.wintypes as wt

ctypes.windll.user32.SetProcessDPIAware()
args = [a for a in sys.argv[1:] if not a.startswith("--")]
scale = float(sys.argv[sys.argv.index("--scale") + 1]) if "--scale" in sys.argv else 0.5
if "--scale" in sys.argv:
    args.remove(sys.argv[sys.argv.index("--scale") + 1])
out, name, secs, fps = args[0], args[1], float(args[2]), float(args[3])
bbox = tuple(int(v) for v in args[4:8]) if len(args) >= 8 else None
frames = []
t0 = time.perf_counter()
n = 0
while time.perf_counter() - t0 < secs:
    t = time.perf_counter()
    im = ImageGrab.grab(bbox=(bbox[0], bbox[1], bbox[0] + bbox[2], bbox[1] + bbox[3]) if bbox else None, all_screens=True).convert("RGB")
    # The screen grab has no mouse pointer: draw one where it is (white arrow, black outline).
    pt = wt.POINT()
    ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
    ox, oy = (bbox[0], bbox[1]) if bbox else (0, 0)
    cx, cy = pt.x - ox, pt.y - oy
    arrow = [(0, 0), (0, 17), (4, 13), (7, 20), (10, 19), (7, 12), (12, 12)]
    ImageDraw.Draw(im).polygon([(cx + 1.4 * x, cy + 1.4 * y) for x, y in arrow], fill=(255, 255, 255), outline=(0, 0, 0))
    if scale != 1:
        im = im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)
    frames.append(im)
    im.save(f"{out}/{name}-{n:03d}.png")
    n += 1
    time.sleep(max(0, 1 / fps - (time.perf_counter() - t)))
if frames:
    frames[0].save(f"{out}/{name}.gif", save_all=True, append_images=frames[1:], duration=int(1000 / fps), loop=0)
print(n, "frames", round(time.perf_counter() - t0, 1), "s")
