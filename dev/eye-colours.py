"""Glitch-eye colour scan over the packed sheet: frames whose eye area is drawn
blue / cyan / black instead of the magenta ramp, and frames with no magenta.

    python dev/eye-colours.py   -> prints suspects, writes dev/out/eye-colours.png
"""
import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
src = (ROOT / "src/sprites/anim.ts").read_text(encoding="utf-8")
W = int(re.search(r"ANIM_FRAME_W = (\d+)", src)[1])
H = int(re.search(r"ANIM_FRAME_H = (\d+)", src)[1])
idx = {m[1]: int(m[2]) for m in re.finditer(r"^  (\w+): (\d+),$", src.split("ANIM_EYES")[0], re.M)}
sheet = np.array(Image.open(ROOT / "public/sprites/glitch-anim.png").convert("RGBA")).astype(int)
cols = sheet.shape[1] // W


def cell(i):
    return sheet[(i // cols) * H : (i // cols + 1) * H, (i % cols) * W : (i % cols + 1) * W]


sus = []
for n, i in idx.items():
    a = cell(i)
    r, g, b, al = (a[..., k] for k in range(4))
    mag = int(((al > 0) & (r > 150) & (b > 180) & (g < 110)).sum())
    magm = (al > 0) & (r > 150) & (b > 180) & (g < 110)
    bluem = (al > 0) & (b > 150) & (r < 110)
    m = (magm | bluem).astype(int)
    if m.sum() < 6:
        continue
    k = 5
    p = np.pad(m, k)
    c = np.cumsum(np.cumsum(p, 0), 1)
    win = c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]
    y, x = np.unravel_index(int(np.argmax(win)), win.shape)
    y0, x0 = max(0, y - k - 1), max(0, x - k - 1)
    mm = int(magm[y0 : y + 2, x0 : x + 2].sum())
    bb = int(bluem[y0 : y + 2, x0 : x + 2].sum())
    # The densest glitch patch is the eye: blue there instead of magenta = a wrong-coloured eye.
    if bb > mm:
        sus.append((n, mm, bb))
for s in sus:
    print(*s)
z = 3
out = Image.new("RGBA", (W * z * 10, H * z * ((len(sus) + 9) // 10 or 1)), (46, 107, 88, 255))
d = ImageDraw.Draw(out)
for k, (n, _, _) in enumerate(sus):
    im = Image.fromarray(cell(idx[n]).astype(np.uint8), "RGBA").resize((W * z, H * z), Image.NEAREST)
    out.alpha_composite(im, ((k % 10) * W * z, (k // 10) * H * z))
    d.text(((k % 10) * W * z + 3, (k // 10) * H * z + 3), n, fill=(255, 255, 255, 255))
out.save(ROOT / "dev/out/eye-colours.png")
